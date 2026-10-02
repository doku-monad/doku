// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {Gen5Candidate} from "./Gen5Candidate.sol";

/**
 * Stands in for `DokuHook`'s sink ledger, and models the part of it that decides this question:
 * THE HOOK HOLDS A MARKET'S FEES IN TWO PLACES, and only one of them is visible to the vault.
 *
 *   `pending`  — `pendingSink[id]`. Claims minted on every swap. Grows continuously with trading
 *                and cannot be pulled.
 *   `owed`     — `owedSink[id]`. Real balance. This is what `RewardVault.fund()` pulls.
 *
 * Three permissionless doors move money between them or into `owed` from outside, and all three
 * are permissionless on the real hook:
 *
 *   `sweep()`           — `DokuHook.sweep(id)`, "Permissionless". Moves the WHOLE of `pending` into
 *                         `owed` in one lump. It is the only route, and it is all-or-nothing.
 *   `creditCurveTax()`  — `DokuHook.creditCurveTax(id)`, whose own NatSpec says "This entry point is
 *                         permissionless, so the amount is attacker-chosen". `owedSink[id] +=`.
 *   `pullSink()`        — the vault's own pull, also permissionless through `fund()`.
 *
 * Those three facts are what every measurement below turns on, so the stub models them exactly
 * rather than collapsing them into one balance the way the older vault fixtures do.
 */
contract FeeLedger {
    uint256 public pending;
    uint256 internal _owed;

    /// @dev A swap's levy. Accrues where the vault cannot see it or reach it.
    function accrue() external payable {
        pending += msg.value;
    }

    /// @dev `DokuHook.sweep`. Permissionless, all-or-nothing.
    function sweep() external {
        _owed += pending;
        pending = 0;
    }

    /// @dev `DokuHook.creditCurveTax`. Permissionless, attacker-chosen amount.
    function creditCurveTax() external payable {
        _owed += msg.value;
    }

    function owedSink(PoolId) external view returns (uint256) {
        return _owed;
    }

    function pullSink(PoolId) external returns (uint256 amount) {
        amount = _owed;
        _owed = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "pull");
    }

    receive() external payable {}
}

/// @dev Every block read goes through `vm.getBlockNumber()`: `via_ir = true` folds `block.number`
///      across a `vm.roll` in the same function body.
abstract contract LeverFixture is Test {
    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint256 internal constant SEED = 222_222_222e18;
    uint256 internal constant FLOAT = SUPPLY - SEED;

    address internal constant PM = address(0x9001);
    address internal constant CURVE = address(0xC0FFEE);
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address internal constant POSM = address(0x9002);
    address internal constant GRAD = address(0x9003);
    address internal constant ANCHOR = address(0xA0);
    address internal constant NEWCOMER = address(0x5EE);
    address internal constant STRANGER = address(0xBADBEEF);

    uint256 internal constant MON_TARGET = 305_868_390_948_742_537_150_460;

    uint8 internal constant SHIPPED = 0;
    uint8 internal constant SPREAD_BACK = 1;
    uint8 internal constant GATE_GRID = 2;
    uint8 internal constant SPREAD_FWD = 4;
    uint8 internal constant DRIP = 8;

    FeeLedger internal hook;
    DokuToken internal token;
    Gen5Candidate internal vault;
    uint256 internal genesis;

    receive() external payable {}

    function _deploy(uint8 mode) internal {
        vm.roll(1_000_000);
        hook = new FeeLedger();
        address impl = address(new DokuToken());
        token = DokuToken(Clones.clone(impl));
        token.initialize("Doku", "DOKU", CURVE, true, "https://cdn.doku.family/metadata/test.json");
        genesis = vm.getBlockNumber();

        address[9] memory ex;
        ex[0] = PM;
        ex[1] = address(hook);
        ex[2] = CURVE;
        ex[3] = address(token);
        ex[4] = DEAD;
        ex[5] = GRAD;
        ex[6] = POSM;
        vault = new Gen5Candidate(
            address(hook), address(token), PoolId.wrap(bytes32(uint256(7))), address(0), MON_TARGET, genesis, ex, mode
        );

        vm.startPrank(CURVE);
        token.transfer(PM, SEED);
        token.transfer(ANCHOR, FLOAT);
        vm.stopPrank();
        vm.roll(vm.getBlockNumber() + 1);
    }

    /// @dev A swap's worth of levy, accruing in the hook where the vault cannot reach it.
    function _accrue(uint256 amount) internal {
        vm.deal(address(this), address(this).balance + amount);
        hook.accrue{value: amount}();
    }

    // ------------------------------------------------------------------ the M-01 scenario

    /// @dev Four intervals of trading that nobody funds. 1,000 MON per interval, accruing in
    ///      `pendingSink` where `fund()` cannot see it until somebody sweeps.
    function _fourUnfundedIntervals() internal {
        for (uint256 i; i < 4; ++i) {
            vm.roll(vault.snapshotBlockFor(i) + 1);
            _accrue(1_000 ether);
        }
        assertEq(hook.pending(), 4_000 ether, "the hook did not accrue");
        assertEq(vault.unallocated(), 0, "something funded early");
    }

    /// @dev The newcomer takes a third of the float one block before grid line 4, so it holds at
    ///      both of epoch 4's checkpoints and at neither of any earlier epoch's.
    function _newcomerArrivesAtGridLine4() internal {
        vm.roll(vault.snapshotBlockFor(4) - 1);
        vm.prank(ANCHOR);
        token.transfer(NEWCOMER, FLOAT / 3);
    }

    /// @dev Stand in interval 4, sweep the backlog into `owedSink`, and pull it. All three calls
    ///      are permissionless and the newcomer makes them itself.
    function _newcomerSweepsAndFunds() internal {
        vm.roll(vault.snapshotBlockFor(4) + 1);
        vm.prank(NEWCOMER);
        hook.sweep();
        vm.prank(NEWCOMER);
        vault.fund();
    }

    /// @dev Hold to the closing grid line, open every epoch the grid owes, and collect epoch 4 —
    ///      the one and only epoch the newcomer carried a position across.
    function _newcomerCollectsEpochFour() internal returns (uint256 paid) {
        vm.roll(vault.snapshotBlockFor(5) + 1);
        vault.createEpochs(6);
        uint256 before = NEWCOMER.balance;
        try vault.claim(NEWCOMER, 4, 4) returns (uint256) {
            paid = NEWCOMER.balance - before;
        } catch {
            paid = 0;
        }
    }

    // ------------------------------------------------------------------ invariant spot-checks

    /// @dev `unallocated == sum(pending[k])`, summed well past anything any rule here can write.
    function _bucketsSumToUnallocated(string memory where) internal view {
        uint256 sum;
        for (uint256 k; k <= 80; ++k) sum += vault.pending(k);
        assertEq(vault.unallocated(), sum, string.concat("unallocated drifted from the buckets @ ", where));
    }

    /// @dev THE BUCKET-SAFETY RULE, as a state check: no bucket an epoch has already opened against
    ///      still holds money. Equivalent to "every credited index was >= epochs.length at credit
    ///      time", and cheaper to assert, because `_openEpoch` empties the bucket it spends.
    function _noSpentBucketHoldsMoney(string memory where) internal view {
        uint256 n = vault.epochCount();
        for (uint256 j; j < n; ++j) {
            assertEq(vault.pending(j), 0, string.concat("a bucket an epoch has spent holds money @ ", where));
        }
    }

    /// @dev The vault's balance equals its ledger exactly. Nothing here donates, so a vault that is
    ///      merely solvent has lost track of a wei.
    function _solventToTheWei(string memory where) internal view {
        uint256 owedOut;
        uint256 n = vault.epochCount();
        for (uint256 k; k < n; ++k) {
            (, uint256 amount,, uint256 claimed) = vault.epochs(k);
            assertLe(claimed, amount, string.concat("an epoch overspent @ ", where));
            owedOut += amount - claimed;
        }
        assertEq(address(vault).balance, owedOut + vault.unallocated(), string.concat("balance != ledger @ ", where));
    }

    function _allInvariants(string memory where) internal view {
        _bucketsSumToUnallocated(where);
        _noSpentBucketHoldsMoney(where);
        _solventToTheWei(where);
    }
}

/**
 * ROUND 5 — M-01's residual, measured against every candidate rule rather than argued about.
 *
 * THE RESIDUAL. `fund()` pulls the hook's whole accrued `owedSink` and books all of it to
 * `pending[intervalAt(block.number)]` — the interval the permissionless caller happened to call in.
 * A newcomer who holds across intervals 4→5 can let four intervals of fees accrue unfunded, sweep
 * and fund inside its own interval, and be paid out of all four. Measured at 1,333 MON of 4,000 by
 * `Round1VaultHunt::test_R5_fundIsTheRemainingTimingLever`, and re-measured as the control below.
 *
 * WHAT IS AND IS NOT FIXABLE. Round 3 established that the hook-side fix is impossible: v4 hands
 * the hook a fee integral with no timeline, so nothing on chain knows which interval a fee accrued
 * in. This round establishes the second half of that, which is sharper and was not previously
 * written down: the vault cannot key a bound on WHEN EITHER, because every signal it can read about
 * elapsed time is attacker-writable at O(1) cost through a permissionless entry point —
 * `createEpochs` moves `epochs.length`, `fund` moves the vault's own funding history, and
 * `creditCurveTax` moves `owedSink` for one wei. Each test below names the door it walks through.
 */
contract Round5FundLever is LeverFixture {
    // =================================================================================
    // The control. The shipped rule, re-measured on this fixture.
    // =================================================================================

    /// @notice `mode == 0` is the deployed generation-4 rule. The whole backlog lands in the
    ///         funder's own interval and the funder is paid a third of it.
    function test_R5_control_theShippedRuleHandsTheNewcomerTheWholeBacklog() public {
        _deploy(SHIPPED);
        _fourUnfundedIntervals();
        _newcomerArrivesAtGridLine4();
        _newcomerSweepsAndFunds();

        assertEq(vault.pending(4), 4_000 ether, "the whole backlog did not land in interval 4");
        uint256 paid = _newcomerCollectsEpochFour();
        console2.log("CONTROL      newcomer's take of a 4,000 MON backlog (wei):", paid);
        assertGt(paid, 1_300 ether, "the control did not reproduce the finding");
        _allInvariants("control");

        // And the holders who were actually there earn nothing: their epochs opened empty.
        for (uint256 k; k < 4; ++k) {
            (, uint256 amount,,) = vault.epochs(k);
            assertEq(amount, 0, "an earlier interval was funded after all");
        }
    }

    // =================================================================================
    // DESIGN A — spread backwards over the missed intervals. The briefed candidate.
    // =================================================================================

    /// @notice DESIGN A, PASSIVELY. With the grid left where a market that nobody tends leaves it —
    ///         parked at zero — A's floor `max(lastFundedInterval + 1, epochs.length)` is zero, the
    ///         window is the whole of 0..4, and the newcomer's take falls by a factor of five.
    ///
    ///         This is A working, and it is the only configuration in which it does.
    function test_R5_A_spreadBackBoundsThePassiveCase() public {
        _deploy(SPREAD_BACK);
        _fourUnfundedIntervals();
        _newcomerArrivesAtGridLine4();
        _newcomerSweepsAndFunds();

        assertEq(vault.pending(4), 800 ether, "the backlog was not spread over five intervals");
        for (uint256 k; k < 4; ++k) {
            assertEq(vault.pending(k), 800 ether, "an earlier interval got no share");
        }
        uint256 paid = _newcomerCollectsEpochFour();
        console2.log("DESIGN A     passive: newcomer's take (wei):", paid);
        assertLt(paid, 300 ether, "A did not bound the take in the passive case");
        _allInvariants("A passive");
    }

    /// @notice DESIGN A, DEFEATED, and the cost of defeating it is one permissionless call the
    ///         attacker was already making a transaction for.
    ///
    ///         A's floor is the bucket-safety rule — only an interval no epoch has opened against
    ///         may be credited — and `createEpochs` is permissionless, unpriced and openable by
    ///         anybody the instant a grid line passes. So the newcomer opens intervals 0..3 as
    ///         EMPTY epochs first, which moves A's floor `epochs.length` up to 4, which is the
    ///         newcomer's own interval. The window collapses to a single bucket and A is exactly
    ///         the shipped rule again.
    ///
    ///         The empty epochs are not a side effect to be tidied away: they are what the grid
    ///         does anyway, they cost one array push each, and a market where anybody has ever
    ///         called `createEpochs` to catch a lagging grid up — which the function exists for —
    ///         is in this state without anyone attacking anything.
    function test_R5_A_spreadBackIsDefeatedByAdvancingTheGridFirst() public {
        _deploy(SPREAD_BACK);
        _fourUnfundedIntervals();
        _newcomerArrivesAtGridLine4();

        // The front-run: open every interval the grid owes as an empty epoch, in the same block the
        // fund happens in, for the price of four array pushes.
        vm.roll(vault.snapshotBlockFor(4) + 1);
        uint256 gasBefore = gasleft();
        vm.prank(NEWCOMER);
        vault.createEpochs(8);
        uint256 frontRunGas = gasBefore - gasleft();
        assertEq(vault.epochCount(), 4, "the grid did not advance to the newcomer's own interval");

        vm.prank(NEWCOMER);
        hook.sweep();
        vm.prank(NEWCOMER);
        vault.fund();

        assertEq(vault.pending(4), 4_000 ether, "the window did not collapse onto interval 4");
        uint256 paid = _newcomerCollectsEpochFour();
        console2.log("DESIGN A     defeated: newcomer's take (wei):", paid);
        console2.log("DESIGN A     gas paid to defeat it:", frontRunGas);
        assertGt(paid, 1_300 ether, "the front-run did not restore the full lever");
        _allInvariants("A defeated");
    }

    /// @notice DESIGN A's SECOND PROBLEM, which is not about the attacker at all: it credits
    ///         buckets BELOW the funder's own interval, and the contract's §4 rule is that money
    ///         only ever moves forward, "never an earlier one that has since sold".
    ///
    ///         A holder who carried a position across intervals 0..3 and sold everything at grid
    ///         line 4 is paid out of a pull that happened after it left — and, because the hook
    ///         carries no timeline, out of fees that may have accrued entirely in interval 4. The
    ///         shipped rule cannot do this in either direction; A can, and it hands the lever to a
    ///         departed holder instead of to a newcomer rather than taking it away.
    function test_R5_A_spreadBackPaysAHolderThatHasAlreadyLeft() public {
        _deploy(SPREAD_BACK);

        // A holder that carries a third of the float across intervals 0..3 and is gone by grid
        // line 4. Under the shipped rule it is owed nothing here, because nothing funded.
        address departed = address(0xDEADBEA7);
        vm.prank(ANCHOR);
        token.transfer(departed, FLOAT / 3);

        // Every wei of the backlog accrues in interval 4 alone — after the departed holder sold.
        vm.roll(vault.snapshotBlockFor(4) - 1);
        vm.prank(departed);
        token.transfer(ANCHOR, FLOAT / 3);
        vm.roll(vault.snapshotBlockFor(4) + 1);
        _accrue(4_000 ether);
        hook.sweep();
        vault.fund();

        vm.roll(vault.snapshotBlockFor(5) + 1);
        vault.createEpochs(6);

        uint256 before = departed.balance;
        vault.claim(departed, 0, 3);
        uint256 paid = departed.balance - before;
        console2.log("DESIGN A     paid to a holder that had already sold (wei):", paid);
        assertGt(paid, 0, "the departed holder was not paid, so this proves nothing");
        _allInvariants("A backwards");
    }

    // =================================================================================
    // DESIGN B — the dual: refuse to advance the grid while fees are unfunded.
    // =================================================================================

    /// @notice DESIGN B ALONE BOUNDS NOTHING. The gate forces a `fund()` before the grid moves; it
    ///         has no opinion on which bucket that fund credits, and `fund()` still credits the
    ///         caller's own interval. The newcomer sweeps, funds, and takes the same third.
    function test_R5_B_gatingTheGridDoesNotMoveASingleWei() public {
        _deploy(GATE_GRID);
        _fourUnfundedIntervals();
        _newcomerArrivesAtGridLine4();
        _newcomerSweepsAndFunds();

        assertEq(vault.pending(4), 4_000 ether, "the gate changed where the money landed");
        uint256 paid = _newcomerCollectsEpochFour();
        console2.log("DESIGN B     newcomer's take (wei):", paid);
        assertGt(paid, 1_300 ether, "B bounded the lever after all");
        _allInvariants("B alone");
    }

    /// @notice DESIGN B IS A ONE-WEI FREEZE OF THE WHOLE VAULT, and that is strictly worse than the
    ///         lever it was meant to close.
    ///
    ///         The gate reads `hook.owedSink(poolId)`. `DokuHook.creditCurveTax` writes that
    ///         mapping, is payable, and its own NatSpec says "This entry point is permissionless,
    ///         so the amount is attacker-chosen". So anybody may make the gate's condition true for
    ///         one wei, in any block, for ever — and while it is true NO EPOCH CAN OPEN.
    ///
    ///         An epoch that cannot open is an epoch that cannot be claimed, so the freeze reaches
    ///         money that is already funded, already bucketed and already earned. That is a
    ///         permanent denial of every holder's dividend at a price of one wei per block, bought
    ///         to close a lever that costs the attacker nothing today and pays them a third of a
    ///         backlog. The trade is not close.
    function test_R5_B_oneWeiFromAnyoneFreezesTheGridAndEveryFundedEpochBehindIt() public {
        _deploy(GATE_GRID);

        // A perfectly ordinary market: interval 0 trades, is swept, is funded.
        vm.roll(vault.snapshotBlockFor(0) + 1);
        _accrue(1_000 ether);
        hook.sweep();
        vault.fund();
        assertEq(vault.pending(0), 1_000 ether, "interval 0 was not funded");

        // Interval 0 has closed. Epoch 0 is owed, and 1,000 MON is waiting behind it.
        vm.roll(vault.snapshotBlockFor(1) + 1);

        // One wei, from a stranger with no position and no interest in this market.
        vm.deal(STRANGER, 1 ether);
        vm.prank(STRANGER);
        hook.creditCurveTax{value: 1}();

        vm.expectRevert(abi.encodeWithSelector(Gen5Candidate.UnfundedFeesOutstanding.selector, uint256(1)));
        vault.createEpoch();
        vm.expectRevert(abi.encodeWithSelector(Gen5Candidate.UnfundedFeesOutstanding.selector, uint256(1)));
        vault.createEpochs(4);
        assertEq(vault.epochCount(), 0, "the grid advanced through the gate");

        // Nobody can claim, because there is no epoch to claim. ANCHOR held the entire float
        // through the whole of interval 0 and is owed every wei of that 1,000 MON.
        vm.expectRevert(Gen5Candidate.BadRange.selector);
        vault.claim(ANCHOR, 0, 0);

        // Clearing it is not a repair, because re-arming it costs one wei again — and the griefer
        // re-arms in the same block the clearing `fund()` lands in. The market never gets an epoch.
        vault.fund();
        vm.prank(STRANGER);
        hook.creditCurveTax{value: 1}();
        vm.expectRevert(abi.encodeWithSelector(Gen5Candidate.UnfundedFeesOutstanding.selector, uint256(1)));
        vault.createEpochs(4);

        // Ten thousand blocks later, and ten thousand more grid lines later, still nothing.
        vm.roll(vault.snapshotBlockFor(40) + 1);
        vm.expectRevert(abi.encodeWithSelector(Gen5Candidate.UnfundedFeesOutstanding.selector, uint256(1)));
        vault.createEpochs(40);
        assertEq(vault.epochCount(), 0, "the grid escaped");
        assertGt(vault.unallocated(), 1_000 ether, "there is nothing frozen, so this proves nothing");
    }

    // =================================================================================
    // DESIGN E — spread FORWARDS over as many intervals as the pull went unfunded.
    // =================================================================================

    /// @notice DESIGN E, PASSIVELY AND AGAINST THE GRID FRONT-RUN. E takes A's width and drops A's
    ///         floor: it never credits a bucket below the funder's own interval, so the
    ///         bucket-safety rule is satisfied by the SHIPPED proof — `intervalAt(block.number) >=
    ///         epochs.length` — with nothing added to it, and `epochs.length` is no longer an input
    ///         the attacker can move. The front-run that defeats A does nothing here.
    function test_R5_E_spreadForwardSurvivesTheFrontRunThatDefeatsA() public {
        _deploy(SPREAD_FWD);
        _fourUnfundedIntervals();
        _newcomerArrivesAtGridLine4();

        vm.roll(vault.snapshotBlockFor(4) + 1);
        vm.prank(NEWCOMER);
        vault.createEpochs(8);
        assertEq(vault.epochCount(), 4, "the grid did not advance");
        vm.prank(NEWCOMER);
        hook.sweep();
        vm.prank(NEWCOMER);
        vault.fund();

        // Five intervals unfunded, so five buckets — all of them at or ahead of the funder.
        assertEq(vault.pending(4), 800 ether, "the pull was not spread over five intervals");
        for (uint256 j = 5; j < 9; ++j) assertEq(vault.pending(j), 800 ether, "a forward bucket is missing");
        for (uint256 j; j < 4; ++j) assertEq(vault.pending(j), 0, "E credited a bucket an epoch had spent");

        uint256 paid = _newcomerCollectsEpochFour();
        console2.log("DESIGN E     front-run: newcomer's take (wei):", paid);
        assertLt(paid, 300 ether, "E did not bound the take");
        _allInvariants("E front-run");
    }

    /// @notice DESIGN E, DEFEATED, and this is the measurement that generalises to every rule of
    ///         this shape.
    ///
    ///         E's width is `k + 1 - fundedThrough`: how long the VAULT has gone unfunded. That
    ///         number is written by `fund()`, which is permissionless, and a `fund()` only has to
    ///         pull a non-zero amount to count — which anybody can arrange for one wei through
    ///         `creditCurveTax`, because the hook's real fee backlog sits in `pendingSink` and does
    ///         not reach `owedSink` until somebody calls the permissionless `sweep`.
    ///
    ///         So the newcomer keeps the vault's funding history looking fresh with one wei per
    ///         interval, leaves the backlog unswept where the vault cannot see it, and sweeps it
    ///         into a width of ONE in the interval it chose. The bound is gone and the whole
    ///         4,000 MON is in the newcomer's own bucket again.
    function test_R5_E_spreadForwardIsDefeatedByOneWeiPerInterval() public {
        _deploy(SPREAD_FWD);
        vm.deal(NEWCOMER, 1 ether);

        // Four intervals of real trading, all of it left in `pendingSink` — and one wei per
        // interval through the door that writes `owedSink` directly, pulled immediately, purely to
        // keep `fundedThrough` abreast of the clock.
        for (uint256 i; i < 4; ++i) {
            vm.roll(vault.snapshotBlockFor(i) + 1);
            _accrue(1_000 ether);
            vm.prank(NEWCOMER);
            hook.creditCurveTax{value: 1}();
            vm.prank(NEWCOMER);
            vault.fund();
        }
        assertEq(hook.pending(), 4_000 ether, "the backlog did not stay out of reach");

        _newcomerArrivesAtGridLine4();
        _newcomerSweepsAndFunds();

        assertEq(vault.fundedThrough(), 5, "the marker was not kept fresh");
        assertGt(vault.pending(4), 3_999 ether, "the width did not collapse to one");
        uint256 paid = _newcomerCollectsEpochFour();
        console2.log("DESIGN E     defeated: newcomer's take (wei):", paid);
        assertGt(paid, 1_300 ether, "the reset did not restore the lever");
        _allInvariants("E defeated");
    }

    // =================================================================================
    // DESIGN F — divide EVERY pull by a constant. The only rule with no input to forge.
    // =================================================================================

    /// @notice DESIGN F against all three preambles at once: passive, grid front-run, and the
    ///         one-wei marker refresh that defeats E. F reads no history and no external state, so
    ///         there is nothing for any of them to move: a pull is divided by a constant and the
    ///         funder's own interval gets a seventh of it whatever anybody did first.
    function test_R5_F_aFixedDripHasNoInputAnyoneCanForge() public {
        uint256[3] memory takes;

        for (uint256 variant; variant < 3; ++variant) {
            _deploy(DRIP);
            vm.deal(NEWCOMER, 1 ether);

            for (uint256 i; i < 4; ++i) {
                vm.roll(vault.snapshotBlockFor(i) + 1);
                _accrue(1_000 ether);
                if (variant == 2) {
                    // The marker refresh that defeats E.
                    vm.prank(NEWCOMER);
                    hook.creditCurveTax{value: 1}();
                    vm.prank(NEWCOMER);
                    vault.fund();
                }
            }
            _newcomerArrivesAtGridLine4();

            if (variant == 1) {
                // The grid front-run that defeats A.
                vm.roll(vault.snapshotBlockFor(4) + 1);
                vm.prank(NEWCOMER);
                vault.createEpochs(8);
            }
            _newcomerSweepsAndFunds();
            takes[variant] = _newcomerCollectsEpochFour();
            _allInvariants("F");
        }

        console2.log("DESIGN F     passive:       newcomer's take (wei):", takes[0]);
        console2.log("DESIGN F     grid front-run: newcomer's take (wei):", takes[1]);
        console2.log("DESIGN F     marker refresh: newcomer's take (wei):", takes[2]);
        for (uint256 i; i < 3; ++i) {
            assertLt(takes[i], 250 ether, "a preamble moved F's bound");
        }
    }

    /// @notice DESIGN F'S PRICE, and it is why F is not free. The drip is unconditional, so it also
    ///         fires on the market nobody is attacking: a single honest interval's fees no longer
    ///         open that interval's own epoch in full, they open it with a seventh and hand the
    ///         rest to the six holder sets that come after.
    ///
    ///         On a market whose per-interval take is anywhere near `minEpochAmount` — the
    ///         anti-spam floor, one ten-thousandth of the graduation raise — a seventh of it is
    ///         UNDER that floor, so the epoch opens EMPTY and the dividend does not arrive at all
    ///         until enough sevenths have carried forward to clear the floor. That is a live
    ///         behaviour change on every healthy market, bought to bound an attack that only
    ///         exists while the keeper is down.
    function test_R5_F_theDripAlsoFiresOnAMarketNobodyIsAttacking() public {
        _deploy(DRIP);
        uint256 floor_ = vault.minEpochAmount();

        // One honest interval, funded promptly, worth six times the floor. Under the shipped rule
        // this opens epoch 0 with all of it.
        vm.roll(vault.snapshotBlockFor(0) + 1);
        _accrue(floor_ * 6);
        hook.sweep();
        vault.fund();

        vm.roll(vault.snapshotBlockFor(1) + 1);
        vault.createEpochs(1);
        (, uint256 amount,,) = vault.epochs(0);
        console2.log("DESIGN F     minEpochAmount (wei):", floor_);
        console2.log("DESIGN F     epoch 0's amount after an honest, prompt fund (wei):", amount);
        assertEq(amount, 0, "the drip did not push a healthy epoch under the floor");

        // Not lost — carried, which is the contract's own third rule — but the holders of interval
        // 0 are paid nothing for interval 0.
        vm.expectRevert(Gen5Candidate.NothingToClaim.selector);
        vault.claim(ANCHOR, 0, 0);
        _allInvariants("F honest market");
    }
}
