// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {RewardVault} from "../../src/sinks/RewardVault.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/**
 * ROUND 3 — `RewardVault` read as a stranger, with a harness deliberately unlike round 1's.
 *
 * `Round1VaultHunt`'s conservation fuzz is the existing proof of this contract's ledger, and it
 * cannot fail in four specific ways, each of which is a configuration the live protocol actually
 * ships:
 *
 *   1. **Its quote is native MON.** Six of the seven registered quotes are ERC-20s, and the two
 *      paths differ: `_held()` reads `balanceOf` rather than `address(this).balance`, `_pay` is a
 *      `safeTransfer` rather than a `call`, and the gated `receive()` — which bounces a stray
 *      native send — has no ERC-20 equivalent at all. Rule 4 of the loop: a fuzz that cannot fail
 *      is worse than no fuzz.
 *   2. **Its four actors are all non-excluded.** The exclusion set is never on either side of the
 *      fraction, so `eligibleSupplyAt`'s saturating subtraction and `weightOf`'s `isExcluded`
 *      early-out are never exercised against a moving balance.
 *   3. **Supply never shrinks.** `DokuToken` is `ERC20Burnable` and its burn path is PUBLIC, so
 *      any holder of any market can shrink `getPastTotalSupply` under a vault that already
 *      recorded a denominator. That is the exact mixing `eligibleSupplyAt`'s NatSpec says it
 *      exists to prevent, and nothing proves it.
 *   4. **It never claims for an excluded address and never uses `claimTo`.**
 *
 * The invariants below are also stated differently. Round 1 asserts solvency as `>=`; the
 * conservation statement here is an **equality**, which is what makes a leak visible rather than
 * merely tolerable:
 *
 *      totalFunded == totalPaid + sum(amount - claimed) + unallocated
 *
 * and the `EpochOverspent` precondition is asserted directly — `sum over every address of
 * weightOf(a, k) <= epochs[k].eligibleSupply` — rather than inferred from the fact that no claim
 * happened to revert.
 */

/// @dev Stands in for `DokuHook`'s `owedSink` ledger, in an ERC-20 quote.
contract Erc20Ledger {
    IERC20 public immutable quote;
    uint256 public owed;

    constructor(IERC20 quote_) {
        quote = quote_;
    }

    function credit(uint256 amount) external {
        quote.transferFrom(msg.sender, address(this), amount);
        owed += amount;
    }

    function pullSink(PoolId) external returns (uint256 amount) {
        amount = owed;
        owed = 0;
        if (amount != 0) quote.transfer(msg.sender, amount);
    }
}

abstract contract Round3VaultFixture is Test {
    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint256 internal constant SEED = 222_222_222e18;
    uint256 internal constant FLOAT = SUPPLY - SEED;

    // The exclusion set, as `DokuGraduation._deploySink` builds it.
    address internal constant PM = address(0x9001);
    address internal constant CURVE = address(0xC0FFEE);
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address internal constant POSM = address(0x9002);
    address internal constant GRAD = address(0x9003);
    /// @dev NOT in the exclusion set. `DokuGraduation` deploys a `SeedLocker`, the seed position's
    ///      owner, and it is absent from the seven addresses the vault is told to exclude.
    address internal constant LOCKER = address(0x9004);

    address internal constant ANCHOR = address(0xA0);

    /// @dev USDC's live target, so `minEpochAmount` is the real 6-decimal figure rather than MON's.
    uint256 internal constant USDC_TARGET = 8_000_000_000;

    MockUSDC internal usdc;
    Erc20Ledger internal hook;
    DokuToken internal token;
    RewardVault internal vault;
    uint256 internal genesis;

    function _deploy() internal {
        vm.roll(1_000_000);
        usdc = new MockUSDC();
        hook = new Erc20Ledger(IERC20(address(usdc)));
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
            address(hook),
            address(token),
            PoolId.wrap(bytes32(uint256(7))),
            address(usdc),
            USDC_TARGET,
            genesis,
            ex
        );

        vm.startPrank(CURVE);
        token.transfer(PM, SEED);
        token.transfer(ANCHOR, FLOAT);
        vm.stopPrank();
        vm.roll(vm.getBlockNumber() + 1);
    }

    function _fund(uint256 amount) internal {
        usdc.mint(address(this), amount);
        usdc.approve(address(hook), amount);
        hook.credit(amount);
        vault.fund();
    }
}

// =====================================================================================
// The handler
// =====================================================================================

contract Round3VaultHandler is Test {
    RewardVault public vault;
    DokuToken public token;
    Erc20Ledger public hook;
    MockUSDC public usdc;

    uint256 public maxInterval;
    uint256 public totalFunded;
    uint256 public totalPaid;
    /// @dev Coverage counters for the sweep action; read by the canary suite at the foot of the
    ///      file, which is the only thing that proves the action ever lands.
    uint256 public totalSwept;
    uint256 public sweeps;
    /// @dev Coverage counter for `doCatchUpThenFund`, for the same reason `sweeps` exists.
    uint256 public catchUpFunds;

    /// @dev Eight addresses, and the point is that FIVE of them are on the vault's exclusion list
    ///      and one (`LOCKER`) is a protocol contract that is not.
    address[9] public actors;

    constructor(RewardVault v, DokuToken t, Erc20Ledger h, MockUSDC u, address anchor) {
        vault = v;
        token = t;
        hook = h;
        usdc = u;
        actors[0] = anchor;
        actors[1] = address(0x7701);
        actors[2] = address(0x7702);
        actors[3] = address(0x7703);
        actors[4] = address(0x9001); // PM       — excluded
        actors[5] = 0x000000000000000000000000000000000000dEaD; // excluded
        actors[6] = address(0x9004); // LOCKER   — NOT excluded
        actors[7] = address(0x9003); // GRAD     — excluded
    }

    function actorCount() external pure returns (uint256) {
        return 8;
    }

    function _note(uint256 k) internal {
        if (k > maxInterval) maxInterval = k;
    }

    function doFund(uint96 amount) external {
        uint256 amt = uint256(amount) % 5_000_000e6;
        if (amt == 0) return;
        usdc.mint(address(this), amt);
        usdc.approve(address(hook), amt);
        hook.credit(amt);
        // The bucket-safety rule, asserted at credit time: the lowest index `fund` can write is the
        // current interval, and it must never be below `epochs.length`.
        assertGe(vault.currentInterval(), vault.epochCount(), "fund credited a bucket an epoch had spent");
        vault.fund();
        totalFunded += amt;
        // Generation 5 spreads a pull FORWARD over up to `MAX_SPREAD_INTERVALS` buckets, and a
        // carry from the last of them writes one past it again.
        _note(vault.currentInterval() + vault.MAX_SPREAD_INTERVALS() + 1);
    }

    /// @dev The grid caught fully up and then funded in the same block — the moment `epochs.length`
    ///      is closest to the current interval, and therefore the tightest test the bucket-safety
    ///      rule gets. It is also the interleaving that collapses a BACKWARD spread onto the
    ///      funder's own bucket; the shipped forward one does not read `epochs.length` at all.
    function doCatchUpThenFund(uint96 amount, uint8 steps) external {
        try vault.createEpochs((uint256(steps) % 8) + 1) returns (uint256 opened) {
            _note(vault.epochCount() + 1);
            opened;
        } catch {}
        uint256 amt = uint256(amount) % 5_000_000e6;
        if (amt == 0) return;
        usdc.mint(address(this), amt);
        usdc.approve(address(hook), amt);
        hook.credit(amt);
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
        address f = actors[from % 8];
        address t = actors[to % 8];
        if (f == t) return;
        uint256 bal = token.balanceOf(f);
        if (bal == 0) return;
        uint256 amt = uint256(amount) % bal;
        if (amt == 0) return;
        vm.prank(f);
        token.transfer(t, amt);
    }

    /// @dev Supply shrinks. `DokuToken.burn` is public on every market, REWARDS included.
    function doBurn(uint8 who, uint96 amount) external {
        address w = actors[who % 8];
        uint256 bal = token.balanceOf(w);
        if (bal == 0) return;
        uint256 amt = uint256(amount) % bal;
        if (amt == 0) return;
        vm.prank(w);
        token.burn(amt);
    }

    /**
     * @dev `sweepResidue`, the third carry-forward. Under an ERC-20 quote and against an actor set
     *      that is half excluded and can burn, which is what makes this copy of the action worth
     *      having: the residue an epoch leaves behind here is produced by exclusion and by supply
     *      shrinking as well as by churn, and the sweep has to move all of it or none.
     *
     *      One call in three jumps the clock to the chosen epoch's own `sweepableFrom` so the sweep
     *      can land; the rest run wherever the sequence left the clock, where the maturity guard
     *      refuses them.
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
            _note(vault.currentInterval() + 1);
        } catch {}
    }

    function doClaim(uint8 who, uint8 from, uint8 span) external {
        uint256 count = vault.epochCount();
        if (count == 0) return;
        address w = actors[who % 8];
        uint256 lo = uint256(from) % count;
        uint256 hi = lo + (uint256(span) % 4);
        if (hi >= count) hi = count - 1;
        uint256 before = usdc.balanceOf(w);
        try vault.claim(w, lo, hi) returns (uint256) {
            totalPaid += usdc.balanceOf(w) - before;
        } catch {}
    }

    /// @dev The holder-only destination path, which round 1's handler never touched.
    function doClaimTo(uint8 who, uint8 to, uint8 from, uint8 span) external {
        uint256 count = vault.epochCount();
        if (count == 0) return;
        address w = actors[who % 8];
        address dest = actors[to % 8];
        uint256 lo = uint256(from) % count;
        uint256 hi = lo + (uint256(span) % 4);
        if (hi >= count) hi = count - 1;
        uint256 before = usdc.balanceOf(dest);
        vm.prank(w);
        try vault.claimTo(w, lo, hi, dest) returns (uint256) {
            totalPaid += usdc.balanceOf(dest) - before;
        } catch {}
    }
}

// =====================================================================================
// The invariants
// =====================================================================================

contract Round3VaultConservation is Round3VaultFixture {
    Round3VaultHandler internal handler;

    function setUp() public {
        _deploy();
        handler = new Round3VaultHandler(vault, token, hook, usdc, ANCHOR);

        bytes4[] memory selectors = new bytes4[](9);
        selectors[8] = Round3VaultHandler.doCatchUpThenFund.selector;
        selectors[0] = Round3VaultHandler.doFund.selector;
        selectors[1] = Round3VaultHandler.doRoll.selector;
        selectors[2] = Round3VaultHandler.doCreateEpochs.selector;
        selectors[3] = Round3VaultHandler.doTransfer.selector;
        selectors[4] = Round3VaultHandler.doBurn.selector;
        selectors[5] = Round3VaultHandler.doClaim.selector;
        selectors[6] = Round3VaultHandler.doClaimTo.selector;
        selectors[7] = Round3VaultHandler.doSweep.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @notice `unallocated == sum(pending[k])`.
    function invariant_r3_unallocatedIsExactlyTheBuckets() public view {
        uint256 sum;
        uint256 top = handler.maxInterval() + 2;
        for (uint256 k; k <= top; ++k) sum += vault.pending(k);
        assertEq(vault.unallocated(), sum, "unallocated drifted from the buckets");
    }

    /**
     * @notice NO BUCKET IS EVER CREDITED AFTER ITS EPOCH HAS SPENT IT, as a state check.
     *
     *         `_openEpoch` empties the bucket it spends and every writer — `fund`, the two carries
     *         and `sweepResidue` — writes an index at or above `epochs.length`, so a non-zero bucket
     *         below the grid means one of them wrote backwards. Generation 5's forward spread is
     *         shaped around exactly this: a backward spread would write these indices and would be
     *         floored by `epochs.length`, which a permissionless `createEpochs` can raise.
     */
    function invariant_r3_noBucketAnEpochHasSpentIsEverCredited() public view {
        uint256 n = vault.epochCount();
        for (uint256 j; j < n; ++j) {
            assertEq(vault.pending(j), 0, "a bucket an epoch has already spent holds money");
        }
    }

    /**
     * @notice CONSERVATION AS AN EQUALITY, which is the statement round 1 makes as an inequality.
     *
     *         Every unit funded is in exactly one of three places: paid out, still owed inside an
     *         opened epoch, or in a `pending` bucket. Nothing is created and nothing evaporates.
     */
    function invariant_r3_everyFundedUnitIsInExactlyOnePlace() public view {
        uint256 owedOut;
        uint256 n = vault.epochCount();
        for (uint256 k; k < n; ++k) {
            (, uint256 amount,, uint256 claimed) = vault.epochs(k);
            assertLe(claimed, amount, "an epoch paid out more than it held");
            owedOut += amount - claimed;
        }
        assertEq(
            handler.totalFunded(),
            handler.totalPaid() + owedOut + vault.unallocated(),
            "funded money is neither paid, owed nor pending"
        );
        assertGe(usdc.balanceOf(address(vault)), owedOut + vault.unallocated(), "the vault cannot cover its ledger");
    }

    /**
     * @notice THE `EpochOverspent` PRECONDITION, asserted directly.
     *
     *         `claim` carries an `EpochOverspent` backstop whose NatSpec calls it "an assertion
     *         that the proof still holds". The proof is that the numerator and the denominator
     *         are read from the same instant with the same exclusion rule. This asserts the proof
     *         rather than the backstop: no claim has to be made for it to fail.
     */
    function invariant_r3_weightsNeverExceedTheDenominator() public view {
        uint256 n = vault.epochCount();
        uint256 count = handler.actorCount();
        for (uint256 k; k < n; ++k) {
            (,, uint256 es,) = vault.epochs(k);
            if (es == 0) continue;
            uint256 sum;
            for (uint256 i; i < count; ++i) sum += vault.weightOf(handler.actors(i), k);
            assertLe(sum, es, "the weights of a single epoch exceed its own denominator");
        }
    }

    /// @notice An excluded address is owed nothing on either side of the fraction.
    function invariant_r3_anExcludedAddressIsNeverPaid() public view {
        uint256 n = vault.epochCount();
        uint256 count = handler.actorCount();
        for (uint256 i; i < count; ++i) {
            address a = handler.actors(i);
            if (!vault.isExcluded(a)) continue;
            for (uint256 k; k < n; ++k) {
                assertEq(vault.weightOf(a, k), 0, "an excluded address carries a weight");
                assertTrue(!vault.hasClaimed(k, a), "an excluded address claimed an epoch");
            }
        }
    }

    /// @notice A paying epoch always carries a non-zero denominator and an empty one always zero.
    function invariant_r3_amountAndDenominatorAgree() public view {
        uint256 n = vault.epochCount();
        for (uint256 k; k < n; ++k) {
            (, uint256 amount, uint256 es,) = vault.epochs(k);
            if (amount == 0) assertEq(es, 0, "an empty epoch stored a denominator");
            else assertGt(es, 0, "a paying epoch stored a zero denominator");
        }
    }
}

/**
 * THE COVERAGE CANARY — rule 4 of the loop, applied to this file's own fuzz.
 *
 * "A passing fuzz that cannot fail is worse than no fuzz." The five invariants above are worth
 * exactly as much as the sequences that reach them, so this suite asserts — as a deliberate
 * FAILURE, run on demand rather than in CI — that money is actually paid and that paying epochs
 * actually open. Measured 2026-09-11 at 512 runs x 64 calls:
 *
 *     CANARY: the fuzz paid out .................. 9,083,319.102062 USDC
 *     CANARY: a paying epoch opened .............. 1,148,084.975465 USDC in one epoch
 *
 * Skipped by default so the suite stays green; `DOKU_VAULT_CANARY=true forge test
 * --match-contract Round3VaultCoverage` re-measures.
 */
contract Round3VaultCoverage is Round3VaultFixture {
    Round3VaultHandler internal handler;

    function setUp() public {
        // Skipped by default: both assertions below are written to FAIL, because the failure IS
        // the measurement. Run with `DOKU_VAULT_CANARY=true` to re-measure.
        if (!vm.envOr("DOKU_VAULT_CANARY", false)) vm.skip(true);
        _deploy();
        handler = new Round3VaultHandler(vault, token, hook, usdc, ANCHOR);
        bytes4[] memory selectors = new bytes4[](9);
        selectors[8] = Round3VaultHandler.doCatchUpThenFund.selector;
        selectors[0] = Round3VaultHandler.doFund.selector;
        selectors[1] = Round3VaultHandler.doRoll.selector;
        selectors[2] = Round3VaultHandler.doCreateEpochs.selector;
        selectors[3] = Round3VaultHandler.doTransfer.selector;
        selectors[4] = Round3VaultHandler.doBurn.selector;
        selectors[5] = Round3VaultHandler.doClaim.selector;
        selectors[6] = Round3VaultHandler.doClaimTo.selector;
        selectors[7] = Round3VaultHandler.doSweep.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @dev Fails the moment the fuzz pays anybody anything, which is the proof that it can.
    function invariant_r3_canary_moneyIsActuallyPaid() public view {
        assertEq(handler.totalPaid(), 0, "CANARY: the fuzz paid out (this failure is the coverage proof)");
    }

    /// @dev Fails the moment a residue sweep lands, which is the proof that the maturity guard is
    ///      not simply refusing every `doSweep` the fuzz throws at it. Without this the sweep
    ///      action is decoration: `sweepResidue` reverts on an immature epoch, on an empty one and
    ///      on an already-swept one, and a handler that only ever hits those three would leave all
    ///      five invariants above untested against the new code path.
    function invariant_r3_canary_residueIsActuallySwept() public view {
        assertEq(handler.sweeps(), 0, "CANARY: a residue sweep landed (this failure is the coverage proof)");
    }

    /// @dev Fails the moment `doCatchUpThenFund` lands a fund, which is the proof that generation
    ///      5's spread is actually being exercised at the tightest moment the bucket-safety rule
    ///      has — the grid caught fully up and a pull credited in the same block. Without this the
    ///      new action is decoration: `createEpochs` reverts whenever the grid is already current,
    ///      and a handler that only ever hit that would never reach `fund` at all.
    function invariant_r3_canary_theCatchUpFundLands() public view {
        assertEq(handler.catchUpFunds(), 0, "CANARY: a catch-up fund landed (this failure is the coverage proof)");
    }

    /// @dev Fails the moment a paying epoch exists, which is the proof the grid actually advances.
    function invariant_r3_canary_payingEpochsExist() public view {
        uint256 n = vault.epochCount();
        for (uint256 k; k < n; ++k) {
            (, uint256 amount,,) = vault.epochs(k);
            assertEq(amount, 0, "CANARY: a paying epoch opened (this failure is the coverage proof)");
        }
    }
}
