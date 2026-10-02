// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

/*
 * THE v3 FIXES TO `ZapRouter`, AND THE PROPERTIES THEY MUST NOT COST.
 *
 * Two defects came out of the 2026-09-10 adversarial pass on `zapSellToNative`, both confirmed by
 * PoC in `test/audit/ZapSellHunt.t.sol`, neither of them fund theft:
 *
 *   1. `maxZapValue` weighed `nativeOut` — the swap leg's credit on v4's ledger — while the money
 *      that actually leaves is the whole balance, swept absolutely. A hook inside the CALLER'S OWN
 *      path could separate the two at no cost, and MON that arrived by any other door was never
 *      weighed at all.
 *
 *   2. `receive()` admitted anything from the PoolManager, and the header read that as "nobody may
 *      PUSH MON here". `take` on the zero currency is a raw call FROM the PoolManager to a
 *      recipient the CALLER names, so a stranger could push for the price of one unlock.
 *
 * The hunt file keeps the original PoCs and now asserts they fail. This file is the other half of
 * the job, and it is mostly about what the fixes MUST NOT have broken:
 *
 *   THE GATE IS NOT TOO TIGHT
 *     test_aSellStillCollectsItsOwnTakeThroughTheGate       the sell the gate exists for still pays
 *     test_aHookMayPayTheRouterInsideTheRoutersOwnUnlock    and a hook's take mid-unlock still lands
 *     test_theWindowIsShutAgainOnceTheZapReturns            it is a window, not a door left open
 *     test_aRevertedZapDoesNotLeaveTheWindowLatched         nor one left open by a failure
 *
 *   THE CEILING WEIGHS THE RIGHT NUMBER
 *     test_aPayoutAtTheCeilingIsAllowedAndOneWeiOverIsNot   the boundary, from both sides
 *     test_aZeroCeilingStillMeansNoCeiling                  the documented escape hatch survives
 *     test_theCeilingRefusalUnwindsTheWholeSale             reverting after the sweep costs nothing
 *     test_donatedMonIsWeighedEvenThoughTheSellerDidNotEarnIt
 *
 *   THE BUY NEEDED NOTHING, AND THIS IS WHY
 *     test_aBuySettlesExactlyMsgValueEvenWhenAHookPaysTheRouterMidUnlock
 *     test_theBuyCeilingIsNotTrippedByMonTheBuyerNeverSpent
 *
 * Nothing here is a stub of the money path: a local v4 `PoolManager` with real liquidity, real
 * caller-chosen hooks, and a real `BondingCurve` clone. Same fixture shape as `ZapSellHunt.t.sol`,
 * deliberately — a fix proved against a different world than the finding is not proved.
 */

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {BaseTestHooks} from "@uniswap/v4-core/src/test/BaseTestHooks.sol";
import {PathKey} from "@uniswap/v4-periphery/src/libraries/PathKey.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";

import {BondingCurve} from "../../src/BondingCurve.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {DokuFactory} from "../../src/DokuFactory.sol";
import {ZapRouter} from "../../src/ZapRouter.sol";
import {Sinks} from "../../src/lib/Sinks.sol";
import {MarketsStub} from "../mocks/MarketsStub.sol";

/// @dev An ordinary 18-decimal quote so every number in this file stays readable.
contract V3Quote is ERC20 {
    constructor() ERC20("V3 Quote", "V3Q") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * @dev Pushes native MON to an arbitrary address THROUGH the PoolManager — the shape `receive()`'s
 *      sender check does not cover, because the MON arrives from the PoolManager itself.
 *
 *      Kept identical to `ZapSellHunt.t.sol`'s `Pusher` on purpose. The two files must be attacking
 *      the same thing for one to be evidence about the other.
 */
contract V3Pusher is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function push(address to, uint256 amount) external {
        pm.unlock(abi.encode(to, amount));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "not pm");
        (address to, uint256 amount) = abi.decode(data, (address, uint256));
        // Debit: the PM pays `to` out of its own reserves and books the debt against us.
        pm.take(Currency.wrap(address(0)), to, amount);
        // Credit: we hand the same amount back, so the pool is whole and the unlock balances.
        pm.sync(Currency.wrap(address(0)));
        pm.settle{value: amount}();
        return "";
    }

    receive() external payable {}
}

/**
 * @dev A hook that PAYS the router out of its own pocket while the router's swap is in flight.
 *
 *      The distinction from `ZapSellHunt.t.sol`'s `DivertingHook` is the whole reason this one
 *      exists. That one MOVES proceeds — it returns `+d` on the unspecified currency, so the
 *      router's v4 credit shrinks by exactly what its balance gains and the total is unchanged.
 *      This one ADDS: it takes `d` to the router and settles `d` of its own MON, so the router
 *      ends up with more than the trade produced and nothing on the ledger says so.
 *
 *      It is the legitimate-looking case, which is why the gate must still accept it: the take
 *      happens inside the ROUTER'S own unlock. Flags: afterSwap (0x40) only — it returns no delta.
 */
contract DonatingHook is BaseTestHooks {
    IPoolManager public immutable pm;
    address public target;
    uint128 public gift;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function arm(address target_, uint128 gift_) external {
        target = target_;
        gift = gift_;
    }

    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata)
        external
        override
        returns (bytes4, int128)
    {
        uint128 g = gift;
        if (g != 0) {
            // Debit us `g` and pay it to the target's raw balance, then hand the PM `g` of our own
            // MON so the unlock balances. Net for the pool: zero. Net for the target: a gift.
            pm.take(Currency.wrap(address(0)), target, g);
            pm.sync(Currency.wrap(address(0)));
            pm.settle{value: g}();
        }
        return (IHooks.afterSwap.selector, int128(0));
    }

    receive() external payable {}
}

/**
 * @dev Asks the one question a test contract cannot ask by itself: is the router's expected-unlock
 *      window still open AFTER a zap, in the SAME call frame?
 *
 *      The flag is transient. A test that ran the zap in one external call and the push in the next
 *      would be asserting something about the runner's transient-storage lifetime rather than about
 *      `_unlock`'s `tstore(slot, 0)` — and it would pass either way, which is worse than failing.
 *      Both halves happen inside one call to `runAfter*` here, so only the contract can explain the
 *      result.
 */
contract WindowProbe {
    ZapRouter public immutable router;
    V3Pusher public immutable pusher;
    IERC20 public immutable base;

    constructor(ZapRouter router_, V3Pusher pusher_, IERC20 base_) {
        router = router_;
        pusher = pusher_;
        base = base_;
    }

    /// @return sold  the zap went through
    /// @return pushed a stranger's push landed afterwards, in the same transaction
    function runAfterSuccess(address curve, PathKey[] memory path, uint256 baseIn, uint256 gift)
        external
        returns (bool sold, bool pushed)
    {
        base.approve(address(router), baseIn);
        router.zapSellToNative(curve, path, baseIn, 0, 0, type(uint256).max);
        sold = true;
        pushed = _push(gift);
    }

    /// @return reverted the zap failed while the window was open
    /// @return pushed   a stranger's push landed afterwards, in the same transaction
    function runAfterRevert(address curve, PathKey[] memory path, uint256 baseIn, uint256 gift)
        external
        returns (bool reverted, bool pushed)
    {
        base.approve(address(router), baseIn);
        try router.zapSellToNative(curve, path, baseIn, 0, 0, type(uint256).max) returns (uint256) {}
        catch {
            reverted = true;
        }
        pushed = _push(gift);
    }

    function _push(uint256 amount) private returns (bool ok) {
        try pusher.push(address(router), amount) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    receive() external payable {}
}

contract ZapRouterV3Test is Test {
    PoolManager internal manager;
    PoolModifyLiquidityTest internal lp;
    V3Quote internal quote;
    BondingCurve internal curve;
    DokuToken internal base;
    MarketsStub internal markets;
    ZapRouter internal router;
    V3Pusher internal pusher;
    DonatingHook internal donateHook;

    address internal constant OWNER = address(0xB0B);
    address internal constant SELLER = address(0xA11CE);
    address internal constant BUYER = address(0xB47E5);
    address internal constant TREASURY = address(0x7EA);
    address internal constant GRADUATOR = address(0x6AD);

    uint160 internal constant SQRT_1_1 = 79228162514264337593543950336;
    uint24 internal constant FEE = 500;
    /// @dev Never initialised. A path through it reverts INSIDE the unlock, which is the only way
    ///      to reach a failure with the expected-unlock flag still raised.
    uint24 internal constant DEAD_FEE = 3000;
    int24 internal constant SPACING = 10;
    int256 internal constant LIQUIDITY = 100_000e18;
    uint256 internal constant QUOTE_TARGET = 1_000e18;
    uint256 internal constant FIRST_BUY = 200e18;
    uint256 internal constant NEVER = type(uint256).max;

    /// @dev Low 14 bits are the v4 hook permission mask. 0x40 = afterSwap, with no return delta.
    address internal constant DONATE_HOOK_ADDR = address(uint160(0x4000000000000000000000000000000000000040));

    receive() external payable {}

    function setUp() public {
        manager = new PoolManager(address(this));
        lp = new PoolModifyLiquidityTest(IPoolManager(address(manager)));

        quote = new V3Quote();
        quote.mint(address(this), 100_000_000e18);
        quote.approve(address(lp), type(uint256).max);

        vm.deal(address(this), 10_000_000 ether);

        PoolKey memory plainKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(quote)),
            fee: FEE,
            tickSpacing: SPACING,
            hooks: IHooks(address(0))
        });
        manager.initialize(plainKey, SQRT_1_1);
        lp.modifyLiquidity{value: 500_000 ether}(
            plainKey,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: LIQUIDITY, salt: 0}),
            ""
        );

        deployCodeTo("ZapRouterV3.t.sol:DonatingHook", abi.encode(IPoolManager(address(manager))), DONATE_HOOK_ADDR);
        donateHook = DonatingHook(payable(DONATE_HOOK_ADDR));
        vm.deal(DONATE_HOOK_ADDR, 10_000 ether);

        PoolKey memory hookKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(quote)),
            fee: FEE,
            tickSpacing: SPACING,
            hooks: IHooks(DONATE_HOOK_ADDR)
        });
        manager.initialize(hookKey, SQRT_1_1);
        lp.modifyLiquidity{value: 500_000 ether}(
            hookKey,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: LIQUIDITY, salt: 0}),
            ""
        );

        curve = BondingCurve(payable(Clones.clone(address(new BondingCurve()))));
        base = DokuToken(Clones.clone(address(new DokuToken())));
        base.initialize("V3", "V3", address(curve), false, "https://cdn.doku.family/metadata/test.json");
        curve.initialize(
            address(base),
            address(quote),
            QUOTE_TARGET,
            Sinks.REWARDS,
            address(0),
            0,
            address(0),
            TREASURY,
            GRADUATOR,
            address(0)
        );

        markets = new MarketsStub();
        router = new ZapRouter(IPoolManager(address(manager)), DokuFactory(payable(address(markets))), OWNER, 0);

        pusher = new V3Pusher(IPoolManager(address(manager)));
        vm.deal(address(pusher), 1_000 ether);

        // Past the launch tax window, so every number below is the plain curve's.
        vm.warp(vm.getBlockTimestamp() + curve.TAX_WINDOW() + 1);

        quote.mint(SELLER, FIRST_BUY);
        vm.startPrank(SELLER);
        quote.approve(address(curve), type(uint256).max);
        curve.buyWithToken(FIRST_BUY, 0, NEVER);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ helpers

    function _toNative(address hooks) internal pure returns (PathKey[] memory p) {
        p = new PathKey[](1);
        p[0] = PathKey({
            intermediateCurrency: Currency.wrap(address(0)),
            fee: FEE,
            tickSpacing: SPACING,
            hooks: IHooks(hooks),
            hookData: ""
        });
    }

    /// @dev A sell route into a pool that was never initialised, so `poolManager.swap` reverts
    ///      while the router's expected-unlock flag is still raised.
    function _toNowhere() internal pure returns (PathKey[] memory p) {
        p = new PathKey[](1);
        p[0] = PathKey({
            intermediateCurrency: Currency.wrap(address(0)),
            fee: DEAD_FEE,
            tickSpacing: SPACING,
            hooks: IHooks(address(0)),
            hookData: ""
        });
    }

    function _toQuote(address hooks) internal view returns (PathKey[] memory p) {
        p = new PathKey[](1);
        p[0] = PathKey({
            intermediateCurrency: Currency.wrap(address(quote)),
            fee: FEE,
            tickSpacing: SPACING,
            hooks: IHooks(hooks),
            hookData: ""
        });
    }

    function _half() internal view returns (uint256) {
        return base.balanceOf(SELLER) / 2;
    }

    function _sell(uint256 baseIn, address hooks) internal returns (uint256 nativeOut) {
        vm.startPrank(SELLER);
        base.approve(address(router), baseIn);
        nativeOut = router.zapSellToNative(address(curve), _toNative(hooks), baseIn, 0, 0, NEVER);
        vm.stopPrank();
    }

    /// @dev What the sale is worth, measured by doing it and rolling back.
    function _measure(uint256 baseIn, address hooks) internal returns (uint256 produced) {
        uint256 snap = vm.snapshotState();
        produced = _sell(baseIn, hooks);
        vm.revertToState(snap);
    }

    // =============================================================================================
    //  1. The gate is not too tight
    // =============================================================================================

    /**
     * THE FIRST THING TO PROVE ABOUT A NEW REFUSAL IS THAT IT DOES NOT REFUSE THE REAL CASE.
     *
     * `receive()` now wants the router's own expected-unlock flag raised, and the router's own
     * `poolManager.take(NATIVE, address(this), ...)` is the one payment that must always satisfy
     * it. A gate that got this wrong would not be subtle — every sell on every market would revert
     * — but "obvious in production" is not a test.
     */
    function test_aSellStillCollectsItsOwnTakeThroughTheGate() public {
        uint256 baseIn = _half();
        uint256 before = SELLER.balance;

        uint256 nativeOut = _sell(baseIn, address(0));

        assertGt(nativeOut, 0, "the sell produced nothing");
        assertEq(SELLER.balance - before, nativeOut, "the seller was not paid what the sale produced");
        assertEq(address(router).balance, 0, "the router kept MON after a sell");
        assertEq(base.balanceOf(address(router)), 0, "the router kept market tokens after a sell");
        assertEq(quote.balanceOf(address(router)), 0, "the router kept quote after a sell");
    }

    /**
     * AND IT MUST STILL ACCEPT A PAYMENT IT DID NOT ASK FOR, so long as the payment happens inside
     * the router's own unlock.
     *
     * A hook in the caller's own path may pay this contract at its own expense. Refusing that would
     * turn somebody else's donation into a failed trade for the caller, which is a worse outcome
     * than the donation. The gate is about WHOSE unlock, not about who benefits — the ceiling is
     * what makes sure the extra MON is weighed on the way out.
     */
    function test_aHookMayPayTheRouterInsideTheRoutersOwnUnlock() public {
        uint256 baseIn = _half();
        uint256 honest = _measure(baseIn, DONATE_HOOK_ADDR);

        uint128 gift = 7 ether;
        donateHook.arm(address(router), gift);

        uint256 before = SELLER.balance;
        uint256 nativeOut = _sell(baseIn, DONATE_HOOK_ADDR);

        assertEq(nativeOut, honest, "the donation moved the swap leg's credit, which it must not");
        assertEq(SELLER.balance - before, honest + gift, "the hook's gift did not reach the seller");
        assertEq(address(router).balance, 0, "the router kept the gift");
    }

    /**
     * IT IS A WINDOW, NOT A DOOR PROPPED OPEN. `_unlock` lowers the flag as soon as
     * `poolManager.unlock` returns, so a push arriving later in the same transaction is refused
     * exactly as one arriving in a different transaction would be.
     *
     * Both halves run inside one call to the probe — see `WindowProbe` for why that matters.
     */
    function test_theWindowIsShutAgainOnceTheZapReturns() public {
        uint256 baseIn = _half();
        WindowProbe probe = new WindowProbe(router, pusher, IERC20(address(base)));
        vm.prank(SELLER);
        base.transfer(address(probe), baseIn);

        (bool sold, bool pushed) = probe.runAfterSuccess(address(curve), _toNative(address(0)), baseIn, 5 ether);

        assertTrue(sold, "the sell itself failed, so this test measured nothing");
        assertFalse(pushed, "the expected-unlock window was still open after the zap returned");
        assertEq(address(router).balance, 0, "MON stuck to the router");
    }

    /**
     * NOR LEFT OPEN BY A FAILURE, which is the case the flag is transient for.
     *
     * The route below points at a pool that was never initialised, so `poolManager.swap` reverts
     * with the flag RAISED — the one moment a latch could survive. `tstore` is reverted along with
     * everything else, and the caller catching the failure does not change that. A storage flag
     * would need an explicit unwind on every reverting path to say the same thing.
     */
    function test_aRevertedZapDoesNotLeaveTheWindowLatched() public {
        uint256 baseIn = _half();
        WindowProbe probe = new WindowProbe(router, pusher, IERC20(address(base)));
        vm.prank(SELLER);
        base.transfer(address(probe), baseIn);

        (bool reverted, bool pushed) = probe.runAfterRevert(address(curve), _toNowhere(), baseIn, 5 ether);

        assertTrue(reverted, "the zap was supposed to fail inside the unlock and did not");
        assertFalse(pushed, "a reverted zap left the expected-unlock window latched open");
        assertEq(address(router).balance, 0, "MON stuck to the router");
    }

    // =============================================================================================
    //  2. The ceiling weighs what was paid
    // =============================================================================================

    /**
     * THE BOUNDARY, FROM BOTH SIDES, on the number that now matters.
     *
     * `paid` is the whole balance the sweep moved, so the MON forced onto the router below counts
     * towards the ceiling even though the sale did not earn it. Exactly at the ceiling is allowed —
     * `>` and not `>=`, the same comparison the buy uses — and one wei less of ceiling refuses.
     *
     * `vm.deal` rather than a push or a hook on purpose: a forced credit is the shape `selfdestruct`
     * and a block reward have, and it is the case no `receive()` can ever refuse. If the ceiling
     * holds for that, the doors the gate does close are a second line rather than the only one.
     */
    function test_aPayoutAtTheCeilingIsAllowedAndOneWeiOverIsNot() public {
        uint256 baseIn = _half();
        uint256 honest = _measure(baseIn, address(0));
        uint256 forced = 4 ether;

        vm.deal(address(router), forced);

        // One wei short of the payout: refused, and the error carries what would have LEFT.
        vm.prank(OWNER);
        router.setMaxZapValue(honest + forced - 1);
        vm.startPrank(SELLER);
        base.approve(address(router), baseIn);
        vm.expectRevert(
            abi.encodeWithSelector(ZapRouter.SellTooLarge.selector, honest + forced, honest + forced - 1)
        );
        router.zapSellToNative(address(curve), _toNative(address(0)), baseIn, 0, 0, NEVER);
        vm.stopPrank();

        // Exactly the payout: allowed.
        vm.prank(OWNER);
        router.setMaxZapValue(honest + forced);
        uint256 before = SELLER.balance;
        uint256 nativeOut = _sell(baseIn, address(0));
        assertEq(nativeOut, honest, "the swap leg produced something other than the honest amount");
        assertEq(SELLER.balance - before, honest + forced, "the payout was not the whole balance");
        assertEq(address(router).balance, 0, "the router kept MON after a sell");
    }

    /**
     * AND ZERO IS STILL NO CEILING, not a ceiling of nothing.
     *
     * The documented escape hatch — "an experiment that worked should end with one transaction, not
     * a redeployment" — is the one thing a comparison moved onto a bigger number could quietly cost.
     */
    function test_aZeroCeilingStillMeansNoCeiling() public {
        assertEq(router.maxZapValue(), 0, "fixture: the router shipped with a ceiling");

        uint256 baseIn = _half();
        vm.deal(address(router), 10_000 ether);

        uint256 before = SELLER.balance;
        uint256 nativeOut = _sell(baseIn, address(0));

        assertGt(SELLER.balance - before, 10_000 ether, "the payout was capped by a ceiling of nothing");
        assertEq(SELLER.balance - before, nativeOut + 10_000 ether, "the payout was not the whole balance");
    }

    /**
     * REVERTING AFTER THE MONEY MOVED COSTS NOTHING, which is the one thing worth checking about
     * where the new check sits.
     *
     * `_sweepNative` pays the seller and THEN the ceiling is weighed, because the number to weigh is
     * the number the payment moved. A revert on that line unwinds the transfer with the pull, the
     * curve sell and the swap — so the failure mode is a wasted gas limit, which the ceiling's own
     * docblock already warns about, and not a partial trade.
     */
    function test_theCeilingRefusalUnwindsTheWholeSale() public {
        uint256 baseIn = _half();
        uint256 honest = _measure(baseIn, address(0));

        vm.deal(address(router), 1 ether);
        vm.prank(OWNER);
        router.setMaxZapValue(honest);

        uint256 sellerBase = base.balanceOf(SELLER);
        uint256 raisedBefore = curve.quoteRaised();
        (uint128 baseReserveBefore, uint128 quoteReserveBefore) = curve.reserves();

        vm.startPrank(SELLER);
        base.approve(address(router), baseIn);
        vm.expectRevert(abi.encodeWithSelector(ZapRouter.SellTooLarge.selector, honest + 1 ether, honest));
        router.zapSellToNative(address(curve), _toNative(address(0)), baseIn, 0, 0, NEVER);
        vm.stopPrank();

        assertEq(SELLER.balance, 0, "the seller was paid by a call that reverted");
        assertEq(base.balanceOf(SELLER), sellerBase, "the seller's tokens were not returned");
        assertEq(curve.quoteRaised(), raisedBefore, "the curve moved");
        (uint128 baseReserveAfter, uint128 quoteReserveAfter) = curve.reserves();
        assertEq(baseReserveAfter, baseReserveBefore, "the curve's base reserve moved");
        assertEq(quoteReserveAfter, quoteReserveBefore, "the curve's quote reserve moved");
        assertEq(address(router).balance, 1 ether, "the forced credit did not survive the revert");
    }

    /**
     * A DONATION IS WEIGHED TOO, and that is deliberate rather than incidental.
     *
     * `DonatingHook` does not move the sale's proceeds the way `ZapSellHunt.t.sol`'s `DivertingHook`
     * does — it pays out of its own pocket, so the router genuinely leaves with more than the trade
     * produced. `maxZapValue` bounds what one zap may MOVE THROUGH this contract, and MON somebody
     * else supplied is still MON leaving through it. Weighing the payout catches both flows with
     * one comparison; weighing the ledger caught neither.
     */
    function test_donatedMonIsWeighedEvenThoughTheSellerDidNotEarnIt() public {
        uint256 baseIn = _half();
        uint256 honest = _measure(baseIn, DONATE_HOOK_ADDR);

        uint128 gift = 3 ether;
        donateHook.arm(address(router), gift);

        vm.prank(OWNER);
        router.setMaxZapValue(honest);

        vm.startPrank(SELLER);
        base.approve(address(router), baseIn);
        vm.expectRevert(abi.encodeWithSelector(ZapRouter.SellTooLarge.selector, honest + gift, honest));
        router.zapSellToNative(address(curve), _toNative(DONATE_HOOK_ADDR), baseIn, 0, 0, NEVER);
        vm.stopPrank();

        // The swap leg on its own is under the ceiling, which is the point: v2 weighed that number
        // and waved this trade through.
        vm.prank(OWNER);
        router.setMaxZapValue(honest + gift);
        uint256 before = SELLER.balance;
        uint256 nativeOut = _sell(baseIn, DONATE_HOOK_ADDR);
        assertEq(nativeOut, honest, "the swap leg's credit was not the number v2 would have weighed");
        assertEq(SELLER.balance - before, honest + gift, "the payout was not credit plus gift");
    }

    // =============================================================================================
    //  3. The buy needed nothing, and this is the verification rather than the assumption
    // =============================================================================================

    /**
     * A BUY SPENDS `msg.value` AND NOTHING ELSE, whatever a hook in the caller's path does.
     *
     * The audit's reason for leaving the buy alone: `_swap` is handed `msg.value`, `_checkPath`
     * forbids any hop back into MON so native is never a hop's UNSPECIFIED currency and no
     * `afterSwapReturnDelta` can touch it, and a hook that shaved the SPECIFIED side would leave
     * `spent != -amount` and trip `HopUnfilled`. So the router's native debt is exactly `msg.value`
     * and the ceiling on `msg.value` is a ceiling on the spend.
     *
     * Measured at the PoolManager, which is where a settle actually lands: its native balance rises
     * by the amount settled and by nothing else. The hook's gift passes straight through it — taken
     * out, paid back in — so a buy that had settled one wei more than `msg.value` would show here.
     */
    function test_aBuySettlesExactlyMsgValueEvenWhenAHookPaysTheRouterMidUnlock() public {
        uint128 gift = 2 ether;
        donateHook.arm(address(router), gift);

        vm.deal(BUYER, 100 ether);
        uint256 pmBefore = address(manager).balance;
        uint256 buyerBefore = BUYER.balance;

        vm.prank(BUYER);
        uint256 baseOut = router.zapBuyWithNative{value: 5 ether}(
            address(curve), _toQuote(DONATE_HOOK_ADDR), 0, 0, NEVER
        );

        assertGt(baseOut, 0, "the buy produced nothing");
        assertEq(address(manager).balance - pmBefore, 5 ether, "the buy settled something other than msg.value");
        // The buyer paid 5 and was handed the hook's gift back by the absolute sweep.
        assertEq(buyerBefore - BUYER.balance, 5 ether - gift, "the buyer's net MON is not spend minus gift");
        assertEq(address(router).balance, 0, "the router kept the gift");
        assertEq(quote.balanceOf(address(router)), 0, "the router kept quote after a buy");
    }

    /**
     * AND THE BUY'S CEILING IS NOT TRIPPED BY MON THE BUYER NEVER SPENT — which is why the sell's
     * fix is one-sided rather than symmetric.
     *
     * `maxZapValue` on the buy bounds `msg.value`, checked before anything external is called,
     * because that is the whole of the exposure. Extending the sell's "weigh the payout" rule to
     * the buy would mean refusing a trade because a stranger, or a hook, put MON on this contract —
     * turning somebody else's donation into the buyer's failed transaction. The ceiling is set to
     * exactly `msg.value` here, with a gift larger than nothing arriving mid-flight, and the buy
     * goes through.
     */
    function test_theBuyCeilingIsNotTrippedByMonTheBuyerNeverSpent() public {
        vm.prank(OWNER);
        router.setMaxZapValue(5 ether);

        donateHook.arm(address(router), 2 ether);
        vm.deal(address(router), 40 ether); // forced past every gate, before the call
        vm.deal(BUYER, 100 ether);

        uint256 buyerBefore = BUYER.balance;
        vm.prank(BUYER);
        uint256 baseOut = router.zapBuyWithNative{value: 5 ether}(
            address(curve), _toQuote(DONATE_HOOK_ADDR), 0, 0, NEVER
        );

        assertGt(baseOut, 0, "the buy at exactly the ceiling was refused");
        // 5 spent, 2 gifted and 40 forced both swept back: the buyer nets +37.
        assertEq(BUYER.balance - buyerBefore, 37 ether, "the buy did not refund what it never spent");
        assertEq(address(router).balance, 0, "the router kept MON after a buy");

        // One wei over `msg.value` is still refused, on `msg.value` and before anything external.
        vm.prank(OWNER);
        router.setMaxZapValue(5 ether - 1);
        vm.prank(BUYER);
        vm.expectRevert(
            abi.encodeWithSelector(ZapRouter.ZapTooLarge.selector, uint256(5 ether), uint256(5 ether - 1))
        );
        router.zapBuyWithNative{value: 5 ether}(address(curve), _toQuote(DONATE_HOOK_ADDR), 0, 0, NEVER);
    }
}
