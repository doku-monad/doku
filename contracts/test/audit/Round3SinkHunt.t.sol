// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {console2} from "forge-std/Test.sol";
import {PosmTestSetup} from "@uniswap/v4-periphery/test/shared/PosmTestSetup.sol";
import {DeployDoku} from "../../script/DeployDoku.s.sol";
import {DokuFactory} from "../../src/DokuFactory.sol";
import {DokuGraduation} from "../../src/DokuGraduation.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {RewardVault, ICheckpointedToken} from "../../src/sinks/RewardVault.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";
import {Sinks} from "../../src/lib/Sinks.sol";
import {Launches} from "../helpers/Launches.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

// Compiled only so `vm.getCode` can find them; see DeployDoku.t.sol.
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {PositionDescriptor} from "@uniswap/v4-periphery/src/PositionDescriptor.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/**
 * ROUND 3 — the sinks, against the real deployment script and a real Uniswap v4.
 *
 * Everything here is measured on the graph `DeployDoku` actually builds, because the two questions
 * this file asks are both about a set the vault is TOLD rather than one it computes:
 *
 *   1. Is `DokuGraduation._deploySink`'s exclusion array complete?
 *   2. Where does an epoch's unclaimed remainder go?
 */
contract Round3SinkHunt is PosmTestSetup {
    using Launches for DokuFactory;

    address internal constant OWNER = address(0x0BEE);
    address internal constant PAUSER = address(0xBA5E);
    address internal constant FEE_RECIPIENT = address(0xFEE);
    address internal constant TREASURY = address(0x7EA);
    address internal constant CREATOR = address(0xC12A);
    address internal constant BUYER = address(0xB0B);
    address internal constant HOLDER = address(0x40D);
    address internal constant CHURNER = address(0xC407);
    /// @dev The holder this whole window exists for: it carries a position across the whole of
    ///      interval 0 and does not come to collect. See `RESIDUE_WINDOW_EPOCHS`.
    address internal constant SLOW = address(0x570E);
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 internal constant TARGET = 1_000e18;
    uint256 internal constant USDC_TARGET = 10_000e6;

    DeployDoku internal script;
    DeployDoku.Deployment internal d;
    MockUSDC internal usdc;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployPosm(manager);
        script = new DeployDoku();
        d = script.runWith(_config());
        vm.deal(CREATOR, 500_000e18);
        vm.deal(BUYER, 5_000_000e18);
        vm.deal(address(this), 5_000_000e18);
    }

    function _config() internal returns (DeployDoku.Config memory cfg) {
        if (address(usdc) == address(0)) usdc = new MockUSDC();
        cfg.poolManager = address(manager);
        cfg.positionManager = address(lpm);
        cfg.permit2 = address(permit2);
        cfg.owner = OWNER;
        cfg.pauser = PAUSER;
        cfg.feeRecipient = FEE_RECIPIENT;
        cfg.treasury = TREASURY;
        cfg.quoteTarget = TARGET;
        cfg.quoteAssets = new address[](1);
        cfg.quoteAssets[0] = address(usdc);
        cfg.quoteTargets = new uint256[](1);
        cfg.quoteTargets[0] = USDC_TARGET;
        cfg.launchFeeWei = 0;
    }

    /// @dev A native-quoted REWARDS market, filled and graduated. Returns its curve, token and vault.
    function _rewardsMarket() internal returns (BondingCurve curve, IERC20 token, RewardVault vault, PoolId id) {
        DokuFactory factory = DokuFactory(d.dokuFactory);
        DokuFactory.LaunchParams memory p = factory.params(address(0), Sinks.REWARDS, 0);
        // A REWARDS market's routed recipient is its vault; naming one is `RecipientNotAllowed`.
        p.taxRecipient = CREATOR;
        vm.prank(CREATOR);
        (address curveAddr, address tokenAddr) = factory.launch(p);
        curve = BondingCurve(payable(curveAddr));
        token = IERC20(tokenAddr);

        vm.warp(vm.getBlockTimestamp() + curve.TAX_WINDOW() + 1);
        vm.prank(BUYER);
        curve.buy{value: 5 * TARGET}(0, vm.getBlockTimestamp() + 1 hours);

        assertTrue(DokuGraduation(payable(d.graduation)).graduated(curveAddr), "market did not graduate");
        id = DokuGraduation(payable(d.graduation)).poolIdOf(curveAddr);
        vault = RewardVault(payable(DokuHook(payable(d.hook)).markets(id).sinkAddr));
        assertEq(vault.quote(), address(0), "expected a native vault");
    }

    /// @dev Credit the market's sink ledger directly. `creditCurveTax` is permissionless, which is
    ///      exactly the shape needed to fund a vault without trading.
    function _creditSink(PoolId id, uint256 amount) internal {
        DokuHook(payable(d.hook)).creditCurveTax{value: amount}(id);
    }

    function _creditSinkErc20(PoolId id, uint256 amount) internal {
        usdc.mint(address(this), amount);
        usdc.approve(d.hook, amount);
        DokuHook(payable(d.hook)).creditCurveTax(id, amount);
    }

    /// @dev The same market priced in a six-decimal ERC-20 — the shape of six of the seven quotes
    ///      the live registry carries.
    function _usdcRewardsMarket() internal returns (BondingCurve curve, IERC20 token, RewardVault vault, PoolId id) {
        DokuFactory factory = DokuFactory(d.dokuFactory);
        DokuFactory.LaunchParams memory p = factory.params(address(usdc), Sinks.REWARDS, 0);
        p.taxRecipient = CREATOR;
        vm.prank(CREATOR);
        (address curveAddr, address tokenAddr) = factory.launch(p);
        curve = BondingCurve(payable(curveAddr));
        token = IERC20(tokenAddr);

        usdc.mint(BUYER, 10 * USDC_TARGET);
        vm.warp(vm.getBlockTimestamp() + curve.TAX_WINDOW() + 1);
        vm.startPrank(BUYER);
        usdc.approve(curveAddr, type(uint256).max);
        curve.buyWithToken(5 * USDC_TARGET, 0, vm.getBlockTimestamp() + 1 hours);
        vm.stopPrank();

        assertTrue(DokuGraduation(payable(d.graduation)).graduated(curveAddr), "usdc market did not graduate");
        id = DokuGraduation(payable(d.graduation)).poolIdOf(curveAddr);
        vault = RewardVault(payable(DokuHook(payable(d.hook)).markets(id).sinkAddr));
        assertEq(vault.quote(), address(usdc), "expected a usdc vault");
    }

    // =================================================================================
    // FINDING 3-A — the `SeedLocker` is missing from the vault's exclusion set
    // =================================================================================

    /**
     * `RewardVault`'s NatSpec states the set as a closed list: "The full set is {PoolManager, hook,
     * curve, token, DEAD, Graduation, PositionManager, this vault}", under the heading "Eligible
     * supply excludes every address that is NOT A HOLDER."
     *
     * `DokuGraduation` deploys a ninth protocol contract that holds the launch token — the
     * `SeedLocker`, owner of the seed position — and it is not in the array. It is not in the
     * array on the live chain either: `_deploySink` fills `ex[0..6]` and the vault fills `ex[8]`
     * with itself.
     *
     * IT WAS DELETED ON PURPOSE, AND THE REASON EXPIRED. `docs/doku/08-plan-v4-hook-tax.md` §9.1
     * writes the v4 membership change as a diff against the V3 set and the third line of it is
     * literally `- locker   deleted`. That was correct when it was written: under the v4 plan the
     * seed position was minted to `0x...dEaD`, so there WAS no locker. `SeedLocker` was then
     * reintroduced — because `DokuHook.LP_LEVY_BPS` DONATED to in-range positions at the time and a
     * dead owner could never collect — and the exclusion set was never put back. (Round 4 has since
     * removed that donate and the locker still holds the position, so the membership question this
     * finding is about is unchanged.) The same §9.1 keeps the
     * PositionManager while saying its "stated reason is now false: POSM never holds tokens under
     * v4". So the set currently excludes the address that cannot hold the token and admits the one
     * that can.
     *
     * `SeedLocker.collect` forwards only ITS OWN DELTA (round 1's fix), so a launch token that
     * arrives at the locker by any other route — a mistyped transfer, a deliberate donation — rests
     * there permanently. Consequence, proved below: those tokens count in `eligibleSupplyAt`'s
     * denominator, carry a non-zero `weightOf`, and `claim` is permissionless, so anyone may
     * crystallise the locker's share into the locker, where nothing can ever move it.
     */
    function test_3A_theSeedLockerIsOneOfTheAddressesTheVaultExcludes() public {
        (,, RewardVault vault,) = _rewardsMarket();

        assertTrue(vault.isExcluded(address(manager)), "PoolManager should be excluded");
        assertTrue(vault.isExcluded(d.hook), "hook should be excluded");
        assertTrue(vault.isExcluded(d.graduation), "Graduation should be excluded");
        assertTrue(vault.isExcluded(address(lpm)), "PositionManager should be excluded");
        assertTrue(vault.isExcluded(DEAD), "DEAD should be excluded");
        assertTrue(vault.isExcluded(address(vault)), "the vault should exclude itself");

        // The ninth contract, and the one the list had forgotten. FIXED: the array is nine wide
        // and `_deploySink` fills the eighth slot with the locker. Flipped rather than deleted so
        // that dropping the locker from the set turns this red again.
        assertTrue(vault.isExcluded(d.seedLocker), "the SeedLocker fell out of the exclusion set");
        assertEq(vault.excluded()[7], d.seedLocker, "the locker is not in the slot _deploySink fills");
    }

    /**
     * THE MONEY HALF, and it splits on the quote asset exactly the way round 2's `claimTo` guard
     * did — which is why both configurations are here and neither on its own is the finding.
     *
     * NATIVE vault: `_pay` is a raw `call`, `SeedLocker.receive()` is gated to the PoolManager, and
     * the claim REVERTS. The locker's share is then claimable by nobody at all — `hasClaimed` is
     * never set, `weightOf` still answers with the parked balance, and the epoch keeps the money
     * for ever. Diluted, and unreachable.
     *
     * ERC-20 vault — six of the seven registered quotes: `_pay` is `safeTransfer`, which succeeds
     * perfectly well against the locker. The quote LANDS there, `hasClaimed` latches, and
     * `SeedLocker` has no owner, no rescue, and a `collect` that forwards only its own delta. Gone.
     */
    function test_3A_native_aLockerDonationIsOutsideTheEpochEntirely() public {
        (, IERC20 token, RewardVault vault, PoolId id) = _rewardsMarket();

        uint256 parked = token.balanceOf(BUYER) / 100;
        vm.prank(BUYER);
        token.transfer(d.seedLocker, parked);

        uint256 epoch = vault.EPOCH_BLOCKS();
        vm.roll(vault.snapshotBlockFor(0) + 1);
        _creditSink(id, 100 ether);
        vault.fund();
        vm.roll(vault.snapshotBlockFor(1) + 1);
        vault.createEpochs(2);
        epoch;

        // FIXED. The parked balance is in neither the numerator nor the denominator: the locker is
        // excluded, so it carries no weight, a claim for it is refused loudly, and the epoch's
        // eligible supply is the float LESS the parked amount — nothing is diluted into nothing.
        assertEq(vault.weightOf(d.seedLocker, 0), 0, "the locker still carries weight");
        vm.expectRevert(abi.encodeWithSelector(RewardVault.HolderExcluded.selector, d.seedLocker));
        vault.claim(d.seedLocker, 0, 0);

        (,, uint256 es,) = vault.epochs(0);
        uint256 floatAtSnap = token.totalSupply() - _excludedBalancesAt(vault, vault.snapshotBlockFor(0));
        assertEq(es, floatAtSnap, "the parked balance is still in the denominator");
    }

    /// @dev Sum of the excluded set's balances at `blockNumber`, read the same way the vault does.
    function _excludedBalancesAt(RewardVault vault, uint256 blockNumber) internal view returns (uint256 sum) {
        address[9] memory ex = vault.excluded();
        ICheckpointedToken t = ICheckpointedToken(address(vault.token()));
        for (uint256 i; i < ex.length; ++i) {
            if (ex[i] != address(0)) sum += t.getPastBalance(ex[i], blockNumber);
        }
    }

    function test_3A_erc20_aStrangerCanNoLongerStrandADividendInTheLocker() public {
        (, IERC20 token, RewardVault vault, PoolId id) = _usdcRewardsMarket();

        uint256 parked = token.balanceOf(BUYER) / 100;
        vm.prank(BUYER);
        token.transfer(d.seedLocker, parked);

        vm.roll(vault.snapshotBlockFor(0) + 1);
        _creditSinkErc20(id, 100_000e6);
        vault.fund();
        vm.roll(vault.snapshotBlockFor(1) + 1);
        vault.createEpochs(2);

        // FIXED. This was the expensive half — `safeTransfer` succeeds against the locker, so a
        // stranger's permissionless claim used to strand ~1,000 USDC of a 100,000 USDC epoch in a
        // contract with no owner and no rescue. The locker now carries no weight and a claim for it
        // is refused before any transfer is attempted.
        assertEq(vault.weightOf(d.seedLocker, 0), 0, "the locker still carries weight");

        uint256 before = usdc.balanceOf(d.seedLocker);
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(RewardVault.HolderExcluded.selector, d.seedLocker));
        vault.claim(d.seedLocker, 0, 0);
        assertEq(usdc.balanceOf(d.seedLocker), before, "USDC reached the locker anyway");
    }

    /**
     * THE DIAGNOSIS, PROVED — the loop's rule 5 run forwards.
     *
     * "Revert the fix and watch the test go red" has no fix to revert here: `_deploySink` lives in
     * `DokuGraduation`, which is another module. So the equivalent is run the other way — build the
     * SAME vault against the SAME token and genesis with the locker IN the array, and show the
     * weight and the denominator both move by exactly the parked balance. That rules out every
     * other explanation for the two tests above.
     *
     * The fix widened the array from eight to nine rather than spending the PositionManager's
     * belt-and-braces slot: that exclusion costs nothing while it is redundant, and it is exactly
     * the shape of this finding if some future periphery ever misroutes tokens there.
     */
    function test_3A_revertCheck_aVaultBuiltWithoutTheLockerReopensTheHole() public {
        (BondingCurve curve, IERC20 token, RewardVault shipped, PoolId id) = _rewardsMarket();

        uint256 parked = token.balanceOf(BUYER) / 100;
        vm.prank(BUYER);
        token.transfer(d.seedLocker, parked);

        // Rule 5, run in place: a vault built with the generation-3 set — seven slots, no locker —
        // against the SAME token and genesis. `shipped` is what `_deploySink` now builds. The
        // difference between the two denominators must be exactly the parked balance, and only the
        // old one may give the locker a weight. If somebody drops the locker from `_deploySink`,
        // `shipped` becomes this vault and both assertions below fail.
        address[9] memory ex;
        ex[0] = address(manager);
        ex[1] = d.hook;
        ex[2] = address(curve);
        ex[3] = address(token);
        ex[4] = DEAD;
        ex[5] = d.graduation;
        ex[6] = address(lpm);
        RewardVault gen3Set = new RewardVault(
            d.hook,
            address(token),
            id,
            address(0),
            curve.quoteTarget(),
            shipped.genesisBlock(),
            ex
        );

        vm.roll(shipped.snapshotBlockFor(0) + 1);
        _creditSink(id, 100 ether);
        shipped.fund();
        vm.roll(shipped.snapshotBlockFor(1) + 1);
        shipped.createEpochs(2);

        uint256 snap = shipped.snapshotBlockFor(0);
        assertEq(
            gen3Set.eligibleSupplyAt(snap) - shipped.eligibleSupplyAt(snap),
            parked,
            "the denominator does not move by the parked balance"
        );
        // Not `gen3Set.weightOf(...)`: that reads `epochs[0]`, and this vault has opened none. The
        // two inputs `weightOf` would multiply are asserted directly instead — the locker is NOT in
        // this set, and its balance at the grid line is exactly the parked amount.
        assertFalse(gen3Set.isExcluded(d.seedLocker), "the gen-3 set excludes the locker after all");
        assertEq(
            ICheckpointedToken(address(token)).getPastBalance(d.seedLocker, snap),
            parked,
            "the parked balance is not what the gen-3 set would weigh"
        );
        assertEq(shipped.weightOf(d.seedLocker, 0), 0, "the shipped vault gives the locker a weight");
        assertTrue(shipped.isExcluded(d.seedLocker), "the shipped vault did not exclude the locker");
    }

    // =================================================================================
    // FINDING 3-B — an epoch's unclaimed remainder was stranded while two other
    //               unclaimable cases carried forward. FIXED: `sweepResidue`.
    // =================================================================================

    /**
     * `_openEpoch` has two branches for money nobody can be paid, and BOTH carry it forward to the
     * next interval: "below `minEpochAmount`" and "no eligible supply". The comment on the second
     * states the rule — "Forward is the only safe direction: it can only ever reach a holder set at
     * or after the one that earned it."
     *
     * There is a third case, and it is the largest one, and it did not carry: the part of an
     * OPENED epoch that no holder's weight reaches. `weightOf` is `min(balance at the opening grid
     * line, balance at the closing one)`, so every address whose balance MOVED inside the interval
     * — which is every trader, because the PoolManager is excluded and a buy takes the balance from
     * zero — contributes strictly less than its share of the denominator. The denominator is the
     * OPENING balance of every non-excluded address. The difference is `amount - claimed`, and
     * nothing in this contract could ever reach it again: `unallocated` did not include it, no
     * function re-bucketed it, and the epoch stayed claimable for ever by holders who no longer
     * exist.
     *
     * This is not the same finding as M-01, which is about WHICH interval money lands in. It is
     * about money that lands in the right interval and is then unreachable.
     *
     * FIXED, AND THE FIX IS A DECISION RATHER THAN AN OVERSIGHT CLOSED. `sweepResidue(k)` is
     * permissionless and, once epoch `k` has been claimable for `RESIDUE_WINDOW_EPOCHS` — 26
     * epochs, about 26 days on Monad — moves `amount - claimed` into the current interval's
     * `pending` bucket, where the next epoch to open pays it to the holders who are here now. That
     * is the third case made consistent with the first two, and it costs exactly one thing: a
     * holder who has not claimed by then is dispossessed. Both halves are asserted below, the
     * second as deliberately as the first.
     *
     * Flipped rather than deleted: reverting `sweepResidue` turns every assertion after the
     * measurement red, and the measurement itself — the unreachable quarter — stays where it was.
     */
    function test_3B_theUnclaimableRemainderOfAnEpochIsPermanentlyUnreachable() public {
        (IERC20 token, RewardVault vault,) = _churnedEpochZero();

        uint256 epoch = vault.EPOCH_BLOCKS();
        (, uint256 amount, uint256 es,) = vault.epochs(0);
        assertGt(amount, 0, "epoch 0 did not fund");

        // Everyone who could possibly claim, claims — except SLOW, who held right through interval
        // 0 and simply does not turn up until the window has closed. SLOW is the cost of this fix
        // and is in the test for that reason.
        address[4] memory all = [BUYER, HOLDER, CREATOR, address(0xBAD)];
        for (uint256 i; i < all.length; ++i) {
            try vault.claim(all[i], 0, 0) returns (uint256) {} catch {}
        }
        // CHURNER's claim is refused for exactly the reason the finding is about: it bought INSIDE
        // the interval, so `min(open, close)` is zero, while a quarter of the float sat in it at
        // the closing line and counted nowhere.
        assertEq(vault.weightOf(CHURNER, 0), 0, "the churner carries a weight after all");
        assertGt(token.balanceOf(CHURNER), 0, "the churner holds nothing, so this proves nothing");
        vm.expectRevert(RewardVault.NothingToClaim.selector);
        vault.claim(CHURNER, 0, 0);

        (,,, uint256 claimed) = vault.epochs(0);
        uint256 stranded = amount - claimed;
        // The two halves of `stranded`, and only the first is the FINDING: SLOW's share is money a
        // real holder can still collect, the rest is money the arithmetic can never reach.
        uint256 slowShare = (amount * vault.weightOf(SLOW, 0)) / es;
        uint256 unreachable = stranded - slowShare;

        console2.log("epoch 0 amount      ", amount);
        console2.log("epoch 0 claimed     ", claimed);
        console2.log("left in the epoch   ", stranded);
        console2.log("  of which SLOW's   ", slowShare);
        console2.log("  of which unreach. ", unreachable);
        console2.log("unreachable, bps    ", (unreachable * 10_000) / amount);
        console2.log("eligibleSupply      ", es);

        assertGt(unreachable, 0, "nothing was unreachable, so this finding is closed");

        // ---- Before the window, it is still epoch 0's money. --------------------------------
        uint256 opensAt = vault.sweepableFrom(0);
        assertEq(
            opensAt,
            vault.snapshotBlockFor(1) + vault.RESIDUE_WINDOW_EPOCHS() * epoch + 1,
            "the window is not 26 epochs past the closing grid line"
        );
        vm.expectRevert(abi.encodeWithSelector(RewardVault.ResidueNotMature.selector, uint256(0), opensAt));
        vault.sweepResidue(0);

        // The last block on which it is refused, which is the one that matters: an off-by-one here
        // is a day of somebody's claiming time.
        vm.roll(opensAt - 1);
        vm.expectRevert(abi.encodeWithSelector(RewardVault.ResidueNotMature.selector, uint256(0), opensAt));
        vault.sweepResidue(0);

        // ---- On the window block, it carries forward. ----------------------------------------
        vm.roll(opensAt);
        uint256 toInterval = vault.currentInterval();
        assertGe(toInterval, vault.epochCount(), "the sweep would write a bucket an epoch has spent");
        uint256 pendingBefore = vault.pending(toInterval);
        uint256 unallocBefore = vault.unallocated();
        uint256 heldBefore = address(vault).balance;

        vm.expectEmit(true, true, false, true, address(vault));
        emit RewardVault.ResidueSwept(0, toInterval, stranded);
        uint256 moved = vault.sweepResidue(0);

        assertEq(moved, stranded, "the sweep did not move the whole remainder");
        assertEq(moved, unreachable + slowShare, "the sweep took only one of the two halves");
        assertEq(vault.pending(toInterval), pendingBefore + moved, "the bucket did not rise by the remainder");
        assertEq(vault.unallocated(), unallocBefore + moved, "unallocated did not rise by the remainder");
        // It is a move, not an exit. Nothing left the contract.
        assertEq(address(vault).balance, heldBefore, "a sweep moved money out of the vault");

        (, uint256 amountAfter,, uint256 claimedAfter) = vault.epochs(0);
        assertEq(amountAfter, amount, "the sweep rewrote the epoch's funded size, which is history");
        assertEq(claimedAfter, amountAfter, "epoch 0 still carries an outstanding obligation");

        // Twice is refused, loudly. The bucket may be credited once and once only.
        vm.expectRevert(abi.encodeWithSelector(RewardVault.NothingToSweep.selector, uint256(0)));
        vault.sweepResidue(0);

        // ---- And the epoch that opens against that bucket pays it out. -----------------------
        vm.roll(vault.snapshotBlockFor(toInterval + 1) + 1);
        vault.createEpochs(toInterval + 1);
        (, uint256 fwdAmount, uint256 fwdEs,) = vault.epochs(toInterval);
        assertEq(fwdAmount, moved, "the swept remainder did not become that interval's dividend");
        assertGt(fwdEs, 0, "the forward epoch opened with no denominator");

        uint256 before = HOLDER.balance;
        vault.claim(HOLDER, toInterval, toInterval);
        assertGt(HOLDER.balance - before, 0, "the holders of the interval it moved into were not paid");

        // ---- The price of the fix, stated as an assertion. ------------------------------------
        //
        // SLOW held through the whole of interval 0, was owed `slowShare`, and never came for it.
        // Twenty-six epochs later that claim is gone: the weight is still there and the epoch has
        // nothing left to weigh it against. This is a DISPOSSESSION and it is deliberate — the
        // alternative is the money staying unreachable for ever, which is the finding.
        assertGt(vault.weightOf(SLOW, 0), 0, "SLOW never had a weight, so nothing was taken");
        assertFalse(vault.hasClaimed(0, SLOW), "SLOW claimed after all");
        vm.expectRevert(RewardVault.NothingToClaim.selector);
        vault.claim(SLOW, 0, 0);

        // The money was moved forward, not taken away, and SLOW is one of the holders it moved to:
        // it is paid out of the same pot as everybody else who is still here.
        uint256 slowBefore = SLOW.balance;
        vault.claim(SLOW, toInterval, toInterval);
        assertGt(SLOW.balance - slowBefore, 0, "the money went somewhere a current holder cannot reach");
    }

    /**
     * THE OTHER HALF OF THE WINDOW, and the one that decides whether 26 is the right number.
     *
     * A holder who turns up on day 25 of a 26-epoch window is paid in full, at the rate the epoch
     * was funded at, with nothing docked for being late. Nothing about `sweepResidue` touches an
     * epoch before `sweepableFrom`, and this is the test that says so: the sweep is refused at that
     * block, and the claim that follows pays exactly `amount * weight / eligibleSupply`.
     */
    function test_3B_aSlowClaimantInsideTheWindowIsPaidInFull() public {
        (, RewardVault vault,) = _churnedEpochZero();
        uint256 epoch = vault.EPOCH_BLOCKS();
        (, uint256 amount, uint256 es,) = vault.epochs(0);

        // Day 25 of 26 — one whole epoch short of the window.
        vm.roll(vault.snapshotBlockFor(1) + 25 * epoch);
        assertLt(vm.getBlockNumber(), vault.sweepableFrom(0), "the fixture rolled past the window");
        vm.expectRevert(
            abi.encodeWithSelector(RewardVault.ResidueNotMature.selector, uint256(0), vault.sweepableFrom(0))
        );
        vault.sweepResidue(0);

        uint256 owed = (amount * vault.weightOf(SLOW, 0)) / es;
        assertGt(owed, 0, "SLOW is owed nothing, so this proves nothing");
        uint256 before = SLOW.balance;
        uint256 paid = vault.claim(SLOW, 0, 0);
        assertEq(paid, owed, "a late-but-inside-the-window claim was docked");
        assertEq(SLOW.balance - before, owed, "the dividend did not arrive");

        // And the sweep then takes only what is left, which is the unreachable part alone.
        (, uint256 amountAfter,, uint256 claimedAfter) = vault.epochs(0);
        vm.roll(vault.sweepableFrom(0));
        uint256 moved = vault.sweepResidue(0);
        assertEq(moved, amountAfter - claimedAfter, "the sweep took something other than the remainder");
    }

    /**
     * THE THREE REFUSALS, in one place: an epoch that does not exist, an epoch whose window has not
     * passed, and an epoch with nothing in it.
     *
     * The order of the first two is the point. Maturity is checked BEFORE the remainder, so an
     * empty epoch inside its window answers `ResidueNotMature` rather than `NothingToSweep` — a
     * caller cannot use the error to learn whether an epoch is worth sweeping before it is
     * sweepable, and an indexer gets the same answer for every immature epoch regardless of what is
     * in it.
     */
    function test_3B_anEpochThatIsAbsentImmatureOrEmptyCannotBeSwept() public {
        (, RewardVault vault,) = _churnedEpochZero();

        // The fixture stops with epoch 0 open: `createEpochs` refuses to open epoch 1 until ITS
        // closing grid line has passed, which is the property that keeps both of an epoch's
        // weighting checkpoints in the past.
        assertEq(vault.epochCount(), 1, "the fixture opened something other than epoch 0");

        // GENERATION 5: the fixture's single `fund()` of 100 ether no longer lands in one bucket —
        // it is spread forward over `spreadWidth(100 ether)` intervals (7 at this floor), each of
        // them at or above `minEpochAmount`, so none of them carries forward. The first EMPTY
        // interval is therefore the one just past the spread, and that is the epoch this test
        // needs. Under generation 4 `spreadWidth` would be 1 and `empty` would be interval 1, the
        // epoch the test used to name — the property is unchanged, only its address moved.
        uint256 empty = vault.spreadWidth(100 ether);
        vm.roll(vault.snapshotBlockFor(empty + 1) + 1);
        vault.createEpochs(empty);
        assertEq(vault.epochCount(), empty + 1, "the empty epoch did not open");

        // Epochs 0..empty exist; empty+1 does not. Same error `claim` gives for the same mistake.
        vm.expectRevert(RewardVault.BadRange.selector);
        vault.sweepResidue(empty + 1);

        // The epoch is empty AND immature. Maturity answers first.
        (, uint256 amountE,, uint256 claimedE) = vault.epochs(empty);
        assertEq(amountE - claimedE, 0, "the epoch past the spread is not empty, so this proves nothing");
        vm.expectRevert(
            abi.encodeWithSelector(RewardVault.ResidueNotMature.selector, empty, vault.sweepableFrom(empty))
        );
        vault.sweepResidue(empty);

        // Past its window, the emptiness is what is left to refuse on.
        vm.roll(vault.sweepableFrom(empty));
        vm.expectRevert(abi.encodeWithSelector(RewardVault.NothingToSweep.selector, empty));
        vault.sweepResidue(empty);
    }

    /**
     * @dev The 3-B fixture: epoch 0, funded, with one holder who carries a position across the whole
     *      interval and claims (HOLDER), one who carries it and does not (SLOW), and one who
     *      acquires an equal position INSIDE the interval (CHURNER) — the shape of every buyer on a
     *      live market, and the shape that produces the unreachable remainder.
     *
     *      Every block read goes through `vm.getBlockNumber()`; `via_ir = true` folds `block.number`
     *      across a `vm.roll` in the same body.
     */
    function _churnedEpochZero() internal returns (IERC20 token, RewardVault vault, PoolId id) {
        (, token, vault, id) = _rewardsMarket();

        uint256 epoch = vault.EPOCH_BLOCKS();
        uint256 bag = token.balanceOf(BUYER);

        vm.startPrank(BUYER);
        token.transfer(HOLDER, bag / 4);
        token.transfer(SLOW, bag / 4);
        vm.stopPrank();

        // Grid line 0 — epoch 0's opening checkpoint.
        vm.roll(vault.snapshotBlockFor(0) + 1);
        _creditSink(id, 100 ether);
        vault.fund();

        // Mid-interval: the churn.
        vm.roll(vm.getBlockNumber() + epoch / 2);
        vm.prank(BUYER);
        token.transfer(CHURNER, bag / 4);

        // Past grid line 1 — epoch 0's closing checkpoint — and open it.
        vm.roll(vault.snapshotBlockFor(1) + 1);
        vault.createEpochs(2);
    }
}
