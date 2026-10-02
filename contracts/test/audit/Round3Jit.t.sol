// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";

contract JTok is ERC20 {
    constructor(string memory n) ERC20(n, n) {
        _mint(msg.sender, 1e33);
    }
}

/// @dev The searcher, as its own account, so its profit and loss is its own ERC-20 balances and
///      never the harness's. The seed position in this fixture belongs to the test contract; a
///      measurement that read the test contract's balances would credit the searcher with the
///      seed's share of the donation and make the attack look profitable at every size.
contract Searcher {
    PoolModifyLiquidityTest immutable lp;

    constructor(PoolModifyLiquidityTest lp_) {
        lp = lp_;
    }

    function approve(address t, address to) external {
        ERC20(t).approve(to, type(uint256).max);
    }

    function act(PoolKey memory key, int24 lo, int24 hi, int256 delta, bytes32 salt)
        external
        returns (BalanceDelta)
    {
        return lp.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: lo, tickUpper: hi, liquidityDelta: delta, salt: salt}), ""
        );
    }

    receive() external payable {}
}

/**
 * # Round 3 — M-04's residual: the maker levy does not bound what a JIT can take
 *
 * ## What generation 4 claims
 *
 * `DokuHook.registerPool`'s note argues the symmetric 30 bps `makerToken` closes the JIT-on-donate
 * attack "in one line of arithmetic":
 *
 *     "the donation a position can capture is at most 70 bps of the swap, and the swap that can end
 *      inside its band is at most what that band's own liquidity absorbs -- so the capture is
 *      bounded by 70 bps OF THE POSITION'S OWN CAPITAL, however narrow the band and however large
 *      the multiple."
 *
 * ## Why that second clause is false
 *
 * A DOKU pool is not the JIT's band. It also carries the graduation seed, which is FULL RANGE and
 * therefore in range at every tick between the starting price and the band. So a swap can be
 * arbitrarily larger than the band's own capacity: the seed absorbs the journey and the band only
 * has to absorb the LAST step. `poolManager.donate` then credits 70 bps of the WHOLE swap to
 * whatever is in range at the POST-swap tick, pro rata to liquidity — not pro rata to how much of
 * the swap each position actually served.
 *
 * So the real bound is
 *
 *     capture  =  0.0070 * X * L_jit / (L_jit + L_seed)
 *     cost     =  0.0030 * capital_in  +  0.0030 * capital_out   (plus impermanent loss and gas)
 *
 * and `X` is free. The configuration the existing sweep measures anchors the band at the CURRENT
 * tick — `test/audit/HookJitDonateFork.t.sol::_bundle`, which states the choice and calls it
 * "searcher-favourable" — so `X` is bounded there by what the band itself can absorb, which is
 * exactly the case the arithmetic above is true for. This file measures the other configuration:
 * the band placed at the tick a LARGE trade ends on.
 *
 * Everything below is a measurement. The finding is economic, so it is only real if it pays.
 *
 * ## ROUND 4 — WHAT HAPPENED NEXT, and why this file now asserts the opposite
 *
 * IT PAID. 23 of 48 configurations, best ROI 8,111 bps, a position holding 0.027% of the pool
 * taking 83% of a donation for absorbing ~0.21% of the trade. The numbers above are the numbers
 * this file produced against the donating hook, and they are left in the docstrings deliberately:
 * they are the reason the design changed, and a proof whose motivating measurement has been deleted
 * is a proof nobody can check.
 *
 * The protocol owner took option 2 from `docs/doku/audit/gen4/README.md` §Round 3: **the 70 bps is
 * no longer donated. `_settleLeg` credits it to the market's sink ledger.** There is no
 * `poolManager.donate` anywhere in `DokuHook` now, so there is no donation to be in range for, and
 * band width, anchoring and liquidity multiple decide nothing at all.
 *
 * So every test below is inverted IN PLACE, against the identical fixture and the identical
 * bundles. Where a run asserted a profit it now asserts that the JIT collected EXACTLY ZERO and
 * lost money; where the sweep asserted that some configuration paid it now asserts that NONE of the
 * 48 does. The two controls are unchanged — they always lost, and they must still lose, or the
 * inversion would be vacuous. And the run that measured what the seed lost now measures what the
 * SINK gains: 70 bps of the swap, identical whether the JIT is there or not.
 *
 * That last pair is the whole claim. The attack is not made unprofitable; the thing it stole no
 * longer exists, and the money it was stolen from arrives at its destination one hop earlier.
 */
contract Round3JitTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint160 constant FLAGS = 0x2FCF;
    address constant TREASURY = address(0xBEEF);
    uint160 constant SQRT_1_1 = 79228162514264337593543950336;
    int24 constant SPACING = 60;

    /// @dev Monad bills the gas LIMIT, not the gas used, and forge's estimator leaves no headroom —
    ///      so a searcher must send 1.5x measured consumption. Same rule, same numbers, as
    ///      `HookJitDonateFork`.
    uint256 constant MONAD_BASE_FEE = 100 gwei;
    uint256 constant INTRINSIC_GAS = 21_000;

    PoolManager manager;
    DokuHook hook;
    PoolSwapTest swapper;
    PoolModifyLiquidityTest lp;
    Searcher jit;

    JTok quote;
    JTok tok;
    PoolKey key;
    PoolId id;

    address graduator = address(0x6AD);
    bytes32 constant SEED_SALT = bytes32(uint256(0x5EED));
    bytes32 constant JIT_SALT = bytes32(uint256(0x117));

    int24 seedLo;
    int24 seedHi;
    uint128 seedLiquidity = 2_000_000 ether;

    receive() external payable {}

    function setUp() public {
        manager = new PoolManager(address(this));
        swapper = new PoolSwapTest(IPoolManager(address(manager)));
        lp = new PoolModifyLiquidityTest(IPoolManager(address(manager)));

        bytes memory args = abi.encode(IPoolManager(address(manager)), address(this), TREASURY, address(0xC5EE));
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        hook = new DokuHook{salt: salt}(IPoolManager(address(manager)), address(this), TREASURY, address(0xC5EE));
        hook.setGraduator(graduator, true);

        // The quote must sort BELOW the token so the quote is currency0 — the flagship shape (a
        // native MON quote is address(0) and always sorts first).
        quote = new JTok("Q");
        JTok t;
        for (uint256 i; i < 256; ++i) {
            t = new JTok("T");
            if (address(t) > address(quote)) break;
        }
        require(address(t) > address(quote), "orientation search failed");
        tok = t;

        key = PoolKey({
            currency0: Currency.wrap(address(quote)),
            currency1: Currency.wrap(address(tok)),
            fee: 0,
            tickSpacing: SPACING,
            hooks: IHooks(address(hook))
        });
        id = key.toId();

        vm.startPrank(graduator);
        manager.initialize(key, SQRT_1_1);
        // REWARDS: the 70 bps LP share is levied on the QUOTE leg. Creator tax zero, so the whole
        // measurement is the levy and nothing else.
        hook.registerPool(key, address(tok), hook.SINK_REWARDS(), address(0x51), 0);
        vm.stopPrank();

        quote.approve(address(lp), type(uint256).max);
        quote.approve(address(swapper), type(uint256).max);
        tok.approve(address(lp), type(uint256).max);
        tok.approve(address(swapper), type(uint256).max);

        seedLo = TickMath.minUsableTick(SPACING);
        seedHi = TickMath.maxUsableTick(SPACING);
        lp.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: seedLo,
                tickUpper: seedHi,
                liquidityDelta: int256(uint256(seedLiquidity)),
                salt: SEED_SALT
            }),
            ""
        );

        jit = new Searcher(lp);
        quote.transfer(address(jit), 1e32);
        tok.transfer(address(jit), 1e32);
        jit.approve(address(quote), address(lp));
        jit.approve(address(tok), address(lp));
    }

    // ------------------------------------------------------------------------------ helpers

    function _tick() internal view returns (int24 t) {
        (, t,,) = StateLibrary.getSlot0(IPoolManager(address(manager)), id);
    }

    function _sqrtP() internal view returns (uint160 s) {
        (s,,,) = StateLibrary.getSlot0(IPoolManager(address(manager)), id);
    }

    function _floor(int24 t) internal pure returns (int24) {
        int24 f = (t / SPACING) * SPACING;
        if (t < 0 && f != t) f -= SPACING;
        return f;
    }

    /// @dev A buy of the token: quote (currency0) in, token (currency1) out, exact input. That is
    ///      `zeroForOne == true`, which moves the tick DOWN.
    function _victimBuy(uint256 quoteIn) internal {
        swapper.swap(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(quoteIn),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @dev `n` token units valued in the quote at the CURRENT spot price.
    ///      price(currency1 in currency0) = 1 / (sqrtP / 2**96)**2.
    function _tokInQuote(uint256 n) internal view returns (uint256) {
        uint256 s = uint256(_sqrtP());
        uint256 a = FixedPointMathLib.fullMulDiv(n, 1 << 96, s);
        return FixedPointMathLib.fullMulDiv(a, 1 << 96, s);
    }

    struct Run {
        uint256 victimQuote;
        uint256 liqMult1e4; // JIT liquidity as 1e4 * multiple of the seed's
        int24 width;
        bool anchoredAtCurrentTick;
        bool inRange;
        int24 endTick;
        uint256 capitalQuote; // quote the entry deposited
        uint256 capitalTok; // token the entry deposited
        uint256 capitalValued; // both, at the ENTRY price
        int256 netQuote;
        int256 netTok;
        int256 netWealth; // netQuote + netTok valued at the EXIT price
        uint256 gasBilled;
        uint256 gasCost;
        int256 afterGas;
        uint256 seedTook; // donation the seed kept, in quote -- ZERO since round 4
        uint256 jitTook; // donation the JIT captured, in quote -- ZERO since round 4
        uint256 sinkBooked; // `pendingSink` growth across the victim's swap, in quote
        uint256 protBooked; // `pendingProtocol` growth across the same swap
    }

    /// @param anchorAtCurrent  place the band at the CURRENT tick (the configuration the existing
    ///                         sweep measures) rather than at the tick the victim's trade ends on.
    function _run(uint256 victimQuote, uint256 liqMult1e4, int24 width, bool anchorAtCurrent)
        internal
        returns (Run memory r)
    {
        r.victimQuote = victimQuote;
        r.liqMult1e4 = liqMult1e4;
        r.width = width;
        r.anchoredAtCurrentTick = anchorAtCurrent;

        int24 cur = _tick();
        int24 lo;
        int24 hi;
        if (anchorAtCurrent) {
            // Strictly below the current tick, so the entry is single-sided in the token.
            hi = _floor(cur);
            if (hi == cur) hi -= SPACING;
            lo = hi - width;
        } else {
            // Where does this trade END with no JIT present? Simulate, then rewind.
            uint256 snap = vm.snapshotState();
            _victimBuy(victimQuote);
            int24 unperturbed = _tick();
            vm.revertToState(snap);

            // The band starts at the unperturbed end tick and runs UP toward the current price:
            // adding liquidity slows the trade, so the perturbed end tick is at or above the
            // unperturbed one.
            lo = _floor(unperturbed);
            hi = lo + width;
            if (hi >= _floor(cur)) hi = _floor(cur) - SPACING; // stay strictly single-sided
            require(lo < hi, "band collapsed: victim trade too small for this width");
        }

        uint256 jitL = (uint256(seedLiquidity) * liqMult1e4) / 1e4;

        uint256 q0 = quote.balanceOf(address(jit));
        uint256 t0 = tok.balanceOf(address(jit));

        uint256 g = gasleft();
        jit.act(key, lo, hi, int256(jitL), JIT_SALT);
        uint256 gasUsed = g - gasleft();

        r.capitalQuote = q0 - quote.balanceOf(address(jit));
        r.capitalTok = t0 - tok.balanceOf(address(jit));
        r.capitalValued = r.capitalQuote + _tokInQuote(r.capitalTok);

        // The ledger, across the victim's trade and nothing else: the JIT's own add is already
        // behind us and its collect/remove is still ahead, so neither maker levy is inside this
        // window. What lands here is the SWAP levy and only the swap levy.
        uint256 sink0 = hook.pendingSink(id);
        uint256 prot0 = hook.pendingProtocol(id);

        _victimBuy(victimQuote);

        r.sinkBooked = hook.pendingSink(id) - sink0;
        r.protBooked = hook.pendingProtocol(id) - prot0;

        r.endTick = _tick();
        r.inRange = r.endTick >= lo && r.endTick < hi;

        g = gasleft();
        BalanceDelta collected = jit.act(key, lo, hi, 0, JIT_SALT);
        jit.act(key, lo, hi, -int256(jitL), JIT_SALT);
        gasUsed += g - gasleft();

        r.jitTook = collected.amount0() > 0 ? uint256(uint128(collected.amount0())) : 0;

        r.netQuote = int256(quote.balanceOf(address(jit))) - int256(q0);
        r.netTok = int256(tok.balanceOf(address(jit))) - int256(t0);
        int256 tokValued = r.netTok >= 0
            ? int256(_tokInQuote(uint256(r.netTok)))
            : -int256(_tokInQuote(uint256(-r.netTok)));
        r.netWealth = r.netQuote + tokValued;

        gasUsed += INTRINSIC_GAS;
        r.gasBilled = (gasUsed * 3) / 2;
        r.gasCost = r.gasBilled * MONAD_BASE_FEE;
        r.afterGas = r.netWealth - int256(r.gasCost);

        // Measurement only, after the searcher's books are closed.
        BalanceDelta seedCollect = lp.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: seedLo, tickUpper: seedHi, liquidityDelta: 0, salt: SEED_SALT}),
            ""
        );
        r.seedTook = seedCollect.amount0() > 0 ? uint256(uint128(seedCollect.amount0())) : 0;
    }

    function _report(string memory tag, Run memory r) internal pure {
        console2.log("---", tag);
        console2.log("  victim quote in          :", r.victimQuote);
        console2.log("  jit L as 1e4 x seed      :", r.liqMult1e4);
        console2.log("  band width (ticks)       :", int256(r.width));
        console2.log("  anchored at current tick :", r.anchoredAtCurrentTick);
        console2.log("  in range at the donate   :", r.inRange);
        console2.log("  end tick                 :", int256(r.endTick));
        console2.log("  capital quote / token    :", r.capitalQuote, r.capitalTok);
        console2.log("  capital valued (quote)   :", r.capitalValued);
        console2.log("  donation JIT took        :", r.jitTook);
        console2.log("  donation seed kept       :", r.seedTook);
        console2.log("  sink ledger booked       :", r.sinkBooked);
        console2.log("  protocol ledger booked   :", r.protBooked);
        console2.log("  net quote                :", r.netQuote);
        console2.log("  net token                :", r.netTok);
        console2.log("  NET WEALTH (quote)       :", r.netWealth);
        console2.log("  gas billed / cost        :", r.gasBilled, r.gasCost);
        console2.log("  NET AFTER GAS            :", r.afterGas);
        console2.log("  PROFITABLE?              :", r.afterGas > 0);
        if (r.capitalValued != 0) {
            console2.log("  ROI bps on capital       :", (r.afterGas * 10_000) / int256(r.capitalValued));
        }
    }

    // -------------------------------------------------------------------------- the control

    /// @notice The configuration the existing sweep measures: band anchored at the CURRENT tick.
    /// @dev Reproduced here on a local fixture so the two configurations are compared on the same
    ///      pool, with the same seed, in the same file. This one is expected to LOSE, which is what
    ///      `HookJitDonateFork` records — and it lost under the donating hook too. KEPT UNCHANGED
    ///      across round 4 on purpose: a control that had to be edited to stay green would not be a
    ///      control. If this ever passes for a NEW reason the inversion below is measuring nothing.
    function test_control_bandAtTheCurrentTickLoses() public {
        Run memory r = _run(20_000 ether, 10_000, 1200, true);
        _report("control: band at the current tick, L = 1x seed", r);
        assertTrue(r.afterGas <= 0, "control was expected to lose");
    }

    /// @notice The same capital and the same band width, anchored at the CURRENT tick instead.
    /// @dev This is the structural difference, isolated. A narrow band at the current tick is only
    ///      in range at the POST-swap tick if the trade is small enough not to cross it — which is
    ///      precisely the clause `registerPool`'s arithmetic assumes. Sized identically to the
    ///      profitable run below, the trade blows straight through it, the JIT is out of range when
    ///      `_settleLeg` donates, and it captures nothing.
    function test_control_sameCapitalAtTheCurrentTickCapturesNothing() public {
        Run memory r = _run(200_000 ether, 500, 120, true);
        _report("control: SAME capital and width, band at the current tick", r);
        assertFalse(r.inRange, "the near band was expected to be crossed and left out of range");
        assertEq(r.jitTook, 0, "an out-of-range position collected a donation");
        assertLt(r.afterGas, 0, "the near band was expected to lose");
    }

    // ------------------------------------------------------------------------- the finding

    /// @notice THE PROOF, on the bundle that used to be THE MEASUREMENT.
    ///
    /// @dev Identical fixture, identical band, identical victim: 200,000 quote against a
    ///      0.05x-seed position 120 ticks wide anchored at the trade's end tick. Under the donating
    ///      hook this returned +60.7 quote at ROI 1,107 bps, and the note here read "the profit IS
    ///      the donation" — net wealth was strictly below `jitTook`, so every other line of the
    ///      bundle was a cost and only the donation made it pay.
    ///
    ///      That sentence is now the proof's own argument, run forwards. There is no donation, so
    ///      the only positive line is gone and what is left is exactly the cost it used to cover:
    ///      30 bps of maker levy in, 30 bps out, adverse selection from being crossed, and gas.
    ///
    ///      THE JIT STILL LANDS IN RANGE — `inRange` is asserted, not waived. The attack is not
    ///      being defeated by a missed band; it executes perfectly and collects nothing, because
    ///      with `POOL_LP_FEE == 0` and no donate there is nothing in a DOKU pool for a position to
    ///      accrue.
    function test_round4_theBandAtTheTradesEndTickNowCapturesNothing() public {
        Run memory r = _run(200_000 ether, 500, 120, false);
        _report("ROUND 4: band at the trade's end tick, L = 0.05x seed, 120 ticks", r);
        assertTrue(r.inRange, "JIT missed the band -- this proof requires the attack to EXECUTE");
        assertEq(r.jitTook, 0, "an in-range JIT collected something: the donate is back");
        assertLt(r.netWealth, int256(0), "the bundle broke even or better with nothing to collect");
        assertLt(r.afterGas, 0, "the far band was expected to lose once the donation was gone");

        // AND THE 70 BPS WENT TO THE SINK INSTEAD. Exact, not approximate: the levied leg is the
        // quote leg, its rate is 100 bps with a zero creator tax, and `_settleLeg` books 70/100 of
        // that to `pendingSink` and the remainder to `pendingProtocol`.
        uint256 levy = (r.victimQuote * 100) / 10_000;
        assertEq(r.sinkBooked, (levy * 70) / 100, "the sink was not credited the full 70 bps");
        assertEq(r.protBooked, levy - r.sinkBooked, "the treasury did not get the rest");
        console2.log("the JIT captured (quote)  :", r.jitTook);
        console2.log("the sink was credited     :", r.sinkBooked);
    }

    /// @notice The same 48-configuration sweep, asserting the opposite. 23 of these paid under the
    ///         donating hook; none of them may pay now, and none of them may collect a single unit.
    /// @dev The `try/catch` stays: several points ask for a band the victim's trade is too small to
    ///      span, and `_run` reverts on those rather than silently measuring a different shape.
    ///      Those are skipped, not counted as passes — `measured` records how many actually ran, and
    ///      is asserted non-trivial so a fixture change that made every configuration revert could
    ///      not pass this test by measuring nothing.
    function test_round4_noConfigurationPays() public {
        uint256[4] memory victims =
            [uint256(50_000 ether), 200_000 ether, 500_000 ether, 1_000_000 ether];
        uint256[4] memory mults = [uint256(500), 2_000, 10_000, 50_000];
        int24[3] memory widths = [int24(120), 600, 3000];

        uint256 profitable;
        uint256 captured;
        uint256 measured;
        uint256 landed;
        for (uint256 v; v < victims.length; ++v) {
            for (uint256 m; m < mults.length; ++m) {
                for (uint256 w; w < widths.length; ++w) {
                    uint256 snap = vm.snapshotState();
                    try this.extRun(victims[v], mults[m], widths[w]) returns (Run memory r) {
                        measured++;
                        if (r.inRange) landed++;
                        if (r.jitTook != 0) {
                            captured++;
                            _report("CAPTURED SOMETHING", r);
                        }
                        if (r.inRange && r.afterGas > 0) {
                            profitable++;
                            _report("PROFITABLE", r);
                        }
                    } catch {}
                    vm.revertToState(snap);
                }
            }
        }
        console2.log("configurations measured  :", measured);
        console2.log("of those, landed in range:", landed);
        console2.log("that captured anything   :", captured);
        console2.log("profitable configurations:", profitable);
        assertGt(measured, 20, "the sweep measured almost nothing -- the fixture, not the hook, changed");
        assertGt(landed, 0, "no configuration landed in range: the sweep proves nothing about capture");
        assertEq(captured, 0, "a configuration collected a donation");
        assertEq(profitable, 0, "a configuration paid with no donation to take");
    }

    function extRun(uint256 victimQuote, uint256 liqMult1e4, int24 width) external returns (Run memory) {
        require(msg.sender == address(this));
        return _run(victimQuote, liqMult1e4, width, false);
    }

    /// @notice THE PAIRED CLAIM, and the one that matters. This test used to prove that the seed
    ///         LOST what the JIT took — the seed position being a quote-paying sink's only
    ///         post-graduation income, since `SINK_LEVY_BPS` is zero. It now proves that there is
    ///         nothing left to lose: the market's income does not pass through the pool at all, so
    ///         it is identical with and without the searcher, to the unit.
    ///
    /// @dev Run twice on the same trade. First with no JIT present, reading the sink ledger. Then
    ///      with a 0.2x-seed band 600 ticks wide at the end tick — a configuration that paid 8,111
    ///      bps under the donating hook. The two sink figures must be EQUAL, and both pool-side
    ///      collects must be zero.
    ///
    ///      Equality is the strong form and it is the right one. "The sink lost less" would be
    ///      satisfied by a fix that merely diluted the attack; only equality says the searcher has
    ///      no lever on the market's income at all.
    function test_round4_theSinkGetsTheWholeShareAndTheJitCannotTouchIt() public {
        uint256 snap = vm.snapshotState();
        uint256 sinkBefore = hook.pendingSink(id);
        _victimBuy(200_000 ether);
        uint256 sinkAlone = hook.pendingSink(id) - sinkBefore;
        BalanceDelta alone = lp.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: seedLo, tickUpper: seedHi, liquidityDelta: 0, salt: SEED_SALT}),
            ""
        );
        uint256 seedAlone = alone.amount0() > 0 ? uint256(uint128(alone.amount0())) : 0;
        vm.revertToState(snap);

        Run memory r = _run(200_000 ether, 2_000, 600, false);
        console2.log("sink credited, no JIT     :", sinkAlone);
        console2.log("sink credited, with a JIT :", r.sinkBooked);
        console2.log("seed collect, no JIT      :", seedAlone);
        console2.log("seed collect, with a JIT  :", r.seedTook);
        console2.log("JIT took                  :", r.jitTook);

        assertEq(seedAlone, 0, "the seed collected a pool-side fee: POOL_LP_FEE or the donate is back");
        assertEq(r.seedTook, 0, "the seed collected a pool-side fee in the JIT bundle");
        assertEq(r.jitTook, 0, "the JIT collected a pool-side fee");
        assertEq(sinkAlone, (200_000 ether * 100 / 10_000) * 70 / 100, "the undiluted swap did not credit 70 bps");
        assertEq(r.sinkBooked, sinkAlone, "the searcher's presence moved the market's income");
    }
}
