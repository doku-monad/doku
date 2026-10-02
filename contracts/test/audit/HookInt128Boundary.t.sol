// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test, console2, stdError} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";

contract B1Tok is ERC20 {
    constructor() ERC20("B1", "B1") {
        _mint(msg.sender, 1e33);
    }
}

/// @notice A raw router. `PoolSwapTest` sanity-checks its own deltas before it settles them, which
///         is exactly the layer a sign-flip test must not be filtered through: it would turn a
///         "the hook handed the caller a positive credit" outcome into a helper's revert and hide
///         which of the two actually happened. This one swaps and then does the least it can.
contract RawSwapper is IUnlockCallback {
    IPoolManager public immutable pm;

    enum Exit {
        NONE, // leave every delta as it falls -> CurrencyNotSettled decides
        MINT, // turn a positive delta into 6909 claims (needs no singleton balance)
        TAKE, // physically pull a positive delta out of the singleton
        PAY // settle what is owed and take what is due -- an honest swapper

    }

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    receive() external payable {}

    function run(PoolKey calldata key, SwapParams calldata p, Exit exit) external payable returns (BalanceDelta) {
        return abi.decode(pm.unlock(abi.encode(key, p, exit)), (BalanceDelta));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm");
        (PoolKey memory key, SwapParams memory p, Exit exit) = abi.decode(data, (PoolKey, SwapParams, Exit));
        BalanceDelta d = pm.swap(key, p, "");
        if (exit != Exit.NONE) {
            _drain(key.currency0, d.amount0(), exit);
            _drain(key.currency1, d.amount1(), exit);
        }
        return abi.encode(d);
    }

    function _drain(Currency c, int128 amt, Exit exit) private {
        if (amt > 0) {
            if (exit == Exit.MINT) pm.mint(address(this), c.toId(), uint256(uint128(amt)));
            else pm.take(c, address(this), uint256(uint128(amt)));
            return;
        }
        if (amt == 0 || exit != Exit.PAY) return;
        uint256 owed = uint256(uint128(-amt));
        if (c.isAddressZero()) {
            pm.settle{value: owed}();
        } else {
            pm.sync(c);
            IERC20(Currency.unwrap(c)).transfer(address(pm), owed);
            pm.settle();
        }
    }
}

/**
 * L-01 — "the hook validates uint128 but returns int128".
 *
 * THE CLAIM. `_beforeSwap` bounds the specified leg's levy at `type(uint128).max` and then returns
 * it as `int128`, so any levy above `type(int128).max` is reinterpreted as NEGATIVE and the
 * function's "the returned specified delta is always positive" invariant is broken.
 *
 * WHAT THESE TESTS ESTABLISH, in order:
 *
 *   1. The sign flip is REAL at the return value. `beforeSwap` is called directly, from a pranked
 *      PoolManager, and the `BeforeSwapDelta` it hands back is read. It is negative. That is the
 *      whole of the report's mechanical claim and it is correct.
 *
 *   2. It is UNREACHABLE AS A LOSS through `PoolManager.swap`, in every one of the four
 *      exact-input/exact-output x zeroForOne shapes, on both a BURN and a non-BURN market, and in
 *      all three exit shapes a caller could try (leave it, mint it, take it). The hook's own
 *      `donate` + `mint` in `_settleLeg` spend the same levy back out, so the hook finishes the
 *      unlock owing roughly 2**128 of the specified currency and `CurrencyNotSettled` — or, on the
 *      BURN leg, v4's own `SafeCast` inside `donate`/`mint` — takes the transaction down first.
 *      The singleton's balance and the hook's ledger are asserted unmoved after every attempt.
 *
 *   3. The boundary is exactly where the arithmetic says. `levy == type(int128).max` is the
 *      largest levy that settles; one wei more is the first that cannot.
 *
 *   4. The `type(int256).min` negation the report also flags reverts with a checked-arithmetic
 *      panic before any state moves — `uint256(-params.amountSpecified)` at DokuHook.sol:377.
 *
 *   5. Every OTHER int128 cast and negation in the hook is bounded by construction, and the two
 *      that are not bounded by their own arithmetic are bounded by v4's `SafeCast`. Enumerated and
 *      driven one by one, because "the sign invariant holds here" is a per-site claim.
 */
contract HookInt128BoundaryTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint160 internal constant FLAGS = 0x2FCF;
    address internal constant TREASURY = address(0xBEEF);
    address internal constant CREATOR_SINK = address(0xC5);
    uint160 internal constant SQRT_1_1 = 79228162514264337593543950336;
    address internal constant GRADUATOR = address(0x6AD);
    address internal constant SINK = address(0x51);

    PoolManager internal manager;
    DokuHook internal hook;
    PoolModifyLiquidityTest internal lp;
    RawSwapper internal raw;

    B1Tok internal tokR; // REWARDS market  -> quote leg 100 bps, token leg 0 bps
    B1Tok internal tokB; // BURN market     -> quote leg  30 bps, token leg 70 bps
    PoolKey internal KR;
    PoolKey internal KB;
    PoolId internal IR;
    PoolId internal IB;

    int24 internal MIN_T;
    int24 internal MAX_T;

    receive() external payable {}

    function setUp() public {
        manager = new PoolManager(address(this));
        lp = new PoolModifyLiquidityTest(IPoolManager(address(manager)));
        raw = new RawSwapper(IPoolManager(address(manager)));

        bytes memory args = abi.encode(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        hook = new DokuHook{salt: salt}(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        hook.setGraduator(GRADUATOR, true);

        MIN_T = TickMath.minUsableTick(60);
        MAX_T = TickMath.maxUsableTick(60);
        vm.deal(address(this), 10_000_000 ether);
        vm.deal(address(raw), 10_000_000 ether);

        tokR = new B1Tok();
        tokB = new B1Tok();
        KR = _key(address(tokR));
        KB = _key(address(tokB));
        IR = KR.toId();
        IB = KB.toId();

        vm.startPrank(GRADUATOR);
        manager.initialize(KR, SQRT_1_1);
        hook.registerPool(KR, address(tokR), hook.SINK_REWARDS(), SINK, 0);
        manager.initialize(KB, SQRT_1_1);
        hook.registerPool(KB, address(tokB), hook.SINK_BURN(), SINK, 0);
        vm.stopPrank();

        tokR.approve(address(lp), type(uint256).max);
        tokB.approve(address(lp), type(uint256).max);
        tokR.transfer(address(raw), 1e32);
        tokB.transfer(address(raw), 1e32);
        lp.modifyLiquidity{value: 1_000_000 ether}(
            KR, ModifyLiquidityParams({tickLower: MIN_T, tickUpper: MAX_T, liquidityDelta: 200_000 ether, salt: 0}), ""
        );
        lp.modifyLiquidity{value: 1_000_000 ether}(
            KB, ModifyLiquidityParams({tickLower: MIN_T, tickUpper: MAX_T, liquidityDelta: 200_000 ether, salt: 0}), ""
        );
    }

    function _key(address t) internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(t),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
    }

    function _ledger(PoolId id) internal view returns (uint256) {
        return hook.pendingProtocol(id) + hook.pendingSink(id) + hook.owedTax(id);
    }

    /// @dev The state a successful drain would have to move. Both are asserted unchanged after
    ///      every reverting attempt, so "it reverted" is backed by "and nothing happened".
    function _witness(PoolId id) internal view returns (uint256 singletonMon, uint256 ledger, uint256 hookClaims) {
        return (
            address(manager).balance,
            _ledger(id),
            manager.balanceOf(address(hook), Currency.wrap(address(0)).toId())
        );
    }

    // ------------------------------------------------------------------ 1. the flip is real

    /// @notice THE FIX, AT THE DOOR. `_beforeSwap` now bounds the levy by `type(int128).max` rather
    ///         than `type(uint128).max`, so the whole sign-flip window is a `LevyOverflow` revert
    ///         and `int128.max` itself is the last value that returns.
    ///
    /// @dev The DEFECT it replaces is proven against the LIVE, IMMUTABLE generation-3 bytecode on a
    ///      Monad-mainnet fork, in `test/audit/HookJitDonateFork.t.sol`
    ///      (`test_L01_theLiveHookReturnsANegativeSpecifiedDelta`). It has to be proven there: the
    ///      hook in this file is compiled from source, and source is the thing that changed.
    ///
    ///      Driven from a pranked PoolManager because `BaseHook.beforeSwap` is `onlyPoolManager`.
    function test_L01_theWindowIsNowRejectedAtTheDoor() public {
        // REWARDS quote leg is 100 bps, so specified == 100 * levy names the levy exactly.
        uint256 levy = uint256(uint128(type(int128).max)) + 1;

        vm.prank(address(manager));
        vm.expectRevert(abi.encodeWithSelector(DokuHook.LevyOverflow.selector, levy * 100, uint256(100)));
        hook.beforeSwap(
            address(this),
            KR,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(levy * 100),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );

        // And one wei lower is the last value that returns, still positive.
        vm.prank(address(manager));
        (, BeforeSwapDelta ok,) = hook.beforeSwap(
            address(this),
            KR,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256((levy - 1) * 100),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );
        assertEq(
            BeforeSwapDeltaLibrary.getSpecifiedDelta(ok), type(int128).max, "int128.max is not the last positive value"
        );
    }

    // ------------------------------------------- 2. and unreachable as a loss, in all four shapes

    /// @dev One attempt: name an amount whose levy is `levy`, in the given shape, and assert the
    ///      whole transaction reverts with nothing moved. `exactIn` picks the sign of
    ///      `amountSpecified`; `zeroForOne` picks the direction; between them they are the four
    ///      shapes `Hooks.beforeSwap` distinguishes.
    function _attempt(PoolKey memory key, PoolId id, uint256 bps, uint256 levy, bool exactIn, bool zeroForOne)
        internal
    {
        uint256 named = (levy * 10_000) / bps;
        int256 amountSpecified = exactIn ? -int256(named) : int256(named);
        uint160 limit = zeroForOne ? uint160(uint256(SQRT_1_1) / 2) : uint160(uint256(SQRT_1_1) * 2);

        (uint256 mon0, uint256 lg0, uint256 cl0) = _witness(id);
        for (uint256 e = 0; e < 3; ++e) {
            vm.expectRevert();
            raw.run{value: 0}(
                key,
                SwapParams({zeroForOne: zeroForOne, amountSpecified: amountSpecified, sqrtPriceLimitX96: limit}),
                RawSwapper.Exit(e)
            );
        }
        (uint256 mon1, uint256 lg1, uint256 cl1) = _witness(id);
        assertEq(mon1, mon0, "singleton MON moved");
        assertEq(lg1, lg0, "hook ledger moved");
        assertEq(cl1, cl0, "hook claim balance moved");
    }

    /// @notice The window is unreachable on a NON-BURN market, in both shapes whose specified leg
    ///         carries a levy. Since the fix it is rejected by `LevyOverflow` in `_beforeSwap`
    ///         itself; before the fix it was rejected by `CurrencyNotSettled` at the end of the
    ///         unlock. The assertion is deliberately "it reverted AND nothing moved" rather than a
    ///         specific selector, so the same test proves the same thing on both. (On the other two the specified leg is the token, whose rate is 0,
    ///         so `_beforeSwap` returns `ZERO_DELTA` before any cast — covered separately below.)
    function test_L01_rewardsMarket_windowAlwaysReverts() public {
        uint256[3] memory levies =
            [uint256(uint128(type(int128).max)) + 1, (uint256(1) << 127) + 1e18, uint256(type(uint128).max)];
        for (uint256 i; i < levies.length; ++i) {
            // exact input, zeroForOne  -> specified is currency0 == the quote
            _attempt(KR, IR, 100, levies[i], true, true);
            // exact output, oneForZero -> specified is currency0 == the quote
            _attempt(KR, IR, 100, levies[i], false, false);
        }
    }

    /// @notice And on a BURN market, where the TOKEN leg is the one carrying 70 bps, so the other
    ///         two shapes are live too. All four are driven here.
    function test_L01_burnMarket_windowAlwaysReverts() public {
        uint256[2] memory levies = [uint256(uint128(type(int128).max)) + 1, uint256(type(uint128).max)];
        for (uint256 i; i < levies.length; ++i) {
            _attempt(KB, IB, 30, levies[i], true, true); // quote leg, exact in
            _attempt(KB, IB, 30, levies[i], false, false); // quote leg, exact out
            _attempt(KB, IB, 70, levies[i], true, false); // token leg, exact in
            _attempt(KB, IB, 70, levies[i], false, true); // token leg, exact out
        }
    }

    /// @notice The two shapes on a non-BURN market whose specified leg is the token: rate 0, so
    ///         the cast is never reached at all, and an ordinary swap of that shape still works.
    function test_L01_nonBurnTokenLegNeverReachesTheCast() public {
        vm.prank(address(manager));
        (, BeforeSwapDelta d,) = hook.beforeSwap(
            address(this),
            KR,
            SwapParams({
                zeroForOne: false,
                amountSpecified: -int256(uint256(type(uint128).max)),
                sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        assertEq(BeforeSwapDelta.unwrap(d), BeforeSwapDelta.unwrap(BeforeSwapDeltaLibrary.ZERO_DELTA));
    }

    // ------------------------------------------------------------------- 3. where the edge is

    /// @notice THE CEILING IS LOWER THAN THE CAST. `type(int128).max` is the largest levy the cast
    ///         itself would carry with the right sign — and it still cannot be settled, because v4
    ///         subtracts the hook's delta from the SWAPPER's (`Hooks.afterSwap`,
    ///         `swapDelta = swapDelta - hookDelta`) and `BalanceDelta.sub` runs the result through
    ///         `SafeCast.toInt128`. The swapper is already negative by whatever they paid, so any
    ///         hook credit within `paid` of `int128.max` pushes that subtraction past `int128.min`.
    ///
    /// @dev This is the second independent backstop, and it is why the report's "downstream v4
    ///      accounting is expected to revert" is not merely expected but doubly enforced: the
    ///      sign-flip window dies on `CurrencyNotSettled`, and the top of the legal range dies here,
    ///      before that. The practical ceiling on a settle-able specified levy is therefore
    ///      `int128.max - amountTheSwapperPays`, not `int128.max`.
    function test_L01_topOfTheLegalRangeAlsoReverts() public {
        (uint256 mon0, uint256 lg0,) = _witness(IR);
        uint160 limit = uint160(uint256(SQRT_1_1) * 99 / 100);
        vm.expectRevert(); // SafeCastOverflow, out of BalanceDelta.sub
        raw.run(
            KR,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(uint256(uint128(type(int128).max)) * 100),
                sqrtPriceLimitX96: limit
            }),
            RawSwapper.Exit.PAY
        );
        (uint256 mon1, uint256 lg1,) = _witness(IR);
        assertEq(mon1, mon0, "singleton MON moved");
        assertEq(lg1, lg0, "hook ledger moved");
    }

    /// @notice And the size that DOES settle, so the ceiling is bracketed rather than asserted from
    ///         one side. A named 1,000,000 MON with a binding price limit levies 10,000 MON, the
    ///         swapper pays it, and every delta closes.
    function test_L01_aLargeButSettleableLevyGoesThrough() public {
        uint256 lg0 = _ledger(IR);
        (uint256 fg0,) = IPoolManager(address(manager)).getFeeGrowthGlobals(IR);
        uint128 liq = IPoolManager(address(manager)).getLiquidity(IR);

        BalanceDelta d = raw.run(
            KR,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(1_000_000 ether),
                sqrtPriceLimitX96: uint160(uint256(SQRT_1_1) * 99 / 100)
            }),
            RawSwapper.Exit.PAY
        );
        (uint256 fg1,) = IPoolManager(address(manager)).getFeeGrowthGlobals(IR);
        uint256 donated = ((fg1 - fg0) * liq) >> 128;
        uint256 levied = (_ledger(IR) - lg0) + donated;

        console2.log("[L-01 ok] swapper paid MON :", uint256(uint128(-d.amount0())));
        console2.log("[L-01 ok] levied to ledger :", _ledger(IR) - lg0);
        console2.log("[L-01 ok] donated to LPs   :", donated);
        // 100 bps of the NAMED million, not of what the limit let the pool consume.
        assertApproxEqAbs(levied, 10_000 ether, 3, "the named-amount levy is not 100 bps of 1,000,000");
    }

    // ----------------------------------------------------------- 4. the int256.min negation path

    /// @notice `type(int256).min` is now rejected by NAME. It was already only a revert — the
    ///         negation is checked, so it panicked rather than wrapping — but a `Panic(0x11)` out of
    ///         a hook is indistinguishable in a trace from a bug in the hook, and the report asked
    ///         for the case to be rejected before the negation rather than by it.
    function test_L01_int256MinIsRejectedByName() public {
        vm.prank(address(manager));
        vm.expectRevert(DokuHook.AmountSpecifiedNotNegatable.selector);
        hook.beforeSwap(
            address(this),
            KR,
            SwapParams({
                zeroForOne: true,
                amountSpecified: type(int256).min,
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );
    }

    /// @notice And through the real manager, in every shape, it is still just a revert.
    function test_L01_int256MinThroughSwapReverts() public {
        (uint256 mon0, uint256 lg0,) = _witness(IR);
        vm.expectRevert();
        raw.run(
            KR,
            SwapParams({
                zeroForOne: true,
                amountSpecified: type(int256).min,
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            RawSwapper.Exit.NONE
        );
        vm.expectRevert();
        raw.run(
            KR,
            SwapParams({
                zeroForOne: false,
                amountSpecified: type(int256).min,
                sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            RawSwapper.Exit.NONE
        );
        (uint256 mon1, uint256 lg1,) = _witness(IR);
        assertEq(mon1, mon0);
        assertEq(lg1, lg0);
    }

    // ------------------------------------------------- 5. every other cast site, one at a time

    /// @notice `_afterSwap`'s unspecified leg (DokuHook.sol:459-467) cannot flip.
    ///
    /// @dev Two casts there. `uint128((uint256(uint128(raw)) * bps) / BPS)` is bounded because
    ///      `raw` is an `int128` from the pool's own delta, so `|raw| <= 2**127` and the product
    ///      over 10,000 at the 1,100 bps ceiling is at most 1.87e37 — an order of magnitude below
    ///      `int128.max`. The `int128(unspecLevy)` return therefore cannot be negative. Asserted as
    ///      arithmetic rather than fuzzed through a pool, because no pool can produce the input.
    function test_L01_unspecifiedLegCannotFlip() public pure {
        uint256 worst = (uint256(uint128(type(int128).max)) * 1100) / 10_000;
        console2.log("[L-01] worst possible unspecified levy:", worst);
        console2.log("[L-01] int128.max                     :", uint256(uint128(type(int128).max)));
        assertLt(worst, uint256(uint128(type(int128).max)), "the unspecified leg CAN flip");
    }

    /// @notice `_makerLevy`'s `toBalanceDelta(int128(h0), int128(h1))` (DokuHook.sol:876-905)
    ///         cannot flip either, and the reason is the recorded maker rate rather than the clamp.
    ///
    /// @dev `h_i` is clamped to `a_i = |base_i| <= 2**127`, so the clamp ALONE permits
    ///      `h_i == 2**127`, which casts to `int128.min`. What rules it out is that the clamp only
    ///      binds when `makerBps > 10_000`, and `registerPool` (DokuHook.sol:606-607) derives the
    ///      recorded rates from `PROTOCOL_LEVY_BPS + SINK_LEVY_BPS == 30` and `0` with no setter
    ///      anywhere. At 30 bps the levy is 0.3% of a number that is itself at most 2**127.
    ///
    ///      That is a real dependency between two distant lines, so it is asserted on the LIVE
    ///      market's recorded rates rather than on the constants.
    function test_L01_makerLevyCannotFlip() public view {
        DokuHook.Market memory r = hook.markets(IR);
        DokuHook.Market memory b = hook.markets(IB);
        for (uint256 i; i < 4; ++i) {
            uint16 bps = [r.makerBps0, r.makerBps1, b.makerBps0, b.makerBps1][i];
            assertLe(bps, 10_000, "a recorded maker rate can engage the clamp: int128(h) would flip");
            uint256 worst = (uint256(1 << 127) * bps) / 10_000;
            assertLe(worst, uint256(uint128(type(int128).max)), "maker levy can exceed int128.max");
        }
        console2.log("[L-01] maker rates rewards:", r.makerBps0, r.makerBps1);
        console2.log("[L-01] maker rates burn   :", b.makerBps0, b.makerBps1);
    }

    /// @notice `_makerLevy`'s own negations (`-b0`, `-b1`) are checked, so `int128.min` panics
    ///         rather than wrapping — and `_afterRemoveLiquidity` is documented as a callback that
    ///         MUST NEVER REVERT (DokuHook.sol:836). The panic is therefore a real, if
    ///         astronomically-out-of-reach, brick rather than a fund loss. Recorded as arithmetic;
    ///         a `BalanceDelta` of `int128.min` is not producible by any position v4 will mint.
    function test_L01_makerLevyNegationIsCheckedNotWrapping() public {
        int128 lo = type(int128).min;
        vm.expectRevert(stdError.arithmeticError);
        this.negate(lo);
    }

    function negate(int128 x) external pure returns (int128) {
        return -x;
    }

    // ------------------------------------------------------------------------------- 6. fuzz

    /// @notice THE INVARIANT, FUZZED, AND THE BOUNDARY PINNED TO THE WEI. The returned specified
    ///         delta is never negative, in any of the four exact-input/exact-output x direction
    ///         shapes; and the call reverts EXACTLY when `levyWide > type(int128).max`. Not
    ///         "usually" and not "for absurd inputs" — a single, sharp, computable line, asserted
    ///         from both sides.
    ///
    /// @dev Driven straight at `beforeSwap` from a pranked PoolManager, because the property being
    ///      characterised is the HOOK's return value, not v4's ability to survive it. The market is
    ///      the BURN one so that no shape short-circuits at `bps == 0`.
    function testFuzz_L01_signFlipsExactlyAboveInt128Max(uint256 seed, bool exactIn, bool zeroForOne) public {
        uint256 named = bound(seed, 1, (uint256(type(uint128).max) * 10_000) / 30);
        int256 amountSpecified = exactIn ? -int256(named) : int256(named);
        // Which leg is specified, and therefore which rate: BURN is 30 bps on the quote
        // (currency0 == native MON here) and 70 on the token.
        bool specifiedIsCurrency0 = (amountSpecified < 0) == zeroForOne;
        uint256 bps = specifiedIsCurrency0 ? 30 : 70;
        uint256 levyWide = (named * bps) / 10_000;

        vm.prank(address(manager));
        try hook.beforeSwap(
            address(this),
            KB,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        ) returns (bytes4, BeforeSwapDelta d, uint24) {
            int128 spec = BeforeSwapDeltaLibrary.getSpecifiedDelta(d);
            assertGe(spec, 0, "L-01 reachable: the hook returned a negative specified delta");
            assertEq(uint256(uint128(spec)), levyWide, "levy is not the named amount at the leg rate");
            assertLe(levyWide, uint256(uint128(type(int128).max)), "a levy above int128.max was accepted");
        } catch {
            // The ONLY reason this may revert is the levy bound, and it must bite at exactly the
            // signed maximum -- one wei lower has to return.
            assertGt(levyWide, uint256(uint128(type(int128).max)), "an in-range specified amount reverted");
        }
    }

    /// @notice AND THE PROPERTY THAT DECIDES THE SEVERITY: through the real `PoolManager.swap`,
    ///         every amount in the sign-flip window reverts, and nothing moves. Fuzzed across the
    ///         window in both live shapes and all three exit strategies.
    ///
    /// @dev This is the difference between "the cast is wrong" (it is) and "the cast loses money"
    ///      (it cannot). A pass here at 10,000 runs is the evidence for downgrading L-01 to
    ///      Informational: there is no amount in the window, in any shape, that leaves the
    ///      singleton or the hook's ledger a wei different from where it started.
    function testFuzz_L01_windowIsUnreachableThroughSwap(uint256 seed, bool exactIn) public {
        uint256 levy = bound(seed, uint256(uint128(type(int128).max)) + 1, type(uint128).max);
        uint256 named = (levy * 10_000) / 100; // REWARDS quote leg
        int256 amountSpecified = exactIn ? -int256(named) : int256(named);
        bool zeroForOne = exactIn; // the two shapes whose specified leg is the quote

        (uint256 mon0, uint256 lg0, uint256 cl0) = _witness(IR);
        for (uint256 e = 0; e < 4; ++e) {
            vm.expectRevert();
            raw.run(
                KR,
                SwapParams({
                    zeroForOne: zeroForOne,
                    amountSpecified: amountSpecified,
                    sqrtPriceLimitX96: zeroForOne ? uint160(uint256(SQRT_1_1) / 2) : uint160(uint256(SQRT_1_1) * 2)
                }),
                RawSwapper.Exit(e)
            );
        }
        (uint256 mon1, uint256 lg1, uint256 cl1) = _witness(IR);
        assertEq(mon1, mon0, "singleton MON moved");
        assertEq(lg1, lg0, "hook ledger moved");
        assertEq(cl1, cl0, "hook claim balance moved");
    }
}
