// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolDonateTest} from "@uniswap/v4-core/src/test/PoolDonateTest.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";

contract MakerToken is ERC20 {
    constructor() ERC20("Maker", "MKR") {
        _mint(msg.sender, 1_000_000_000e18);
    }
}

/// @notice The maker levy, and the two ways it permanently bricks LP positions if written naively.
/// @dev v4-core applies a hook's liquidity-side delta with NO magnitude check — unlike `beforeSwap`,
///      which has `HookDeltaExceedsSwapAmount`. So exceeding the position's own principal is legal
///      in core and lands as an unrecoverable `SafeCastOverflow` inside PositionManager instead.
contract HookMakerTest is Test {
    using CurrencyLibrary for Currency;

    uint160 internal constant FLAGS = 0x2FCF;
    address internal constant TREASURY = address(0xBEEF);
    address internal constant CREATOR_SINK = address(0xC5);
    uint160 internal constant SQRT_1_1 = 79228162514264337593543950336;

    PoolManager internal manager;
    DokuHook internal hook;
    PoolModifyLiquidityTest internal lp;
    PoolDonateTest internal donor;

    MakerToken internal tok;
    PoolKey internal key;
    PoolId internal id;

    address internal graduator = address(0x6AD);
    address internal sinkAddr = address(0x51);

    receive() external payable {}

    function setUp() public {
        manager = new PoolManager(address(this));
        lp = new PoolModifyLiquidityTest(IPoolManager(address(manager)));
        donor = new PoolDonateTest(IPoolManager(address(manager)));

        bytes memory args = abi.encode(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        hook = new DokuHook{salt: salt}(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        hook.setGraduator(graduator, true);

        tok = new MakerToken();
        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(tok)),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        id = PoolIdLibrary.toId(key);

        vm.startPrank(graduator);
        manager.initialize(key, SQRT_1_1);
        hook.registerPool(key, address(tok), hook.SINK_BURN(), sinkAddr, 0);
        vm.stopPrank();

        tok.approve(address(lp), type(uint256).max);
        tok.approve(address(donor), type(uint256).max);
        vm.deal(address(this), 100_000 ether);
    }

    function _add(int24 lo, int24 hi, int256 liq) internal returns (BalanceDelta) {
        return lp.modifyLiquidity{value: 5_000 ether}(
            key, ModifyLiquidityParams({tickLower: lo, tickUpper: hi, liquidityDelta: liq, salt: 0}), ""
        );
    }

    function _remove(int24 lo, int24 hi, int256 liq) internal returns (BalanceDelta) {
        return lp.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: lo, tickUpper: hi, liquidityDelta: -liq, salt: 0}), ""
        );
    }

    // ------------------------------------------------------------------------------- blockers

    /// @dev BLOCKER 1. `delta` is `principal + feesAccrued`, and POSM slippage-checks
    ///      `principal - hookDelta` through a `toUint128` cast that reverts on a negative BEFORE any
    ///      minimum is compared — so `amount0Min = 0` does not save it. Levy off `delta` and a
    ///      position whose accrued fees are large relative to its principal can never be withdrawn.
    ///
    ///      `PoolKey.fee == 0` does NOT make `feesAccrued` zero: `PoolManager.donate` has no access
    ///      control and credits `feeGrowthGlobal` directly, so an attacker can manufacture it.
    ///      Levying `delta - feesAccrued` is what makes this survivable.
    function test_theLevyBaseExcludesFeesAccruedSoADonationCannotBrickAPosition() public {
        _add(-6000, 6000, 500 ether);

        // A stranger donates far more than the position's principal is worth.
        donor.donate{value: 100 ether}(key, 100 ether, 1_000_000e18, "");

        // The position must still be fully withdrawable.
        BalanceDelta out = _remove(-6000, 6000, 500 ether);
        assertGt(out.amount0(), 0, "principal became unwithdrawable in MON");
        assertGt(out.amount1(), 0, "principal became unwithdrawable in token");
    }

    /// @dev BLOCKER 2. A range order is single-sided by construction, so one currency's base is 0.
    ///      Levying the currency the position never supplied asks the LP for a currency they never
    ///      intended to provide on add, and is the permanent brick on remove. Range orders are the
    ///      exact shape this levy is aimed at, so this is the common case rather than an edge.
    function test_aSingleSidedRangeOrderIsNeverLeviedInTheCurrencyItDidNotSupply() public {
        // Spot sits at tick 0 and the range is [600, 1200], i.e. entirely ABOVE spot. In v4 that
        // means the position is 100% currency0 — MON — and holds no token at all. (Below spot is
        // the token-only side; getting this backwards is easy and the assertion catches it.)
        BalanceDelta d = _add(600, 1200, 100 ether);
        assertEq(d.amount1(), 0, "a MON-only range order moved token");
        assertLt(d.amount0(), 0, "a MON-only range order supplied no MON");

        BalanceDelta o = _remove(600, 1200, 100 ether);
        assertEq(o.amount1(), 0, "a MON-only range order was levied in token on exit");
        assertGt(o.amount0(), 0, "MON principal was not returned");

        // And the mirror image, below spot: token-only, never levied in MON.
        BalanceDelta e = _add(-1200, -600, 100 ether);
        assertEq(e.amount0(), 0, "a token-only range order moved MON");
        BalanceDelta f = _remove(-1200, -600, 100 ether);
        assertEq(f.amount0(), 0, "a token-only range order was levied in MON on exit");
        assertGt(f.amount1(), 0, "token principal was not returned");
    }

    /// @dev `liquidityDelta == 0` routes to the REMOVE branch — v4 splits on `> 0` vs `<= 0` — and
    ///      it is v4's documented fee-collect call, where `principal == 0` and `delta == feesAccrued`.
    ///      Any nonzero levy on it makes every collect revert, unconditionally.
    function test_theZeroLiquidityCollectPathIsNeverLevied() public {
        _add(-6000, 6000, 500 ether);
        donor.donate{value: 10 ether}(key, 10 ether, 1_000e18, "");

        uint256 p0 = hook.pendingProtocol(id);
        uint256 s0 = hook.pendingSink(id);
        lp.modifyLiquidity(key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 0, salt: 0}), "");
        assertEq(hook.pendingProtocol(id), p0, "the collect path was levied for the treasury");
        assertEq(hook.pendingSink(id), s0, "the collect path was levied for the sink");
    }

    /// @dev The one callback that must never revert. Failing closed on the swap path means an
    ///      untaxed swap does not happen; failing closed here means an LP's principal is trapped
    ///      forever, and since the hook address is a PoolKey field a fixed hook is a different pool.
    function test_afterRemoveLiquidityNeverRevertsEvenOnAnUnregisteredPool() public {
        MakerToken orphan = new MakerToken();
        PoolKey memory ok_ = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(orphan)),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        vm.prank(graduator);
        manager.initialize(ok_, SQRT_1_1); // initialised but deliberately never registered

        orphan.approve(address(lp), type(uint256).max);
        lp.modifyLiquidity{value: 5_000 ether}(
            ok_, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 100 ether, salt: 0}), ""
        );
        // The exit must work, and must levy nothing, because the market was never registered.
        BalanceDelta out = lp.modifyLiquidity(
            ok_, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: -100 ether, salt: 0}), ""
        );
        assertGt(out.amount0(), 0, "unregistered pool trapped MON principal");
        assertGt(out.amount1(), 0, "unregistered pool trapped token principal");
        assertEq(hook.pendingProtocol(PoolIdLibrary.toId(ok_)), 0, "unregistered pool was levied");
    }

    // -------------------------------------------------------------------------------- the levy

    /// @dev A round trip through liquidity pays the RECORDED maker rate — `PROTOCOL_LEVY_BPS` on
    ///      each leg since generation 4 — on the way in and again on the way out, which is what
    ///      stops a range order being a zero-levy way to trade.
    ///
    ///      `pendingSink` is asserted UNMOVED, and that assertion has outlived two changes to the
    ///      reason for it. It held when the token-leg maker rate was zero (nothing was charged) and
    ///      it holds now that the rate is 30 bps, for a different reason: `_accrueMaker` books the
    ///      token leg to `pendingProtocolToken`, never to a sink. It is the SWAP levy that funds a
    ///      sink — 70 bps, `_settleLeg`, round 4 — and a maker is not swapping.
    function test_aRangeOrderPaysTheProtocolShareOnEntryAndExit() public {
        uint256 p0 = hook.pendingProtocol(id);
        uint256 s0 = hook.pendingSink(id);
        _add(-6000, 6000, 500 ether);
        assertGt(hook.pendingProtocol(id) - p0, 0, "add levied no MON for the treasury");
        assertEq(hook.pendingSink(id), s0, "a maker add reached a sink's ledger");

        uint256 p1 = hook.pendingProtocol(id);
        uint256 s1 = hook.pendingSink(id);
        _remove(-6000, 6000, 500 ether);
        assertGt(hook.pendingProtocol(id) - p1, 0, "remove levied no MON for the treasury");
        assertEq(hook.pendingSink(id), s1, "a maker remove reached a sink's ledger");
    }

    /// @dev GENERATION 4 INVERTS THIS. The maker rate is now symmetric — `registerPool` records
    ///      `PROTOCOL_LEVY_BPS` on both legs.
    ///
    ///      The rate's original REASON is gone and the rate is not: a zero token-side rate let a
    ///      searcher mint a single-sided token range order for free immediately before a buy, sit
    ///      in range when `_settleLeg`'s donate landed, and take the LP share away from the
    ///      permanently locked seed (measured on a mainnet fork in
    ///      `test/audit/HookJitDonateFork.t.sol`). Round 4 deleted the donate, so that entry buys
    ///      nothing now. `registerPool`'s docblock says why the levy stayed anyway — it is a toll on
    ///      using the venue, it is symmetric because the two legs are the same act, and removing a
    ///      verified rate because its original argument expired is a second change needing its own
    ///      audit.
    ///
    ///      What is asserted here is therefore the NEW policy and, more importantly, that the money
    ///      lands in the treasury's own token bucket rather than in a sink's — a REWARDS sink is
    ///      paid in the quote and a token credited to it would be swept as quote it never received.
    function test_aRewardsMarketsMakerLevyIsChargedOnTheTokenLegToo() public {
        MakerToken rt = new MakerToken();
        PoolKey memory rk = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(rt)),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        vm.startPrank(graduator);
        manager.initialize(rk, SQRT_1_1);
        hook.registerPool(rk, address(rt), hook.SINK_REWARDS(), sinkAddr, 0);
        vm.stopPrank();

        rt.approve(address(lp), type(uint256).max);
        PoolId rid = PoolIdLibrary.toId(rk);
        lp.modifyLiquidity{value: 5_000 ether}(
            rk, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 500 ether, salt: 0}), ""
        );
        uint256 held = manager.balanceOf(address(hook), Currency.wrap(address(rt)).toId());
        assertGt(held, 0, "the token leg of a REWARDS maker levy was not charged");
        assertEq(hook.pendingProtocolToken(rid), held, "the token maker levy is not in the treasury's token bucket");
        assertEq(hook.pendingSink(rid), 0, "a REWARDS sink was credited in the token");
        assertEq(hook.markets(rid).makerBps1, hook.PROTOCOL_LEVY_BPS(), "the recorded token maker rate is not 30 bps");
    }
}
