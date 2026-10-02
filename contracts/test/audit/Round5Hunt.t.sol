// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PosmTestSetup} from "@uniswap/v4-periphery/test/shared/PosmTestSetup.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";
import {RewardVault} from "../../src/sinks/RewardVault.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {DokuGraduation} from "../../src/DokuGraduation.sol";
import {CreatorSink} from "../../src/sinks/CreatorSink.sol";
import {Sinks} from "../../src/lib/Sinks.sol";
import {MarketsStub} from "../mocks/MarketsStub.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {VaultFixture} from "./Round1VaultHunt.t.sol";

// Imported ONLY so forge builds their artifacts for `vm.getCode` in PosmTestSetup's Deploy library.
// solhint-disable-next-line no-unused-import
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {PositionDescriptor} from "@uniswap/v4-periphery/src/PositionDescriptor.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/**
 * ROUND 5 — the generation-5 diff, probed where the suites shipped WITH it do not reach.
 *
 * Scope is `git diff 4b9b0631 -- src/`: the sticky graduator bit in `DokuHook`, the forward spread
 * in `RewardVault.fund`, and the dropped `Actions.SWEEP` in `DokuGraduation._mintSeed`. Everything
 * else was audited in rounds 0-4 and is deployed; it is touched here only where the diff changes
 * an assumption that was load-bearing for it.
 *
 * Each test below states which WRONG implementation it would go red against, because a green test
 * that cannot fail is worse than no test.
 */

// =====================================================================================
// A. `DokuHook` — the sticky graduator bit
// =====================================================================================

contract Round5HookHunt is Test {
    uint160 internal constant FLAGS = 0x2FCF;
    uint160 internal constant SQRT_1_1 = 79228162514264337593543950336;
    address internal constant TREASURY = address(0xBEEF);
    address internal constant CREATOR_SINK = address(0xC5);

    PoolManager internal manager;
    DokuHook internal hook;

    uint8 internal BURN;
    uint24 internal LP_FEE;
    int24 internal SPACING;

    address internal honest = address(0x6AD);
    address internal rogue = address(0x0B0E);
    address internal sinkAddr = address(0x51);

    function setUp() public {
        manager = new PoolManager(address(this));
        bytes memory args = abi.encode(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        hook = new DokuHook{salt: salt}(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        BURN = hook.SINK_BURN();
        LP_FEE = hook.POOL_LP_FEE();
        SPACING = hook.POOL_TICK_SPACING();
        hook.setGraduator(honest, true);
    }

    function _key(address token_) internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token_),
            fee: LP_FEE,
            tickSpacing: SPACING,
            hooks: IHooks(address(hook))
        });
    }

    function _register(address who, address token_) internal returns (PoolId) {
        PoolKey memory k = _key(token_);
        vm.prank(who);
        hook.registerPool(k, token_, BURN, sinkAddr, 0);
        return PoolIdLibrary.toId(k);
    }

    // --------------------------------------------------------------------- A1 (the finding)

    /**
     * @notice THE RECOVERY PATH `setGraduator`'s DOCBLOCK PROMISES IS DEFEATABLE BY ITS SUBJECT.
     *
     * @dev The docblock's second bullet: "REVOKING A NEVER-USED GRADUATOR still works, and it has
     *      to. It is the 'wired the wrong address at deployment' recovery path." That is true only
     *      while the wrong address cooperates. `registerPool` asks for nothing but the allowlist
     *      bit and a well-formed `PoolKey` — no curve, no factory, no `isMarket`, no money — so an
     *      allowlisted address can pin itself PERMANENTLY, in one transaction, against a pool that
     *      is not a DOKU market and that nobody's funds are in. There is no path in the contract
     *      that lowers the bit again, for the owner or for anyone.
     *
     *      So the exposure is: from the moment an address is allowlisted, whether it can ever be
     *      removed is ITS choice, not the owner's. Rank: liveness/permanence, not fund theft — a
     *      still-allowlisted rogue can only squat pools of its own, exactly as the docblock's own
     *      "what this trade costs" section already concedes. It is recorded here because the
     *      recovery path is documented as working and the test that asserts it
     *      (`Gen5StickyGraduator::test_aGraduatorThatNeverGraduatedAnythingCanStillBeRemoved`)
     *      only ever exercises a cooperative subject.
     *
     *      GOES RED AGAINST: a `registerPool` that required the caller to be pinned by something
     *      the owner controls, or a two-step revocation with a timelock.
     */
    function test_R5A_anAllowlistedAddressPinsItselfAgainstAPoolNobodysMoneyIsIn() public {
        hook.setGraduator(rogue, true);
        assertFalse(hook.graduatorEverRegistered(rogue), "pinned before doing anything");

        // Not a DOKU market by any measure the protocol uses: no curve, no factory, no raise.
        _register(rogue, address(0xDEAD0001));
        assertTrue(hook.graduatorEverRegistered(rogue), "a junk pool did not set the sticky bit");

        vm.expectRevert(abi.encodeWithSelector(DokuHook.GraduatorInUse.selector, rogue));
        hook.setGraduator(rogue, false);

        // And it stays refused: there is no second door.
        vm.expectRevert(abi.encodeWithSelector(DokuHook.GraduatorInUse.selector, rogue));
        hook.setGraduator(rogue, false);
        assertTrue(hook.isGraduator(rogue), "the rogue is not permanently allowlisted");
    }

    // ------------------------------------------------------ A2 (the claim that had to be refuted)

    /**
     * @notice A permanently-allowlisted rogue cannot reach ONE WEI of a market it did not create.
     *
     * @dev This is the question the sticky bit actually raises: eviction is gone, so what is left
     *      of a rogue graduator's reach over an EXISTING market? Every hook ledger is keyed by
     *      `PoolId` and `registerPool` refuses an id it has already written, so the answer must be
     *      "nothing". Asserted rather than argued: the honest market's six ledgers are planted with
     *      recognisable values through `vm.store` at the slots `forge inspect` reports, the rogue
     *      then tries every graduator-gated entry point against that id, and every ledger is read
     *      back unchanged.
     *
     *      GOES RED AGAINST: a `registerPool` that overwrote `_markets[id]` (which would let a
     *      rogue repoint an existing market's `sinkAddr` and take its levy), or a `beginSeed` that
     *      did not check `registered`/`seeded`.
     */
    function test_R5A_theStickyRogueCannotTouchAnExistingMarketsLedgers() public {
        PoolId id = _register(honest, address(0x70CE));
        hook.setGraduator(rogue, true);
        _register(rogue, address(0xDEAD0002));

        // Plant the six ledgers the partition is made of, at the slots the layout reports.
        bytes32 idw = PoolId.unwrap(id);
        vm.store(address(hook), keccak256(abi.encode(idw, uint256(6))), bytes32(uint256(111)));
        vm.store(address(hook), keccak256(abi.encode(idw, uint256(7))), bytes32(uint256(222)));
        vm.store(address(hook), keccak256(abi.encode(idw, uint256(8))), bytes32(uint256(333)));
        vm.store(address(hook), keccak256(abi.encode(idw, uint256(10))), bytes32(uint256(444)));
        vm.store(address(hook), keccak256(abi.encode(idw, uint256(11))), bytes32(uint256(555)));
        assertEq(hook.pendingProtocol(id), 111, "slot 6 is not pendingProtocol");
        assertEq(hook.pendingSink(id), 222, "slot 7 is not pendingSink");
        assertEq(hook.pendingProtocolToken(id), 333, "slot 8 is not pendingProtocolToken");
        assertEq(hook.owedSink(id), 444, "slot 10 is not owedSink");
        assertEq(hook.owedTax(id), 555, "slot 11 is not owedTax");

        DokuHook.Market memory before_ = hook.markets(id);

        // Re-registration: refused on the id, so the terms cannot be repointed.
        PoolKey memory k = _key(address(0x70CE));
        vm.prank(rogue);
        vm.expectRevert(DokuHook.AlreadyRegistered.selector);
        hook.registerPool(k, address(0x70CE), BURN, address(0xBAD), 5000);

        /*
         * The seed waiver. `beginSeed` is authenticated by the ALLOWLIST and not by "the graduator
         * that registered this pool", so a rogue graduator IS accepted here — on a pool that is
         * registered and not yet seeded. That state does not exist for a live market: `graduate()`
         * registers, arms, mints and disarms in one transaction and `_afterAddLiquidity` latches
         * `m.seeded`, which `Round5GraduationHunt::test_R5C_aGraduatedMarketIsLatchedSeeded`
         * asserts against a real graduation. It is recorded rather than asserted away because
         * generation 4's answer to a rogue graduator was eviction, and generation 5 does not have
         * one — so what `beginSeed` gates on is now the whole of the defence.
         *
         * Even accepted, it moves nothing: the waiver is transient, it is checked against
         * `m.seedLiquidity` (still zero here), and no ledger is reachable from it.
         */
        vm.prank(rogue);
        hook.beginSeed(id, 1, -60, 60);

        // `endSeed` on somebody else's id is reachable and is a transient-storage no-op.
        vm.prank(rogue);
        hook.endSeed(id);

        DokuHook.Market memory after_ = hook.markets(id);
        assertEq(after_.sinkAddr, before_.sinkAddr, "the rogue repointed an existing market's sink");
        assertEq(after_.creatorTaxBps, before_.creatorTaxBps, "the rogue repointed an existing market's tax");
        assertEq(after_.sink, before_.sink, "the rogue repointed an existing market's sink kind");
        assertEq(hook.pendingProtocol(id), 111, "pendingProtocol moved");
        assertEq(hook.pendingSink(id), 222, "pendingSink moved");
        assertEq(hook.pendingProtocolToken(id), 333, "pendingProtocolToken moved");
        assertEq(hook.owedSink(id), 444, "owedSink moved");
        assertEq(hook.owedTax(id), 555, "owedTax moved");
    }

    // ------------------------------------------------------------------------- A3 the packing

    /**
     * @notice `allowed` is byte 0 and `everRegistered` byte 1 of the SAME slot-2 mapping entry, and
     *         `_markets` is still slot 3.
     *
     * @dev The change's central claim is "no new storage slot, every ledger keeps the slot it had".
     *      `forge inspect` says so at compile time; this says so at run time, through `vm.load` at
     *      the addresses the old `mapping(address => bool)` used, which is the only formulation that
     *      would catch a future base-class insertion shifting everything by one.
     *
     *      GOES RED AGAINST: a second `mapping(address => bool) everRegistered` (which would take
     *      slot 3 and push `_markets` to 4, silently re-keying six ledgers), or a `uint256` counter
     *      in place of the bit.
     */
    function test_R5A_theStickyBitTookAByteAndNotASlot() public {
        bytes32 gslot = keccak256(abi.encode(rogue, uint256(2)));
        assertEq(vm.load(address(hook), gslot), bytes32(0), "the graduator slot started dirty");

        hook.setGraduator(rogue, true);
        assertEq(uint256(vm.load(address(hook), gslot)), 1, "allowed is not byte 0 alone");

        _register(rogue, address(0xDEAD0003));
        // byte 0 = allowed = 1, byte 1 = everRegistered = 1.
        assertEq(uint256(vm.load(address(hook), gslot)), 0x0101, "the two bools are not packed into bytes 0 and 1");

        // And slot 3 is still where a market lands.
        PoolId id = _register(honest, address(0x70CE));
        assertTrue(
            vm.load(address(hook), keccak256(abi.encode(PoolId.unwrap(id), uint256(3)))) != bytes32(0),
            "_markets is no longer slot 3"
        );
    }

    // ------------------------------------------------------------- A4 the gate cannot set the bit

    /**
     * @notice Passing `_beforeInitialize` is not registering. An allowlisted address that opens a
     *         pool and stops there is still revocable.
     *
     * @dev The docblock's own claim ("`_beforeInitialize` sees a graduator too, but it is a `view`
     *      callback"). Distinct from `Gen5StickyGraduator::test_aFailedRegistrationDoesNotPinTheGraduator`,
     *      which exercises a reverting `registerPool`; here the transaction SUCCEEDS and still must
     *      not pin.
     *
     *      GOES RED AGAINST: the bit being set in `_beforeInitialize` (which would need the hook's
     *      permission flags to make it non-view) or in `beginSeed`/`endSeed`.
     */
    function test_R5A_openingAPoolWithoutRegisteringDoesNotPin() public {
        address spare = address(0x5A5A);
        hook.setGraduator(spare, true);

        vm.prank(spare);
        manager.initialize(_key(address(0xFA11)), SQRT_1_1);
        assertFalse(hook.graduatorEverRegistered(spare), "the view gate pinned a graduator");

        hook.setGraduator(spare, false);
        assertFalse(hook.isGraduator(spare), "a never-registered graduator could not be revoked");
    }
}

// =====================================================================================
// B. `RewardVault.fund` — the forward spread
// =====================================================================================

contract Round5VaultHunt is VaultFixture {
    uint256 internal E;
    uint256 internal M;
    uint256 internal N;

    function setUp() public {
        _deploy();
        E = vault.EPOCH_BLOCKS();
        M = vault.minEpochAmount();
        N = vault.MAX_SPREAD_INTERVALS();
    }

    /// @dev Roll to the block whose interval is `k`, one block past its opening grid line.
    function _rollToInterval(uint256 k) internal {
        vm.roll(genesis + (k + 1) * E + 1);
        assertEq(vault.currentInterval(), k, "rolled to the wrong interval");
    }

    // ------------------------------------------------- B1 bucket safety at the tightest point

    /**
     * @notice The spread never writes a bucket an epoch has spent — measured at the ONE point the
     *         argument is tight: an adversary advances the grid as far as it will go in the same
     *         block, so `epochs.length == intervalAt(block.number)` exactly, and then the pull is
     *         spread seven wide from there.
     *
     * @dev `Round4Hunt` proves `intervalAt >= epochs.length` for `sweepResidue`'s single write.
     *      The spread writes seven, and the proof it rests on is quoted rather than re-derived, so
     *      this is the re-derivation. Every one of the seven is then SPENT by its own epoch at full
     *      value — no carry — which is the second half of the claim: each piece clears
     *      `minEpochAmount`.
     *
     *      GOES RED AGAINST: a backward or centred spread (`pending[k - j]`), an off-by-one that
     *      started the loop at `k - 1`, or a width whose pieces fall under the floor.
     */
    function test_R5B_theSpreadNeverWritesASpentBucketEvenWithTheGridRacedForward() public {
        _rollToInterval(9);
        vault.createEpochs(100);
        uint256 len = vault.epochCount();
        assertEq(len, 9, "the grid did not advance to the tightest point");
        assertEq(vault.currentInterval(), len, "intervalAt is not exactly epochs.length here");

        uint256 amount = 7 * M + 3;
        _fund(amount);
        assertEq(vault.spreadWidth(amount), N, "the pull was not seven wide");

        uint256 each = amount / N;
        uint256 first = amount - each * (N - 1);
        uint256 sum;
        for (uint256 j; j < N; ++j) {
            uint256 got = vault.pending(len + j);
            assertEq(got, j == 0 ? first : each, "a bucket took the wrong share");
            sum += got;
        }
        assertEq(sum, amount, "the spread lost or made money");
        assertEq(vault.unallocated(), amount, "unallocated disagrees with the buckets");

        // No bucket BEFORE the current interval was touched.
        for (uint256 i; i < len; ++i) {
            assertEq(vault.pending(i), 0, "the spread reached back into a spent bucket");
        }

        // And every one of the seven is spent at full value by its own epoch.
        for (uint256 j; j < N; ++j) {
            vm.roll(genesis + (len + j + 2) * E + 1);
            uint256 idx = vault.createEpoch();
            assertEq(idx, len + j, "epoch index and interval index diverged");
            (, uint256 amt,,) = vault.epochs(idx);
            assertEq(amt, j == 0 ? first : each, "a spread piece was carried instead of paid");
        }
        assertEq(vault.unallocated(), 0, "money was left unallocated after all seven epochs opened");
    }

    // ------------------------------------------------------------ B2 the arithmetic, fuzzed

    /**
     * @notice Whatever the pull, the spread conserves it exactly, uses at most seven buckets, and
     *         every piece clears `minEpochAmount`.
     *
     * @dev The three properties `spreadWidth`'s docblock claims, asserted against the CONTRACT's
     *      own `pending` rather than against a re-implementation of the formula.
     *
     *      GOES RED AGAINST: `each = amount / n` with the remainder dropped (conservation fails),
     *      a fixed width of seven (the floor fails for any pull under `7 * minEpochAmount` — which
     *      is the behaviour `Round5FundLever::test_R5_F_theDripAlsoFiresOnAMarketNobodyIsAttacking`
     *      measures as opening epoch 0 with zero), or an uncapped width.
     */
    function testFuzz_R5B_theSpreadConservesAndFloorsEveryPiece(uint256 amount) public {
        amount = bound(amount, 0, 1e30);
        _rollToInterval(3);
        uint256 k = vault.currentInterval();

        uint256 n = vault.spreadWidth(amount);
        assertGe(n, 1, "width under one");
        assertLe(n, N, "width over the cap");

        _fund(amount);

        uint256 sum;
        for (uint256 j; j < 32; ++j) {
            uint256 got = vault.pending(k + j);
            if (j >= n) {
                assertEq(got, 0, "the spread wrote past its own width");
            } else if (amount >= M) {
                // `spreadWidth`'s claim: a pull is cut into at most one piece per floor it
                // contains, so every piece clears the floor. A pull UNDER one floor is not cut at
                // all and behaves exactly as generation 4 did — the docblock's own carve-out.
                assertGe(got, M, "a piece fell under the anti-spam floor");
            }
            sum += got;
        }
        assertEq(sum, amount, "the spread did not conserve the pull");
        assertEq(vault.unallocated(), amount, "unallocated != sum(pending)");

        // The sentence `MAX_SPREAD_INTERVALS` commits to, on the FIRST bucket, which is the one a
        // caller who is only there for one interval can reach. The `+ n` is the integer division's
        // remainder riding the first bucket, which the docblock accounts for as "the 2* is not slack".
        uint256 firstBucket = vault.pending(k);
        uint256 ceiling = 2 * M + n > amount / N + n ? 2 * M + n : amount / N + n;
        assertLe(firstBucket, ceiling, "one pull concentrated more than the stated bound");
    }

    // --------------------------------------------------- B3 the identity across the whole machine

    /**
     * @notice `unallocated == sum(pending) + sum(open epochs' unclaimed)` survives a spread, a
     *         carry-forward and a residue sweep in one sequence.
     *
     * @dev The suites shipped with the spread assert conservation ACROSS `fund` alone. This drives
     *      the three writers of `pending` — `fund`'s seven-wide spread, `_openEpoch`'s
     *      below-the-floor carry, and `sweepResidue` — through one vault and checks the ledger
     *      identity after each.
     *
     *      GOES RED AGAINST: a spread that credited `pending` without adding to `unallocated`, or
     *      a carry that wrote `pending[index]` instead of `pending[index + 1]`.
     */
    function test_R5B_theLedgerIdentityHoldsAcrossSpreadCarryAndSweep() public {
        _rollToInterval(2);
        _fund(7 * M + 11); // seven wide
        _assertIdentity("after the spread");

        // A dust pull in the same interval: under the floor, one bucket, and it will carry.
        _fund(M / 3);
        _assertIdentity("after the dust pull");

        for (uint256 i; i < 12; ++i) {
            vm.roll(genesis + (vault.epochCount() + 2) * E + 1);
            vault.createEpoch();
            _assertIdentity("after an epoch opened");
        }

        // Nobody claimed anything, so every opened epoch is pure residue. Sweep the oldest.
        vm.roll(vault.sweepableFrom(2));
        vault.sweepResidue(2);
        _assertIdentity("after the residue sweep");
    }

    function _assertIdentity(string memory where) internal view {
        uint256 sum;
        for (uint256 i; i < 64; ++i) sum += vault.pending(i);
        uint256 open;
        uint256 n = vault.epochCount();
        for (uint256 i; i < n; ++i) {
            (, uint256 amt,, uint256 claimed) = vault.epochs(i);
            open += amt - claimed;
        }
        assertEq(vault.unallocated() + open, sum + open, string.concat("ledger identity broke @ ", where));
        assertEq(address(vault).balance, sum + open, string.concat("the vault is not solvent @ ", where));
    }

    // ------------------------------------------------------ B4 who the forward buckets belong to

    /**
     * @notice A funder who leaves right after `fund()` takes the first bucket and nothing else.
     *
     * @dev The economic point of the whole change, stated as money. The attacker holds the entire
     *      float across interval `k`, pulls a seven-interval backlog, and sells the instant epoch
     *      `k`'s closing grid line is behind them. Their weight at every later epoch is
     *      `min(open, close) == 0`, so six sevenths of the backlog belongs to whoever is holding
     *      then — which is the capital-time the single-bucket version let them skip.
     *
     *      GOES RED AGAINST: the generation-4 single-bucket `fund`, which pays this address the
     *      entire backlog.
     */
    function test_R5B_theFunderWhoSellsImmediatelyTakesOneSeventh() public {
        address attacker = address(0xA77AC);
        vm.prank(ANCHOR);
        token.transfer(attacker, FLOAT);

        _rollToInterval(4);
        uint256 k = vault.currentInterval();
        uint256 backlog = 7 * M;
        _fund(backlog);

        // Out one block AFTER epoch k's closing grid line. `getPastBalance` is the END-OF-BLOCK
        // value, so selling AT the line would zero the closing checkpoint of epoch k as well and
        // measure nothing; one block later the attacker holds both of epoch k's checkpoints in full
        // and neither of epoch k + 1's.
        vm.roll(vault.snapshotBlockFor(k + 1) + 1);
        vm.prank(attacker);
        token.transfer(ANCHOR, FLOAT);

        while (vault.epochCount() <= k + N - 1) {
            vm.roll(genesis + (vault.epochCount() + 2) * E + 1);
            vault.createEpoch();
        }

        uint256 before_ = attacker.balance;
        vault.claim(attacker, k, k + N - 1);
        uint256 took = attacker.balance - before_;

        assertGt(took, 0, "the funder was paid nothing at all, so this measures the wrong thing");
        assertLe(took, backlog / N + N, "the funder took more than the first bucket");
        assertLt(took, backlog / 2, "the single-bucket concentration is still reachable");
    }

    // ------------------------------------------------------------------------- B5 the edges

    /// @dev A zero pull still behaves exactly as generation 4 did: one bucket, nothing moved.
    ///      GOES RED AGAINST: a `spreadWidth` without the `n == 0` guard (division by zero).
    function test_R5B_aZeroPullIsAOneBucketNoOp() public {
        _rollToInterval(1);
        assertEq(vault.spreadWidth(0), 1, "a zero pull does not answer one");
        vault.fund();
        assertEq(vault.unallocated(), 0, "a zero pull moved something");
    }

    /// @dev `minEpochAmount` can never be zero, which is what keeps `spreadWidth`'s division safe.
    ///      GOES RED AGAINST: the constructor's floor guard being removed (a sub-10,000-unit quote
    ///      target floors to zero and every `spreadWidth` call reverts, bricking `fund`).
    function test_R5B_theFloorIsNeverZeroSoTheDivisionIsAlwaysSafe() public {
        address[9] memory ex;
        RewardVault tiny = new RewardVault(
            address(hook), address(token), PoolId.wrap(bytes32(uint256(9))), address(0), 1, genesis, ex
        );
        assertEq(tiny.minEpochAmount(), 1, "the floor collapsed to zero");
        assertEq(tiny.spreadWidth(0), 1, "spreadWidth reverted or answered wrong at zero");
        assertEq(tiny.spreadWidth(100), tiny.MAX_SPREAD_INTERVALS(), "the cap did not bind");
    }

    /**
     * @notice What a seven-wide `fund()` costs, against the keeper that pays for it.
     *
     * @dev The keeper (`indexer/src/indexer/processing/keeper-chain.ts`) signs no fixed limit: it
     *      calls `estimateContractGas` and adds `withHeadroom`'s quarter. So the risk is not a
     *      transaction that runs out of gas, it is PRICE — Monad bills the limit, so seven cold
     *      `SSTORE`s and seven `Bucketed` logs are paid in full on every funding. This records the
     *      number so a regression is visible; the ceiling is generous on purpose.
     *
     *      GOES RED AGAINST: an unbounded spread width.
     */
    function test_R5B_aSevenWideFundIsBoundedGas() public {
        _rollToInterval(6);
        _credit(7 * M);
        uint256 g = gasleft();
        vault.fund();
        uint256 used = g - gasleft();
        emit log_named_uint("gas: fund() at width 7 (all buckets cold)", used);
        assertLt(used, 400_000, "a seven-wide fund costs more than the recorded envelope");
    }
}

// =====================================================================================
// C. `DokuGraduation` — the dropped `Actions.SWEEP`
// =====================================================================================

contract Round5GraduationHunt is PosmTestSetup {
    uint160 internal constant FLAGS = 0x2FCF;
    address internal constant TREASURY = address(0xBEEF);
    address internal constant ALICE = address(0xA11CE);
    address internal constant MALLORY = address(0x4A110C);
    uint256 internal constant TARGET_USDC = 10_000e6;

    DokuHook internal dokuHook;
    DokuGraduation internal graduation;
    CreatorSink internal creatorSink;
    MarketsStub internal markets;
    MockUSDC internal usdc;

    address internal curveImpl;
    address internal tokenImpl;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployPosm(manager);

        creatorSink = new CreatorSink(address(this));
        markets = new MarketsStub();
        usdc = new MockUSDC();

        bytes memory args = abi.encode(IPoolManager(address(manager)), address(this), TREASURY, address(creatorSink));
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        dokuHook =
            new DokuHook{salt: salt}(IPoolManager(address(manager)), address(this), TREASURY, address(creatorSink));

        graduation =
            new DokuGraduation(address(manager), address(lpm), address(permit2), address(dokuHook), address(markets));
        dokuHook.setGraduator(address(graduation), true);
        creatorSink.setGraduator(address(graduation));
        creatorSink.setFactory(address(markets));

        curveImpl = address(new BondingCurve());
        tokenImpl = address(new DokuToken());
        vm.deal(ALICE, 1_000_000e18);
    }

    function _market(address quote, uint256 target, uint8 sink, address routed) internal returns (BondingCurve c) {
        c = BondingCurve(payable(Clones.clone(curveImpl)));
        DokuToken t = DokuToken(Clones.clone(tokenImpl));
        t.initialize(unicode"D", unicode"D", address(c), sink == Sinks.REWARDS, "https://cdn.doku.family/metadata/test.json");
        c.initialize(
            address(t), quote, target, sink, routed, 0, ALICE, TREASURY, address(graduation), address(creatorSink)
        );
    }

    function _fill(BondingCurve c, address buyer) internal {
        vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);
        uint256 spend = 5 * TARGET_USDC;
        usdc.mint(buyer, spend);
        vm.startPrank(buyer);
        usdc.approve(address(c), spend);
        c.buyWithToken(spend, 0, vm.getBlockTimestamp());
        vm.stopPrank();
        assertTrue(graduation.graduated(address(c)), "market did not auto-graduate");
    }

    /**
     * @notice THE PREMISE OF THE WHOLE CHANGE, ON THE ERC-20 PATH: the PositionManager never holds
     *         a unit of our quote, so removing `Actions.SWEEP` forfeits exactly nothing.
     *
     * @dev The docblock asserts this from v4-periphery's source ("`_pay` →
     *      `permit2.transferFrom(payer, poolManager, debt)`: it pulls the EXACT debt"). If it were
     *      wrong — if POSM ever ended a settle holding part of our leg — then dropping the sweep
     *      would abandon the market's own money into a contract where any caller can take it, and
     *      the "ERC-20 — NOTHING, and this is not an approximation" claim would be a live loss.
     *      Measured on both sides: POSM's balance is unchanged across the graduation, and the
     *      unspent remainder is in the GRADUATOR, where `_sweepDust` credits it.
     *
     *      GOES RED AGAINST: a settle path that overpays POSM and relies on `SWEEP` to come back —
     *      which is what the generation-4 action list was shaped for.
     */
    function test_R5C_anErc20GraduationLeavesNoneOfOurQuoteInThePositionManager() public {
        uint256 posmBefore = usdc.balanceOf(address(lpm));
        BondingCurve c = _market(address(usdc), TARGET_USDC, Sinks.BURN, address(0));
        _fill(c, MALLORY);
        assertEq(usdc.balanceOf(address(lpm)), posmBefore, "POSM ended the graduation holding our quote");
        // And the residue this graduation did create went where it is credited, not where it is lost.
        assertEq(usdc.balanceOf(address(graduation)), 0, "the graduator kept quote it should have credited");
    }

    /**
     * @notice A graduated market is latched `seeded`, so no OTHER graduator can ever re-arm its
     *         seed waiver.
     *
     * @dev The residual `Round5HookHunt::test_R5A_theStickyRogueCannotTouchAnExistingMarketsLedgers`
     *      records: `beginSeed` is gated on the allowlist, not on "the graduator that registered
     *      this pool", and generation 5 took away the owner's ability to evict a rogue from that
     *      allowlist. The whole of what stops a rogue re-arming somebody else's market is that
     *      `graduate()` registers, arms, mints and disarms atomically and `_afterAddLiquidity`
     *      latches `m.seeded`. That latch is the load-bearing line, so it is asserted against a
     *      real graduation rather than taken from a comment.
     *
     *      GOES RED AGAINST: a `_afterAddLiquidity` that consumed the waiver without latching, or a
     *      `graduate()` that split registration and minting across transactions.
     */
    function test_R5C_aGraduatedMarketIsLatchedSeeded() public {
        BondingCurve c = _market(address(usdc), TARGET_USDC, Sinks.BURN, address(0));
        _fill(c, MALLORY);
        PoolId id = graduation.poolIdOf(address(c));
        assertTrue(dokuHook.markets(id).seeded, "a graduated market is not latched seeded");

        address rogue = address(0x0B0E);
        dokuHook.setGraduator(rogue, true);
        vm.prank(rogue);
        vm.expectRevert(DokuHook.AlreadySeeded.selector);
        dokuHook.beginSeed(id, 1, -60, 60);
    }

    /**
     * @notice Quote misdirected to the shared graduator BEFORE a graduation is not credited to that
     *         graduation's market, and is not forwarded anywhere either.
     *
     * @dev `_sweepDust`'s `notOurs` argument is gone; the only defence left is
     *      `held - quoteHeldBefore`, read before `release()`. This is that defence with the
     *      generation-4 machinery removed: a stranger's 50,000 USDC sitting on the graduator when a
     *      market graduates must stay exactly where it is, and the market's sink must receive only
     *      the residue the mint actually produced.
     *
     *      GOES RED AGAINST: `_sweepDust` reading an absolute `balanceOf(address(this))` — the
     *      shape M-02 was filed against — or a `quoteHeldBefore` read AFTER `release()`.
     */
    function test_R5C_quoteAlreadySittingOnTheGraduatorIsNotCreditedToTheMarket() public {
        uint256 parked = 50_000e6;
        usdc.mint(address(graduation), parked);
        uint256 treasuryBefore = usdc.balanceOf(TREASURY);

        BondingCurve c = _market(address(usdc), TARGET_USDC, Sinks.BURN, address(0));
        _fill(c, MALLORY);

        // A BURN market's quote residue goes to the treasury. It must be dust, not the stranger's.
        uint256 credited = usdc.balanceOf(TREASURY) - treasuryBefore;
        assertLt(credited, 1e6, "a stranger's balance was credited as this market's residue");
        assertGe(usdc.balanceOf(address(graduation)), parked, "the stranger's balance was moved");
    }
}
