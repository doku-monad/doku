// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {LiquidityAmounts} from "@uniswap/v4-core/test/utils/LiquidityAmounts.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";

/// @dev A DOKU market's token supply is 1,000,000,000 — see `test/Supply1B.t.sol` — and 222,222,222
///      of it is the graduation seed. The mint here is deliberately far larger than that, because
///      several points in the sweep need MORE INVENTORY THAN THE MARKET HAS and the useful thing is
///      to see how far past the supply they land, not to have the harness revert on it. Every
///      capital figure is reported against `REAL_SUPPLY` so the gap is visible.
contract JitTok is ERC20 {
    constructor() ERC20("Jit Market", "JIT") {
        _mint(msg.sender, 1e33);
    }
}

/**
 * M-04 — "post-swap donations remain exposed to concentrated JIT liquidity".
 *
 * THE CLAIM. `_settleLeg` (DokuHook.sol:489-510) pushes the 70 bps LP share of the swap levy into
 * `poolManager.donate`, which credits whatever liquidity is in range AT THE POST-SWAP TICK. A
 * searcher can therefore mint a narrow position around the tick the victim's trade will end on,
 * collect the donation, and leave — diluting the permanent locked seed. The report notes that the
 * recorded token-side maker rate is zero, so a single-sided TOKEN range order enters free.
 *
 * WHAT THIS FILE DOES ABOUT IT. The finding is economic, so it is only real if it PAYS. This is a
 * measurement, not an argument:
 *
 *   - It forks Monad MAINNET at head and builds the market on the REAL, DEPLOYED, IMMUTABLE
 *     generation-3 hook at 0xb1A67a7c8000a86e0b1E5C019EBf859ce71C6Fcf, through the REAL Uniswap v4
 *     PoolManager, with the REAL graduation contract pranked as the graduator. The bytecode under
 *     attack is the bytecode on the chain, not a local recompile.
 *
 *   - The seed is the shipped one: `DOKU_SEED_BASE` = 222,222,222 tokens against the shipped MON
 *     quote target of 305,868.390948742537150460 MON, full range on tick spacing 60, minted through
 *     the hook's own `beginSeed` waiver — i.e. exactly what `DokuGraduation._seed` produces.
 *
 *   - Every run reports the donation the JIT captured, the donation the seed captured, the levies
 *     the searcher actually paid on entry and exit, their inventory change valued at the exit
 *     price, and the gas. MONAD BILLS THE GAS LIMIT, NOT THE GAS USED, so the cost line is computed
 *     from the limit a searcher must set (measured consumption plus headroom), never from
 *     consumption.
 *
 * There are zero graduated generation-3 markets on Monad mainnet as of the head block this forks —
 * `PoolRegistered` on the live hook returns nothing across 103,427,913..head, and gen-2's hook
 * returns nothing either. So this pool is the one the protocol WILL have, built to its own shipped
 * numbers, rather than one it has.
 *
 * ## WHAT THIS FILE MEANS AFTER ROUND 4
 *
 * Read the two hooks in here as two different eras, because that is what they are.
 *
 *   `rewards` / `burn`  — the LIVE, DEPLOYED generation-3 bytecode at 0xb1A6…6Fcf. It donates, it
 *                         always will, and nothing in `src/` can change it. Every sweep below that
 *                         drives these markets still measures the attack PAYING, and those numbers
 *                         are the record of why the design moved. They are not stale; they are the
 *                         chain.
 *
 *   `fixedRewards`      — a hook compiled from `src/v4/DokuHook.sol` as it stands, deployed onto
 *                         the same fork at a freshly mined address. Round 0 built this column to
 *                         show the symmetric maker levy pricing the attack out. Since round 4 it
 *                         shows something strictly stronger, and `test_M04_fixKillsTheAttack`
 *                         asserts it: the searcher does not merely lose money, it collects EXACTLY
 *                         ZERO, because `_settleLeg` no longer donates at all. The 70 bps goes to
 *                         `pendingSink`, where no position can reach it at any width, any anchor
 *                         and any liquidity multiple.
 *
 * The value of the pairing is the same as it always was: the two columns differ in one contract,
 * on one fork, against one seed, and the difference is legible in the printed report.
 */
contract HookJitDonateForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    // ------------------------------------------------------------------ the live chain

    uint256 constant MONAD_MAINNET = 143;
    address constant POOL_MANAGER = 0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e;
    address constant DOKU_HOOK = 0xb1A67a7c8000a86e0b1E5C019EBf859ce71C6Fcf;
    address constant DOKU_GRADUATION = 0x98fC11774910c62b2Dd15Be11758C6740ac9940E;

    /// @dev The shipped MON quote target and seed base. Both are protocol constants, not test
    ///      numbers: `QuoteRegistry`'s MON target and `BondingCurve.DOKU_SEED_BASE`.
    uint256 constant TARGET_MON = 305_868_390_948_742_537_150_460;
    uint256 constant SEED_BASE = 222_222_222e18;
    /// @dev A DOKU token's whole supply. The searcher's inventory is measured against it.
    uint256 constant REAL_SUPPLY = 1_000_000_000e18;
    int24 constant SPACING = 60;

    /// @dev Monad's base fee at the head this was measured against, read with `cast base-fee`.
    ///      100 gwei; `cast gas-price` quotes 102. Used only to price gas, never to bound it.
    uint256 constant MONAD_BASE_FEE = 100 gwei;

    /// @dev The headroom a searcher must actually send on Monad. The chain bills and bounds by the
    ///      LIMIT, and forge's estimator sets the limit to its estimate with no slack — which is
    ///      how a correct transaction reverts with `gasUsed == gasLimit` (docs/doku/deployments.md,
    ///      "Monad charges the gas LIMIT"). 1.5x measured consumption is the smallest multiple
    ///      anyone shipping this would dare; the deploy log records a 1.5% shortfall bricking a
    ///      real transaction at 1.0x.
    uint256 constant GAS_HEADROOM_NUM = 3;
    uint256 constant GAS_HEADROOM_DEN = 2;

    /// @dev One EVM transaction's fixed cost, paid three times by a searcher who does not bundle
    ///      add / observe / remove into one contract call. Counted ONCE here, which is the
    ///      searcher-favourable reading: the whole bundle is assumed to be a single call.
    uint256 constant INTRINSIC_GAS = 21_000;

    IPoolManager pm;
    DokuHook hook;
    PoolSwapTest swapper;
    PoolModifyLiquidityTest lp;

    bytes32 constant SEED_SALT = bytes32(uint256(0x5EED));
    bytes32 constant JIT_SALT = bytes32(uint256(0x11700));

    address constant VICTIM = address(0xF1C71);

    struct Market {
        PoolKey key;
        PoolId id;
        JitTok tok;
        uint128 seedLiquidity;
        int24 seedLo;
        int24 seedHi;
        /// @dev Which hook this market's pool carries. Every measurement below is run twice: once
        ///      against the LIVE, IMMUTABLE generation-3 hook, and once against a hook compiled
        ///      from `src/v4/DokuHook.sol` as it stands after the fix, so the two numbers differ by
        ///      the fix and by nothing else.
        DokuHook hk;
        address grad;
    }

    Market rewards; // non-BURN: the LP share is 70 bps of the QUOTE leg
    Market burn; // BURN:     the LP share is 70 bps of the TOKEN leg
    Market fixedRewards; // the same market, on the patched hook

    bool forked;

    receive() external payable {}

    // --------------------------------------------------------------------------- setup

    function setUp() public {
        string memory url = vm.envOr("MONAD_RPC_URL", string(""));
        if (bytes(url).length == 0) return;
        uint256 pinned = vm.envOr("MONAD_FORK_BLOCK", uint256(0));
        if (pinned == 0) vm.createSelectFork(url);
        else vm.createSelectFork(url, pinned);
        require(block.chainid == MONAD_MAINNET, "not Monad mainnet");
        forked = true;

        pm = IPoolManager(POOL_MANAGER);
        hook = DokuHook(payable(DOKU_HOOK));
        swapper = new PoolSwapTest(pm);
        lp = new PoolModifyLiquidityTest(pm);

        vm.deal(address(this), 100_000_000 ether);
        vm.deal(VICTIM, 100_000_000 ether);

        _build(rewards, hook.SINK_REWARDS(), hook, DOKU_GRADUATION);
        _build(burn, hook.SINK_BURN(), hook, DOKU_GRADUATION);

        // The patched hook, deployed onto the same fork at a freshly mined address. It is the same
        // Uniswap singleton, the same seed, the same tick spacing and the same shipped numbers —
        // the only difference between `rewards` and `fixedRewards` is the contract under test.
        bytes memory args = abi.encode(pm, address(this), address(0xBEEF), address(0xC5));
        (, bytes32 salt) = HookMiner.find(address(this), 0x2FCF, type(DokuHook).creationCode, args);
        DokuHook patched = new DokuHook{salt: salt}(pm, address(this), address(0xBEEF), address(0xC5));
        patched.setGraduator(address(this), true);
        _build(fixedRewards, patched.SINK_REWARDS(), patched, address(this));
    }

    /// @dev Reproduces `DokuGraduation._seed` exactly: the same price derivation, the same full
    ///      range on spacing 60, the same `getLiquidityForAmounts`, the same
    ///      `registerPool` -> `beginSeed` -> mint -> `endSeed` order, and therefore the same waived
    ///      seed. Driven as the real graduator so the live hook's `NotGraduator` gate is satisfied
    ///      the way it is in production.
    function _build(Market storage m, uint8 sink, DokuHook hk, address grad) internal {
        m.hk = hk;
        m.grad = grad;
        m.tok = new JitTok();
        m.key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(m.tok)),
            fee: 0,
            tickSpacing: SPACING,
            hooks: IHooks(address(hk))
        });
        m.id = m.key.toId();
        m.seedLo = TickMath.minUsableTick(SPACING);
        m.seedHi = TickMath.maxUsableTick(SPACING);

        uint160 sqrtP = _sqrtPriceX96(TARGET_MON, SEED_BASE);
        m.seedLiquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtP,
            TickMath.getSqrtPriceAtTick(m.seedLo),
            TickMath.getSqrtPriceAtTick(m.seedHi),
            TARGET_MON,
            SEED_BASE
        );

        vm.startPrank(grad);
        pm.initialize(m.key, sqrtP);
        hk.registerPool(m.key, address(m.tok), sink, address(0x51), 0);
        hk.beginSeed(m.id, m.seedLiquidity, m.seedLo, m.seedHi);
        vm.stopPrank();

        m.tok.approve(address(lp), type(uint256).max);
        m.tok.approve(address(swapper), type(uint256).max);
        lp.modifyLiquidity{value: TARGET_MON * 2}(
            m.key,
            ModifyLiquidityParams({
                tickLower: m.seedLo,
                tickUpper: m.seedHi,
                liquidityDelta: int256(uint256(m.seedLiquidity)),
                salt: SEED_SALT
            }),
            ""
        );
        vm.prank(grad);
        hk.endSeed(m.id);

        // The waiver has to have BEEN taken, or the seed paid a maker levy and this is not the
        // pool graduation builds.
        assertTrue(hk.markets(m.id).seeded, "the seed waiver was not consumed");
        assertEq(pm.getLiquidity(m.id), m.seedLiquidity, "seed liquidity is not what graduation mints");
    }

    /// @dev `DokuGraduation._sqrtPriceX96`, verbatim. Restated rather than imported because the
    ///      function is `internal` and the point here is to build the identical pool, not to reuse
    ///      the code that builds it.
    function _sqrtPriceX96(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        if (amount1 < (1 << 64) * amount0) {
            return uint160(FixedPointMathLib.sqrt(FixedPointMathLib.fullMulDiv(amount1, 1 << 192, amount0)));
        }
        return uint160(FixedPointMathLib.sqrt(FixedPointMathLib.fullMulDiv(amount1, 1 << 96, amount0)) << 48);
    }

    // ------------------------------------------------------------------------ primitives

    /// @dev Every bucket the maker levy can land in, valued in the market's QUOTE so the entry and
    ///      exit tolls are one number. `pendingProtocolToken` exists only on the patched hook, and
    ///      the token side has to be priced or the fix's cost to the searcher is invisible.
    function _ledgerOf(Market storage m) internal view returns (uint256) {
        uint256 q = m.hk.pendingProtocol(m.id) + m.hk.pendingSink(m.id);
        if (address(m.hk) == DOKU_HOOK) return q; // generation 3 has no token bucket
        return q + _tokInMon(m.id, m.hk.pendingProtocolToken(m.id));
    }

    function _tick(PoolId id) internal view returns (int24 t) {
        (, t,,) = pm.getSlot0(id);
    }

    function _sqrt(PoolId id) internal view returns (uint160 s) {
        (s,,,) = pm.getSlot0(id);
    }

    /// @dev Value a token amount in MON at the CURRENT marginal price. MON per token is
    ///      `(2**96 / sqrtP)**2`, done in two `mulDiv`s so nothing overflows. This is a marginal
    ///      valuation and therefore GENEROUS to the searcher: realising it through this same pool
    ///      would cost slippage and another 100 bps of levy.
    function _tokInMon(PoolId id, uint256 amt) internal view returns (uint256) {
        uint256 s = uint256(_sqrt(id));
        return FullMath.mulDiv(FullMath.mulDiv(amt, 1 << 96, s), 1 << 96, s);
    }

    function _ceil60(int24 t) internal pure returns (int24) {
        int24 q = t / SPACING;
        if (t > 0 && t % SPACING != 0) q += 1;
        return q * SPACING;
    }

    function _floor60(int24 t) internal pure returns (int24) {
        int24 q = t / SPACING;
        if (t < 0 && t % SPACING != 0) q -= 1;
        return q * SPACING;
    }

    /// @dev The victim's trade. `buy` is MON in for tokens out (zeroForOne, tick falls); the sell is
    ///      the mirror. Exact input in both directions, which is the shape every launchpad frontend
    ///      emits.
    function _victim(Market storage m, uint256 size, bool buy) internal {
        vm.startPrank(VICTIM);
        if (buy) {
            swapper.swap{value: size}(
                m.key,
                SwapParams({zeroForOne: true, amountSpecified: -int256(size), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                ""
            );
        } else {
            m.tok.approve(address(swapper), type(uint256).max);
            swapper.swap(
                m.key,
                SwapParams({zeroForOne: false, amountSpecified: -int256(size), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1}),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                ""
            );
        }
        vm.stopPrank();
    }

    /// @dev Fund the victim for a SELL: they need tokens, so buy them some first and measure from
    ///      after that. Returns the token amount to sell.
    function _fundVictimTokens(Market storage m, uint256 monSpend) internal returns (uint256) {
        uint256 before = m.tok.balanceOf(VICTIM);
        _victim(m, monSpend, true);
        return m.tok.balanceOf(VICTIM) - before;
    }

    // ------------------------------------------------------------------------ the attack

    struct Run {
        // shape
        uint256 victimQuote; // the victim's trade, in MON (or its token equivalent for a sell)
        uint256 liqMult; // JIT liquidity as a multiple of the seed's
        int24 width; // JIT range width in ticks
        // capture
        uint256 donationTotal; // 70 bps of the levied leg, whatever the pool received
        uint256 jitFees0; // donation the JIT position collected, currency0
        uint256 jitFees1; // ... currency1
        uint256 seedFees0; // donation the seed collected in the same bundle
        uint256 seedFees1;
        uint256 seedFeesAlone0; // what the seed would have collected with no JIT present
        uint256 seedFeesAlone1;
        // cost
        uint256 makerLevyPaid; // hook ledger movement caused by the JIT's own add and remove
        int256 netMon; // searcher's MON delta over the bundle
        int256 netTok; // searcher's token delta over the bundle
        int256 netWealth; // netMon + netTok valued at the exit price
        uint256 gasUsed; // add + remove + collect, measured
        uint256 gasBilled; // what Monad bills: the LIMIT a searcher must set
        uint256 gasCostMon;
        // capital -- the axis that actually decides this
        uint256 capital0; // MON the entry deposited
        uint256 capital1; // tokens the entry deposited
        uint256 capitalMon; // both, valued in MON at the ENTRY price
        uint256 seedCapitalMon; // the seed's own capital, for scale
        int256 roiBps; // net after gas, as bps of capital, for ONE bundle
        bool inRange; // did the JIT actually end in range? (if not it captured nothing)
        bool singleSidedEntry; // did the entry deposit only one currency?
    }

    /// @notice One full same-block bundle: add a narrow position on the side the price is moving
    ///         into, let the victim swap through the hook, collect, remove, settle.
    ///
    /// @dev The range is anchored at the tick-spacing boundary just PAST the current tick on the
    ///      side the trade moves toward, so the position is single-sided at entry — the shape the
    ///      report names, and the shape the recorded maker rates make free on the token side. `hi`
    ///      is placed strictly beyond the current tick so that entry cannot be two-sided.
    ///
    ///      Anchoring at the current tick rather than at the tick the victim's trade WOULD have
    ///      ended on is deliberate and is the searcher-favourable choice: adding liquidity moves
    ///      where the trade ends, so a range aimed at the unperturbed end tick is frequently missed
    ///      entirely, whereas a range starting at the current tick is entered immediately and — at
    ///      any liquidity multiple worth the capital — is where the trade stops.
    function _bundle(Market storage m, uint256 victimSize, bool buy, uint256 liqMult, int24 width)
        internal
        returns (Run memory r)
    {
        return _bundle(m, victimSize, buy, liqMult, width, false);
    }

    /// @dev `straddle` selects the OTHER shape: a range spanning the current tick, which is in range
    ///      from the first wei of the trade and therefore always collects — at the price of being
    ///      two-sided at entry, which means depositing the QUOTE and paying the recorded 30 bps
    ///      maker levy on it. The free single-sided entry the report names only collects when the
    ///      victim's trade is big enough to cross a whole tick-spacing boundary, because a position
    ///      that is single-sided in the token must start strictly BELOW the current tick.
    function _bundle(Market storage m, uint256 victimSize, bool buy, uint256 liqMult, int24 width, bool straddle)
        internal
        returns (Run memory r)
    {
        r.victimQuote = victimSize;
        r.liqMult = liqMult;
        r.width = width;

        int24 cur = _tick(m.id);
        int24 lo;
        int24 hi;
        if (straddle) {
            lo = _floor60(cur) - width;
            hi = _floor60(cur) + SPACING;
        } else if (buy) {
            hi = _floor60(cur);
            if (hi == cur) hi -= SPACING; // strictly below: all currency1, no quote leg on entry
            lo = hi - width;
        } else {
            lo = _ceil60(cur);
            if (lo == cur) lo += SPACING; // strictly above: all currency0
            hi = lo + width;
        }

        uint256 jitL = uint256(m.seedLiquidity) * liqMult;

        uint256 mon0 = address(this).balance;
        uint256 tok0 = m.tok.balanceOf(address(this));
        uint256 ledger0 = _ledgerOf(m);

        uint256 g = gasleft();
        BalanceDelta addD = lp.modifyLiquidity{value: TARGET_MON * 20}(
            m.key,
            ModifyLiquidityParams({tickLower: lo, tickUpper: hi, liquidityDelta: int256(jitL), salt: JIT_SALT}),
            ""
        );
        r.gasUsed = g - gasleft();
        r.singleSidedEntry = (addD.amount0() == 0 || addD.amount1() == 0);
        r.capital0 = addD.amount0() < 0 ? uint256(uint128(-addD.amount0())) : 0;
        r.capital1 = addD.amount1() < 0 ? uint256(uint128(-addD.amount1())) : 0;
        // Valued at the ENTRY price -- i.e. what the searcher had to be holding before the bundle,
        // not what it is worth after their own liquidity has moved the trade.
        r.capitalMon = r.capital0 + _tokInMon(m.id, r.capital1);
        uint256 ledgerAfterAdd = _ledgerOf(m);

        _victim(m, victimSize, buy);

        int24 endTick = _tick(m.id);
        r.inRange = endTick >= lo && endTick < hi;
        uint256 ledgerBeforeExit = _ledgerOf(m);

        g = gasleft();
        BalanceDelta collectD = lp.modifyLiquidity(
            m.key, ModifyLiquidityParams({tickLower: lo, tickUpper: hi, liquidityDelta: 0, salt: JIT_SALT}), ""
        );
        BalanceDelta rmD = lp.modifyLiquidity(
            m.key,
            ModifyLiquidityParams({tickLower: lo, tickUpper: hi, liquidityDelta: -int256(jitL), salt: JIT_SALT}),
            ""
        );
        r.gasUsed += g - gasleft();
        rmD; // the wealth accounting below reads balances, not deltas

        r.jitFees0 = collectD.amount0() > 0 ? uint256(uint128(collectD.amount0())) : 0;
        r.jitFees1 = collectD.amount1() > 0 ? uint256(uint128(collectD.amount1())) : 0;

        // THE SEARCHER'S BOOKS CLOSE HERE, before the seed is touched. The seed position in this
        // harness is held by the same router and its collect pays out to this contract, so reading
        // balances after it would credit the searcher with the seed's donation — a mistake worth
        // naming, because it makes the attack look profitable at every size.
        int256 dMon = int256(address(this).balance) - int256(mon0);
        int256 dTok = int256(m.tok.balanceOf(address(this))) - int256(tok0);
        r.netMon = dMon;
        r.netTok = dTok;
        int256 dTokMon =
            dTok >= 0 ? int256(_tokInMon(m.id, uint256(dTok))) : -int256(_tokInMon(m.id, uint256(-dTok)));
        r.netWealth = dMon + dTokMon;

        // The maker levy the searcher actually paid: the hook-ledger movement across their own add
        // plus the movement across their own remove. The victim's swap levy sits between the two
        // and is excluded by construction.
        r.makerLevyPaid = (ledgerAfterAdd - ledger0) + (_ledgerOf(m) - ledgerBeforeExit);

        // Measurement only, after the books are closed: what the seed captured in the same bundle.
        BalanceDelta seedCollect = lp.modifyLiquidity(
            m.key,
            ModifyLiquidityParams({tickLower: m.seedLo, tickUpper: m.seedHi, liquidityDelta: 0, salt: SEED_SALT}),
            ""
        );
        r.seedFees0 = seedCollect.amount0() > 0 ? uint256(uint128(seedCollect.amount0())) : 0;
        r.seedFees1 = seedCollect.amount1() > 0 ? uint256(uint128(seedCollect.amount1())) : 0;
        r.donationTotal = r.jitFees0 + r.seedFees0 + r.jitFees1 + r.seedFees1;

        r.gasUsed += INTRINSIC_GAS;
        r.gasBilled = (r.gasUsed * GAS_HEADROOM_NUM) / GAS_HEADROOM_DEN;
        r.gasCostMon = r.gasBilled * MONAD_BASE_FEE;
        r.seedCapitalMon = TARGET_MON * 2; // the seed is TARGET_MON of quote plus its token match
        int256 afterGas = r.netWealth - int256(r.gasCostMon);
        r.roiBps = r.capitalMon == 0 ? int256(0) : (afterGas * 10_000) / int256(r.capitalMon);
    }

    /// @dev The same victim trade with no JIT present, so the seed's undiluted take is known.
    function _baseline(Market storage m, uint256 victimSize, bool buy)
        internal
        returns (uint256 f0, uint256 f1, int24 endTick)
    {
        _victim(m, victimSize, buy);
        endTick = _tick(m.id);
        BalanceDelta d = lp.modifyLiquidity(
            m.key,
            ModifyLiquidityParams({tickLower: m.seedLo, tickUpper: m.seedHi, liquidityDelta: 0, salt: SEED_SALT}),
            ""
        );
        f0 = d.amount0() > 0 ? uint256(uint128(d.amount0())) : 0;
        f1 = d.amount1() > 0 ? uint256(uint128(d.amount1())) : 0;
    }

    function _report(string memory tag, Run memory r) internal pure {
        console2.log("---", tag);
        console2.log("  victim size (raw)        :", r.victimQuote);
        console2.log("  jit liquidity multiple   :", r.liqMult);
        console2.log("  jit in range at donate   :", r.inRange);
        console2.log("  single-sided entry       :", r.singleSidedEntry);
        console2.log("  maker levy paid (in+out) :", r.makerLevyPaid);
        console2.log("  capital MON / TOK        :", r.capital0, r.capital1);
        console2.log("  capital valued in MON    :", r.capitalMon);
        console2.log("  ... as x the seed's own  :", r.capitalMon / (r.seedCapitalMon == 0 ? 1 : r.seedCapitalMon));
        console2.log("  ... token side as % supply:", (r.capital1 * 100) / REAL_SUPPLY);
        console2.log("  ROI bps for one bundle   :", r.roiBps);
        console2.log("  jit donation c0 / c1     :", r.jitFees0, r.jitFees1);
        console2.log("  seed donation c0 / c1    :", r.seedFees0, r.seedFees1);
        console2.log("  seed WOULD have had c0/c1:", r.seedFeesAlone0, r.seedFeesAlone1);
        console2.log("  searcher d MON           :", r.netMon);
        console2.log("  searcher d TOK           :", r.netTok);
        console2.log("  searcher NET WEALTH (MON):", r.netWealth);
        console2.log("  gas measured             :", r.gasUsed);
        console2.log("  gas BILLED (Monad: limit):", r.gasBilled);
        console2.log("  gas cost (wei of MON)    :", r.gasCostMon);
        int256 afterGas = r.netWealth - int256(r.gasCostMon);
        console2.log("  NET AFTER GAS (MON wei)  :", afterGas);
        console2.log("  PROFITABLE?              :", afterGas > 0);
    }

    // ------------------------------------------------------------------------- the sweep

    /// @notice THE MEASUREMENT. Six orders of magnitude of victim size against the shipped seed, on
    ///         a non-BURN market, in the buy direction — the only direction where the entry is
    ///         free, because it is the only one whose single-sided side is the token.
    function test_M04_sweep_rewardsBuy() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        uint256[7] memory sizes = [
            uint256(0.1 ether),
            1 ether,
            10 ether,
            100 ether,
            1_000 ether,
            10_000 ether,
            100_000 ether
        ];
        uint256[3] memory mults = [uint256(1), 10, 100];
        console2.log("=== M-04 sweep: REWARDS (non-BURN) market, victim BUYS, donation is QUOTE ===");
        console2.log("seed liquidity:", uint256(rewards.seedLiquidity));
        for (uint256 i; i < sizes.length; ++i) {
            uint256 snap = vm.snapshotState();
            (uint256 b0, uint256 b1,) = _baseline(rewards, sizes[i], true);
            vm.revertToState(snap);
            for (uint256 j; j < mults.length; ++j) {
                uint256 s2 = vm.snapshotState();
                Run memory r = _bundle(rewards, sizes[i], true, mults[j], 600);
                r.seedFeesAlone0 = b0;
                r.seedFeesAlone1 = b1;
                _report("rewards/buy", r);
                vm.revertToState(s2);
            }
        }
    }

    /// @notice The mirror: a victim SELL on the same market. The single-sided side is now the
    ///         QUOTE, whose recorded maker rate is 30 bps, so the entry is NOT free.
    function test_M04_sweep_rewardsSell() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        console2.log("=== M-04 sweep: REWARDS market, victim SELLS, donation is QUOTE ===");
        uint256[4] memory monSpend = [uint256(1 ether), 100 ether, 10_000 ether, 100_000 ether];
        for (uint256 i; i < monSpend.length; ++i) {
            uint256 snap = vm.snapshotState();
            uint256 toks = _fundVictimTokens(rewards, monSpend[i]);
            uint256 inner = vm.snapshotState();
            (uint256 b0, uint256 b1,) = _baseline(rewards, toks, false);
            vm.revertToState(inner);
            Run memory r = _bundle(rewards, toks, false, 10, 600);
            r.seedFeesAlone0 = b0;
            r.seedFeesAlone1 = b1;
            _report("rewards/sell", r);
            vm.revertToState(snap);
        }
    }

    /// @notice And a BURN market, where the LP share is 70 bps of the TOKEN leg rather than the
    ///         quote. The report's maker-rate asymmetry is asserted here rather than assumed — see
    ///         `test_M04_makerRatesAreIdenticalOnBothSinks`.
    function test_M04_sweep_burnBuy() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        console2.log("=== M-04 sweep: BURN market, victim BUYS, donation is TOKEN ===");
        uint256[4] memory sizes = [uint256(1 ether), 100 ether, 10_000 ether, 100_000 ether];
        for (uint256 i; i < sizes.length; ++i) {
            uint256 snap = vm.snapshotState();
            (uint256 b0, uint256 b1,) = _baseline(burn, sizes[i], true);
            vm.revertToState(snap);
            uint256 s2 = vm.snapshotState();
            Run memory r = _bundle(burn, sizes[i], true, 10, 600);
            r.seedFeesAlone0 = b0;
            r.seedFeesAlone1 = b1;
            _report("burn/buy", r);
            vm.revertToState(s2);
        }
    }

    /// @notice CAPITAL EFFICIENCY, which is where this finding actually lives. The same liquidity
    ///         over a narrower band costs proportionally less inventory, so a searcher's real
    ///         question is not "can I capture the donation" (they can) but "what must I be holding
    ///         to do it, and what is that worth for one block".
    ///
    /// @dev The width is swept at a fixed 10,000 MON victim and a fixed liquidity multiple, so the
    ///      only thing moving is the capital. The narrowest band that still contains the trade's
    ///      end tick is the searcher's optimum.
    function test_M04_widthSweep() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        console2.log("=== M-04: width sweep, victim 10,000 MON, jit liquidity 100x the seed ===");
        int24[5] memory widths = [int24(60), 120, 600, 3000, 12000];
        for (uint256 i; i < widths.length; ++i) {
            uint256 snap = vm.snapshotState();
            (uint256 b0, uint256 b1,) = _baseline(rewards, 10_000 ether, true);
            vm.revertToState(snap);
            uint256 s2 = vm.snapshotState();
            Run memory r = _bundle(rewards, 10_000 ether, true, 100, widths[i]);
            r.seedFeesAlone0 = b0;
            r.seedFeesAlone1 = b1;
            console2.log("width (ticks):", int256(widths[i]));
            _report("rewards/buy/width", r);
            vm.revertToState(s2);
        }
    }

    /// @notice And the same question with the liquidity multiple swept at the narrowest band that
    ///         works, which is where a real searcher would operate.
    function test_M04_multSweepNarrow() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        console2.log("=== M-04: liquidity sweep at width 120, victim 1,000 MON ===");
        uint256[5] memory mults = [uint256(1), 3, 10, 30, 100];
        for (uint256 i; i < mults.length; ++i) {
            uint256 snap = vm.snapshotState();
            (uint256 b0, uint256 b1,) = _baseline(rewards, 1_000 ether, true);
            vm.revertToState(snap);
            uint256 s2 = vm.snapshotState();
            Run memory r = _bundle(rewards, 1_000 ether, true, mults[i], 120);
            r.seedFeesAlone0 = b0;
            r.seedFeesAlone1 = b1;
            _report("rewards/buy/narrow", r);
            vm.revertToState(s2);
        }
    }

    /// @notice THE SHAPE THAT ALWAYS COLLECTS. A single-sided token position must start strictly
    ///         BELOW the current tick, so it only ever enters the range if the victim's trade
    ///         crosses a whole tick-spacing boundary — 60 ticks, 0.6% of price, which on the
    ///         shipped 305,868 MON seed is a ~918 MON trade. Below that the free entry captures
    ///         nothing at all, and the searcher's only option is a range that STRADDLES the current
    ///         tick: in range from the first wei, and two-sided at entry, so it pays the recorded
    ///         30 bps maker levy on the quote it deposits.
    function test_M04_sweep_straddle() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        console2.log("=== M-04 sweep: REWARDS, STRADDLE shape (always in range, pays entry levy) ===");
        uint256[6] memory sizes =
            [uint256(0.1 ether), 1 ether, 10 ether, 100 ether, 1_000 ether, 10_000 ether];
        for (uint256 i; i < sizes.length; ++i) {
            uint256 snap = vm.snapshotState();
            (uint256 b0, uint256 b1,) = _baseline(rewards, sizes[i], true);
            vm.revertToState(snap);
            uint256 s2 = vm.snapshotState();
            Run memory r = _bundle(rewards, sizes[i], true, 100, 120, true);
            r.seedFeesAlone0 = b0;
            r.seedFeesAlone1 = b1;
            _report("rewards/buy/straddle", r);
            vm.revertToState(s2);
        }
    }

    /// @notice THE FIX, MEASURED THE SAME WAY. `fixedRewards` is the identical market — identical
    ///         seed, identical price, identical Uniswap singleton, identical bundle — on a hook
    ///         compiled from `src/v4/DokuHook.sol` as it stands. Two changes separate it from the
    ///         live gen-3 bytecode now, and they are asserted separately below because they are
    ///         different claims:
    ///
    ///           gen-4  `registerPool` records `PROTOCOL_LEVY_BPS` as the TOKEN-side maker rate
    ///                  instead of zero, so the single-sided entry is no longer free. That is a
    ///                  COST imposed on the searcher: `makerLevyPaid` must be strictly higher here.
    ///
    ///           gen-5  `_settleLeg` books the 70 bps to `pendingSink` instead of donating it, so
    ///                  there is nothing in the pool to collect. That is not a cost, it is an
    ///                  ABSENCE: `jitFees0`, `jitFees1` and `donationTotal` must all be exactly
    ///                  zero, at every size and every liquidity multiple.
    ///
    /// @dev Round 0 asserted only `fixNet < 0`, and that assertion was too weak for what it was
    ///      claiming — round 3 found a band anchoring that flipped the sign back on a configuration
    ///      this grid does not contain. The zero-capture assertion has no such loophole: it is not
    ///      an inequality over an economic quantity, it is the statement that the quantity does not
    ///      exist. No anchoring, width or multiple can move it.
    ///
    ///      The pairs are run side by side so the two columns can be read against each other, and
    ///      `live.donationTotal` is asserted NON-zero, so a fork that silently stopped reaching the
    ///      real hook could not pass this by making both columns empty.
    function test_M04_fixKillsTheAttack() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        console2.log("=== M-04: live gen-3 hook vs the patched hook, same market, same bundle ===");
        uint256[3] memory sizes = [uint256(100 ether), 1_000 ether, 10_000 ether];
        uint256[3] memory mults = [uint256(1), 10, 100];
        for (uint256 i; i < sizes.length; ++i) {
            for (uint256 j; j < mults.length; ++j) {
                uint256 s1 = vm.snapshotState();
                Run memory live = _bundle(rewards, sizes[i], true, mults[j], 120);
                vm.revertToState(s1);
                uint256 s2 = vm.snapshotState();
                Run memory fixt = _bundle(fixedRewards, sizes[i], true, mults[j], 120);
                vm.revertToState(s2);

                int256 liveNet = live.netWealth - int256(live.gasCostMon);
                int256 fixNet = fixt.netWealth - int256(fixt.gasCostMon);
                console2.log("victim / mult:", sizes[i], mults[j]);
                console2.log("   gen-3  entry+exit levy:", live.makerLevyPaid);
                console2.log("   gen-3  net after gas  :", liveNet);
                console2.log("   fixed  entry+exit levy:", fixt.makerLevyPaid);
                console2.log("   fixed  net after gas  :", fixNet);
                console2.log("   gen-3  donation total :", live.donationTotal);
                console2.log("   fixed  donation total :", fixt.donationTotal);
                assertGt(
                    fixt.makerLevyPaid, live.makerLevyPaid, "the patched hook charged no more than gen-3 did"
                );
                assertLt(fixNet, 0, "the patched hook still leaves the JIT bundle profitable");
                // The live hook must still be donating, or the comparison below is vacuous.
                assertGt(live.donationTotal, 0, "the LIVE gen-3 hook donated nothing: the fork is not reaching it");
                // And the compiled hook must donate nothing at all -- to the JIT, to the seed, to
                // anyone. This is the round-4 claim, and it is an absence rather than a bound.
                assertEq(fixt.jitFees0, 0, "the patched hook paid the JIT currency0");
                assertEq(fixt.jitFees1, 0, "the patched hook paid the JIT currency1");
                assertEq(fixt.donationTotal, 0, "the patched hook donated something to somebody");
            }
        }
    }

    /// @notice The other half of the fix: the token-side maker levy has to land somewhere it can be
    ///         spent from. It lands in `pendingProtocolToken`, is swept into `owedTreasury[token]`,
    ///         and is pulled by the existing currency-keyed path — and it never touches the sink's
    ///         ledger, which on a REWARDS market is denominated in the quote and shared with every
    ///         other market on that quote.
    function test_M04_theTokenMakerLevyIsSweepableAndNeverTouchesTheSink() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        Market storage m = fixedRewards;
        int24 hi = _floor60(_tick(m.id)) - SPACING;
        lp.modifyLiquidity(
            m.key,
            ModifyLiquidityParams({
                tickLower: hi - 600,
                tickUpper: hi,
                liquidityDelta: int256(uint256(m.seedLiquidity)),
                salt: JIT_SALT
            }),
            ""
        );
        uint256 owed = m.hk.pendingProtocolToken(m.id);
        assertGt(owed, 0, "a single-sided token entry still paid nothing");
        assertEq(m.hk.pendingSink(m.id), 0, "the sink's quote ledger was credited in the token");

        m.hk.sweep(m.id);
        assertEq(m.hk.pendingProtocolToken(m.id), 0, "sweep left the token bucket");
        assertEq(m.hk.owedTreasury(Currency.wrap(address(m.tok))), owed, "the token did not reach the treasury");

        uint256 before = m.tok.balanceOf(address(0xBEEF));
        m.hk.pullTreasury(Currency.wrap(address(m.tok)));
        assertEq(m.tok.balanceOf(address(0xBEEF)) - before, owed, "the treasury was not paid the token");
    }

    /// @notice THE NUMBER THE FINDING REDUCES TO: the smallest victim buy at which the bundle turns
    ///         profitable, bisected on the live hook, and the same figure on the patched one.
    ///
    /// @dev Bisection rather than a grid, because the boundary is not where gas puts it. Gas alone
    ///      breaks even at about 7 MON (0.0508 MON billed against 70 bps of the trade), and the real
    ///      floor is geometric: a position that is single-sided in the token must start STRICTLY
    ///      below the current tick, so the victim's trade has to move the price past the nearest
    ///      tick-spacing boundary before the position is in range when the donate lands. Where the
    ///      pool's price sits inside its 60-tick bucket therefore sets the floor, and it moves with
    ///      the market: this pool initialises 4 ticks above a boundary, so the floor here is near
    ///      its best case. The worst case is a full 60 ticks — 0.6% of price, ~918 MON against the
    ///      shipped 305,868 MON seed — and is reported alongside so the range is visible.
    function test_M04_breakEven() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        console2.log("=== M-04 break-even victim buy (wei of MON), width 120 ===");
        console2.log("pool tick at graduation      :", int256(_tick(rewards.id)));
        console2.log("nearest boundary below       :", int256(_floor60(_tick(rewards.id))));
        uint256[3] memory mults = [uint256(1), 10, 100];
        for (uint256 j; j < mults.length; ++j) {
            console2.log("liquidity multiple           :", mults[j]);
            console2.log("  gen-3 break-even (wei MON) :", _bisect(rewards, mults[j]));
            console2.log("  patched: profitable at all?:", _profitable(fixedRewards, 1_000_000 ether, mults[j]));
        }
    }

    function _profitable(Market storage m, uint256 size, uint256 mult) internal returns (bool ok) {
        uint256 snap = vm.snapshotState();
        Run memory r = _bundle(m, size, true, mult, 120);
        ok = r.netWealth > int256(r.gasCostMon);
        vm.revertToState(snap);
    }

    /// @dev Smallest profitable victim buy, found by doubling up from 1 MON to the first size that
    ///      pays and then bisecting the last gap. NOT a plain bisection over the whole interval:
    ///      profit is not monotone in size — a trade large enough to run the position over turns it
    ///      into a pure adverse-selection loss (measured at −5,823 MON on a 100,000 MON buy at
    ///      liquidity parity) — so the only sound invariant is "the size below does not pay and this
    ///      one does", which is also what a searcher probing upward would find. Returns 0 if nothing
    ///      in [1 MON, 500,000 MON] pays.
    function _bisect(Market storage m, uint256 mult) internal returns (uint256) {
        uint256 lo;
        uint256 hi;
        for (uint256 s = 1 ether; s <= 500_000 ether; s *= 2) {
            if (_profitable(m, s, mult)) {
                hi = s;
                break;
            }
            lo = s;
        }
        if (hi == 0) return 0;
        if (lo == 0) return hi;
        while (hi - lo > 1e15) {
            uint256 mid = lo + (hi - lo) / 2;
            if (_profitable(m, mid, mult)) hi = mid;
            else lo = mid;
        }
        return hi;
    }

    // ------------------------------------------------------- L-01, against the live bytecode

    /// @notice L-01, PROVEN ON THE DEPLOYED GENERATION-3 HOOK. `_beforeSwap` there bounds the
    ///         specified leg's levy by `type(uint128).max` and returns it as `int128`, so a levy in
    ///         `(int128.max, uint128.max]` comes back NEGATIVE — a hook debt where the function's
    ///         own natspec promises a hook credit.
    ///
    /// @dev This is the only place the defect CAN be proven, because `src/v4/DokuHook.sol` has been
    ///      fixed and the deployed contract is immutable. Read straight off 0xb1A6…6Fcf's runtime
    ///      code on a mainnet fork, through a pranked PoolManager.
    function test_L01_theLiveHookReturnsANegativeSpecifiedDelta() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        uint256 levy = uint256(uint128(type(int128).max)) + 1; // one wei into the window
        vm.prank(POOL_MANAGER);
        (, BeforeSwapDelta d,) = hook.beforeSwap(
            address(this),
            rewards.key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(levy * 100), // REWARDS quote leg is 100 bps
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );
        int128 spec = BeforeSwapDeltaLibrary.getSpecifiedDelta(d);
        console2.log("[L-01 live] levy               :", levy);
        console2.log("[L-01 live] specified delta    :", int256(spec));
        assertLt(spec, 0, "the live hook did not flip: L-01 is a false positive");
        assertEq(spec, int128(uint128(levy)), "the flip is not a plain two's-complement wrap");
    }

    /// @notice And the same input against the PATCHED hook is a named revert before anything moves.
    function test_L01_thePatchedHookRejectsTheWindow() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        uint256 levy = uint256(uint128(type(int128).max)) + 1;
        vm.prank(POOL_MANAGER);
        vm.expectRevert(
            abi.encodeWithSelector(DokuHook.LevyOverflow.selector, levy * 100, uint256(100))
        );
        fixedRewards.hk.beforeSwap(
            address(this),
            fixedRewards.key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(levy * 100),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );
    }

    /// @notice THE SEVERITY ARGUMENT, on the live pool. Nothing in the window can be settled: the
    ///         hook's own `donate` + `mint` spend the same levy back out, so the unlock ends owing
    ///         it, and the singleton's balance and the hook's ledger are unmoved afterwards.
    function test_L01_theLiveWindowStillCannotBeDrained() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        uint256 mon0 = POOL_MANAGER.balance;
        uint256 lg0 = hook.pendingProtocol(rewards.id) + hook.pendingSink(rewards.id);
        uint256[2] memory levies = [uint256(uint128(type(int128).max)) + 1, uint256(type(uint128).max)];
        for (uint256 i; i < levies.length; ++i) {
            vm.prank(VICTIM);
            vm.expectRevert();
            swapper.swap{value: 1 ether}(
                rewards.key,
                SwapParams({
                    zeroForOne: true,
                    amountSpecified: -int256(levies[i] * 100),
                    sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
                }),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                ""
            );
        }
        assertEq(POOL_MANAGER.balance, mon0, "the singleton's MON moved");
        assertEq(hook.pendingProtocol(rewards.id) + hook.pendingSink(rewards.id), lg0, "the hook's ledger moved");
    }

    // ------------------------------------------------------------------ the report's premise

    /// @notice THE REPORT'S STATED MECHANISM IS HALF WRONG. It says the zero token-side maker rate
    ///         is a NON-BURN property ("for non-BURN markets the recorded token-side maker rate is
    ///         zero"). It is zero on BOTH sinks, because `registerPool` derives it as
    ///         `sink == SINK_BURN ? SINK_LEVY_BPS : 0` (DokuHook.sol:607) and `SINK_LEVY_BPS` is
    ///         itself 0 (DokuHook.sol:131). There is no asymmetry between the sinks to exploit.
    function test_M04_makerRatesAreIdenticalOnBothSinks() public view {
        if (!forked) return;
        DokuHook.Market memory r = hook.markets(rewards.id);
        DokuHook.Market memory b = hook.markets(burn.id);
        assertEq(r.makerBps0, b.makerBps0, "quote-side maker rate differs by sink");
        assertEq(r.makerBps1, b.makerBps1, "token-side maker rate differs by sink");
        assertEq(r.makerBps1, 0, "the token-side maker rate is not zero");
        assertEq(hook.SINK_LEVY_BPS(), 0, "SINK_LEVY_BPS moved");
        console2.log("maker rates rewards (q,t):", r.makerBps0, r.makerBps1);
        console2.log("maker rates burn    (q,t):", b.makerBps0, b.makerBps1);
    }

    /// @notice THE PROTOCOL'S OWN INVARIANT, on the live hook: whatever the JIT does to the LP
    ///         share, the hook's take is untouched. This is the property the whole v4 migration
    ///         exists to buy and it is the one M-04 does NOT threaten.
    function test_M04_protocolTakeIsUndilutedByJit() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        uint256 snap = vm.snapshotState();
        uint256 p0 = hook.pendingProtocol(rewards.id);
        _victim(rewards, 10_000 ether, true);
        uint256 alone = hook.pendingProtocol(rewards.id) - p0;
        vm.revertToState(snap);

        int24 cur = _tick(rewards.id);
        int24 hi = _floor60(cur) - SPACING;
        lp.modifyLiquidity{value: TARGET_MON * 20}(
            rewards.key,
            ModifyLiquidityParams({
                tickLower: hi - 600,
                tickUpper: hi,
                liquidityDelta: int256(uint256(rewards.seedLiquidity) * 100),
                salt: JIT_SALT
            }),
            ""
        );
        uint256 p1 = hook.pendingProtocol(rewards.id);
        _victim(rewards, 10_000 ether, true);
        uint256 withJit = hook.pendingProtocol(rewards.id) - p1;
        console2.log("protocol take, no jit  :", alone);
        console2.log("protocol take, with jit:", withJit);
        assertEq(withJit, alone, "a JIT diluted the hook's own take");
    }
}
