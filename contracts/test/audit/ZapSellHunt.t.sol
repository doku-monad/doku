// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

/*
 * ADVERSARIAL AUDIT OF `ZapRouter.zapSellToNative` AND EVERYTHING IT TOUCHES.
 *
 * Every test in this file is a PoC against `src/ZapRouter.sol`, and each one is either a defect or
 * a false positive killed on the record. Nothing here is a stub of the money path: a local v4
 * `PoolManager` with real liquidity, real caller-chosen hostile hooks, and a real `BondingCurve`
 * clone.
 *
 * THE FOUR PoCs BELOW WERE WRITTEN AGAINST THE DEPLOYED v2 AND NOW ASSERT THE v3 FIX. Each keeps
 * its original exploit — the same pusher, the same diverting hook, the same trade, the same
 * fixture — and asserts that it no longer works. A PoC rewritten into a happy path proves nothing,
 * so the attack is still built and still fired; only the expected outcome moved. They are RENAMED,
 * because a test called `...DoesNotBound...` that asserts the bound holds is a worse lie than the
 * bug was; the v2 names are kept here so the audit record still resolves.
 *
 *   test_theStrangersPushThroughThePoolManagerIsRefused     `receive()` now wants the router's OWN
 *     was test_anyoneCanPushMonToTheRouterThroughThePoolManager    unlock open, not just the PM
 *   test_thereIsNoPushedMonForTheNextSellerToSweep          so the absolute sweep has nothing extra
 *     was test_pushedMonIsSweptByTheNextUnrelatedSeller           to hand on
 *   test_theSellCeilingBoundsWhatIsActuallyPaidOut          `maxZapValue` weighs what was PAID —
 *     was test_theSellCeilingDoesNotBoundWhatIsActuallyPaidOut    even MON forced past every gate
 *   test_aHookCannotMoveProceedsPastTheCeilingCheck         and the zero-cost hook bypass is caught
 *     was test_aHookMovesProceedsPastTheCeilingCheck
 *
 * `test/audit/ZapRouterV3.t.sol` carries the rest of the fix's coverage — chiefly that the gate is
 * not so tight that it breaks the sell it exists for.
 *
 * FALSE POSITIVES KILLED
 *   test_aHookCannotReenterTheSell / ...TheBuy              `nonReentrant` really does hold
 *   test_aHookCannotDriveUnlockCallbackDirectly             the one unguarded entry point is shut
 *   test_aHookFindsNoLiveAllowanceAndCannotPullTheRoutersQuote
 *   test_aHookThatEatsTheWholeOutputIsNamedNotWrapped       `got <= 0` fires before the cast
 *   test_theBuyCeilingStillBoundsWhatABuyCanSpend           the buy side of the cap is sound
 *
 * DESIGN, NOT A DEFECT, BUT WORTH SEEING
 *   test_withNoFloorAHostileHookTakesTheWholeSale
 */

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {BalanceDelta, toBalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {BaseTestHooks} from "@uniswap/v4-core/src/test/BaseTestHooks.sol";
import {PathKey} from "@uniswap/v4-periphery/src/libraries/PathKey.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {ReentrancyGuard} from "openzeppelin/utils/ReentrancyGuard.sol";

import {BondingCurve} from "../../src/BondingCurve.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {DokuFactory} from "../../src/DokuFactory.sol";
import {ZapRouter} from "../../src/ZapRouter.sol";
import {Sinks} from "../../src/lib/Sinks.sol";
import {MarketsStub} from "../mocks/MarketsStub.sol";

/// @dev An ordinary 18-decimal quote so every number in this file stays readable.
contract HuntQuote is ERC20 {
    constructor() ERC20("Hunt Quote", "HQ") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * @dev Pushes native MON to an arbitrary address THROUGH the PoolManager.
 *
 *      This is the shape the router's `receive()` gate does not cover: it checks `msg.sender ==
 *      poolManager`, and `PoolManager.take` on the zero currency is a raw call FROM the pool
 *      manager to any recipient the caller names. Anyone may open an unlock and name one.
 */
contract Pusher is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    /// @notice Move `amount` MON of this contract's own money onto `to`, laundered through the PM.
    function push(address to, uint256 amount) external payable {
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
 * @dev A hook that diverts part of the swap's native output AWAY from the router's v4 ledger and
 *      hands the same MON straight to the router's BALANCE instead.
 *
 *      Flags: afterSwap (0x40) + afterSwapReturnDelta (0x04). The address it is deployed to
 *      carries exactly those two bits.
 */
contract DivertingHook is BaseTestHooks {
    IPoolManager public immutable pm;
    address public router;
    uint128 public divert;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function arm(address router_, uint128 amount) external {
        router = router_;
        divert = amount;
    }

    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata)
        external
        override
        returns (bytes4, int128)
    {
        uint128 d = divert;
        if (d == 0) return (IHooks.afterSwap.selector, int128(0));
        // Debit us `d` native and pay it to the router's raw balance. The `+d` we return below is
        // the matching credit, so this hook nets to zero and pays for nothing.
        pm.take(Currency.wrap(address(0)), router, d);
        return (IHooks.afterSwap.selector, int128(d));
    }
}

/**
 * @dev A hook that tries to re-enter the router while the router's own swap is in flight.
 *      Flags: beforeSwap (0x80) only.
 */
contract ReenteringHook is BaseTestHooks {
    ZapRouter public router;
    address public curve;
    uint8 public mode; // 1 = sell, 2 = buy, 3 = unlockCallback
    bool public fired;
    bytes public lastRevert;

    function arm(ZapRouter r, address c, uint8 m) external {
        router = r;
        curve = c;
        mode = m;
        fired = false;
    }

    function beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (!fired && mode != 0) {
            fired = true;
            PathKey[] memory p = new PathKey[](1);
            p[0] = PathKey({
                intermediateCurrency: Currency.wrap(address(0)),
                fee: 500,
                tickSpacing: 10,
                hooks: IHooks(address(0)),
                hookData: ""
            });
            if (mode == 1) {
                try router.zapSellToNative(curve, p, 1e18, 0, 0, type(uint256).max) {}
                catch (bytes memory e) {
                    lastRevert = e;
                }
            } else if (mode == 2) {
                try router.zapBuyWithNative{value: 0}(curve, p, 0, 0, type(uint256).max) {}
                catch (bytes memory e) {
                    lastRevert = e;
                }
            } else if (mode == 3) {
                try router.unlockCallback(abi.encode(true, p, address(0), uint256(1))) {}
                catch (bytes memory e) {
                    lastRevert = e;
                }
            }
        }
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }
}


/**
 * @dev The greedy version of `DivertingHook`, plus a probe of what the router is holding while it
 *      is inside its own unlock. Flags: beforeSwap (0x80) | afterSwap (0x40) |
 *      afterSwapReturnDelta (0x04) = 0xC4.
 */
contract PredatorHook is BaseTestHooks {
    IPoolManager public immutable pm;
    address public router;
    address public curve;
    address public baseToken;
    address public quoteToken;
    uint128 public grab;

    uint256 public seenBaseAllowance;
    uint256 public seenQuoteAllowance;
    uint256 public seenQuoteBalance;
    bool public pullSucceeded;
    bool public probed;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function arm(address router_, address curve_, address base_, address quote_, uint128 grab_) external {
        router = router_;
        curve = curve_;
        baseToken = base_;
        quoteToken = quote_;
        grab = grab_;
        probed = false;
        pullSucceeded = false;
    }

    function beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        probed = true;
        // What allowances is the router standing on while a hook runs?
        seenBaseAllowance = IERC20(baseToken).allowance(router, curve);
        seenQuoteAllowance = IERC20(quoteToken).allowance(router, curve);
        // And what quote is sitting on it, un-settled, at this exact moment?
        seenQuoteBalance = IERC20(quoteToken).balanceOf(router);
        // Can any of it be pulled out from under the router?
        if (seenQuoteBalance != 0) {
            (bool ok,) = quoteToken.call(
                abi.encodeWithSelector(IERC20.transferFrom.selector, router, address(this), seenQuoteBalance)
            );
            pullSucceeded = ok && IERC20(quoteToken).balanceOf(address(this)) != 0;
        }
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata)
        external
        override
        returns (bytes4, int128)
    {
        uint128 g = grab;
        if (g == 0) return (IHooks.afterSwap.selector, int128(0));
        pm.take(Currency.wrap(address(0)), address(this), g);
        return (IHooks.afterSwap.selector, int128(g));
    }

    receive() external payable {}
}

/**
 * The sell direction of `ZapRouter`, hunted for fund theft.
 *
 * The fixture is deliberately the same shape as `test/ZapSell.t.sol`'s: a LOCAL v4 `PoolManager`
 * with a real native/quote pool and real liquidity, and a REAL `BondingCurve` clone. Nothing here
 * is a stub of the money path — a PoC against a stub proves nothing about the contract on chain.
 */
contract ZapSellHuntTest is Test {
    PoolManager internal manager;
    PoolModifyLiquidityTest internal lp;
    HuntQuote internal quote;
    BondingCurve internal curve;
    DokuToken internal base;
    MarketsStub internal markets;
    ZapRouter internal router;
    PoolKey internal key;
    PoolKey internal hookKey;
    Pusher internal pusher;
    DivertingHook internal divertHook;
    ReenteringHook internal reenterHook;
    PredatorHook internal predatorHook;

    address internal constant OWNER = address(0xB0B);
    address internal constant SELLER = address(0xA11CE);
    address internal constant ATTACKER = address(0xBAD);
    address internal constant TREASURY = address(0x7EA);
    address internal constant GRADUATOR = address(0x6AD);

    uint160 internal constant SQRT_1_1 = 79228162514264337593543950336;
    uint24 internal constant FEE = 500;
    int24 internal constant SPACING = 10;
    int256 internal constant LIQUIDITY = 100_000e18;
    uint256 internal constant QUOTE_TARGET = 1_000e18;
    uint256 internal constant FIRST_BUY = 200e18;
    uint256 internal constant NEVER = type(uint256).max;

    /// @dev Low 14 bits are the v4 hook permission mask. 0x44 = afterSwap | afterSwapReturnDelta.
    address internal constant DIVERT_HOOK_ADDR = address(uint160(0x1000000000000000000000000000000000000044));
    /// @dev 0x80 = beforeSwap.
    address internal constant REENTER_HOOK_ADDR = address(uint160(0x2000000000000000000000000000000000000080));
    /// @dev 0xC4 = beforeSwap | afterSwap | afterSwapReturnDelta.
    address internal constant PREDATOR_HOOK_ADDR = address(uint160(0x30000000000000000000000000000000000000c4));

    receive() external payable {}

    function setUp() public {
        manager = new PoolManager(address(this));
        lp = new PoolModifyLiquidityTest(IPoolManager(address(manager)));

        quote = new HuntQuote();
        quote.mint(address(this), 100_000_000e18);
        quote.approve(address(lp), type(uint256).max);

        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(quote)),
            fee: FEE,
            tickSpacing: SPACING,
            hooks: IHooks(address(0))
        });
        manager.initialize(key, SQRT_1_1);

        vm.deal(address(this), 10_000_000 ether);
        lp.modifyLiquidity{value: 500_000 ether}(
            key,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: LIQUIDITY, salt: 0}),
            ""
        );

        // The same pool again, behind a hostile hook the caller is free to name in its path.
        deployCodeTo("ZapSellHunt.t.sol:DivertingHook", abi.encode(IPoolManager(address(manager))), DIVERT_HOOK_ADDR);
        divertHook = DivertingHook(DIVERT_HOOK_ADDR);
        hookKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(quote)),
            fee: FEE,
            tickSpacing: SPACING,
            hooks: IHooks(DIVERT_HOOK_ADDR)
        });
        manager.initialize(hookKey, SQRT_1_1);
        lp.modifyLiquidity{value: 500_000 ether}(
            hookKey,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: LIQUIDITY, salt: 0}),
            ""
        );

        deployCodeTo("ZapSellHunt.t.sol:ReenteringHook", "", REENTER_HOOK_ADDR);
        reenterHook = ReenteringHook(REENTER_HOOK_ADDR);

        deployCodeTo(
            "ZapSellHunt.t.sol:PredatorHook", abi.encode(IPoolManager(address(manager))), PREDATOR_HOOK_ADDR
        );
        predatorHook = PredatorHook(payable(PREDATOR_HOOK_ADDR));
        PoolKey memory pk = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(quote)),
            fee: FEE,
            tickSpacing: SPACING,
            hooks: IHooks(PREDATOR_HOOK_ADDR)
        });
        manager.initialize(pk, SQRT_1_1);
        lp.modifyLiquidity{value: 500_000 ether}(
            pk,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: LIQUIDITY, salt: 0}),
            ""
        );

        curve = BondingCurve(payable(Clones.clone(address(new BondingCurve()))));
        base = DokuToken(Clones.clone(address(new DokuToken())));
        base.initialize("Hunt", "HUNT", address(curve), false, "https://cdn.doku.family/metadata/test.json");
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

        pusher = new Pusher(IPoolManager(address(manager)));
        vm.deal(address(pusher), 1_000 ether);

        vm.warp(vm.getBlockTimestamp() + curve.TAX_WINDOW() + 1);

        quote.mint(SELLER, FIRST_BUY);
        vm.startPrank(SELLER);
        quote.approve(address(curve), type(uint256).max);
        curve.buyWithToken(FIRST_BUY, 0, NEVER);
        vm.stopPrank();

        quote.mint(ATTACKER, FIRST_BUY);
        vm.startPrank(ATTACKER);
        quote.approve(address(curve), type(uint256).max);
        curve.buyWithToken(FIRST_BUY, 0, NEVER);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ helpers

    function _hop(address to, address hooks) internal pure returns (PathKey memory) {
        return PathKey({
            intermediateCurrency: Currency.wrap(to),
            fee: FEE,
            tickSpacing: SPACING,
            hooks: IHooks(hooks),
            hookData: ""
        });
    }

    function _toNative() internal pure returns (PathKey[] memory p) {
        p = new PathKey[](1);
        p[0] = _hop(address(0), address(0));
    }

    function _toNativeVia(address hooks) internal pure returns (PathKey[] memory p) {
        p = new PathKey[](1);
        p[0] = _hop(address(0), hooks);
    }

    function _sell(address who, uint256 baseIn, PathKey[] memory path, uint256 minNativeOut)
        internal
        returns (uint256 nativeOut)
    {
        vm.startPrank(who);
        base.approve(address(router), baseIn);
        nativeOut = router.zapSellToNative(address(curve), path, baseIn, 0, minNativeOut, NEVER);
        vm.stopPrank();
    }

    // =============================================================================================
    //  1. The `receive()` gate
    // =============================================================================================

    /**
     * THE GATE NOW DOES WHAT THE HEADER CLAIMS. (v2: it did not.)
     *
     * `receive()` used to refuse everyone but the PoolManager, and the header read that as "nobody
     * may PUSH MON here". It did not follow: `PoolManager.take` on the zero currency is a raw call
     * FROM the pool manager to a recipient the CALLER names, and anybody may open an unlock and
     * name one — so the MON arrived from exactly the address the gate admitted, and the push was
     * available to any address on the chain for the cost of one unlock.
     *
     * v3 adds the second condition: the router's own transient expected-unlock flag. The pusher
     * below is unchanged and still fires; it is now refused, and refused BY NAME rather than by
     * running out of gas or failing somewhere incidental — the wrapped reason is the router's own
     * `OnlyOwnUnlockPays`, which is what says the new line is the one that stopped it.
     *
     * `test_nobodyButThePoolManagerMayPayTheRouter` in `test/ZapSell.t.sol` still measures the
     * direct send, which was never the interesting door.
     */
    function test_theStrangersPushThroughThePoolManagerIsRefused() public {
        // The direct door is shut, exactly as the existing suite says.
        vm.deal(ATTACKER, 10 ether);
        vm.prank(ATTACKER);
        (bool direct,) = address(router).call{value: 1 ether}("");
        assertFalse(direct, "the direct send should still be refused");
        assertEq(address(router).balance, 0);

        // And so is the one that used to be open to anyone. v4 wraps a failed native transfer in
        // ERC-7751, so the router's own selector arrives as the `reason` inside `WrappedError`.
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(router),
                bytes4(0),
                abi.encodeWithSelector(ZapRouter.OnlyOwnUnlockPays.selector),
                abi.encodeWithSelector(CurrencyLibrary.NativeTransferFailed.selector)
            )
        );
        pusher.push(address(router), 5 ether);
        assertEq(address(router).balance, 0, "MON was pushed through the pool manager after all");
    }

    /**
     * And the consequence the header names, from the other end: with the push refused there is
     * nothing on the balance for the absolute sweep to hand to whoever zaps next.
     *
     * The push is still attempted, in a `try` rather than as a bare call, because the assertion
     * that matters is about the SELLER — a test that only proved the push reverts would be the one
     * above wearing a different name.
     */
    function test_thereIsNoPushedMonForTheNextSellerToSweep() public {
        try pusher.push(address(router), 5 ether) {
            fail();
        } catch {}
        assertEq(address(router).balance, 0, "the push landed");

        uint256 before = SELLER.balance;
        uint256 baseIn = base.balanceOf(SELLER) / 2;
        uint256 nativeOut = _sell(SELLER, baseIn, _toNative(), 0);

        assertEq(
            SELLER.balance - before,
            nativeOut,
            "the seller walked off with more than their own proceeds"
        );
        assertEq(address(router).balance, 0);
    }

    // =============================================================================================
    //  2. The spend ceiling
    // =============================================================================================

    /**
     * THE SELL CEILING NOW BOUNDS THE NUMBER THAT LEAVES. (v2: it bounded the wrong one.)
     *
     * `SellTooLarge` used to be checked against `nativeOut` — what the SWAP LEG credited — while
     * the money that actually leaves is `address(this).balance`, swept absolutely. Any MON that
     * reached the router by another door was paid out without ever being weighed.
     *
     * The original PoC put that MON there with `pusher`, and the gate fix has closed that route,
     * so this test uses the one route NO gate can close: `vm.deal` is a forced credit, the shape
     * `selfdestruct` and a block reward have. That is the stronger PoC of the two — it says the
     * ceiling holds even for MON that arrived by a door nobody has thought of, which is exactly the
     * claim `receive()` alone cannot make. The pusher's version of the story is
     * `test_theStrangersPushThroughThePoolManagerIsRefused` above.
     */
    function test_theSellCeilingBoundsWhatIsActuallyPaidOut() public {
        uint256 baseIn = base.balanceOf(SELLER) / 2;

        // Measure the honest proceeds, then set the ceiling just above them so an ordinary sell
        // is legal.
        uint256 snap = vm.snapshotState();
        uint256 honest = _sell(SELLER, baseIn, _toNative(), 0);
        vm.revertToState(snap);

        vm.prank(OWNER);
        router.setMaxZapValue(honest + 1);

        // Forced past every gate this contract has.
        vm.deal(address(router), 50 ether);

        vm.startPrank(SELLER);
        base.approve(address(router), baseIn);
        vm.expectRevert(
            abi.encodeWithSelector(ZapRouter.SellTooLarge.selector, honest + 50 ether, honest + 1)
        );
        router.zapSellToNative(address(curve), _toNative(), baseIn, 0, 0, NEVER);
        vm.stopPrank();

        // Nothing moved: the revert unwinds the sweep along with the rest of the call.
        assertEq(address(router).balance, 50 ether, "the forced credit did not survive the revert");

        // And the ceiling is not a brick: below it, the same sell pays out the whole balance.
        vm.prank(OWNER);
        router.setMaxZapValue(honest + 50 ether);
        uint256 before = SELLER.balance;
        uint256 nativeOut = _sell(SELLER, baseIn, _toNative(), 0);
        assertEq(nativeOut, honest, "the swap leg produced something other than the honest amount");
        assertEq(SELLER.balance - before, honest + 50 ether, "the payout was not the whole balance");
    }

    /**
     * The same bypass at zero cost and with no prior push at all — and it is now caught.
     *
     * A hook in the caller's OWN path moves part of the proceeds off the v4 ledger (where the
     * ceiling used to look) and onto the router's balance (where the sweep looks), netting to zero
     * and funding nothing. Note that the `receive()` fix does NOT close this one: the hook runs
     * inside the ROUTER'S own unlock, where the expected-unlock flag is legitimately raised. The
     * two fixes are independent, and this is the test that says so.
     */
    function test_aHookCannotMoveProceedsPastTheCeilingCheck() public {
        uint256 baseIn = base.balanceOf(SELLER) / 2;

        uint256 snap = vm.snapshotState();
        uint256 honest = _sell(SELLER, baseIn, _toNativeVia(DIVERT_HOOK_ADDR), 0);
        vm.revertToState(snap);

        // A ceiling that would refuse the honest sell outright.
        vm.prank(OWNER);
        router.setMaxZapValue(honest / 2);

        // Without the hook armed, the sell is refused for being too large.
        vm.startPrank(SELLER);
        base.approve(address(router), baseIn);
        vm.expectRevert(abi.encodeWithSelector(ZapRouter.SellTooLarge.selector, honest, honest / 2));
        router.zapSellToNative(address(curve), _toNativeVia(DIVERT_HOOK_ADDR), baseIn, 0, 0, NEVER);
        vm.stopPrank();

        // Armed, the diversion still happens — the hook's `take` lands, because it runs inside the
        // router's own unlock — but the payout is what is weighed, so the total is unchanged and
        // the same refusal fires on the same number.
        uint128 diverted = uint128(honest - honest / 2 + 1);
        divertHook.arm(address(router), diverted);
        vm.startPrank(SELLER);
        base.approve(address(router), baseIn);
        vm.expectRevert(abi.encodeWithSelector(ZapRouter.SellTooLarge.selector, honest, honest / 2));
        router.zapSellToNative(address(curve), _toNativeVia(DIVERT_HOOK_ADDR), baseIn, 0, 0, NEVER);
        vm.stopPrank();

        // And the diversion is still a real one: with the ceiling lifted, the trade goes through,
        // the checked credit is BELOW what the seller banks, and the seller banks all of it. That
        // is the gap the v2 ceiling was reading the wrong side of.
        vm.prank(OWNER);
        router.setMaxZapValue(0);
        uint256 before = SELLER.balance;
        uint256 nativeOut = _sell(SELLER, baseIn, _toNativeVia(DIVERT_HOOK_ADDR), 0);
        assertEq(nativeOut, honest - diverted, "the hook did not actually divert anything");
        assertEq(SELLER.balance - before, honest, "the seller banked something other than the sale");
    }

    // =============================================================================================
    //  3. Re-entrancy from a hook the caller chose — the claim that makes the sweeps safe
    // =============================================================================================

    function _reenterAndExpectGuard(uint8 mode) internal {
        reenterHook.arm(router, address(curve), mode);
        uint256 baseIn = base.balanceOf(ATTACKER) / 2;

        // The hostile hook needs its own pool. Same currencies, its own key.
        PoolKey memory k = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(quote)),
            fee: FEE,
            tickSpacing: SPACING,
            hooks: IHooks(REENTER_HOOK_ADDR)
        });
        manager.initialize(k, SQRT_1_1);
        lp.modifyLiquidity{value: 100_000 ether}(
            k,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 20_000e18, salt: 0}),
            ""
        );

        vm.startPrank(ATTACKER);
        base.approve(address(router), baseIn);
        router.zapSellToNative(address(curve), _toNativeVia(REENTER_HOOK_ADDR), baseIn, 0, 0, NEVER);
        vm.stopPrank();

        assertTrue(reenterHook.fired(), "the hook never ran");
        assertGt(reenterHook.lastRevert().length, 0, "the re-entry did not revert at all");
    }

    /// A hook in the seller's own path cannot re-enter the sell. `nonReentrant` holds.
    function test_aHookCannotReenterTheSell() public {
        _reenterAndExpectGuard(1);
        assertEq(
            bytes4(reenterHook.lastRevert()),
            ReentrancyGuard.ReentrancyGuardReentrantCall.selector,
            "the re-entry was refused for some other reason than the guard"
        );
    }

    /// Nor the buy. The guard is shared between the two entry points.
    function test_aHookCannotReenterTheBuy() public {
        _reenterAndExpectGuard(2);
        assertEq(
            bytes4(reenterHook.lastRevert()),
            ReentrancyGuard.ReentrancyGuardReentrantCall.selector,
            "the re-entry was refused for some other reason than the guard"
        );
    }

    /// Nor may it drive `unlockCallback` directly, which is the one entry point with no guard.
    function test_aHookCannotDriveUnlockCallbackDirectly() public {
        _reenterAndExpectGuard(3);
        assertEq(
            bytes4(reenterHook.lastRevert()),
            ZapRouter.NotPoolManager.selector,
            "unlockCallback accepted a caller that is not the pool manager"
        );
    }

    // =============================================================================================
    //  4. What a hostile hook can actually reach while the router is mid-flight
    // =============================================================================================

    /**
     * THE ALLOWANCE WINDOW NEVER OVERLAPS A HOOK, AND THIS IS THE TEST THAT SAYS SO.
     *
     * `_sell` grants the curve an allowance and takes it back before `_swapToNative` is called;
     * `_buy` grants and takes back after `_swap` has returned. So at the one moment a caller-chosen
     * hook is executing, the router stands on no allowance at all — which is why "a hook could
     * spend the router's approval" is not a finding. Probed from INSIDE the swap rather than
     * asserted from outside it, because outside it the answer is trivially zero.
     */
    function test_aHookFindsNoLiveAllowanceAndCannotPullTheRoutersQuote() public {
        uint256 baseIn = base.balanceOf(SELLER) / 2;
        predatorHook.arm(address(router), address(curve), address(base), address(quote), 0);

        _sell(SELLER, baseIn, _toNativeVia(PREDATOR_HOOK_ADDR), 0);

        assertTrue(predatorHook.probed(), "the hook never ran, so this test measured nothing");
        assertEq(predatorHook.seenBaseAllowance(), 0, "a live base allowance to the curve during the swap");
        assertEq(predatorHook.seenQuoteAllowance(), 0, "a live quote allowance to the curve during the swap");
        assertFalse(predatorHook.pullSucceeded(), "the hook pulled quote out from under the router");
        assertEq(quote.balanceOf(PREDATOR_HOOK_ADDR), 0, "the hook ended up holding the router's quote");
    }

    /**
     * A hook that eats the WHOLE output is refused by name rather than wrapped into an enormous
     * positive number. `got <= 0` is the line; this is the case that reaches it.
     */
    function test_aHookThatEatsTheWholeOutputIsNamedNotWrapped() public {
        uint256 baseIn = base.balanceOf(SELLER) / 2;

        uint256 snap = vm.snapshotState();
        predatorHook.arm(address(router), address(curve), address(base), address(quote), 0);
        uint256 honest = _sell(SELLER, baseIn, _toNativeVia(PREDATOR_HOOK_ADDR), 0);
        vm.revertToState(snap);

        predatorHook.arm(address(router), address(curve), address(base), address(quote), uint128(honest));
        vm.startPrank(SELLER);
        base.approve(address(router), baseIn);
        vm.expectRevert(abi.encodeWithSelector(ZapRouter.HopProducedNothing.selector, uint256(0)));
        router.zapSellToNative(address(curve), _toNativeVia(PREDATOR_HOOK_ADDR), baseIn, 0, 0, NEVER);
        vm.stopPrank();
    }

    /**
     * AND THE THING THAT IS NOT A BUG BUT IS WORTH SEEING: with `minNativeOut` left at zero, a hook
     * the CALLER named takes the entire proceeds and the router books the trade without complaint.
     *
     * This is design decision 2 working exactly as written — "the route is the caller's" and "the
     * two slippage bounds are what make a bad route the caller's loss rather than a silent one".
     * It is a finding only for whoever BUILDS the route: an interface that lets an untrusted pool
     * list into a `PathKey[]`, or that ships `minNativeOut = 0`, is handing an arbitrary contract
     * the whole sale.
     */
    function test_withNoFloorAHostileHookTakesTheWholeSale() public {
        uint256 baseIn = base.balanceOf(SELLER) / 2;

        uint256 snap = vm.snapshotState();
        predatorHook.arm(address(router), address(curve), address(base), address(quote), 0);
        uint256 honest = _sell(SELLER, baseIn, _toNativeVia(PREDATOR_HOOK_ADDR), 0);
        vm.revertToState(snap);

        predatorHook.arm(address(router), address(curve), address(base), address(quote), uint128(honest - 1));

        uint256 before = SELLER.balance;
        uint256 nativeOut = _sell(SELLER, baseIn, _toNativeVia(PREDATOR_HOOK_ADDR), 0);
        assertEq(nativeOut, 1, "the seller was paid more than the one wei the hook left");
        assertEq(SELLER.balance - before, 1, "the seller banked more than one wei");
        assertEq(PREDATOR_HOOK_ADDR.balance, honest - 1, "the hook did not end up with the sale");

        // With a floor, the same route is refused instead.
        vm.revertToState(snap);
        predatorHook.arm(address(router), address(curve), address(base), address(quote), uint128(honest - 1));
        vm.startPrank(SELLER);
        base.approve(address(router), baseIn);
        vm.expectRevert(
            abi.encodeWithSelector(ZapRouter.InsufficientNativeOut.selector, honest, uint256(1))
        );
        router.zapSellToNative(address(curve), _toNativeVia(PREDATOR_HOOK_ADDR), baseIn, 0, honest, NEVER);
        vm.stopPrank();
    }

    /**
     * The BUY ceiling is sound, and this is the control that keeps the sell finding honest — the
     * reason the fix above is a one-sided change rather than a symmetric one.
     *
     * The buy's ceiling bounds what a caller may SPEND, and a buy spends `msg.value` and nothing
     * else: `_swap` is handed `msg.value`, `_checkPath` forbids any hop back into MON so no hop
     * has native as its unspecified currency, and a hook that shaved the specified side would trip
     * `HopUnfilled` before the settle. MON that arrives by some other door is not spend — it is
     * refunded to the buyer by the same absolute sweep — so weighing it would refuse trades for
     * somebody else's donation.
     *
     * The original PoC put that MON there with `pusher`; that route is closed now, so this uses
     * `vm.deal` — the forced credit no gate can stop, which is the only case left that matters.
     */
    function test_theBuyCeilingStillBoundsWhatABuyCanSpend() public {
        vm.prank(OWNER);
        router.setMaxZapValue(1 ether);

        // Forced past every gate, the way `selfdestruct` or a block reward would arrive.
        vm.deal(address(router), 50 ether);

        PathKey[] memory p = new PathKey[](1);
        p[0] = _hop(address(quote), address(0));

        vm.deal(ATTACKER, 100 ether);
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(ZapRouter.ZapTooLarge.selector, uint256(2 ether), uint256(1 ether))
        );
        router.zapBuyWithNative{value: 2 ether}(address(curve), p, 0, 0, NEVER);

        // A legal buy spends only `msg.value`; the forced MON comes back out as "refund".
        uint256 before = ATTACKER.balance;
        vm.prank(ATTACKER);
        router.zapBuyWithNative{value: 1 ether}(address(curve), p, 0, 0, NEVER);
        // Spent exactly `msg.value`; the 50 forced MON came straight back out as "refund", which
        // is the sell finding's mirror and costs nobody anything on this side.
        assertEq(ATTACKER.balance, before - 1 ether + 50 ether, "the buy spent something other than msg.value");
        assertEq(address(router).balance, 0, "the router kept MON after a buy");
    }
}
