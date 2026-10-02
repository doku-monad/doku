// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test, stdError} from "forge-std/Test.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {Round3LedgerBase} from "./Round3Ledger.t.sol";
import {VaultFixture} from "./Round1VaultHunt.t.sol";
import {RewardVault} from "../../src/sinks/RewardVault.sol";

/**
 * ROUND 4 — the three decided changes, probed at the edges the existing suites do not reach.
 *
 * Two things are being tested here and nothing else.
 *
 *  A. `DokuHook._settleLeg` now books the 70 bps sink share to `pendingSink` instead of donating
 *     it. The implementer's claim is that `lpCut` is ALWAYS denominated in `sinkCurrency(id)`.
 *     `Round3Ledger` drives a BURN market at `quoteIsCurrency0 == false` and
 *     `Gen4HookLedgerHunt` drives one at `quoteIsCurrency0 == true` — but BOTH are ERC-20 quoted,
 *     and the combination a DOKU mainnet launch produces most often, a NATIVE-quoted BURN market,
 *     is in neither. That is the shape below: the token leg is `currency1`, the quote leg is MON,
 *     and the two books that share the token (`pendingSink` and `pendingProtocolToken`) are drained
 *     by two separate burns inside one `sweep`.
 *
 *  B. `RewardVault.sweepResidue`. The suites added with it prove the two conservation invariants
 *     over random sequences; what they do not state is the vault's solvency as an EQUALITY (the
 *     invariant asserts `>=`), the same-block claim/sweep ordering in both directions, or the
 *     `intervalAt(block.number) >= epochs.length` argument at the two places it is tightest —
 *     exactly on a grid line, and with `k + 1 == epochs.length`.
 */
contract Round4NativeBurnMarket is Round3LedgerBase {
    address internal constant BURNSINK = address(0xB0B0);

    Currency internal T;

    function setUp() public {
        _deploy();
        // NATIVE quote, BURN sink, a live creator tax. `address(0) < any token`, so the quote is
        // currency0 and the TOKEN LEG — the leg whose whole levy is the sink's — is currency1.
        mkts[0] = _open(tokNative, address(0), SINK_BURN, BURNSINK, 700);
        T = Currency.wrap(mkts[0].token);
    }

    /// @dev The partition, stated for exactly the two currencies this market touches.
    function _partition(string memory where) internal view {
        PoolId id = mkts[0].id;
        assertEq(
            Currency.unwrap(hook.sinkCurrency(id)),
            mkts[0].token,
            string.concat("a BURN market's sink currency is not its token @ ", where)
        );
        // The QUOTE side: the treasury's swap share and the creator's tax, and NOTHING of the
        // sink's — a BURN sink cannot spend MON.
        assertEq(
            _claims(NATIVE),
            hook.pendingProtocol(id) + hook.owedTax(id),
            string.concat("native claims != native books @ ", where)
        );
        // The TOKEN side: the sink's 70 bps from the swap's token leg, and the treasury's maker
        // levy on the same leg. If `lpCut` were ever booked in the wrong currency this is the
        // equality that breaks, and it breaks on BOTH sides at once.
        assertEq(
            _claims(T),
            hook.pendingSink(id) + hook.pendingProtocolToken(id),
            string.concat("token claims != token books @ ", where)
        );
        assertEq(_real(NATIVE), hook.owedTreasury(NATIVE), string.concat("real MON != owed MON @ ", where));
        assertEq(
            _real(T),
            hook.owedTreasury(T) + hook.owedSink(id),
            string.concat("real token != owed token @ ", where)
        );
    }

    /// @notice All four swap shapes, both directions, with the partition asserted after each — and
    ///         then the whole flow out: sweep, pullSink, pullTax, pullTreasury on both currencies.
    function test_R4A_aNativeQuotedBurnMarketBooksTheSinksCutInTheTOKEN() public {
        PoolId id = mkts[0].id;
        _partition("start");

        // exact-input buy: specified leg is the QUOTE (MON), unspecified is the TOKEN.
        _swap(0, true, -50 ether);
        _partition("exact-in buy");
        assertGt(hook.pendingSink(id), 0, "the token leg paid the sink nothing");
        assertGt(hook.pendingProtocol(id), 0, "the quote leg paid the treasury nothing");
        assertGt(hook.owedTax(id), 0, "the quote leg paid the creator nothing");

        // exact-output buy: specified leg is the TOKEN, unspecified is the QUOTE.
        _swap(0, true, 10 ether);
        _partition("exact-out buy");

        // exact-input sell: specified leg is the TOKEN.
        ERC20(mkts[0].token).approve(address(swapper), type(uint256).max);
        _swap(0, false, -5 ether);
        _partition("exact-in sell");

        // exact-output sell: specified leg is the QUOTE.
        _swap(0, false, 1 ether);
        _partition("exact-out sell");

        // A maker levy on both legs, so `pendingProtocolToken` is non-zero alongside `pendingSink`
        // and one sweep has to drain two token books with two separate burns.
        _tryLiq(0, -6000, 6000, 1 ether);
        _partition("add");
        _tryLiq(0, -6000, 6000, -1 ether);
        _partition("remove");
        assertGt(hook.pendingProtocolToken(id), 0, "the maker levy never reached the token book");

        uint256 sinkOwed = hook.pendingSink(id);
        uint256 protTok = hook.pendingProtocolToken(id);
        uint256 protMon = hook.pendingProtocol(id);

        hook.sweep(id);
        _partition("sweep");
        assertEq(hook.owedSink(id), sinkOwed, "the sink's token book did not materialise");
        assertEq(hook.owedTreasury(T), protTok, "the treasury's token book did not materialise");
        assertEq(hook.owedTreasury(NATIVE), protMon, "the treasury's MON book did not materialise");
        assertEq(hook.pendingSink(id), 0, "pendingSink survived the sweep");

        // The burn sink is paid in the TOKEN and in nothing else.
        uint256 burnTokBefore = ERC20(mkts[0].token).balanceOf(BURNSINK);
        uint256 burnMonBefore = BURNSINK.balance;
        vm.prank(BURNSINK);
        uint256 pulled = hook.pullSink(id);
        assertEq(pulled, sinkOwed, "pullSink paid something other than the sink's book");
        assertEq(
            ERC20(mkts[0].token).balanceOf(BURNSINK) - burnTokBefore, sinkOwed, "the burn sink was not paid the token"
        );
        assertEq(BURNSINK.balance, burnMonBefore, "the burn sink was paid MON it cannot burn");
        _partition("pullSink");

        // The creator's tax is the QUOTE, on a market whose sink takes the token.
        uint256 tax = hook.owedTax(id);
        assertGt(tax, 0, "no tax to pull");
        uint256 csBefore = creatorSinkAddr.balance;
        vm.prank(creatorSinkAddr);
        hook.pullTax(id);
        assertEq(creatorSinkAddr.balance - csBefore, tax, "the creator sink was not paid MON");
        _partition("pullTax");

        hook.pullTreasury(NATIVE);
        hook.pullTreasury(T);
        assertEq(TREASURY.balance, protMon, "the treasury was not paid its MON");
        assertEq(ERC20(mkts[0].token).balanceOf(TREASURY), protTok, "the treasury was not paid its token");
        _partition("pullTreasury");

        // Nothing is left behind in either currency.
        assertEq(_claims(NATIVE), 0, "MON claims left over");
        assertEq(_claims(T), 0, "token claims left over");
        assertEq(_real(NATIVE), 0, "MON left in the hook");
        assertEq(_real(T), 0, "token left in the hook");
    }

    /// @notice The same market over random sequences, so the partition is not asserted only along
    ///         the one path written above.
    function testFuzz_R4A_partitionHoldsOnANativeBurnMarket(uint8[8] memory acts, uint64[8] memory sizes) public {
        PoolId id = mkts[0].id;
        ERC20(mkts[0].token).approve(address(swapper), type(uint256).max);
        for (uint256 i; i < 8; ++i) {
            uint256 n = bound(uint256(sizes[i]), 1e9, 40 ether);
            uint256 a = acts[i] % 8;
            if (a == 0) _trySwap(0, true, -int256(n));
            else if (a == 1) _trySwap(0, true, int256(n / 100 + 1));
            else if (a == 2) _trySwap(0, false, -int256(n));
            else if (a == 3) _trySwap(0, false, int256(n / 100 + 1));
            else if (a == 4) _tryLiq(0, -6000, 6000, int256(n));
            else if (a == 5) _tryLiq(0, -6000, 6000, -int256(n));
            else if (a == 6) {
                try hook.sweep(id) {} catch {}
            } else {
                vm.prank(BURNSINK);
                try hook.pullSink(id) {} catch {}
            }
            _partition("fuzz");
        }
    }
}

/**
 * `RewardVault.sweepResidue`, at the edges.
 */
contract Round4VaultResidue is VaultFixture {
    address internal constant HELD = address(0x8E1D);
    address internal constant CHURN = address(0xC4);
    address internal constant SLOW = address(0x570E);

    function setUp() public {
        _deploy();
    }

    /// @dev The vault's obligation, as the solvency statement is written: the unspent part of every
    ///      opened epoch plus everything still in a bucket.
    function _obligation() internal view returns (uint256 owedOut) {
        uint256 n = vault.epochCount();
        for (uint256 k; k < n; ++k) {
            (, uint256 amount,, uint256 claimed) = vault.epochs(k);
            assertLe(claimed, amount, "an epoch paid out more than it held");
            owedOut += amount - claimed;
        }
        owedOut += vault.unallocated();
    }

    /// @dev EQUALITY, not `>=`. Nothing in this fixture donates, so a vault that is merely solvent
    ///      is a vault that has lost track of a wei.
    function _exact(string memory where) internal view {
        assertEq(address(vault).balance, _obligation(), string.concat("balance != ledger @ ", where));
    }

    /// @dev An epoch 0 with a real remainder: ANCHOR, `held` and `slow` carry positions across the
    ///      whole of interval 0; `churn` acquires one INSIDE it, so it weighs zero and still sits in
    ///      the denominator.
    function _epochZeroWithResidue() internal {
        vm.startPrank(ANCHOR);
        token.transfer(HELD, FLOAT / 4);
        token.transfer(SLOW, FLOAT / 4);
        vm.stopPrank();

        vm.roll(vault.snapshotBlockFor(0) + 1);
        // 1,400 rather than 100, for the reason spelled out on the twin of this fixture in
        // `Round1VaultHunt::test_R6_aMaturedEpochsResidueCarriesForwardLikeTheOtherTwo`: generation
        // 5's `fund` spreads a pull over one bucket per `minEpochAmount`, capped at seven, so 100
        // would leave epoch 0 a remainder under the floor and the epoch that spends the swept bucket
        // would open empty. What this fixture is for is the residue, not the floor.
        _fund(1_400 ether);

        vm.roll(vm.getBlockNumber() + vault.EPOCH_BLOCKS() / 2);
        vm.prank(ANCHOR);
        token.transfer(CHURN, FLOAT / 4);

        vm.roll(vault.snapshotBlockFor(1) + 1);
        vault.createEpochs(2);
        (, uint256 amount,,) = vault.epochs(0);
        assertGt(amount, 0, "epoch 0 did not fund");
    }

    // -------------------------------------------------------------- solvency as an equality

    function test_R4B_solvencyIsAnEqualityAcrossASweepAndTheEpochThatSpendsIt() public {
        _epochZeroWithResidue();
        _exact("epoch 0 open");
        vault.claim(ANCHOR, 0, 0);
        _exact("after a claim");

        vm.roll(vault.sweepableFrom(0));
        uint256 moved = vault.sweepResidue(0);
        assertGt(moved, 0, "nothing was swept");
        _exact("after the sweep");

        // ...and again when the bucket it landed in is spent by its own epoch.
        uint256 to = vault.currentInterval();
        vm.roll(vault.snapshotBlockFor(to + 1) + 1);
        vault.createEpochs(uint8(255));
        _exact("after the forward epoch opens");
        vault.claim(HELD, to, to);
        _exact("after the forward epoch is claimed");
    }

    // ------------------------------------------------- claim and sweep in the same block

    /// @notice Claim first, sweep second, same block: the sweep may only move what the claim left.
    function test_R4B_claimThenSweepInOneBlockMovesOnlyTheRemainder() public {
        _epochZeroWithResidue();
        vm.roll(vault.sweepableFrom(0));

        (, uint256 amount,, uint256 claimedBefore) = vault.epochs(0);
        uint256 paid = vault.claim(HELD, 0, 0);
        assertGt(paid, 0, "the claim paid nothing");
        (,,, uint256 claimedAfter) = vault.epochs(0);
        assertEq(claimedAfter, claimedBefore + paid, "claimed did not track the payout");

        uint256 moved = vault.sweepResidue(0);
        assertEq(moved, amount - claimedAfter, "the sweep moved more than the claim left");
        assertEq(paid + claimedBefore + moved, amount, "paid + swept != the epoch");
        _exact("claim then sweep");

        // And the epoch is now closed to everybody.
        vm.expectRevert(RewardVault.NothingToClaim.selector);
        vault.claim(SLOW, 0, 0);
    }

    /// @notice Sweep first, claim second, same block: the claim must be REFUSED, not paid out of a
    ///         bucket that now belongs to a later interval. This is the `amount <= claimed` skip.
    function test_R4B_sweepThenClaimInOneBlockPaysNothingTwice() public {
        _epochZeroWithResidue();
        vm.roll(vault.sweepableFrom(0));

        uint256 moved = vault.sweepResidue(0);
        assertGt(moved, 0, "nothing was swept");
        uint256 vaultBalance = address(vault).balance;

        // `HELD` carries a real weight in epoch 0 and has never claimed it.
        assertGt(vault.weightOf(HELD, 0), 0, "HELD has no weight, so this proves nothing");
        assertFalse(vault.hasClaimed(0, HELD), "HELD already claimed");
        vm.expectRevert(RewardVault.NothingToClaim.selector);
        vault.claim(HELD, 0, 0);
        assertEq(address(vault).balance, vaultBalance, "a claim moved money out of a swept epoch");
        _exact("sweep then claim");
    }

    // ------------------------------------------ the bucket a sweep writes is never a spent one

    /// @notice `intervalAt(block.number) >= epochs.length` at the two places it is tightest: with
    ///         the grid caught fully up, exactly ON a grid line, and with `k + 1 == epochs.length`.
    function test_R4B_aSweepNeverWritesABucketAnEpochHasSpent() public {
        _epochZeroWithResidue();

        // Catch the grid all the way up to the first block a sweep of epoch 0 is allowed.
        uint256 opensAt = vault.sweepableFrom(0);
        vm.roll(opensAt);
        vault.createEpochs(uint8(255));
        uint256 n = vault.epochCount();
        assertGt(n, 1, "the grid did not advance");

        // Now stand EXACTLY on a grid line — the block `snapshotBlockFor` names, not one past it.
        uint256 line = vault.snapshotBlockFor(n + 2);
        vm.roll(line);
        assertEq((vm.getBlockNumber() - genesis) % vault.EPOCH_BLOCKS(), 0, "not on a grid line");
        vault.createEpochs(uint8(255));
        uint256 count = vault.epochCount();
        uint256 at = vault.currentInterval();
        assertGe(at, count, "a sweep here would write a bucket an epoch has already spent");

        // `k + 1 == epochs.length`: the LAST epoch, the one closest to the current interval.
        uint256 k = count - 1;
        uint256 before = vault.pending(at);
        // The last epoch is far too young to sweep, which is itself the guard working.
        vm.expectRevert(
            abi.encodeWithSelector(RewardVault.ResidueNotMature.selector, k, vault.sweepableFrom(k))
        );
        vault.sweepResidue(k);

        // Epoch 0 is mature, and its destination is the CURRENT interval, never its own.
        uint256 moved = vault.sweepResidue(0);
        assertGt(moved, 0, "nothing was swept");
        assertEq(vault.pending(at), before + moved, "the sweep did not credit the current interval");
        assertGt(at, 0, "the sweep landed in interval 0");
        // Every bucket an epoch has already opened against is untouched.
        for (uint256 j; j < count; ++j) {
            assertEq(vault.pending(j), 0, "a bucket an epoch has spent was credited by a sweep");
        }
        _exact("grid-line sweep");
    }

    /// @notice `k >= epochs.length` is refused before `sweepableFrom` is ever evaluated, which is
    ///         what keeps a large `k` from reaching the multiplication at all.
    function test_R4B_sweepableFromCannotWrapAndABigKIsRefusedFirst() public {
        _epochZeroWithResidue();
        // HOISTED. `vault.sweepResidue(vault.epochCount())` evaluates the inner call AFTER
        // `expectRevert` is armed, and that inner call consumes the arming.
        uint256 n = vault.epochCount();
        vm.expectRevert(RewardVault.BadRange.selector);
        vault.sweepResidue(type(uint256).max);
        vm.expectRevert(RewardVault.BadRange.selector);
        vault.sweepResidue(n);

        // And the view itself panics on overflow rather than wrapping to a block already passed.
        vm.expectRevert(stdError.arithmeticError);
        vault.sweepableFrom(type(uint256).max);
    }

    // ---------------------------------------------------------------------------- fuzz

    /// @notice Over random maturities and random epochs: a sweep never writes a spent bucket, never
    ///         moves money out of the contract, and never breaks the exact ledger identity.
    function testFuzz_R4B_sweepPreservesTheLedgerAtEveryMaturity(uint8 k, uint16 extra, uint8 catchUp) public {
        _epochZeroWithResidue();
        uint256 idx = uint256(k) % vault.epochCount();
        uint256 target = vault.sweepableFrom(idx) + uint256(extra);
        vm.roll(target);
        if (catchUp % 2 == 0) vault.createEpochs(uint8(255));

        uint256 balBefore = address(vault).balance;
        uint256 count = vault.epochCount();
        uint256 at = vault.currentInterval();
        assertGe(at, count, "intervalAt fell behind epochs.length");

        try vault.sweepResidue(idx) returns (uint256 moved) {
            assertGt(moved, 0, "a successful sweep moved nothing");
            assertEq(address(vault).balance, balBefore, "a sweep moved money out of the vault");
            // The destination is at or beyond the next epoch to open — never a spent bucket.
            assertGe(vault.currentInterval(), count, "the sweep wrote a bucket an epoch has spent");
            (, uint256 amount,, uint256 claimed) = vault.epochs(idx);
            assertEq(claimed, amount, "the sweep left an obligation behind");
        } catch {}
        _exact("fuzz");
    }
}
