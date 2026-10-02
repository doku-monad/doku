// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {PosmTestSetup} from "@uniswap/v4-periphery/test/shared/PosmTestSetup.sol";
import {PoolDonateTest} from "@uniswap/v4-core/src/test/PoolDonateTest.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Pausable} from "openzeppelin/utils/Pausable.sol";
import {DeployDoku} from "../../script/DeployDoku.s.sol";
import {DokuFactory} from "../../src/DokuFactory.sol";
import {DokuGraduation} from "../../src/DokuGraduation.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {CreatorSink} from "../../src/sinks/CreatorSink.sol";
import {RewardVault} from "../../src/sinks/RewardVault.sol";
import {SeedLocker} from "../../src/SeedLocker.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";
import {Sinks} from "../../src/lib/Sinks.sol";
import {Launches} from "../helpers/Launches.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

// Compiled only so `vm.getCode` can find them; see DeployDoku.t.sol.
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {PositionDescriptor} from "@uniswap/v4-periphery/src/PositionDescriptor.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/**
 * ROUND 2, part B — the activation state machine (item 3), and every native payer into the two
 * gated `receive()`s (item 5), against the real deployment script rather than a mocked graph.
 */
contract Round2HuntB is PosmTestSetup {
    using Launches for DokuFactory;

    address internal constant OWNER = address(0x0BEE);
    address internal constant PAUSER = address(0xBA5E);
    address internal constant FEE_RECIPIENT = address(0xFEE);
    address internal constant TREASURY = address(0x7EA);
    address internal constant CREATOR = address(0xC12A);
    address internal constant BUYER = address(0xB0B);
    uint256 internal constant TARGET = 1_000e18;
    uint256 internal constant USDC_TARGET = 10_000e6;

    DeployDoku internal script;
    DeployDoku.Deployment internal d;
    MockUSDC internal usdc;
    PoolSwapTest internal swapper;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployPosm(manager);
        script = new DeployDoku();
        d = script.runWith(_config());
        swapper = new PoolSwapTest(manager);
        // `DeployDoku` uses `Ownable2Step`, so the script only OFFERS ownership to `cfg.owner`.
        // Every `vm.prank(OWNER)` below is an owner call, so the offer has to be accepted first.
        vm.startPrank(OWNER);
        DokuFactory(d.dokuFactory).acceptOwnership();
        DokuHook(payable(d.hook)).acceptOwnership();
        vm.stopPrank();
        vm.deal(CREATOR, 500_000e18);
        vm.deal(BUYER, 5_000_000e18);
        vm.deal(address(this), 500_000e18);
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
        cfg.launchFeeWei = 0.01 ether;
    }

    function _deps() internal view returns (DokuFactory.Dependencies memory dep) {
        DokuGraduation g = DokuGraduation(payable(d.graduation));
        dep = DokuFactory.Dependencies({
            graduator: d.graduation,
            hook: d.hook,
            creatorSink: d.creatorSink,
            poolManager: address(g.poolManager()),
            positionManager: address(g.positionManager()),
            permit2: address(g.permit2())
        });
    }

    function _canLaunch() internal returns (bool ok) {
        DokuFactory factory = DokuFactory(d.dokuFactory);
        DokuFactory.LaunchParams memory p = factory.native(Sinks.BURN);
        uint256 fee = factory.launchFee(CREATOR);
        vm.prank(CREATOR);
        try factory.launch{value: fee}(p) returns (address, address) {
            return true;
        } catch {
            return false;
        }
    }

    // ================================================== ITEM 3: the activation state machine
    //
    // Round 1 made `activate` unpause ONLY on the transition into an activated state
    // (`bool opening = !activated`). The brief's question is whether that leaves the factory
    // permanently unlaunchable, or launchable when it should not be, anywhere in the reachable
    // state space. The state is exactly (`activated`, `paused()`), and this walks all of it.

    function test_item3_theWalkTheBriefNames() public {
        DokuFactory f = DokuFactory(d.dokuFactory);

        // The script already activated. (activated, paused) == (true, false).
        assertTrue(f.activated(), "the script did not activate");
        assertFalse(f.paused(), "the script left the factory paused");
        assertTrue(_canLaunch(), "1. activated: cannot launch");

        // pause
        vm.prank(PAUSER);
        f.pause();
        assertFalse(_canLaunch(), "2. paused: launched anyway");

        // activate -- must NOT reopen what the pauser shut. This is the round-1 fix.
        DokuFactory.Dependencies memory same = _deps();
        vm.prank(OWNER);
        f.activate(same);
        assertTrue(f.paused(), "3. activate reopened a factory the pauser shut");
        assertFalse(_canLaunch(), "3. launched while paused");

        // unpause -- the owner's own key, always available, so nothing is permanently shut.
        vm.prank(OWNER);
        f.unpause();
        assertTrue(_canLaunch(), "4. unpause did not reopen an activated factory");

        // setGraduator -- deactivates AND pauses.
        DokuGraduation g2 = new DokuGraduation(
            address(manager), address(lpm), address(permit2), d.hook, d.dokuFactory
        );
        vm.prank(OWNER);
        f.setGraduator(address(g2));
        assertFalse(f.activated(), "5. setGraduator left the factory activated");
        assertTrue(f.paused(), "5. setGraduator left the factory unpaused");
        assertEq(f.dependencyHash(), bytes32(0), "5. the dependency hash survived");
        assertFalse(_canLaunch(), "5. launched into an unverified graph");

        // activate onto the new graph -- this IS a first activation again, so it opens.
        vm.prank(OWNER);
        DokuHook(payable(d.hook)).setGraduator(address(g2), true);
        // Hoisted: `_newDeps` makes view calls and would otherwise consume the cheatcodes below.
        DokuFactory.Dependencies memory nd = _newDeps(address(g2));
        vm.prank(OWNER);
        vm.expectRevert(); // the shared sink's one-shot graduator still names the OLD graduator
        f.activate(nd);
        assertFalse(f.activated(), "6. a graph with a mis-wired sink activated anyway");
        assertTrue(f.paused(), "6. a refused activation unpaused");
    }

    function _newDeps(address grad) internal view returns (DokuFactory.Dependencies memory dep) {
        DokuGraduation g = DokuGraduation(payable(grad));
        dep = DokuFactory.Dependencies({
            graduator: grad,
            hook: d.hook,
            creatorSink: d.creatorSink,
            poolManager: address(g.poolManager()),
            positionManager: address(g.positionManager()),
            permit2: address(g.permit2())
        });
    }

    /// @notice The other half: "activated but permanently unlaunchable". `unpause()` is `onlyOwner`
    ///         and unconditional, so the only way to reach one is to renounce ownership — an owner
    ///         action, demoted by the rules of this round, and recorded here so the claim is
    ///         bounded rather than asserted.
    function test_item3_theOnlyPermanentlyShutStateNeedsTheOwnerToRenounce() public {
        DokuFactory f = DokuFactory(d.dokuFactory);
        vm.prank(PAUSER);
        f.pause();
        // Still recoverable while there is an owner.
        vm.prank(OWNER);
        f.unpause();
        assertTrue(_canLaunch(), "recoverable state was not recoverable");
    }

    /// @notice `activate` cannot be used to open a factory onto a graph it did not verify: the only
    ///         declaration `_validateDeployment` accepts is the one the live graph already agrees
    ///         with, so "re-activate onto something else" is not a move.
    function test_item3_activateCannotDeclareAGraphTheLiveOneDisagreesWith() public {
        DokuFactory f = DokuFactory(d.dokuFactory);
        DokuFactory.Dependencies memory bad = _deps();
        bad.poolManager = address(lpm); // a real contract, wrong role
        vm.prank(OWNER);
        vm.expectRevert();
        f.activate(bad);

        DokuFactory.Dependencies memory bad2 = _deps();
        bad2.creatorSink = address(this);
        vm.prank(OWNER);
        vm.expectRevert();
        f.activate(bad2);
    }

    // ============================================ ITEM 5: the two gated `receive()`s, end to end
    //
    // Round 1 gated `RewardVault.receive` and `CreatorSink.receive` to the hook. The risk is not
    // that the gate is wrong but that some LEGITIMATE native inflow goes through `receive` rather
    // than through a payable function, and now bounces. There are only three native payers into a
    // sink in the whole tree -- `DokuHook.pullSink`, `DokuHook.pullTax` and
    // `BondingCurve._payOrCredit`'s `credit{value:}` -- and the first two are the hook itself while
    // the third is a payable function. This exercises all three on one native market.

    function test_item5_aNativeRewardsMarketPaysOutEndToEndThroughTheGate() public {
        DokuFactory factory = DokuFactory(d.dokuFactory);
        DokuFactory.LaunchParams memory p = factory.params(address(0), Sinks.REWARDS, 100);
        p.taxRecipient = CREATOR;
        uint256 fee = factory.launchFee(CREATOR);
        vm.prank(CREATOR);
        (address curveAddr, address token) = factory.launch{value: fee}(p);

        BondingCurve c = BondingCurve(payable(curveAddr));
        vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);
        vm.prank(BUYER);
        c.buy{value: 5 * TARGET}(0, vm.getBlockTimestamp() + 1 hours);
        assertTrue(DokuGraduation(payable(d.graduation)).graduated(curveAddr), "did not graduate");

        RewardVault vault = RewardVault(payable(DokuGraduation(payable(d.graduation)).sinkOf(curveAddr)));

        // (a) BondingCurve.collectFees on a graduated REWARDS market -> graduator -> hook ledger.
        c.collectFees();
        // (b) BondingCurve.collectTax -> _payOrCredit -> a push to CREATOR, which succeeds.
        c.collectTax();
        // (c) SeedLocker.collect -> hook.creditCurveTax, after real trading.
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: DokuGraduation(payable(d.graduation)).LP_FEE(),
            tickSpacing: DokuGraduation(payable(d.graduation)).TICK_SPACING(),
            hooks: IHooks(d.hook)
        });
        for (uint256 i; i < 4; ++i) {
            _swap(key, true, 50 ether);
            _swap(key, false, IERC20(token).balanceOf(address(this)) / 2);
        }
        PoolId id = PoolIdLibrary.toId(key);
        DokuHook(payable(d.hook)).sweep(id);
        SeedLocker(payable(d.seedLocker)).collect(_tokenIdOf(address(vault)));

        // (d) the vault pulls from the hook. THIS is the call that lands in `receive()`.
        uint256 funded = vault.fund();
        assertGt(funded, 0, "the gated receive() blocked the hook's own payment to the vault");
        assertEq(address(vault).balance, funded, "the vault did not end up holding it");

        // (e) and a bare send from anybody else bounces rather than burning.
        vm.deal(address(0xBADBAD), 1 ether);
        vm.prank(address(0xBADBAD));
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertFalse(ok, "a stranger's MON was accepted and would have been unclaimable");
    }

    /// @notice The `CreatorSink` half: the hook pays it on `pull`, and a curve pays it through the
    ///         payable `credit`, and neither goes through `receive`.
    function test_item5_theCreatorSinkIsPaidByBothItsLegitimateRoutes() public {
        DokuFactory factory = DokuFactory(d.dokuFactory);
        DokuFactory.LaunchParams memory p = factory.params(address(0), Sinks.CREATOR, 100);
        // A recipient that cannot receive MON, so `_payOrCredit` takes the DEFERRED arm and the
        // curve pays the shared sink through `credit{value:}`.
        p.routedRecipient = address(new Deaf());
        p.taxRecipient = p.routedRecipient;
        uint256 fee = factory.launchFee(CREATOR);
        vm.prank(CREATOR);
        (address curveAddr,) = factory.launch{value: fee}(p);

        BondingCurve c = BondingCurve(payable(curveAddr));
        vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);
        vm.prank(BUYER);
        c.buy{value: 5 * TARGET}(0, vm.getBlockTimestamp() + 1 hours);

        uint256 sinkBefore = d.creatorSink.balance;
        c.collectFees();
        c.collectTax();
        assertGt(d.creatorSink.balance - sinkBefore, 0, "credit{value:} was blocked by the receive gate");

        // And the pull route, which is the hook paying the sink directly.
        CreatorSink(payable(d.creatorSink)).pull(curveAddr);

        // A bare send from anybody else still bounces.
        vm.deal(address(0xBADBAD), 1 ether);
        vm.prank(address(0xBADBAD));
        (bool ok,) = d.creatorSink.call{value: 1 ether}("");
        assertFalse(ok, "a stranger's MON was accepted into the shared sink");
    }

    // ====================================================== ITEM 6: is there a fourth door?
    //
    // `claimable[address(this)][quote]` is the dead end. There are exactly four writers of a
    // recipient or a claim in `CreatorSink`, and round 1 closed the third. This enumerates all
    // four against the live sink.

    function test_item6_everyWriterOfARecipientRefusesTheSink() public {
        CreatorSink sink = CreatorSink(payable(d.creatorSink));

        // 1. register -- graduator only, refuses both legs.
        vm.prank(d.graduation);
        vm.expectRevert(CreatorSink.SinkIsNotARecipient.selector);
        sink.register(address(0xF00D), PoolId.wrap(bytes32(uint256(1))), address(0), address(sink), address(0xA1));
        vm.prank(d.graduation);
        vm.expectRevert(CreatorSink.SinkIsNotARecipient.selector);
        sink.register(address(0xF00D), PoolId.wrap(bytes32(uint256(1))), address(0), address(0xA1), address(sink));

        // 2. credit -- markets only, refuses `who == address(this)`.
        DokuFactory factory = DokuFactory(d.dokuFactory);
        DokuFactory.LaunchParams memory p = factory.params(address(0), Sinks.CREATOR, 100);
        p.routedRecipient = address(0xA11CE);
        p.taxRecipient = address(0xA11CE);
        uint256 fee = factory.launchFee(CREATOR);
        vm.prank(CREATOR);
        (address curveAddr,) = factory.launch{value: fee}(p);
        vm.deal(curveAddr, 1 ether);
        vm.prank(curveAddr);
        vm.expectRevert(CreatorSink.SinkIsNotARecipient.selector);
        sink.credit{value: 1}(address(sink), address(0), 1);

        // 3. transferRecipient -- the routed recipient, refused since round 1.
        BondingCurve c = BondingCurve(payable(curveAddr));
        vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);
        vm.prank(BUYER);
        c.buy{value: 5 * TARGET}(0, vm.getBlockTimestamp() + 1 hours);
        vm.prank(address(0xA11CE));
        vm.expectRevert(CreatorSink.SinkIsNotARecipient.selector);
        sink.transferRecipient(curveAddr, address(sink));

        // 4. pull -- writes no recipient at all; it only reads `e.routed`/`e.tax`, both of which the
        //    three doors above are the sole writers of. Asserted by the ledger staying empty after
        //    a real pull.
        sink.pull(curveAddr);
        assertEq(sink.claimable(address(sink), address(0)), 0, "the sink booked a claim to itself");

        // 5. and the launch-time guard, which is what keeps door 1 from ever being reached.
        DokuFactory.LaunchParams memory q = factory.params(address(0), Sinks.BURN, 100);
        q.taxRecipient = address(sink);
        vm.prank(CREATOR);
        vm.expectRevert(DokuFactory.RecipientNotAllowed.selector);
        factory.launch{value: fee}(q);
    }


    // ============================== ITEM 5, the comment rather than the code: the dilution claim
    //
    // `claimTo` refuses `recipient == address(this)` and gives the reason as: "Paying the vault
    // burns the dividend: `receive()` does not credit it to any epoch, and it would then dilute
    // every later holder through `eligibleSupply`."
    //
    // The first half is right. The second is not, and it is the constructor's reasoning about
    // TOKENS borrowed for a payment made in the QUOTE. `eligibleSupplyAt` is
    // `token.getPastTotalSupply(b)` minus the excluded addresses' TOKEN balances at `b` — it never
    // reads a quote balance, so quote sitting in the vault cannot move it by any amount. (And the
    // token door is closed twice over: the vault is `_excluded[7]`.)
    //
    // The GUARD is still correct — a claim spent on a destination that cannot re-enter any epoch is
    // a burn — so this is a comment finding, in the same class as round 1's `unlockCallback` note.
    // It matters because the next reader to touch the exclusion set will be told the two are linked.
    function test_item5_quoteParkedInTheVaultCannotDiluteAnybody() public {
        DokuFactory factory = DokuFactory(d.dokuFactory);
        DokuFactory.LaunchParams memory p = factory.params(address(0), Sinks.REWARDS, 0);
        uint256 fee = factory.launchFee(CREATOR);
        vm.prank(CREATOR);
        (address curveAddr,) = factory.launch{value: fee}(p);
        BondingCurve c = BondingCurve(payable(curveAddr));
        vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);
        vm.prank(BUYER);
        c.buy{value: 5 * TARGET}(0, vm.getBlockTimestamp() + 1 hours);
        RewardVault vault = RewardVault(payable(DokuGraduation(payable(d.graduation)).sinkOf(curveAddr)));

        uint256 b = vm.getBlockNumber();
        vm.roll(b + 1);
        uint256 esBefore = vault.eligibleSupplyAt(b);
        assertGt(esBefore, 0, "no eligible supply to dilute; the test would be vacuous");

        // An arbitrary QUOTE balance appears in the vault, by any means at all.
        vm.deal(address(vault), address(vault).balance + 10_000 ether);
        assertEq(vault.eligibleSupplyAt(b), esBefore, "a quote balance moved eligibleSupply");

        // (The guard `claimTo` justifies with this claim is exercised on an ERC-20 vault below,
        // where it is the only thing holding the door -- see
        // `test_item5_theClaimToSelfGuardIsWhatStopsAnErc20Vault_notTheReceiveGate`.)
    }

    // ================ ITEM 4, the premise: "`receive()` cannot be gated" on the SeedLocker
    //
    // Round 1 leaves a resting balance in the locker permanently unreachable, and gives two reasons
    // it is "a thing that happens": the BURN branch, and an ungateable `receive()`. The second is
    // stated as impossible — "`TAKE_PAIR` is a native `call` from the PoolManager, so this cannot be
    // gated on a sender the way `CreatorSink.receive` is."
    //
    // It cannot be gated on the HOOK. It CAN be gated on the PoolManager, which is the only address
    // that ever pays it: `collect`'s action list is DECREASE_LIQUIDITY + TAKE_PAIR and sends no
    // value, so POSM never refunds and never sweeps to the locker. This asserts the payer.
    function test_item4_thePoolManagerIsTheOnlyNativePayerIntoTheLocker() public {
        DokuFactory factory = DokuFactory(d.dokuFactory);
        DokuFactory.LaunchParams memory p = factory.params(address(0), Sinks.REWARDS, 0);
        uint256 fee = factory.launchFee(CREATOR);
        vm.prank(CREATOR);
        (address curveAddr, address token) = factory.launch{value: fee}(p);
        BondingCurve c = BondingCurve(payable(curveAddr));
        vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);
        vm.prank(BUYER);
        c.buy{value: 5 * TARGET}(0, vm.getBlockTimestamp() + 1 hours);

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: DokuGraduation(payable(d.graduation)).LP_FEE(),
            tickSpacing: DokuGraduation(payable(d.graduation)).TICK_SPACING(),
            hooks: IHooks(d.hook)
        });
        for (uint256 i; i < 4; ++i) {
            _swap(key, true, 50 ether);
            _swap(key, false, IERC20(token).balanceOf(address(this)) / 2);
        }

        uint256 tokenId = _tokenIdOf(DokuGraduation(payable(d.graduation)).sinkOf(curveAddr));

        // Since the M-04 decision (2026-09-11) swaps no longer put anything on the seed position —
        // the LP share is booked to `pendingSink` and `poolManager.donate` is gone from `src/`. So
        // the swaps above give `collect` nothing to move and this test would be vacuous. Put fees on
        // the seed the one way that is still possible for anyone: a direct `PoolManager.donate`,
        // which is permissionless v4 and exactly the stranger-funded case the `receive` gate is for.
        PoolDonateTest donor = new PoolDonateTest(IPoolManager(address(manager)));
        vm.deal(address(this), 10 ether);
        donor.donate{value: 3 ether}(key, 3 ether, 0, "");

        uint256 pmBefore = address(manager).balance;
        uint256 posmBefore = address(lpm).balance;
        uint256 lockBefore = d.seedLocker.balance;
        uint256 hookBefore = d.hook.balance;

        SeedLocker(payable(d.seedLocker)).collect(tokenId);

        uint256 moved = (d.seedLocker.balance - lockBefore) + (d.hook.balance - hookBefore);
        assertGt(moved, 0, "the collect moved no MON at all; the test would be vacuous");
        assertEq(pmBefore - address(manager).balance, moved, "the PoolManager was not the sole payer");
        assertEq(address(lpm).balance, posmBefore, "POSM paid the locker; a PoolManager gate would break");
    }


    // ========== THE MISSING HUNT TEST FOR ROUND 1'S HIGH: what a revert inside `register` COSTS
    //
    // Reverting `DokuFactory._recipients`'s guard turns exactly three tests red, and all three
    // assert only that the LAUNCH was refused. Nothing in the tree demonstrates the loss the guard
    // exists to prevent, and the paired-test convention cannot supply it: the frozen generation-3
    // sink has no `register` guard at all, so the gen-3 hunt shows the CREATOR losing their own
    // fees, which is the cheap version of this input rather than the expensive one. The expensive
    // version was created by round 0's own fix and lives only in `src/`.
    //
    // So it is proved here, structurally: ANY revert inside `CreatorSink.register` seals the whole
    // raise, because `_register` is a step of `graduate()` and `graduate()` runs behind
    // `BondingCurve._tryAutoGraduate`'s swallowing raw call. The revert is injected with
    // `mockCallRevert` rather than by naming the sink, so the test states the property — "a
    // reverting `register` costs the raise" — rather than one input that used to reach it.
    function test_theCostOfAnyRevertInsideRegister_theRaiseIsSealed() public {
        DokuFactory factory = DokuFactory(d.dokuFactory);
        DokuFactory.LaunchParams memory p = factory.params(address(0), Sinks.BURN, 100);
        p.taxRecipient = address(0xDEFA17);
        uint256 fee = factory.launchFee(CREATOR);
        vm.prank(CREATOR);
        (address curveAddr,) = factory.launch{value: fee}(p);
        BondingCurve c = BondingCurve(payable(curveAddr));

        // Exactly what `taxRecipient == creatorSink` did before round 1 moved the guard forward.
        vm.mockCallRevert(
            d.creatorSink,
            abi.encodeWithSelector(CreatorSink.register.selector),
            abi.encodeWithSelector(CreatorSink.SinkIsNotARecipient.selector)
        );

        vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);
        vm.prank(BUYER);
        c.buy{value: 5 * TARGET}(0, vm.getBlockTimestamp() + 1 hours);

        // The buy SUCCEEDED. The curve filled, latched, and reports nothing wrong.
        assertTrue(c.readyToGraduate(), "the curve did not fill");
        assertFalse(DokuGraduation(payable(d.graduation)).graduated(curveAddr), "it graduated anyway");

        uint256 sealedRaise = curveAddr.balance;
        emit log_named_decimal_uint("MON sealed in the curve, per market", sealedRaise, 18);
        assertGe(sealedRaise, TARGET, "the raise is not in the curve");

        // And there is no way out, from any direction.
        vm.prank(BUYER);
        vm.expectRevert(BondingCurve.CurveClosed.selector);
        c.buy{value: 1 ether}(0, vm.getBlockTimestamp() + 1 hours);

        vm.prank(BUYER);
        vm.expectRevert(BondingCurve.CurveClosed.selector);
        c.sell(1e18, 0, vm.getBlockTimestamp() + 1 hours);

        vm.prank(BUYER);
        vm.expectRevert(BondingCurve.NotGraduator.selector);
        c.release();

        // Retrying graduation reverts for ever -- it is not a transient failure.
        vm.expectRevert(CreatorSink.SinkIsNotARecipient.selector);
        DokuGraduation(payable(d.graduation)).graduate(curveAddr);

        // No owner power reaches it: the graduator is pinned at `initialize` with no setter, so
        // re-pointing the FACTORY changes nothing for a market that already exists.
        assertEq(c.graduator(), d.graduation, "the market's graduator moved");

        // The control: with `register` working, the identical market graduates on the filling buy.
        vm.clearMockedCalls();
        DokuFactory.LaunchParams memory q = factory.params(address(0), Sinks.BURN, 100);
        q.taxRecipient = address(0xDEFA17);
        uint256 fee2 = factory.launchFee(CREATOR);
        vm.prank(CREATOR);
        (address ok,) = factory.launch{value: fee2}(q);
        BondingCurve c2 = BondingCurve(payable(ok));
        vm.warp(vm.getBlockTimestamp() + c2.TAX_WINDOW() + 1);
        vm.prank(BUYER);
        c2.buy{value: 5 * TARGET}(0, vm.getBlockTimestamp() + 1 hours);
        assertTrue(DokuGraduation(payable(d.graduation)).graduated(ok), "the control did not graduate");
    }


    // ===== THE ONE FLIPPED TEST THAT GOES RED FOR THE WRONG REASON: `claimTo`'s self-refusal
    //
    // Reverting `if (recipient == address(this)) revert ZeroAddress();` turns exactly one test red
    // -- `Round1VaultHunt::test_R4_aFrozenHolderCanNameADestinationAndNobodyElseCan` -- and it goes
    // red with `TransferFailed() != ZeroAddress()`. That is not the guard firing. It is the OTHER
    // round-1 fix, the gated `receive()`, bouncing the vault's own native send back at `_pay`.
    //
    // So on a NATIVE vault the guard is redundant and the test cannot tell the two apart. On an
    // ERC-20 vault -- six of the seven registered quote assets -- `_pay` is `safeTransfer`, which
    // succeeds against `address(this)`: the epoch would be marked claimed, the money would sit in
    // the shared balance backing no epoch, and nothing in the tree would have noticed. The guard is
    // load-bearing in exactly the configuration no test exercises.
    //
    // This is that test. It asserts the GUARD's error on a vault whose quote is an ERC-20.
    function test_item5_theClaimToSelfGuardIsWhatStopsAnErc20Vault_notTheReceiveGate() public {
        DokuFactory factory = DokuFactory(d.dokuFactory);
        DokuFactory.LaunchParams memory p = factory.params(address(usdc), Sinks.REWARDS, 0);
        uint256 fee = factory.launchFee(CREATOR);
        vm.prank(CREATOR);
        (address curveAddr,) = factory.launch{value: fee}(p);

        BondingCurve c = BondingCurve(payable(curveAddr));
        usdc.mint(BUYER, 10 * USDC_TARGET);
        vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);
        vm.startPrank(BUYER);
        usdc.approve(curveAddr, type(uint256).max);
        c.buyWithToken(5 * USDC_TARGET, 0, vm.getBlockTimestamp() + 1 hours);
        vm.stopPrank();
        assertTrue(DokuGraduation(payable(d.graduation)).graduated(curveAddr), "the USDC market did not graduate");

        RewardVault vault = RewardVault(payable(DokuGraduation(payable(d.graduation)).sinkOf(curveAddr)));
        assertEq(vault.quote(), address(usdc), "this vault is not ERC-20 quoted; the test would be vacuous");

        // A REAL, claimable dividend, so the guard is refusing something rather than nothing.
        c.collectFees();
        assertGt(vault.fund(), 0, "the vault was never funded");
        vm.roll(vault.snapshotBlockFor(2) + 1);
        vault.createEpochs(2);
        assertGt(vault.weightOf(BUYER, 0), 0, "the buyer has no weight; the test would be vacuous");

        // `_pay` here is `safeTransfer`, which has no opinion about its destination. Without the
        // guard this call SUCCEEDS: epoch 0 is marked claimed for BUYER and the USDC lands back in
        // the vault, backing no epoch and reachable by nobody. The guard is the only thing stopping
        // it -- the gated `receive()` is never reached on an ERC-20 vault.
        vm.prank(BUYER);
        vm.expectRevert(RewardVault.ZeroAddress.selector);
        vault.claimTo(BUYER, 0, 0, address(vault));

        // And the dividend is still there, unspent, which is what "refused" has to mean.
        address fresh = address(0xF3E5);
        vm.prank(BUYER);
        uint256 paid = vault.claimTo(BUYER, 0, 0, fresh);
        assertGt(paid, 0, "there was no dividend to burn; the refusal above proved nothing");
        assertEq(IERC20(address(usdc)).balanceOf(fresh), paid, "the dividend did not reach the destination");
    }

    function _tokenIdOf(address wantSink) internal view returns (uint256) {
        for (uint256 id = 1; id < 40; ++id) {
            (, address s,,) = SeedLocker(payable(d.seedLocker)).positionOf(id);
            if (s == wantSink) return id;
        }
        revert("no position");
    }

    function _swap(PoolKey memory key, bool zeroForOne, uint256 amountIn) internal {
        if (amountIn == 0) return;
        if (!zeroForOne) {
            IERC20(Currency.unwrap(key.currency1)).approve(address(swapper), amountIn);
        }
        swapper.swap{value: zeroForOne ? amountIn : 0}(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }
}

/// @dev A recipient that cannot receive MON, so `_payOrCredit` takes its deferred arm.
contract Deaf {
    receive() external payable {
        revert("deaf");
    }
}
