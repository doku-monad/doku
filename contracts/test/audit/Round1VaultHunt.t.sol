// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {RewardVault} from "../../src/sinks/RewardVault.sol";

/// @dev Stands in for DokuHook's `owedSink` ledger. Same shape as `RewardVaultFix.t.sol`'s.
contract VaultLedger {
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

/// @dev A holder that cannot take native MON. A multisig whose fallback was removed by an upgrade,
///      a contract wallet with a `receive` that reverts, a token-locker. All of them can hold the
///      launch token and therefore all of them earn a dividend.
contract CannotBePaid {
    receive() external payable {
        revert("no");
    }
}

/// @dev Every block read goes through `vm.getBlockNumber()`: `via_ir = true` folds `block.number`
///      across a `vm.roll` in the same function body.
abstract contract VaultFixture is Test {
    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint256 internal constant SEED = 222_222_222e18;
    uint256 internal constant FLOAT = SUPPLY - SEED;

    address internal constant PM = address(0x9001);
    address internal constant CURVE = address(0xC0FFEE);
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address internal constant POSM = address(0x9002);
    address internal constant GRAD = address(0x9003);
    address internal constant ANCHOR = address(0xA0);

    uint256 internal constant MON_TARGET = 305_868_390_948_742_537_150_460;

    VaultLedger internal hook;
    DokuToken internal token;
    RewardVault internal vault;
    uint256 internal genesis;

    receive() external payable {}

    function _deploy() internal {
        vm.roll(1_000_000);
        hook = new VaultLedger();
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
        vault = new RewardVault(
            address(hook), address(token), PoolId.wrap(bytes32(uint256(7))), address(0), MON_TARGET, genesis, ex
        );

        vm.startPrank(CURVE);
        token.transfer(PM, SEED);
        token.transfer(ANCHOR, FLOAT);
        vm.stopPrank();
        vm.roll(vm.getBlockNumber() + 1);
    }

    function _credit(uint256 amount) internal {
        vm.deal(address(this), address(this).balance + amount);
        hook.credit{value: amount}();
    }

    function _fund(uint256 amount) internal {
        _credit(amount);
        vault.fund();
    }
}

/**
 * ROUND 1 - `RewardVault`, the sibling the round-0 fixes did not travel to.
 *
 * Round 0 closed two shapes in `CreatorSink` and left the identical shapes open here. The
 * creator-sink write-up names the pattern itself: "the lesson never travelled the twenty lines to
 * here." It has not travelled to the other sink either.
 */
contract Round1RewardVaultHunt is VaultFixture {
    function setUp() public {
        _deploy();
    }

    // =================================================================================
    // R3 - the open `receive()`, which `CreatorSink` closed today and this did not.
    // =================================================================================

    /// @notice FIXED. `CreatorSink.receive` was gated in round 0 because "an open `receive` turned
    ///         a mistyped address into a permanent burn that the sender got no warning about".
    ///         `RewardVault` is the sibling and had exactly that property, with more force: MON
    ///         arriving bare is not `unallocated`, is in no `pending` bucket, is therefore in no
    ///         epoch, and every exit from this contract is a debit of an epoch. It was a burn with
    ///         a receipt.
    ///
    ///         Flipped rather than deleted: reverting the gate turns this red again.
    function test_R3_bareNativeNowBouncesOffTheSiblingSinkToo() public {
        address stranger = address(0xBADBEEF);
        vm.deal(stranger, 5 ether);

        vm.prank(stranger);
        (bool ok,) = address(vault).call{value: 5 ether}("");
        assertFalse(ok, "the vault still swallows a bare send");
        assertEq(address(vault).balance, 0, "MON landed anyway");
        assertEq(stranger.balance, 5 ether, "the sender did not keep their money");

        // The hook is still able to pay, which is the entire reason `receive` exists: `fund()`
        // measures the hook's payment as a balance delta and must keep working.
        _fund(100 ether);
        assertEq(vault.unallocated(), 100 ether, "the gate broke the only legitimate inflow");
    }

    /// @notice FIXED. `RewardVault.claim` paid the named holder, all or nothing, with no
    ///         destination — so a holder who cannot receive the quote (a frozen USDC or USDT0
    ///         address, a contract whose fallback broke after it bought in) never collected, and
    ///         the dividend sat in the epoch for ever. `CreatorSink` got `claim(quote, amount, to)`
    ///         in round 0 for precisely that reason and the sibling did not.
    ///
    ///         The gate is what keeps both properties at once: `claim` stays permissionless so a
    ///         stranger can still crystallise your dividend, and only YOU may say where it goes.
    function test_R4_aFrozenHolderCanNameADestinationAndNobodyElseCan() public {
        _fund(100 ether);
        vm.roll(vault.snapshotBlockFor(2) + 1);
        vault.createEpochs(2);

        address fresh = address(0xF3E5);
        uint256 before = fresh.balance;

        // A stranger may NOT redirect it — that is the property `claim` is built on.
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(RewardVault.NotHolder.selector, ANCHOR, address(0xBAD)));
        vault.claimTo(ANCHOR, 0, 0, fresh);

        // Nor may the holder burn it by naming the vault, which `receive` would swallow into no
        // epoch at all and dilute every later holder through `eligibleSupply`.
        vm.prank(ANCHOR);
        vm.expectRevert(RewardVault.ZeroAddress.selector);
        vault.claimTo(ANCHOR, 0, 0, address(vault));

        // The holder can.
        vm.prank(ANCHOR);
        uint256 paid = vault.claimTo(ANCHOR, 0, 0, fresh);
        assertGt(paid, 0, "nothing was paid");
        assertEq(fresh.balance - before, paid, "the dividend did not arrive at the destination");

        // And it is spent: the same epoch cannot be claimed twice by either door.
        vm.prank(ANCHOR);
        vm.expectRevert(RewardVault.NothingToClaim.selector);
        vault.claim(ANCHOR, 0, 0);
    }

    function test_R4_plainClaimStillCannotRouteAroundAFrozenHolder() public {
        address locked = address(new CannotBePaid());
        vm.prank(ANCHOR);
        token.transfer(locked, FLOAT / 2);
        vm.roll(vm.getBlockNumber() + 1);

        _fund(100 ether);
        vm.roll(vault.snapshotBlockFor(2) + 1);
        vault.createEpochs(2);

        (, uint256 amount,,) = vault.epochs(0);
        assertGt(amount, 0, "epoch 0 is empty, so the test proves nothing");
        assertGt(vault.weightOf(locked, 0), 0, "the holder has no weight, so the test proves nothing");

        // It is owed. It cannot take it, and nobody can take it for it.
        vm.expectRevert(RewardVault.TransferFailed.selector);
        vault.claim(locked, 0, 0);

        vm.prank(locked);
        vm.expectRevert(RewardVault.TransferFailed.selector);
        vault.claim(locked, 0, 0);

        assertFalse(vault.hasClaimed(0, locked), "the bitmap latched on a failed payment");

        // Pre-fix the story ended here: `claim` was the whole ABI, so there was no destination the
        // holder could name and the money stayed in the epoch until the heat death of the market.
        // `claimTo` is the way out — proved next door in
        // `test_R4_aFrozenHolderCanNameADestinationAndNobodyElseCan`. What this test still pins is
        // the half that has not changed and must not: plain `claim` pays the NAMED holder and
        // nobody else, so a stranger calling it for a frozen address still cannot move that money
        // anywhere, and the bitmap does not latch on a failed payment.
        vm.roll(vault.snapshotBlockFor(500) + 1);
        vault.createEpochs(499);
        vm.expectRevert(RewardVault.TransferFailed.selector);
        vault.claim(locked, 0, 0);
    }

    // =================================================================================
    // R6 - the third carry-forward, against the NATIVE quote and no deployment script.
    // =================================================================================

    /**
     * @notice `sweepResidue`, proved on the lightweight fixture. The finding itself is written up
     *         in `Round3SinkHunt::test_3B_theUnclaimableRemainderOfAnEpochIsPermanentlyUnreachable`
     *         and proved there against the real `DeployDoku` graph; this is the same mechanics on a
     *         native-quoted vault with no v4, no graduation and no hook, which is the configuration
     *         that fixture exists to cover and the one that can be run when the deployment script
     *         is red for reasons of its own.
     *
     *         The shape is the finding's: ANCHOR and `held` carry positions across the whole of
     *         interval 0, `churn` acquires one INSIDE it and therefore weighs zero while still
     *         sitting in the denominator, and `slow` carries one and never comes to collect. What
     *         is left of the epoch after everybody who will claim has claimed used to be reachable
     *         by nothing at all.
     */
    function test_R6_aMaturedEpochsResidueCarriesForwardLikeTheOtherTwo() public {
        address held = address(0x8E1D);
        address churn = address(0xC4);
        address slow = address(0x570E);

        vm.startPrank(ANCHOR);
        token.transfer(held, FLOAT / 4);
        token.transfer(slow, FLOAT / 4);
        vm.stopPrank();

        vm.roll(vault.snapshotBlockFor(0) + 1);
        // 1,400 rather than the 100 this test funded before generation 5, and the reason is the
        // spread rather than the sweep. `fund` now cuts a pull into one bucket per `minEpochAmount`
        // it contains, capped at seven, so 100 MON would reach epoch 0 as 33 and the quarter of it
        // this test sweeps would be 8 - under the floor, carried rather than paid, which is
        // `_openEpoch` working and not `sweepResidue` failing. 1,400 gives epoch 0 the 200 that
        // leaves a 50 MON remainder, comfortably clear of the floor and the same shape as before.
        _fund(1_400 ether);

        // Mid-interval: the churn. `min(open, close)` is zero for it and its balance is a quarter
        // of the denominator.
        vm.roll(vm.getBlockNumber() + vault.EPOCH_BLOCKS() / 2);
        vm.prank(ANCHOR);
        token.transfer(churn, FLOAT / 4);

        vm.roll(vault.snapshotBlockFor(1) + 1);
        vault.createEpochs(2);

        (, uint256 amount,,) = vault.epochs(0);
        assertGt(amount, 0, "epoch 0 did not fund");
        assertEq(vault.weightOf(churn, 0), 0, "the churner carries a weight after all");
        vault.claim(ANCHOR, 0, 0);
        vault.claim(held, 0, 0);

        (,,, uint256 claimed) = vault.epochs(0);
        uint256 left = amount - claimed;
        assertGt(left, 0, "nothing was left, so this proves nothing");

        // Inside the window it is still epoch 0's money, and the refusal names the block.
        uint256 opensAt = vault.sweepableFrom(0);
        vm.expectRevert(abi.encodeWithSelector(RewardVault.ResidueNotMature.selector, uint256(0), opensAt));
        vault.sweepResidue(0);

        vm.roll(opensAt);
        uint256 toInterval = vault.currentInterval();
        assertGe(toInterval, vault.epochCount(), "the sweep would write a bucket an epoch has spent");
        uint256 unallocBefore = vault.unallocated();
        uint256 vaultHeld = address(vault).balance;

        uint256 moved = vault.sweepResidue(0);
        assertEq(moved, left, "the sweep moved something other than the remainder");
        assertEq(vault.pending(toInterval), moved, "the current interval's bucket did not take it");
        assertEq(vault.unallocated(), unallocBefore + moved, "unallocated did not rise by the remainder");
        // A sweep is a move between this contract's own ledger slots, never an exit.
        assertEq(address(vault).balance, vaultHeld, "MON left the vault on a sweep");

        vm.expectRevert(abi.encodeWithSelector(RewardVault.NothingToSweep.selector, uint256(0)));
        vault.sweepResidue(0);

        // Forward, not away: the epoch that opens against that bucket pays it to the holders of
        // the interval it landed in.
        vm.roll(vault.snapshotBlockFor(toInterval + 1) + 1);
        vault.createEpochs(toInterval + 1);
        (, uint256 fwd,,) = vault.epochs(toInterval);
        assertEq(fwd, moved, "the swept remainder did not become that interval's dividend");

        uint256 before = held.balance;
        vault.claim(held, toInterval, toInterval);
        assertGt(held.balance - before, 0, "the holders it moved to were not paid");

        // And the price: `slow` held right through interval 0, still carries a weight in it, and
        // is dispossessed. Deliberately, after 26 epochs.
        assertGt(vault.weightOf(slow, 0), 0, "slow never had a weight, so nothing was taken");
        assertFalse(vault.hasClaimed(0, slow), "slow claimed after all");
        vm.expectRevert(RewardVault.NothingToClaim.selector);
        vault.claim(slow, 0, 0);
    }

    // =================================================================================
    // R5 - `fund()` was the remaining timing lever. Generation 5 bounds it.
    // =================================================================================

    /**
     * @notice BOUNDED, NOT CLOSED, and the distinction is the whole finding.
     *
     *         THE LEVER. Round 0's fix says of `createEpoch`: "there is nothing left for a caller to
     *         time." That was true of `createEpoch` and was not true of the vault, because the
     *         interval a fee landed in was `intervalAt(block.number)` AT THE MOMENT `fund()` RAN -
     *         and `fund()` is permissionless, unbounded in cadence, and pulls the hook's WHOLE
     *         accrued ledger in one go. So an address that held across exactly one grid interval and
     *         funded inside it was paid its pro-rata share of every fee the market had earned since
     *         the last call, including months of trading it was not there for.
     *
     *         Below is the scenario this test was written with, unchanged: ANCHOR holds the entire
     *         float through intervals 0-3 while the market earns 4,000 MON, a newcomer buys a third
     *         of the float at grid line 4, funds, and holds to grid line 5. Generation 4 pays it
     *         1,333.33 MON - a third of all four intervals. Generation 5 pays it 190.48.
     *
     *         WHAT THE BOUND IS. `fund` now spreads its pull forward over one bucket per
     *         `minEpochAmount` it contains, capped at `MAX_SPREAD_INTERVALS`, so one call credits
     *         its own interval with at most `max(minEpochAmount, amount / MAX_SPREAD_INTERVALS)`.
     *         The assertion below is the tighter statement that follows from it whenever the backlog
     *         is no longer than the cap: THE NEWCOMER TAKES NO MORE THAN IT WOULD BE OWED FOR THE
     *         ONE INTERVAL IT ACTUALLY HELD ACROSS, had that interval's own 1,000 MON been funded on
     *         time. 190.48 against 333.33.
     *
     *         WHAT IS NOT FIXED, and this half of the test is unchanged on purpose: the holders who
     *         were actually there still earn nothing for intervals 0-3, because those epochs still
     *         open empty. The money cannot be sent back to them - the hook carries no timeline, so
     *         nothing on chain knows it was theirs, and §4's rule is that money only ever moves
     *         forward. Generation 5 takes the windfall away from the newcomer and hands it to the
     *         six holder sets that follow, whoever they turn out to be. It does not restore it to
     *         the ones that earned it, and no on-chain rule can; see
     *         `test/audit/Round5FundLever.t.sol` for the four designs that were measured trying.
     *
     *         REVERT-CHECK. Point `spreadWidth` at 1 - or set `MAX_SPREAD_INTERVALS` to 1 - and the
     *         newcomer is back to 1,333.33 MON and the first assertion below fails.
     */
    function test_R5_fundIsTheRemainingTimingLever() public {
        // Four intervals of trading. The fees accrue in the HOOK; nobody funds.
        for (uint256 i; i < 4; ++i) {
            vm.roll(vault.snapshotBlockFor(i) + 1);
            _credit(1_000 ether);
        }
        assertEq(hook.owed(), 4_000 ether, "the hook did not accrue");
        assertEq(vault.unallocated(), 0, "something funded early");

        // A newcomer takes a third of the float, one block before grid line 4.
        address newcomer = address(0x5EE);
        vm.roll(vault.snapshotBlockFor(4) - 1);
        vm.prank(ANCHOR);
        token.transfer(newcomer, FLOAT / 3);

        // ...and calls `fund()` itself, inside its own interval. Anyone may.
        vm.roll(vault.snapshotBlockFor(4) + 1);
        vm.prank(newcomer);
        vault.fund();

        // The backlog is 130 floors, so the width is the cap: seven buckets, starting at the
        // funder's own interval and running forward. Never backward - see the contract.
        assertEq(vault.spreadWidth(4_000 ether), vault.MAX_SPREAD_INTERVALS(), "the width is not the cap");
        uint256 backlog = 4_000 ether;
        uint256 each = backlog / 7;
        assertEq(vault.pending(4), backlog - each * 6, "interval 4 did not take a seventh and the dust");
        for (uint256 j = 5; j < 11; ++j) {
            assertEq(vault.pending(j), each, "a forward bucket did not take its seventh");
        }
        assertEq(vault.pending(3), 0, "money moved BACKWARDS out of the funder's interval");

        // Hold to the closing grid line, then collect.
        vm.roll(vault.snapshotBlockFor(5) + 1);
        vault.createEpochs(5);

        uint256 before = newcomer.balance;
        vault.claim(newcomer, 4, 4);
        uint256 paid = newcomer.balance - before;

        console2.log("fees earned over intervals 0-3 (MON wei):", uint256(4_000 ether));
        console2.log("generation 4 paid a holder who arrived at grid line 4:", uint256(1_333_333_333_333_333_333_333));
        console2.log("generation 5 pays it:", uint256(paid));

        // THE BOUND. A third of ONE interval's 1,000 MON is what this holder would have been owed
        // had the market been funded on the cadence it is supposed to be funded on. It takes less.
        uint256 oneIntervalsFees = 1_000 ether;
        uint256 owedForTheOneIntervalItHeld = oneIntervalsFees / 3;
        assertLt(paid, owedForTheOneIntervalItHeld, "the newcomer still out-earns the interval it held");
        // ...and specifically a seventh of what generation 4 handed it, to the wei of the division.
        assertApproxEqAbs(paid * 7, 1_333_333_333_333_333_333_333, 1e13, "the bound is not a seventh");

        // UNCHANGED, AND STILL THE FINDING'S OTHER HALF. ANCHOR held for the whole of intervals 0-3
        // and is owed nothing for any of them, because every one of those epochs still opens empty.
        for (uint256 k; k < 4; ++k) {
            (, uint256 amount,,) = vault.epochs(k);
            assertEq(amount, 0, "an earlier interval was funded after all");
        }
        vm.expectRevert(RewardVault.NothingToClaim.selector);
        vault.claim(ANCHOR, 0, 3);

        // Where the other six sevenths went: forward, to whoever is still holding at each of the
        // next six grid lines. ANCHOR is, so ANCHOR collects them - and so would the newcomer, if it
        // were still here, which is the capital-time the concentrated version let it skip.
        vm.roll(vault.snapshotBlockFor(11) + 1);
        vault.createEpochs(6);
        uint256 anchorBefore = ANCHOR.balance;
        vault.claim(ANCHOR, 5, 10);
        // ANCHOR holds two thirds of the float - the newcomer never sold - so two thirds of the six
        // sevenings is what reaches it, and the newcomer's own third of them is still claimable BY
        // THE NEWCOMER, which is exactly the point: the money it used to take in one interval is now
        // spread across six more that it has to still be holding at.
        uint256 sixSevenths = each * 6;
        assertApproxEqAbs(
            ANCHOR.balance - anchorBefore, (sixSevenths * 2) / 3, 1e15, "the forward buckets did not reach a holder"
        );
    }

    /**
     * @notice THE STEADY-STATE CLAIM, MEASURED. `MAX_SPREAD_INTERVALS` says the spread "costs
     *         nothing in between" — that a market funded on a steady cadence is paid what it was
     *         paid before, and that the ramp and the tail are a delay at each end of a market's life
     *         rather than a loss. That is the kind of sentence this file has been wrong in before,
     *         so it is a test and not a comment.
     *
     *         Twenty intervals, funded on the cadence the keeper is supposed to fund on, with one
     *         holder holding throughout. What it collects over the epochs that are fully inside the
     *         steady state is exactly what those intervals earned; what is missing at the end is the
     *         tail, and the tail is still in `pending`, not gone.
     */
    function test_R5_aSteadyCadenceIsPaidWhatItWasPaidBefore() public {
        uint256 perInterval = 700 ether; // ten floors, so every pull spreads to the full width
        for (uint256 i; i < 20; ++i) {
            vm.roll(vault.snapshotBlockFor(i) + 1);
            _fund(perInterval);
        }
        vm.roll(vault.snapshotBlockFor(21) + 1);
        vault.createEpochs(21);

        // The steady state is everything from the ramp's end to the last funded interval. Epochs 6
        // through 19 each received a seventh from each of the seven pulls that reached them.
        for (uint256 k = 6; k < 20; ++k) {
            (, uint256 amount,,) = vault.epochs(k);
            assertApproxEqAbs(amount, perInterval, 10, "a steady-state epoch was not paid its interval");
        }

        // Nothing is lost at either end either: the ramp is in the epochs before 6 and the tail is
        // still in the buckets ahead of 20, and the three add up to every wei that was funded.
        uint256 booked;
        uint256 n = vault.epochCount();
        for (uint256 k; k < n; ++k) {
            (, uint256 amount,,) = vault.epochs(k);
            booked += amount;
        }
        assertEq(booked + vault.unallocated(), perInterval * 20, "a wei went missing between the ends");

        uint256 before = ANCHOR.balance;
        vault.claim(ANCHOR, 0, n - 1);
        console2.log("steady cadence: funded over 20 intervals (wei):", perInterval * 20);
        console2.log("steady cadence: collected by the holder who held throughout (wei):", ANCHOR.balance - before);
        console2.log("steady cadence: still in buckets ahead of the grid (the tail) (wei):", vault.unallocated());
    }

    /// @notice WHAT THE SPREAD COSTS THE KEEPER, measured rather than estimated, because the keeper
    ///         pays it on every REWARDS vault on every interval and Monad bills the gas LIMIT rather
    ///         than the gas used. A pull under one `minEpochAmount` writes one bucket and is the
    ///         generation-4 cost; a pull over seven writes seven.
    function test_R5_theSpreadsGasCostOnTheKeepersHotPath() public {
        vm.roll(vault.snapshotBlockFor(0) + 1);
        uint256 floor_ = vault.minEpochAmount();

        _credit(floor_ - 1);
        uint256 g0 = gasleft();
        vault.fund();
        uint256 narrow = g0 - gasleft();

        vm.roll(vault.snapshotBlockFor(1) + 1);
        _credit(floor_ * 100);
        uint256 g1 = gasleft();
        vault.fund();
        uint256 wide = g1 - gasleft();

        console2.log("fund() gas, width 1 (generation-4 shape):", narrow);
        console2.log("fund() gas, width 7 (the cap):", wide);
        assertEq(vault.spreadWidth(floor_ - 1), 1, "a sub-floor pull was spread");
        assertEq(vault.spreadWidth(floor_ * 100), 7, "a large pull was not capped at seven");
    }

    /// @notice THE BOUND ITSELF, stated as a property over pull sizes rather than as one scenario.
    ///         One `fund()` credits its own interval with at most
    ///         `max(minEpochAmount, amount / MAX_SPREAD_INTERVALS)`, and the spread never
    ///         manufactures a bucket under the anti-spam floor that was not already under it.
    function testFuzz_R5_onePullCanNeverConcentrateMoreThanAFloorOrASeventh(uint96 raw) public {
        uint256 amount = uint256(raw);
        vm.assume(amount != 0);
        vm.roll(vault.snapshotBlockFor(3) + 1);
        _credit(amount);
        vault.fund();

        uint256 k = vault.currentInterval();
        uint256 floor_ = vault.minEpochAmount();
        uint256 cap = amount / vault.MAX_SPREAD_INTERVALS();
        // TWO floors, not one, and the fuzz is what established that: below the cap the width is
        // `amount / minEpochAmount` rounded DOWN, so a pull of 1.99 floors is one piece and the
        // share reaches `2 * minEpochAmount` at a width of one. See `MAX_SPREAD_INTERVALS`.
        uint256 bound = 2 * floor_ > cap ? 2 * floor_ : cap;
        // The dust from the division rides with the first bucket, so the bound is `+ n - 1` wei.
        assertLe(vault.pending(k), bound + vault.MAX_SPREAD_INTERVALS(), "one call concentrated more than the bound");

        uint256 sum;
        uint256 n = vault.spreadWidth(amount);
        for (uint256 j; j <= 10; ++j) {
            sum += vault.pending(k + j);
            // No bucket is pushed under the floor that was not under it as a whole pull.
            if (j < n && amount >= floor_) {
                assertGe(vault.pending(k + j), floor_, "the spread manufactured a sub-floor bucket");
            }
        }
        assertEq(sum, amount, "the spread lost or created a wei");
        assertEq(vault.unallocated(), amount, "unallocated disagrees with the buckets");
    }
}

/**
 * The stateful handler for the conservation invariant below.
 *
 * Every action is one an outsider can really take: fund at an arbitrary block, catch the grid up by
 * an arbitrary number of steps, move tokens between holders, claim an arbitrary range, sweep a
 * matured epoch's residue forward. The handler tracks only what the invariant needs that the chain
 * cannot be asked for: the highest interval any money has ever touched (so `sum(pending[k])` is
 * computable) and the running totals in and out.
 */
contract VaultHandler is Test {
    RewardVault public vault;
    DokuToken public token;
    VaultLedger public hook;

    uint256 public maxInterval;
    uint256 public totalFunded;
    uint256 public totalPaid;
    /// @dev Coverage counters for the sweep action: an action that is always refused would leave
    ///      both invariants below untested against the new code path and look identical to one
    ///      that never breaks them.
    uint256 public totalSwept;
    uint256 public sweeps;
    /// @dev Coverage counter for `doCatchUpThenFund`, for the same reason `sweeps` exists.
    uint256 public catchUpFunds;

    address[4] public actors;

    constructor(RewardVault v, DokuToken t, VaultLedger h, address anchor) {
        vault = v;
        token = t;
        hook = h;
        actors[0] = anchor;
        actors[1] = address(0x7701);
        actors[2] = address(0x7702);
        actors[3] = address(0x7703);
    }

    receive() external payable {}

    function _note(uint256 k) internal {
        if (k > maxInterval) maxInterval = k;
    }

    function doFund(uint96 amount) external {
        uint256 amt = uint256(amount) % 5_000 ether;
        if (amt == 0) return;
        vm.deal(address(this), address(this).balance + amt);
        hook.credit{value: amt}();
        // THE BUCKET-SAFETY RULE, ASSERTED AT CREDIT TIME rather than inferred from the state
        // afterwards. `fund` writes `intervalAt(block.number) + j` for `j < spreadWidth`, so the
        // lowest index it can touch is the current interval; if that is ever below `epochs.length`
        // then a bucket an epoch has already spent has just been credited.
        assertGe(vault.currentInterval(), vault.epochCount(), "fund credited a bucket an epoch had spent");
        vault.fund();
        totalFunded += amt;
        // Generation 5 spreads a pull FORWARD over up to `MAX_SPREAD_INTERVALS` buckets, and a
        // carry from the last of them writes one past it again.
        _note(vault.currentInterval() + vault.MAX_SPREAD_INTERVALS() + 1);
    }

    /**
     * @dev THE INTERLEAVING THAT DEFEATS THE BACKWARD SPREAD, run against the forward one.
     *
     *      `createEpochs` is permissionless and moves `epochs.length`, which is the floor any
     *      BACKWARD spread would have to respect — so catching the grid fully up and funding in the
     *      same block collapses a backward window onto the funder's own bucket
     *      (`Round5FundLever::test_R5_A_spreadBackIsDefeatedByAdvancingTheGridFirst`, 162,289 gas).
     *      The shipped rule spreads forward and does not read `epochs.length` at all, so the
     *      sequence is not an attack on it — but it is the tightest moment the bucket-safety rule
     *      has, because it puts `epochs.length` as close to the current interval as it can get.
     *      That is what this action is here to keep hammering.
     */
    function doCatchUpThenFund(uint96 amount, uint8 steps) external {
        try vault.createEpochs((uint256(steps) % 8) + 1) returns (uint256 opened) {
            _note(vault.epochCount() + 1);
            opened;
        } catch {}
        uint256 amt = uint256(amount) % 5_000 ether;
        if (amt == 0) return;
        vm.deal(address(this), address(this).balance + amt);
        hook.credit{value: amt}();
        assertGe(vault.currentInterval(), vault.epochCount(), "fund credited a bucket an epoch had spent");
        vault.fund();
        totalFunded += amt;
        _note(vault.currentInterval() + vault.MAX_SPREAD_INTERVALS() + 1);
        ++catchUpFunds;
    }

    function doRoll(uint16 steps) external {
        uint256 n = (uint256(steps) % 3) + 1;
        vm.roll(vm.getBlockNumber() + n * (vault.EPOCH_BLOCKS() / 2) + 1);
    }

    function doCreateEpochs(uint8 n) external {
        uint256 steps = (uint256(n) % 6) + 1;
        try vault.createEpochs(steps) returns (uint256 opened) {
            _note(vault.epochCount() + 1);
            opened;
        } catch {}
    }

    function doTransfer(uint8 from, uint8 to, uint96 amount) external {
        address f = actors[from % 4];
        address t = actors[to % 4];
        if (f == t) return;
        uint256 bal = token.balanceOf(f);
        if (bal == 0) return;
        uint256 amt = uint256(amount) % bal;
        if (amt == 0) return;
        vm.prank(f);
        token.transfer(t, amt);
    }

    /**
     * @dev The third carry-forward, added with `sweepResidue`. Two modes on purpose, because an
     *      action that can never succeed proves nothing and one that always succeeds never
     *      exercises the guard: one call in three jumps the clock to the epoch's own
     *      `sweepableFrom` so the sweep lands, and the rest are left wherever the sequence put the
     *      clock, where the sweep is usually refused.
     *
     *      The jump is to `sweepableFrom(idx)` exactly, not by a fixed stride, so the clock runs no
     *      further ahead than the action needs and the grid stays catchable by `doCreateEpochs`.
     */
    function doSweep(uint8 k, uint8 mode) external {
        uint256 count = vault.epochCount();
        if (count == 0) return;
        uint256 idx = uint256(k) % count;
        if (mode % 3 == 0) {
            uint256 opensAt = vault.sweepableFrom(idx);
            if (vm.getBlockNumber() < opensAt) vm.roll(opensAt);
        }
        try vault.sweepResidue(idx) returns (uint256 moved) {
            totalSwept += moved;
            ++sweeps;
            // A sweep credits the bucket `fund` would credit in the same block.
            _note(vault.currentInterval() + 1);
        } catch {}
    }

    function doClaim(uint8 who, uint8 from, uint8 span) external {
        uint256 count = vault.epochCount();
        if (count == 0) return;
        address w = actors[who % 4];
        uint256 lo = uint256(from) % count;
        uint256 hi = lo + (uint256(span) % 4);
        if (hi >= count) hi = count - 1;
        uint256 before = w.balance;
        try vault.claim(w, lo, hi) returns (uint256) {
            totalPaid += w.balance - before;
        } catch {}
    }
}

/**
 * ROUND 1 - the conservation invariant, stateful.
 *
 * The brief for `RewardVault` this round is "re-establish the conservation invariant: an epoch's
 * total claims must never exceed its funded amount, and `unallocated == sum(pending[k])` at all
 * times". The existing suite proves both over SCRIPTED sequences. This proves them over sequences
 * nobody wrote down, with `createEpochs`, carry-forward, zero-eligible-supply carries, residue
 * sweeps and claims all interleaved.
 *
 * `sweepResidue` is in the action set because it is the only function that credits `unallocated`
 * outside `fund` and the only one that moves money out of an OPENED epoch without paying anybody.
 * Both invariants below are exactly the statements it could break: it debits `amount - claimed`
 * from one side of the solvency sum and credits a `pending` bucket on the other, and if those two
 * ever disagree — by a wei, or by writing a bucket an epoch has already spent — this is where it
 * shows.
 */
contract Round1VaultConservation is VaultFixture {
    VaultHandler internal handler;

    function setUp() public {
        _deploy();
        handler = new VaultHandler(vault, token, hook, ANCHOR);

        // The float starts on ANCHOR; let the handler move it.
        vm.prank(ANCHOR);
        token.approve(address(handler), type(uint256).max);

        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = VaultHandler.doFund.selector;
        selectors[1] = VaultHandler.doRoll.selector;
        selectors[2] = VaultHandler.doCreateEpochs.selector;
        selectors[3] = VaultHandler.doTransfer.selector;
        selectors[4] = VaultHandler.doClaim.selector;
        selectors[5] = VaultHandler.doSweep.selector;
        selectors[6] = VaultHandler.doCatchUpThenFund.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @notice `unallocated == sum(pending[k])`, the number the contract's own NatSpec promises.
    function invariant_unallocatedIsExactlyTheSumOfTheBuckets() public view {
        uint256 sum;
        uint256 top = handler.maxInterval() + 2;
        for (uint256 k; k <= top; ++k) sum += vault.pending(k);
        assertEq(vault.unallocated(), sum, "unallocated drifted from the buckets");
    }

    /// @notice No epoch ever pays out more than it was funded with, and none of them together ever
    ///         exceed what the vault holds. This is the solvency statement.
    function invariant_everyEpochIsSolventAndSoIsTheVault() public view {
        uint256 owedOut;
        uint256 n = vault.epochCount();
        for (uint256 k; k < n; ++k) {
            (, uint256 amount,, uint256 claimed) = vault.epochs(k);
            assertLe(claimed, amount, "an epoch paid out more than it held");
            owedOut += amount - claimed;
        }
        assertGe(address(vault).balance, owedOut + vault.unallocated(), "the vault cannot cover its ledger");
    }

    /// @notice Nothing is created. Everything paid out came from a `fund`.
    function invariant_nothingIsPaidThatWasNeverFunded() public view {
        assertLe(handler.totalPaid(), handler.totalFunded(), "the vault paid out money nobody funded");
    }

    /**
     * @notice NO BUCKET IS EVER CREDITED AFTER ITS EPOCH HAS SPENT IT, as a state check.
     *
     *         `_openEpoch` empties the bucket it spends, and every writer — `fund`, the two carries
     *         and `sweepResidue` — writes an index at or above `epochs.length`. So a non-zero bucket
     *         below the grid can only mean one of them wrote backwards, which is the failure the
     *         generation-5 spread had to be shaped around: a BACKWARD spread would credit exactly
     *         these indices, and the only thing stopping it reaching a spent one is a floor an
     *         attacker can raise with a permissionless `createEpochs`. The forward spread cannot
     *         write here at all, and this is the assertion that says so over sequences nobody wrote
     *         down. `doFund` and `doCatchUpThenFund` assert the same thing at credit time.
     */
    function invariant_noBucketAnEpochHasSpentIsEverCredited() public view {
        uint256 n = vault.epochCount();
        for (uint256 j; j < n; ++j) {
            assertEq(vault.pending(j), 0, "a bucket an epoch has already spent holds money");
        }
    }

    /// @notice A paying epoch always carries a non-zero denominator, and an empty one always
    ///         carries zero. This is what keeps `claim`'s division safe without a guard of its own.
    function invariant_anEpochsAmountAndDenominatorAgree() public view {
        uint256 n = vault.epochCount();
        for (uint256 k; k < n; ++k) {
            (, uint256 amount, uint256 es,) = vault.epochs(k);
            if (amount == 0) assertEq(es, 0, "an empty epoch stored a denominator");
            else assertGt(es, 0, "a paying epoch stored a zero denominator");
        }
    }
}
