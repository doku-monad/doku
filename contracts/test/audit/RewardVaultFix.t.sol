// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {RewardVault} from "../../src/sinks/RewardVault.sol";

/// @dev Stands in for DokuHook's `owedSink` ledger: holds native quote and hands it to the
///      market's sink when the sink asks.
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

/// @title RewardVaultFix
/// @notice The other half of `RewardVaultFindings.t.sol`. That file runs the three findings
///         against the frozen generation-3 vault and shows them working; this one runs the same
///         scenarios against `src/` and shows they no longer do, plus the properties the fix has to
///         hold on to while it does that.
///
/// @dev Every block read goes through `vm.getBlockNumber()`: `via_ir = true` folds `block.number`
///      across a `vm.roll` in the same function body, and a test written the obvious way passes
///      for the wrong reason.
///
///      The handover blocks below are chosen against `Checkpoints.upperLookupRecent`, which
///      answers with the value at the END of the block asked about. So a transfer executed AT grid
///      line `k` is already visible at grid line `k`, and a whale funded at line `k` and unwound at
///      line `k + 1` PLUS ONE holds at both of epoch `k`'s checkpoints and at neither of any other
///      epoch's. That is what makes "one whale per interval, cleanly" expressible at all.
contract RewardVaultFixTest is Test {
    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint256 internal constant SEED = 222_222_222e18; // the PoolManager's locked graduation seed
    uint256 internal constant FLOAT = SUPPLY - SEED;
    uint256 internal constant BAG = 100_000_000e18;

    address internal constant PM = address(0x9001); // "PoolManager"  (excluded)
    address internal constant CURVE = address(0xC0FFEE); //             (excluded)
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address internal constant POSM = address(0x9002);
    address internal constant GRAD = address(0x9003);

    address internal ANCHOR = address(0xA0);

    uint256 internal constant MON_TARGET = 305_868_390_948_742_537_150_460;

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
        token.initialize("Doku", "DOKU", CURVE, true, "https://cdn.doku.family/metadata/test.json");

        genesis = vm.getBlockNumber();
        vault = _mkVault(MON_TARGET);

        vm.startPrank(CURVE);
        token.transfer(PM, SEED);
        token.transfer(ANCHOR, FLOAT);
        vm.stopPrank();

        vm.roll(vm.getBlockNumber() + 1);
    }

    function _ex() internal view returns (address[9] memory ex) {
        ex[0] = PM;
        ex[1] = address(hook);
        ex[2] = CURVE;
        ex[3] = address(token);
        ex[4] = DEAD;
        ex[5] = GRAD;
        ex[6] = POSM;
    }

    function _mkVault(uint256 quoteTarget) internal returns (RewardVault) {
        return new RewardVault(
            address(hook), address(token), PoolId.wrap(bytes32(uint256(7))), address(0), quoteTarget, genesis, _ex()
        );
    }

    function _credit(uint256 amount) internal {
        vm.deal(address(this), address(this).balance + amount);
        hook.credit{value: amount}();
    }

    function _fund(uint256 amount) internal {
        _credit(amount);
        vault.fund();
    }

    function _whale(uint256 i) internal pure returns (address) {
        return address(uint160(0x7700 + i));
    }

    function _tryClaim(address who, uint256 k) internal returns (uint256) {
        try vault.claim(who, k, k) returns (uint256 got) {
            return got;
        } catch {
            return 0;
        }
    }

    // ============================================================ M-01, refuted on the fix

    /// @notice The finding's own script, run against the fixed contract. The address that exits at
    ///         grid line 1 and then watches twenty epochs of fees accrue is paid NOTHING, because
    ///         none of that money was ever in interval 0's bucket.
    function test_M01_theExitedHolderIsNoLongerPaidLaterFees() public {
        vm.roll(vault.snapshotBlockFor(1) + 1);
        vm.prank(ANCHOR);
        token.transfer(_whale(99), FLOAT); // ANCHOR exits completely, one block after grid line 1
        assertEq(token.balanceOf(ANCHOR), 0);

        for (uint256 i = 2; i <= 21; ++i) {
            vm.roll(vault.snapshotBlockFor(i) + 1);
            _fund(1_000 ether);
        }

        // ANCHOR opens the ancient epoch itself, exactly as in the finding.
        vm.prank(ANCHOR);
        uint256 k = vault.createEpoch();
        (uint256 snap, uint256 amount, uint256 es,) = vault.epochs(k);

        assertEq(k, 0, "not the ancient index");
        assertEq(snap, vault.snapshotBlockFor(0));
        assertEq(amount, 0, "the later intervals' money leaked into epoch 0");
        assertEq(es, 0, "an empty epoch stored a denominator");
        assertEq(vault.unallocated(), 20_000 ether, "the money left the buckets");

        vm.expectRevert(RewardVault.NothingToClaim.selector);
        vault.claim(ANCHOR, k, k);
        assertEq(ANCHOR.balance, 0, "the exited holder was paid something");

        // GENERATION 5. Each of those twenty pulls is spread FORWARD over up to
        // `MAX_SPREAD_INTERVALS` buckets, so an interval no longer holds its own takings and only
        // its own — bucket `j` holds a share of every pull from `j - 6` to `j`. What the finding
        // turns on is untouched and is the sharper statement of the two: NOT ONE WEI reached a
        // bucket at or before the grid line ANCHOR left at, and every wei is still in a bucket
        // ahead of it.
        assertEq(vault.pending(0), 0, "money reached the exited holder's interval");
        assertEq(vault.pending(1), 0, "money reached the exited holder's interval");
        uint256 inBuckets;
        for (uint256 i = 2; i <= 40; ++i) inBuckets += vault.pending(i);
        assertEq(inBuckets, 20_000 ether, "an interval lost its takings");
        assertEq(inBuckets, vault.unallocated(), "unallocated drifted from the buckets");
    }

    /// @notice Delayed funding across many epochs, with the bag changing hands at EVERY grid line.
    ///         Each whale is paid out of the interval it actually held through, and out of no other
    ///         — including whale 0, who is long gone by the time intervals 1-5 earn anything.
    ///
    /// @dev No epoch is opened until the very end. The generation-3 contrast is not run here:
    ///      re-running the script against the frozen vault needs a backward `vm.roll`, and a
    ///      checkpointed token's history cannot be written out of order. It is in
    ///      `RewardVaultFindings.t.sol` instead.
    function test_M01_delayedFundingWithOwnershipChangingAtEveryGridLine() public {
        uint256 n = 6;
        _rotateAndFund(n);
        vm.roll(vault.snapshotBlockFor(n + 1) + 1);
        vault.createEpochs(n);

        uint256 totalFunded;
        for (uint256 i; i < n; ++i) {
            (, uint256 amount,,) = vault.epochs(i);
            // Generation 5: a share of the pulls from `i - 6` to `i`, not interval `i`'s pull
            // alone. Every one of them still opens as a PAYING epoch, which is what the claims
            // below need and is `spreadWidth`'s floor-unit rule doing its job.
            assertGt(amount, 0, "an epoch in the rotation opened empty");
            totalFunded += amount;

            uint256 paid = _tryClaim(_whale(i), i);
            console2.log("fix: interval", i);
            console2.log("     funded          ", amount);
            console2.log("     its whale paid  ", paid);
            assertGt(paid, 0, "the whale who held through the interval was paid nothing");
            assertLe(paid, amount, "a whale was paid more than its interval earned");

            // ...and that whale is paid by NO other epoch. This is M-01 stated as an assertion.
            for (uint256 j; j < n; ++j) {
                if (j == i) continue;
                assertEq(vault.weightOf(_whale(i), j), 0, "a whale had weight in a foreign interval");
            }
        }
        // Every wei is in one of two places: an epoch that opened, or a bucket ahead of the grid
        // holding the forward tail of the last few pulls.
        assertEq(totalFunded + vault.unallocated(), 2_100 ether, "the buckets and the epochs disagree");
    }

    /// @dev ANCHOR lends whale `i` a bag AT grid line `i` and takes it back one block after grid
    ///      line `i + 1`, so the whale holds at exactly the two checkpoints epoch `i` weighs and at
    ///      neither checkpoint of any other epoch. Two whales are therefore holding at once for one
    ///      block at every grid line, which is what "the bag changes hands at every grid line"
    ///      actually has to look like: a handover that gives BOTH sides a full epoch cannot be
    ///      instantaneous, because each side needs the position at two checkpoints an epoch apart.
    ///
    ///      Written strictly in block order. A checkpointed token's history cannot be written out
    ///      of order — `Checkpoints` reverts `CheckpointUnorderedInsertion` — so the two transfers
    ///      belonging to one whale are separated across two turns of this loop rather than kept
    ///      together and rolled backwards.
    ///
    ///      Interval `i` is funded with `(i + 1) * 100` MON while its whale holds; every figure is
    ///      comfortably over `minEpochAmount` so nothing carries. Under generation 5 an epoch's
    ///      amount is no longer exactly its own interval's takings — `fund` spreads each pull
    ///      forward over one bucket per `minEpochAmount` it contains — which changes what each
    ///      epoch is WORTH and changes nothing about WHO can claim it. No epoch is opened until the
    ///      very end; the delay is the whole point of the finding.
    function _rotateAndFund(uint256 n) internal {
        for (uint256 i; i < n; ++i) {
            vm.roll(vault.snapshotBlockFor(i));
            vm.prank(ANCHOR);
            token.transfer(_whale(i), BAG);

            vm.roll(vm.getBlockNumber() + 1);
            _fund((i + 1) * 100 ether);

            if (i != 0) {
                // Whale i-1 held at grid lines i-1 and i, and is out before grid line i+1.
                vm.prank(_whale(i - 1));
                token.transfer(ANCHOR, BAG);
            }
        }
        vm.roll(vault.snapshotBlockFor(n) + 1);
        vm.prank(_whale(n - 1));
        token.transfer(ANCHOR, BAG);
    }

    /// @notice An interval that earns nothing opens as an EMPTY epoch and the grid moves on. Under
    ///         the old shape it refused, the index stopped, and the next interval's money was then
    ///         paid against this interval's grid line — which is the mechanism of M-01.
    function test_emptyIntervalsAdvanceTheGridInsteadOfStallingIt() public {
        // Nothing at all happens for ten epochs, then one interval earns.
        vm.roll(vault.snapshotBlockFor(10) + 1);
        _fund(500 ether);
        // GENERATION 5: interval 10 and the six after it, never interval 9 or anything below it.
        uint256 width = vault.spreadWidth(500 ether);
        uint256 each = 500 ether / width;
        assertEq(vault.pending(10), 500 ether - each * (width - 1), "the money did not land in interval 10");
        uint256 spread;
        for (uint256 i = 10; i < 10 + width; ++i) spread += vault.pending(i);
        assertEq(spread, 500 ether, "the spread lost a wei");
        for (uint256 i; i < 10; ++i) assertEq(vault.pending(i), 0, "money landed behind the funder");

        vm.roll(vault.snapshotBlockFor(11) + 1);
        assertEq(vault.createEpochs(50), 11, "the grid did not catch up in one call");
        assertEq(vault.epochCount(), 11);
        for (uint256 i; i < 10; ++i) {
            (, uint256 amount, uint256 es,) = vault.epochs(i);
            assertEq(amount, 0, "an empty interval was given money");
            assertEq(es, 0);
        }
        (, uint256 a10,,) = vault.epochs(10);
        assertEq(a10, 500 ether - each * (width - 1), "interval 10's epoch did not get interval 10's money");

        // The grid is now level with real time: the next epoch is refused on BLOCKS.
        vm.expectRevert(abi.encodeWithSelector(RewardVault.TooEarly.selector, vault.snapshotBlockFor(12) + 1));
        vault.createEpoch();
    }

    // ============================================================ zero eligible supply

    /// @notice A grid line where every token sits in an excluded address no longer bricks the
    ///         vault: the interval's money carries FORWARD, and the market recovers.
    /// @dev This is finding E1 from `SinksHunt.t.sol` — under the old shape index 0 could never be
    ///      created, so no later index could either, and every levy the market would ever collect
    ///      was stranded for good with no owner and no rescue.
    function test_zeroEligibleSupplyCarriesForwardInsteadOfBricking() public {
        // The whole float parked in an excluded address before grid line 0.
        vm.prank(ANCHOR);
        token.transfer(DEAD, FLOAT);

        _fund(500 ether);
        // GENERATION 5: the pull is cut into `width` shares across interval 0 and the ones after
        // it, so what the zero-denominator carry moves forward is interval 0's SHARE and not the
        // whole 500. The carry is the thing under test and it is unchanged; the arithmetic below
        // follows the shares rather than the pull.
        uint256 width = vault.spreadWidth(500 ether);
        uint256 each = 500 ether / width;
        uint256 first = 500 ether - each * (width - 1);
        assertEq(vault.pending(0), first);
        assertEq(vault.unallocated(), 500 ether, "the spread lost a wei");

        vm.roll(vault.snapshotBlockFor(1) + 1);
        assertEq(vault.eligibleSupplyAt(vault.snapshotBlockFor(0)), 0, "expected a zero denominator");

        uint256 k = vault.createEpoch();
        (, uint256 amount,,) = vault.epochs(k);
        assertEq(amount, 0, "an epoch nobody could claim was opened anyway");
        assertEq(vault.pending(1), first + each, "the money did not carry forward");
        assertEq(vault.unallocated(), 500 ether, "the money was written off");

        // The float comes back into holders' hands and the vault recovers — which is the whole
        // difference from E1.
        //
        // It recovers at the next grid line but one, and the arithmetic is worth following.
        // Epoch 1 still snapshots grid line 1, and the float only returned one block AFTER grid
        // line 1, so that denominator is still zero and the money carries a second time. Grid
        // line 2 is the first checkpoint at which anybody holds, so epoch 2 is the first that can
        // pay. The money reaches the holder set that came after it, never one before it — which
        // is the rule the carry exists to keep.
        vm.prank(DEAD);
        token.transfer(ANCHOR, FLOAT);

        vm.roll(vault.snapshotBlockFor(2) + 1);
        vault.createEpoch();
        (, uint256 amount1,,) = vault.epochs(1);
        assertEq(amount1, 0, "grid line 1 had a denominator after all");
        assertEq(vault.pending(2), first + each * 2, "the money did not carry a second time");

        vm.roll(vault.snapshotBlockFor(3) + 1);
        uint256 k2 = vault.createEpoch();
        (, uint256 amount2, uint256 es2,) = vault.epochs(k2);
        assertEq(k2, 2);
        assertEq(amount2, first + each * 2, "the carried money was not spent by the first payable epoch");
        assertGt(es2, 0);
        // What is left unallocated is the forward tail of the same pull, in the buckets ahead of
        // the grid, and it is spent by the epochs that open against them.
        assertEq(vault.unallocated(), each * (width - 3), "the tail is not what the spread put there");
        assertGt(vault.claim(ANCHOR, k2, k2), 0, "the recovered market still paid nobody");

        vm.roll(vault.snapshotBlockFor(width + 1) + 1);
        vault.createEpochs(width);
        assertEq(vault.unallocated(), 0, "the forward tail never reached an epoch");
    }

    // ============================================================ L-02

    /// @notice The floor is never zero, for any quote target the curve permits —
    ///         `BondingCurve.MIN_QUOTE_TARGET` is 5, so targets under 10,000 raw units are
    ///         reachable through the registry and the old integer division floored them at zero.
    function test_L02_theFloorIsNeverZero() public {
        uint256[5] memory targets = [uint256(0), 1, 5, 9_999, 10_000];
        for (uint256 i; i < targets.length; ++i) {
            assertGt(_mkVault(targets[i]).minEpochAmount(), 0, "the floor was zero");
        }
        assertEq(_mkVault(9_999).minEpochAmount(), 1, "the floor is not one raw unit");
        assertEq(_mkVault(10_000).minEpochAmount(), 1, "the ordinary quotient moved");
        assertEq(_mkVault(MON_TARGET).minEpochAmount(), MON_TARGET / 10_000, "a real target's floor moved");
    }

    /// @notice And with the floor at one raw unit, a zero-value epoch is not merely discouraged —
    ///         the paying path is refused independently of the floor being right.
    function test_L02_aZeroValueEpochIsNeverAPayingEpoch() public {
        RewardVault tiny = _mkVault(9_999);
        vm.roll(tiny.snapshotBlockFor(1) + 1);
        uint256 k = tiny.createEpoch();
        (, uint256 amount, uint256 es,) = tiny.epochs(k);
        assertEq(amount, 0);
        assertEq(es, 0);
        // And it pays nobody rather than reverting on a division by its own zero denominator.
        vm.expectRevert(RewardVault.NothingToClaim.selector);
        tiny.claim(ANCHOR, k, k);
    }

    /// @notice Takings under the floor carry to the next interval instead of opening an epoch not
    ///         worth the claim gas — and instead of being stranded behind a grid line that, under
    ///         the old shape, would never open again.
    function test_L02_dustCarriesForwardAndIsEventuallyPaid() public {
        uint256 floor_ = vault.minEpochAmount();
        _fund(floor_ - 1); // one wei under

        vm.roll(vault.snapshotBlockFor(1) + 1);
        vault.createEpoch();
        (, uint256 amount0,,) = vault.epochs(0);
        assertEq(amount0, 0, "an epoch under the floor was opened");
        assertEq(vault.pending(1), floor_ - 1, "the dust did not carry");

        // Interval 1 adds one wei; together they clear the floor and are paid out normally.
        _fund(1);
        vm.roll(vault.snapshotBlockFor(2) + 1);
        vault.createEpoch();
        (, uint256 amount1,,) = vault.epochs(1);
        assertEq(amount1, floor_, "the carried dust was not paid out with the next interval");
        assertEq(vault.unallocated(), 0);
        assertGt(vault.claim(ANCHOR, 1, 1), 0);
    }

    // ============================================================ conservation

    /// @notice No epoch ever pays out more than it was funded, and the vault always holds enough to
    ///         honour every open epoch plus every unspent bucket. Fuzzed over the shape that
    ///         breaks accounting if anything does: arbitrary churn, including into and out of
    ///         excluded addresses, while money is carried between buckets.
    function testFuzz_conservationAcrossCarryAndChurn(uint96 m1, uint96 m2, uint96 fee0, uint96 fee1) public {
        address holderA = _whale(1);
        address holderB = _whale(2);
        vm.startPrank(ANCHOR);
        token.transfer(holderA, 300_000_000e18);
        token.transfer(holderB, 200_000_000e18);
        vm.stopPrank();

        uint256 f0 = uint256(fee0) % 500 ether;
        uint256 f1 = uint256(fee1) % 500 ether;

        vm.roll(vault.snapshotBlockFor(0));
        if (f0 != 0) _fund(f0);

        // Churn inside interval 0, including into excluded addresses.
        vm.prank(holderA);
        token.transfer(DEAD, uint256(m1) % 300_000_000e18);
        vm.prank(holderB);
        token.transfer(PM, uint256(m2) % 200_000_000e18);

        vm.roll(vault.snapshotBlockFor(1) + 1);
        if (f1 != 0) _fund(f1);
        vault.createEpochs(2);

        vm.roll(vault.snapshotBlockFor(3) + 1);
        vault.createEpochs(2);

        uint256 owed;
        uint256 paidOut;
        for (uint256 k; k < vault.epochCount(); ++k) {
            paidOut += _tryClaim(holderA, k);
            paidOut += _tryClaim(holderB, k);
            paidOut += _tryClaim(ANCHOR, k);
            (, uint256 amount,, uint256 claimed) = vault.epochs(k);
            assertLe(claimed, amount, "an epoch paid out more than it was funded");
            owed += amount - claimed;
        }

        // Everything that was ever funded is now in exactly one of three places: a live bucket, an
        // open epoch's unclaimed remainder, or a holder's wallet. Nothing was invented, nothing
        // double-counted, and nothing left the vault that no epoch had accounted for.
        assertEq(f0 + f1, vault.unallocated() + owed + paidOut, "conservation");
        assertEq(address(vault).balance, vault.unallocated() + owed, "the vault's balance and its books disagree");
    }

    /// @notice `unallocated` is exactly the sum of the live buckets, through carries and spends.
    function test_unallocatedTracksTheBucketsExactly() public {
        vm.roll(vault.snapshotBlockFor(0));
        _fund(70 ether);
        vm.roll(vault.snapshotBlockFor(1) + 1);
        _fund(110 ether);
        vm.roll(vault.snapshotBlockFor(2) + 1);
        _fund(130 ether);

        // GENERATION 5: three pulls, each spread forward, so the live buckets run past interval 2.
        // `unallocated == sum(pending[k])` is the property this test is named for and it holds over
        // whatever range the spread reached — which is the point of summing rather than naming.
        uint256 buckets;
        for (uint256 i; i < 16; ++i) buckets += vault.pending(i);
        assertEq(buckets, vault.unallocated(), "unallocated drifted from the buckets before any spend");
        assertEq(buckets, 310 ether, "the three pulls are not all in buckets");

        vm.roll(vault.snapshotBlockFor(3) + 1);
        vault.createEpochs(3);

        buckets = 0;
        for (uint256 i; i < 16; ++i) {
            buckets += vault.pending(i);
        }
        assertEq(buckets, vault.unallocated(), "unallocated drifted from the buckets");
        assertEq(vault.pending(0) + vault.pending(1) + vault.pending(2), 0, "a spent bucket still holds money");

        // ...and the forward tail is spent in turn, by the epochs that open against its buckets.
        vm.roll(vault.snapshotBlockFor(16) + 1);
        vault.createEpochs(16);
        assertEq(vault.unallocated(), 0, "three funded intervals left something unspent");
    }

    // ============================================================ preserved properties

    /// @notice The two-snapshot anti-flash-claim rule is untouched: buying just before a grid line
    ///         and claiming the moment the epoch opens still earns nothing.
    function test_theTwoSnapshotRuleStillDefeatsAFlashHolder() public {
        _fund(500 ether);

        address flipper = _whale(7);
        vm.roll(vault.snapshotBlockFor(0) - 1);
        vm.prank(ANCHOR);
        token.transfer(flipper, BAG); // in place for the OPENING checkpoint

        vm.roll(vault.snapshotBlockFor(0) + 1);
        vm.prank(flipper);
        token.transfer(ANCHOR, BAG); // out again, long before the CLOSING one

        vm.roll(vault.snapshotBlockFor(1) + 1);
        uint256 k = vault.createEpoch();
        assertEq(vault.weightOf(flipper, k), 0, "a one-epoch-less holder had weight");
        vm.expectRevert(RewardVault.NothingToClaim.selector);
        vault.claim(flipper, k, k);
    }

    /// @notice An epoch cannot be opened while its own interval is still running — otherwise every
    ///         fee arriving after the call would be locked out of the bucket it belongs to.
    function test_anEpochCannotOpenBeforeItsIntervalCloses() public {
        vm.roll(vault.snapshotBlockFor(0) + 1);
        vm.expectRevert(abi.encodeWithSelector(RewardVault.TooEarly.selector, vault.snapshotBlockFor(1) + 1));
        vault.createEpoch();
    }

    /// @notice `intervalAt` is the grid, read the other way round, and the two must agree exactly
    ///         or money lands one epoch away from the holders who earned it.
    function testFuzz_intervalAtIsTheInverseOfSnapshotBlockFor(uint8 k, uint32 offset) public view {
        uint256 open = vault.snapshotBlockFor(k);
        uint256 span = vault.EPOCH_BLOCKS();
        uint256 within = open + (uint256(offset) % span);
        assertEq(vault.intervalAt(within), k, "a block inside interval k answered something else");
        assertEq(vault.intervalAt(open + span), uint256(k) + 1, "the next grid line did not open the next interval");
    }

    /// @notice Everything at or before grid line 0 — the market's first epoch of life, before any
    ///         weighting window has opened — answers interval 0.
    function test_intervalAtBeforeTheFirstGridLineIsZero() public view {
        assertEq(vault.intervalAt(genesis), 0);
        assertEq(vault.intervalAt(genesis + 1), 0);
        assertEq(vault.intervalAt(vault.snapshotBlockFor(0)), 0);
        assertEq(vault.intervalAt(vault.snapshotBlockFor(0) + 1), 0);
    }
}
