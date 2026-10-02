// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {RewardVaultGen3 as RewardVault} from "./RewardVaultGen3.sol";

/// @dev Stands in for DokuHook's `owedSink` ledger: holds native quote and hands it to the
///      market's sink when the sink asks. Shape-identical to what `RewardVault.fund` needs.
contract Ledger {
    uint256 public owed;

    function credit() external payable {
        owed += msg.value;
    }

    function pullSink(PoolId) external returns (uint256 amount) {
        amount = owed;
        owed = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "pull");
    }

    receive() external payable {}
}

/// @title RewardVaultFindings
/// @notice Adjudicates the three findings the 2026-09-11 external review raised against
///         `src/sinks/RewardVault.sol` — M-01 (delayed epochs pay future fees to former holders),
///         L-02 (a quote target under 10,000 raw units floors `minEpochAmount` at zero) and I-02
///         (the comments claim a continuing-holder rule the code does not implement).
///
/// @dev Every one of these runs against `RewardVaultGen3.sol` — the frozen copy of the shape
///      these findings were raised against — NOT against `src/`. `src/` has since been fixed, and
///      `RewardVaultFix.t.sol` is the other half of this pair: the same scenarios, against the
///      fixed contract, asserting they no longer work.
///
/// @dev EVERY block read in here goes through `vm.getBlockNumber()`. `foundry.toml` has
///      `via_ir = true`, and the IR pipeline constant-folds `block.number` across a `vm.roll`
///      inside the same function body — a test written the obvious way passes for the wrong
///      reason and reports a lag of zero. That is a repo-specific trap, not a style preference.
contract RewardVaultFindingsTest is Test {
    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint256 internal constant SEED = 222_222_222e18; // the PoolManager's locked graduation seed
    uint256 internal constant FLOAT = SUPPLY - SEED;

    address internal constant PM = address(0x9001); // "PoolManager"  (excluded)
    address internal constant CURVE = address(0xC0FFEE); //             (excluded)
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address internal constant POSM = address(0x9002);
    address internal constant GRAD = address(0x9003);

    /// @dev The exiting whale of M-01, the holder who stays, and the holder set that arrives after.
    address internal EXITER = address(0xE1);
    address internal STAYER = address(0x57A1);
    address internal NEWCOMER = address(0x8E6);

    /// @dev The registry's real figures, so the reachability claims below are about production
    ///      numbers rather than about a number chosen to make a point. MON is the largest target
    ///      and XAUt0 the smallest; if L-02 is unreachable at XAUt0 it is unreachable everywhere.
    uint256 internal constant MON_TARGET = 305_868_390_948_742_537_150_460;
    uint256 internal constant XAUT0_TARGET = 1_809_590;

    Ledger internal hook;
    DokuToken internal token;
    RewardVault internal vault;
    uint256 internal genesis;

    receive() external payable {}

    function setUp() public {
        vm.roll(1_000_000);
        hook = new Ledger();

        address impl = address(new DokuToken());
        token = DokuToken(Clones.clone(impl));
        // A REWARDS market tracks balance history; the whole supply is minted to the curve.
        token.initialize("Doku", "DOKU", CURVE, true, "https://cdn.doku.family/metadata/test.json");

        genesis = vm.getBlockNumber(); // == BondingCurve.readyAtBlock

        vault = _mkVault(MON_TARGET);

        // Graduation: the seed goes to the pool, the float is in holders' hands.
        vm.startPrank(CURVE);
        token.transfer(PM, SEED);
        token.transfer(EXITER, 400_000_000e18);
        token.transfer(STAYER, 200_000_000e18);
        token.transfer(NEWCOMER, FLOAT - 600_000_000e18);
        vm.stopPrank();
        assertEq(token.balanceOf(CURVE), 0);

        vm.roll(vm.getBlockNumber() + 1);
    }

    function _mkVault(uint256 quoteTarget) internal returns (RewardVault v) {
        address[8] memory ex;
        ex[0] = PM;
        ex[1] = address(hook);
        ex[2] = CURVE;
        ex[3] = address(token);
        ex[4] = DEAD;
        ex[5] = GRAD;
        ex[6] = POSM;
        v = new RewardVault(
            address(hook), address(token), PoolId.wrap(bytes32(uint256(7))), address(0), quoteTarget, genesis, ex
        );
    }

    function _fund(RewardVault v, uint256 amount) internal {
        vm.deal(address(this), address(this).balance + amount);
        hook.credit{value: amount}();
        v.fund();
    }

    function _tryClaim(address who, uint256 k) internal returns (uint256) {
        try vault.claim(who, k, k) returns (uint256 got) {
            return got;
        } catch {
            return 0;
        }
    }

    // ================================================================= M-01

    /// @notice M-01, CONFIRMED. A holder who left at grid line 1 is paid out of fees that were
    ///         generated entirely after it left, because `createEpoch` hands the whole global
    ///         `unallocated` bucket to whichever epoch index happens to be next in line.
    ///
    /// @dev The sequence is exactly the reviewer's, and nothing in it is privileged: every call
    ///      here is permissionless and every actor is an ordinary address.
    ///
    ///      What makes it money rather than a mis-labelled log is the pairing of two facts that
    ///      live in different functions. `createEpoch` (L212-226) reads `index = epochs.length`
    ///      and `amount = unallocated` — an index that tracks how many epochs have been OPENED and
    ///      an amount that tracks everything the vault has ever been handed and not yet spent, with
    ///      no relation between them. `weightOf` (L266-286) reads that index's two grid lines and
    ///      nothing else. So the pot is "all fees to date" and the divisor is "the holder set of
    ///      whenever the grid happens to be", and the gap between those two is the theft.
    function test_M01_exitedHolderIsPaidFromFeesEarnedAfterItLeft() public {
        // 1. EXITER holds across grid lines 0 and 1 — the two checkpoints epoch 0 weighs — and
        //    then sells the entire position. It is now, and stays, a zero-balance address.
        vm.roll(vault.snapshotBlockFor(1) + 1);
        vm.prank(EXITER);
        token.transfer(NEWCOMER, 400_000_000e18);
        assertEq(token.balanceOf(EXITER), 0, "EXITER still holds");

        // 2. Twenty epochs of trading. Every wei of this levy is earned by a market EXITER has
        //    no position in. Nobody calls createEpoch, which is the ordinary case: there is no
        //    keeper for it anywhere in src/, indexer/ or the frontend.
        uint256 earnedAfterExit;
        for (uint256 i = 2; i <= 21; ++i) {
            vm.roll(vault.snapshotBlockFor(i) + 1);
            _fund(vault, 1_000 ether);
            earnedAfterExit += 1_000 ether;
        }

        // 3. EXITER opens the stale epoch itself and claims against its old balance.
        vm.startPrank(EXITER);
        uint256 k = vault.createEpoch();
        uint256 got = vault.claim(EXITER, k, k);
        vm.stopPrank();

        (uint256 snap, uint256 amount, uint256 es,) = vault.epochs(k);
        console2.log("epoch index opened          ", k);
        console2.log("its snapshot block          ", snap);
        console2.log("current block               ", vm.getBlockNumber());
        console2.log("blocks of lag               ", vm.getBlockNumber() - snap);
        console2.log("quote funded after EXITER left", earnedAfterExit);
        console2.log("epoch amount (the whole bucket)", amount);
        console2.log("eligibleSupply at that snapshot", es);
        console2.log("EXITER token balance now    ", token.balanceOf(EXITER));
        console2.log("EXITER was PAID             ", got);

        assertEq(k, 0, "the epoch opened was not the ancient one");
        assertEq(amount, earnedAfterExit, "the whole post-exit backlog landed in epoch 0");
        assertEq(token.balanceOf(EXITER), 0, "EXITER holds tokens after all");
        assertGt(got, 500 ether, "EXITER extracted nothing");
        assertEq(EXITER.balance, got, "the quote did not actually leave the vault");

        // NEWCOMER bought EXITER's bag at grid line 1 and carried it through all twenty epochs
        // that generated this money. It is weighed at the two ANCIENT grid lines, so it is paid
        // only for the position it already had — nothing for the bag it bought.
        uint256 newcomerGot = _tryClaim(NEWCOMER, k);
        console2.log("NEWCOMER token balance now  ", token.balanceOf(NEWCOMER));
        console2.log("NEWCOMER was paid           ", newcomerGot);
        assertLt(newcomerGot, got, "NEWCOMER out-earned the exited whale after all");
    }

    /// @notice M-01, the part the review understates: the lag is not a one-off, it RATCHETS.
    ///
    /// @dev Once the grid is behind, it can never catch up. `createEpoch` drains `unallocated` to
    ///      zero, so the next index immediately reverts `NotEnoughToDistribute` and waits for the
    ///      next batch of fees — while real blocks keep passing. The epoch index therefore advances
    ///      at most once per funding batch and the grid line it points at falls further behind
    ///      every time. Every future fee this market ever earns is attributed to a snapshot pair
    ///      from the distant past, permanently, with no admin lever and no upgrade path.
    function test_M01_theGridLagIsPermanentAndGrows() public {
        uint256[] memory lag = new uint256[](6);
        for (uint256 n; n < 6; ++n) {
            // Ten grid lines' worth of real time passes between each funding batch, which is
            // simply what "fees arrive slower than the grid" looks like.
            vm.roll(vault.snapshotBlockFor(10 * (n + 1)) + 1);
            _fund(vault, 100 ether);
            uint256 k = vault.createEpoch();
            (uint256 snap,,,) = vault.epochs(k);
            lag[n] = vm.getBlockNumber() - snap;
            console2.log("batch", n);
            console2.log("  opened epoch index", k);
            console2.log("  its snapshot is behind by (blocks)", lag[n]);
        }
        for (uint256 n = 1; n < 6; ++n) {
            assertGt(lag[n], lag[n - 1], "the lag did not grow");
        }
        assertGt(lag[5], 40 * vault.EPOCH_BLOCKS(), "expected the grid to be tens of epochs behind");
    }

    // ================================================================= L-02

    /// @notice L-02, CONFIRMED IN SOURCE. `minEpochAmount = quoteTarget_ / 10_000` is integer
    ///         division, so any target under 10,000 raw units floors it at zero, and
    ///         `if (amount < minEpochAmount)` with both sides zero is FALSE — the guard admits an
    ///         epoch worth nothing, which permanently consumes a snapshot index.
    function test_L02_zeroTargetAdmitsAZeroValueEpoch() public {
        RewardVault tiny = _mkVault(9_999); // one raw unit under the threshold
        assertEq(tiny.minEpochAmount(), 0, "floor was not zero");

        vm.roll(tiny.snapshotBlockFor(0) + 1);
        assertEq(tiny.unallocated(), 0, "something was already unallocated");

        vm.prank(address(0xBAD)); // a stranger with no position in this market
        uint256 k = tiny.createEpoch();

        (, uint256 amount,,) = tiny.epochs(k);
        assertEq(k, 0);
        assertEq(amount, 0, "the epoch was not empty");
        assertEq(tiny.epochCount(), 1, "index 0 was not consumed");
    }

    /// @notice L-02's griefing shape: with the floor at zero, a stranger who wins the race to
    ///         `createEpoch` at every grid line pushes the market's whole reward stream a full
    ///         epoch further out, forever, at the cost of one transaction per epoch.
    function test_L02_emptyEpochsPushRealRewardsOutByAWholeEpochEach() public {
        RewardVault tiny = _mkVault(9_999);

        // The griefer opens five grid lines' worth of nothing.
        for (uint256 i; i < 5; ++i) {
            vm.roll(tiny.snapshotBlockFor(i) + 1);
            vm.prank(address(0xBAD));
            tiny.createEpoch();
        }
        assertEq(tiny.epochCount(), 5);

        // Real fees now arrive. They can only land in index 5, whose snapshot is grid line 5 —
        // and whose maturity is grid line 6, five whole epochs later than the money's own.
        vm.roll(tiny.snapshotBlockFor(5) + 1);
        _fund(tiny, 100 ether);
        uint256 k = tiny.createEpoch();
        assertEq(k, 5);
        (uint256 snap,,,) = tiny.epochs(k);
        assertEq(snap, tiny.snapshotBlockFor(5));

        vm.expectRevert(
            abi.encodeWithSelector(RewardVault.NotMatured.selector, k, tiny.snapshotBlockFor(6) + 1)
        );
        tiny.claim(STAYER, k, k);
    }

    /// @notice L-02, NOT REACHABLE ON THE LIVE REGISTRY. Every quote target `QuoteRegistry`
    ///         currently holds is orders of magnitude above the 10,000-raw-unit threshold — the
    ///         smallest, XAUt0's 1,809,590, still floors at 180 raw units. The finding is real
    ///         source code and unreachable production, and it stays that way only for as long as
    ///         nobody registers a low-decimal asset.
    function test_L02_everyRegisteredQuoteTargetClearsTheThreshold() public {
        uint256[7] memory targets = [
            MON_TARGET, // MON, 18dp
            uint256(8_000_000_000), // USDC, 6dp
            uint256(8_000_000_000), // USDT0, 6dp
            uint256(3_230_717_663_544_986_110), // WETH, 18dp
            uint256(10_170_090), // WBTC, 8dp
            uint256(10_170_090), // cbBTC, 8dp
            XAUT0_TARGET // XAUt0, 6dp — the smallest registered target
        ];
        for (uint256 i; i < targets.length; ++i) {
            assertGe(targets[i], 10_000, "a registered target is under the threshold");
            assertGt(_mkVault(targets[i]).minEpochAmount(), 0, "a live vault would floor at zero");
        }
        assertEq(_mkVault(XAUT0_TARGET).minEpochAmount(), 180, "XAUt0's floor moved");
    }

    // ================================================================= I-02

    /// @notice I-02, CONFIRMED, and it is in three places rather than the two the review cites.
    ///         `weightOf` reads two HISTORICAL checkpoints and never calls `balanceOf`. A claimant
    ///         holding literally zero at claim time is paid in full.
    ///
    /// @dev The contract's own words, against this test's result:
    ///        L49-52  "Weight is `min(pastBalance, currentBalance)` ... Requiring the claimant to
    ///                 still hold costs one `balanceOf` and removes it."
    ///        L309-310 "the holder must ALSO still hold when they claim"
    ///      and `ICheckpointedToken.balanceOf` (L17) is declared but called nowhere in the file.
    ///      The rule the code actually implements is at L284: the cap is the balance at the NEXT
    ///      grid line, which is a fact about the past.
    function test_I02_aZeroBalanceAddressIsPaidInFull() public {
        _fund(vault, 1_000 ether);
        vm.roll(vault.snapshotBlockFor(0) + 1);
        uint256 k = vault.createEpoch();

        // EXITER carries the position across grid line 1 — satisfying the real rule — and then
        // sells every token it owns before claiming a single wei.
        vm.roll(vault.snapshotBlockFor(1) + 1);
        vm.prank(EXITER);
        token.transfer(NEWCOMER, 400_000_000e18);
        assertEq(token.balanceOf(EXITER), 0, "EXITER still holds");

        uint256 w = vault.weightOf(EXITER, k);
        uint256 got = vault.claim(EXITER, k, k);
        console2.log("EXITER balanceOf at claim time", token.balanceOf(EXITER));
        console2.log("EXITER weightOf               ", w);
        console2.log("EXITER paid                   ", got);

        assertEq(token.balanceOf(EXITER), 0);
        assertEq(w, 400_000_000e18, "weight was not the full historical position");
        assertGt(got, 0, "the comment was right after all");
    }
}
