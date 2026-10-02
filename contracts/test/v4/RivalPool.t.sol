// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";

contract RivalToken is ERC20 {
    constructor() ERC20("Rival", "RVL") {
        _mint(msg.sender, 10_000_000_000e18);
    }
}

/// @notice The measurement this whole migration exists for, and its honest counterpart.
///
/// @dev On Uniswap V3 the fee accrues to POSITIONS, so a locked graduation position keeps only its
///      pro-rata share and anyone may mint alongside it. Measured on this repo's own forked V3
///      stack: a rival with 1% of the locked capital in a single tick-spacing band took 39.55% of
///      the fee, and a JIT LP at capital parity took 98.49%, leaving the market 1.1 bps of volume.
///      A tax funded that way collects approximately nothing on any market a market maker notices.
///
///      `test_rivalLiquidityCannotDiluteTheLevy` is the number that replaces it. It is the positive
///      result, and `test_aHooklessRivalPoolIsCompletelyUntaxed` immediately below it is the
///      negative one — both belong in the same file, because a reader who sees only the first will
///      over-claim.
contract RivalPoolTest is Test {
    uint160 internal constant FLAGS = 0x2FCF;
    address internal constant TREASURY = address(0xBEEF);
    address internal constant CREATOR_SINK = address(0xC5);
    uint160 internal constant SQRT_1_1 = 79228162514264337593543950336;

    PoolManager internal manager;
    DokuHook internal hook;
    PoolSwapTest internal swapper;
    PoolModifyLiquidityTest internal lp;
    address internal graduator = address(0x6AD);

    receive() external payable {}

    function setUp() public {
        manager = new PoolManager(address(this));
        swapper = new PoolSwapTest(IPoolManager(address(manager)));
        lp = new PoolModifyLiquidityTest(IPoolManager(address(manager)));
        bytes memory args = abi.encode(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        hook = new DokuHook{salt: salt}(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        hook.setGraduator(graduator, true);
        vm.deal(address(this), 5_000_000 ether);
    }

    function _hookedMarket(uint256 rivalMultiple) internal returns (PoolId id, RivalToken t, PoolKey memory k) {
        t = new RivalToken();
        k = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(t)),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        id = PoolIdLibrary.toId(k);
        vm.startPrank(graduator);
        manager.initialize(k, SQRT_1_1);
        hook.registerPool(k, address(t), hook.SINK_REWARDS(), address(0x51), 0);
        vm.stopPrank();

        t.approve(address(lp), type(uint256).max);
        t.approve(address(swapper), type(uint256).max);

        // The "locked" graduation position.
        lp.modifyLiquidity{value: 200_000 ether}(
            k, ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 1_000 ether, salt: 0}), ""
        );
        // A rival market maker in the SAME pool, at a multiple of the locked capital.
        if (rivalMultiple != 0) {
            lp.modifyLiquidity{value: 2_000_000 ether}(
                k,
                ModifyLiquidityParams({
                    tickLower: -60_000,
                    tickUpper: 60_000,
                    liquidityDelta: int256(1_000 ether * rivalMultiple),
                    salt: bytes32(uint256(1))
                }),
                ""
            );
        }
    }

    function _buy(PoolKey memory k, uint256 monIn) internal {
        swapper.swap{value: monIn}(
            k,
            SwapParams({zeroForOne: true, amountSpecified: -int256(monIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @dev THE measurement. Identical volume through the same PoolKey, once with only the locked
    ///      position and once with a rival holding 100x its capital. The levy must be BIT-IDENTICAL,
    ///      because it is skimmed from the singleton's flash-accounting ledger and never touches LP
    ///      accrual — which is the entire reason this design moved off V3.
    function test_rivalLiquidityCannotDiluteTheLevy() public {
        (PoolId aloneId,, PoolKey memory aloneKey) = _hookedMarket(0);
        uint256 sinkBefore = hook.pendingSink(aloneId);
        uint256 protBefore = hook.pendingProtocol(aloneId);
        _buy(aloneKey, 1_000 ether);
        uint256 aloneSink = hook.pendingSink(aloneId) - sinkBefore;
        uint256 aloneProt = hook.pendingProtocol(aloneId) - protBefore;

        (PoolId rivalId,, PoolKey memory rivalKey) = _hookedMarket(100);
        uint256 rSinkBefore = hook.pendingSink(rivalId);
        uint256 rProtBefore = hook.pendingProtocol(rivalId);
        _buy(rivalKey, 1_000 ether);
        uint256 rivalSink = hook.pendingSink(rivalId) - rSinkBefore;
        uint256 rivalProt = hook.pendingProtocol(rivalId) - rProtBefore;

        // BOTH books now prove it. This comment has been wrong twice and the history is short
        // enough to keep: gen-1 funded the sink from swaps, gen-2 through gen-4 donated that share
        // to the pool's LPs so only the treasury's line moved, and round 4 routed it back to the
        // sink — not as a rate change but as a destination change, `_settleLeg` booking
        // `LP_LEVY_BPS` to `pendingSink` instead of to `poolManager.donate`. So the sink's take is
        // a real, non-zero number again, and asserting it non-zero is what keeps the equality below
        // from being two zeroes agreeing with each other.
        assertGt(aloneProt, 0, "no levy at all, so this proves nothing");
        assertGt(aloneSink, 0, "the sink took nothing, so its equality below proves nothing");
        assertEq(rivalSink, aloneSink, "100x rival liquidity diluted the sink's take");
        assertEq(rivalProt, aloneProt, "100x rival liquidity diluted the treasury's take");
    }

    /// @dev The negative result, in the same file on purpose. The levy is scoped to one PoolId, and
    ///      `PoolManager.initialize` has NO access control — so anyone may open a hookless pool for
    ///      the same pair and trade it completely untaxed. No design on v4 can prevent this: the
    ///      token cannot tell one pool from another when every pool is the same singleton.
    ///
    ///      Depth in the canonical pool is the only thing that holds volume, and §2's
    ///      `s* = g*m/(m-1)` has infimum `g`, so no amount of depth reaches the sub-1% band. This
    ///      belongs in the launch copy, not in a footnote.
    function test_aHooklessRivalPoolIsCompletelyUntaxed() public {
        RivalToken t = new RivalToken();
        PoolKey memory hookless = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(t)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0)) // no hook, so no gate and no levy
        });

        // Anyone. No graduator, no registration, no permission of any kind.
        vm.prank(address(0xA11CE));
        manager.initialize(hookless, SQRT_1_1);

        t.approve(address(lp), type(uint256).max);
        t.approve(address(swapper), type(uint256).max);
        lp.modifyLiquidity{value: 200_000 ether}(
            hookless,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 1_000 ether, salt: 0}),
            ""
        );

        uint256 hookMonBefore = manager.balanceOf(address(hook), Currency.wrap(address(0)).toId());
        _buy(hookless, 1_000 ether);
        assertEq(
            manager.balanceOf(address(hook), Currency.wrap(address(0)).toId()),
            hookMonBefore,
            "a hookless pool somehow paid the levy"
        );
    }

    /// @notice A third-party LP earns NOTHING from a graduated DOKU pool, at any volume.
    ///
    /// @dev THIS NAME HAS FLIPPED TWICE AND THE HISTORY IS THE POINT. It began as
    ///      `test_theCanonicalPoolPaysItsLpsNothing` — true, and the reason the liquidity UI stayed
    ///      switched off. Generation 2 made it `test_theCanonicalPoolPaysItsLps` when
    ///      `_settleLeg` started donating `LP_LEVY_BPS` to in-range positions. Round 3 measured what
    ///      that donation actually bought — see `test/audit/Round3Jit.t.sol` — and the protocol
    ///      owner routed the 70 bps to the market's sink instead. So it is back, asserting the
    ///      original claim for a new reason, and the assertion is now an EQUALITY rather than an
    ///      inequality: not "LPs earn little", but "there is no mechanism by which a position in
    ///      this pool accrues anything".
    ///
    ///      Two mechanisms could pay a position and both are off. `PoolKey.fee` is
    ///      `POOL_LP_FEE == 0` and must stay zero — a non-zero LP fee re-arms exactly the
    ///      recapture the hook exists to escape — and the hook donates nothing. A graduated DOKU
    ///      pool is therefore seed-only by construction, which is the accepted cost of the round-4
    ///      decision and is stated as such in `LP_LEVY_BPS`'s docblock.
    ///
    ///      Asserted through the COLLECT path rather than a round trip. A round trip returns
    ///      inventory that has rotated against the LP — after buys they hold more token and less
    ///      MON — and mistaking that rotation for a fee is easy. A zero-liquidity poke returns the
    ///      accrued fee and nothing else, so a zero here is unambiguously "earned nothing".
    function test_theCanonicalPoolPaysItsLpsNothing() public {
        (PoolId id,, PoolKey memory k) = _hookedMarket(0);

        uint256 sink0 = hook.pendingSink(id);
        _buy(k, 5_000 ether);
        _buy(k, 5_000 ether);

        BalanceDelta fees = lp.modifyLiquidity(
            k, ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 0, salt: 0}), ""
        );

        assertEq(fees.amount0(), 0, "an LP earned MON from a taxed swap");
        assertEq(fees.amount1(), 0, "an LP accrued a token fee, which nothing levies");
        // And the money still exists. A pool that paid its LPs nothing because the levy had
        // vanished would pass the two lines above; this one says where it went.
        assertGt(hook.pendingSink(id) - sink0, 0, "the levy paid nobody at all");
    }

    /// @notice The share that used to be donated reaches the SINK, at exactly its rate.
    ///
    /// @dev Ties the amount to the rate rather than to a fixture, which is what the donate-era
    ///      version of this test did too — a test that only asserts "greater than zero" passes just
    ///      as happily if the split is one basis point as if it is the seventy it is supposed to be,
    ///      and the difference is the entire value proposition.
    ///
    ///      The bound has TIGHTENED from a two-sided inequality to an equality, and that is the
    ///      substance of the change rather than a tidier assertion. Under `donate` the seed and this
    ///      LP shared the credit, so the most this test could say was "no more than the rate, and
    ///      not far below it" — and "shared, in what proportion" was precisely the degree of freedom
    ///      round 3 attacked. The sink's ledger has no such proportion in it: it is 70/100 of the
    ///      quote leg's levy, to the unit, whoever else is in the pool.
    function test_theLpShareNowGoesToTheSinkAtItsRate() public {
        (PoolId id,, PoolKey memory k) = _hookedMarket(0);

        uint256 monIn = 5_000 ether;
        uint256 sink0 = hook.pendingSink(id);
        _buy(k, monIn);
        uint256 credited = hook.pendingSink(id) - sink0;

        BalanceDelta fees = lp.modifyLiquidity(
            k, ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 0, salt: 0}), ""
        );

        uint256 levied = (monIn * hook.LP_LEVY_BPS()) / 10_000;
        assertEq(credited, levied, "the sink was not credited the levy's 70 bps exactly");
        assertEq(fees.amount0(), 0, "a rival LP took a share of it after all");
    }
}
