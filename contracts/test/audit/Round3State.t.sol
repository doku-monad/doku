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
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";
import {SeedLocker} from "../../src/SeedLocker.sol";

contract STok is ERC20 {
    constructor(string memory n) ERC20(n, n) {
        _mint(msg.sender, 1e33);
    }
}

/// @dev Opens a real unlock and then pokes the hook's `unlockCallback` from inside it, so the
///      `NotPoolManager` guard is not the thing under test — the expected-unlock flag is.
contract UnsolicitedUnlocker is IUnlockCallback {
    IPoolManager immutable manager;
    DokuHook immutable hook;

    constructor(IPoolManager m, DokuHook h) {
        manager = m;
        hook = h;
    }

    function go(bytes memory payload) external {
        manager.unlock(payload);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager));
        // Impersonating the manager is impossible, so this is the closest a stranger gets: ask the
        // manager to relay. It cannot, so assert the direct call's guard instead and then prove the
        // second guard with a prank in the test.
        hook.unlockCallback(data);
        return "";
    }
}

/**
 * # Round 3 — the state machines, from first principles
 *
 * Not a diff review. Every external entry point on `DokuHook` and `SeedLocker` that changes state
 * or moves value, asked the same question: who can reach it, and what does it let them keep?
 */
contract Round3StateTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint160 constant FLAGS = 0x2FCF;
    address constant TREASURY = address(0xBEEF);
    uint160 constant SQRT_1_1 = 79228162514264337593543950336;
    int24 constant SPACING = 60;

    PoolManager manager;
    DokuHook hook;
    PoolSwapTest swapper;
    PoolModifyLiquidityTest lp;

    STok quote;
    STok tok;
    PoolKey key;
    PoolId id;

    address graduator = address(0x6AD);
    address creatorSinkAddr = address(0xC5EE);
    address sinkAddr = address(0x51);
    address stranger = address(0xBAD);
    /// @dev Hoisted. `f(g())` evaluates `g()` FIRST and consumes a prank or an armed `expectRevert`.
    uint8 REWARDS;

    receive() external payable {}

    function setUp() public {
        manager = new PoolManager(address(this));
        swapper = new PoolSwapTest(IPoolManager(address(manager)));
        lp = new PoolModifyLiquidityTest(IPoolManager(address(manager)));

        bytes memory args = abi.encode(IPoolManager(address(manager)), address(this), TREASURY, creatorSinkAddr);
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        hook = new DokuHook{salt: salt}(IPoolManager(address(manager)), address(this), TREASURY, creatorSinkAddr);
        hook.setGraduator(graduator, true);
        REWARDS = hook.SINK_REWARDS();

        quote = new STok("Q");
        STok t;
        for (uint256 i; i < 256; ++i) {
            t = new STok("T");
            if (address(t) > address(quote)) break;
        }
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
        hook.registerPool(key, address(tok), REWARDS, sinkAddr, 0);
        vm.stopPrank();

        quote.approve(address(lp), type(uint256).max);
        quote.approve(address(swapper), type(uint256).max);
        quote.approve(address(hook), type(uint256).max);
        tok.approve(address(lp), type(uint256).max);
        tok.approve(address(swapper), type(uint256).max);

        lp.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -60000, tickUpper: 60000, liquidityDelta: 2_000 ether, salt: 0}),
            ""
        );
    }

    // ------------------------------------------------------------------------- the seed waiver

    function test_aStrangerCannotArmOrDisarmTheWaiver() public {
        vm.prank(stranger);
        vm.expectRevert(DokuHook.NotGraduator.selector);
        hook.beginSeed(id, 1 ether, -60, 60);

        vm.prank(stranger);
        vm.expectRevert(DokuHook.NotGraduator.selector);
        hook.endSeed(id);
    }

    /// @notice The waiver is consumed once and never re-arms, and the shape must match exactly.
    function test_theWaiverIsOneShotAndShapeBound() public {
        int24 lo = TickMath.minUsableTick(SPACING);
        int24 hi = TickMath.maxUsableTick(SPACING);
        uint128 shape = 1_000 ether;

        // A wrong-shape add inside the window is levied like anybody else's.
        vm.prank(graduator);
        hook.beginSeed(id, shape, lo, hi);
        uint256 p0 = hook.pendingProtocol(id);
        lp.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: lo, tickUpper: hi, liquidityDelta: int256(uint256(shape)) + 1, salt: 0}),
            ""
        );
        assertGt(hook.pendingProtocol(id), p0, "a wrong-shape add inside the window went free");
        assertFalse(hook.markets(id).seeded, "a wrong-shape add consumed the waiver");

        // The exact shape is waived, exactly once.
        p0 = hook.pendingProtocol(id);
        uint256 pt0 = hook.pendingProtocolToken(id);
        lp.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: lo, tickUpper: hi, liquidityDelta: int256(uint256(shape)), salt: 0}),
            ""
        );
        assertEq(hook.pendingProtocol(id), p0, "the seed paid a quote-leg levy");
        assertEq(hook.pendingProtocolToken(id), pt0, "the seed paid a token-leg levy");
        assertTrue(hook.markets(id).seeded, "the waiver was not consumed");

        // A second identical add, still inside the transient window, is levied.
        p0 = hook.pendingProtocol(id);
        lp.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: lo,
                tickUpper: hi,
                liquidityDelta: int256(uint256(shape)),
                salt: bytes32(uint256(1))
            }),
            ""
        );
        assertGt(hook.pendingProtocol(id), p0, "a SECOND seed-shaped add went free");

        // And re-arming is refused for good.
        vm.prank(graduator);
        vm.expectRevert(DokuHook.AlreadySeeded.selector);
        hook.beginSeed(id, shape, lo, hi);
    }

    /// @notice `endSeed` closes the window even when the graduator's own caller keeps executing.
    function test_endSeedClosesTheWindowWithinTheSameTransaction() public {
        int24 lo = TickMath.minUsableTick(SPACING);
        int24 hi = TickMath.maxUsableTick(SPACING);
        uint128 shape = 1_000 ether;

        vm.prank(graduator);
        hook.beginSeed(id, shape, lo, hi);
        vm.prank(graduator);
        hook.endSeed(id);

        uint256 p0 = hook.pendingProtocol(id);
        lp.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: lo, tickUpper: hi, liquidityDelta: int256(uint256(shape)), salt: 0}),
            ""
        );
        assertGt(hook.pendingProtocol(id), p0, "the waiver survived endSeed");
        assertFalse(hook.markets(id).seeded, "an add after endSeed consumed the waiver");
    }

    // ------------------------------------------------------------------------------ the gate

    function test_onlyAGraduatorCanBringAHookedPoolIntoExistence() public {
        STok other = new STok("O");
        PoolKey memory k2 = PoolKey({
            currency0: Currency.wrap(address(quote) < address(other) ? address(quote) : address(other)),
            currency1: Currency.wrap(address(quote) < address(other) ? address(other) : address(quote)),
            fee: 0,
            tickSpacing: SPACING,
            hooks: IHooks(address(hook))
        });
        vm.prank(stranger);
        vm.expectRevert();
        manager.initialize(k2, SQRT_1_1);

        vm.prank(stranger);
        vm.expectRevert(DokuHook.NotGraduator.selector);
        hook.registerPool(k2, address(other), REWARDS, sinkAddr, 0);
    }

    function test_registerPoolRefusesEveryWrongKeyShape() public {
        STok other = new STok("O");
        bool qFirst = address(quote) < address(other);
        Currency c0 = Currency.wrap(qFirst ? address(quote) : address(other));
        Currency c1 = Currency.wrap(qFirst ? address(other) : address(quote));

        vm.startPrank(graduator);

        PoolKey memory bad = PoolKey({currency0: c0, currency1: c1, fee: 500, tickSpacing: SPACING, hooks: IHooks(address(hook))});
        vm.expectRevert(DokuHook.InvalidPoolKey.selector);
        hook.registerPool(bad, address(other), REWARDS, sinkAddr, 0);

        bad.fee = 0;
        bad.tickSpacing = 10;
        vm.expectRevert(DokuHook.InvalidPoolKey.selector);
        hook.registerPool(bad, address(other), REWARDS, sinkAddr, 0);

        bad.tickSpacing = SPACING;
        bad.hooks = IHooks(address(0));
        vm.expectRevert(DokuHook.InvalidPoolKey.selector);
        hook.registerPool(bad, address(other), REWARDS, sinkAddr, 0);

        bad.hooks = IHooks(address(hook));
        bad.currency0 = c1;
        bad.currency1 = c0;
        vm.expectRevert(DokuHook.InvalidPoolKey.selector);
        hook.registerPool(bad, address(other), REWARDS, sinkAddr, 0);

        // A token that is on neither side of the key.
        bad.currency0 = c0;
        bad.currency1 = c1;
        vm.expectRevert(DokuHook.InvalidPoolKey.selector);
        hook.registerPool(bad, address(0xDEAD), REWARDS, sinkAddr, 0);

        // Over the ceiling.
        vm.expectRevert(DokuHook.InvalidBps.selector);
        hook.registerPool(bad, address(other), REWARDS, sinkAddr, 1001);

        // Already registered.
        vm.expectRevert(DokuHook.AlreadyRegistered.selector);
        hook.registerPool(key, address(tok), REWARDS, sinkAddr, 0);

        vm.stopPrank();
    }

    // -------------------------------------------------------------------------- the withdrawals

    function test_theWithdrawalsRefuseStrangers() public {
        vm.prank(stranger);
        vm.expectRevert(DokuHook.NotSink.selector);
        hook.pullSink(id);

        vm.prank(stranger);
        vm.expectRevert(DokuHook.NotSink.selector);
        hook.pullTax(id);

        // The one deliberate softening: the shared CreatorSink asks every market and is answered
        // zero rather than reverting.
        vm.prank(creatorSinkAddr);
        assertEq(hook.pullSink(id), 0, "the creator sink should be answered zero, not revert");

        // `pullTreasury` is permissionless but pays the immutable treasury and nobody else.
        _swapIn(1_000 ether);
        hook.sweep(id);
        uint256 owed = hook.owedTreasury(Currency.wrap(address(quote)));
        assertGt(owed, 0);
        uint256 sBefore = quote.balanceOf(stranger);
        vm.prank(stranger);
        hook.pullTreasury(Currency.wrap(address(quote)));
        assertEq(quote.balanceOf(stranger), sBefore, "pullTreasury paid its caller");
        assertEq(quote.balanceOf(TREASURY), owed, "the treasury was not paid");
    }

    function test_unlockCallbackRefusesAnUnsolicitedCall() public {
        bytes memory payload = abi.encode(id, uint256(0), uint256(0), uint256(0), uint256(0));

        vm.prank(stranger);
        vm.expectRevert();
        hook.unlockCallback(payload);

        // Even from the real PoolManager's address: the expected-unlock flag is transient and is
        // only set inside `_materialise`.
        vm.prank(address(manager));
        vm.expectRevert(DokuHook.UnexpectedUnlock.selector);
        hook.unlockCallback(payload);
    }

    function test_creditCurveTaxRefusesTheWrongMarketAndCurrency() public {
        // The ERC-20 form on a market whose quote is an ERC-20 is fine; the native form is not.
        vm.expectRevert(DokuHook.WrongSinkCurrency.selector);
        hook.creditCurveTax{value: 0}(id);

        PoolId ghost = PoolId.wrap(bytes32(uint256(0xDEAD)));
        vm.expectRevert(DokuHook.UnknownPool.selector);
        hook.creditCurveTax(ghost, 1);

        vm.expectRevert(DokuHook.UnknownPool.selector);
        hook.creditCurveTax{value: 0}(ghost);
    }

    function test_renounceIsDisabledAndTheOwnerCannotReachMarketFunds() public {
        vm.expectRevert(DokuHook.RenounceDisabled.selector);
        hook.renounceOwnership();

        _swapIn(1_000 ether);
        hook.sweep(id);
        uint256 owed = hook.owedTreasury(Currency.wrap(address(quote)));
        uint256 owedToSink = hook.owedSink(id);
        assertGt(owed, 0);
        assertGt(owedToSink, 0, "the sweep materialised nothing for the sink");

        // The owner has no path to any of it: there is no rate setter, no sink setter, no treasury
        // setter, and `pullTreasury` pays the immutable treasury from any caller.
        hook.pullTreasury(Currency.wrap(address(quote)));
        assertEq(quote.balanceOf(TREASURY), owed);

        // WHAT IS LEFT IS THE MARKET'S, AND THAT IS THE POINT. This line used to read
        // `assertEq(quote.balanceOf(address(hook)), 0)` — with `SINK_LEVY_BPS == 0` and the 70 bps
        // donated to the pool, the treasury's pull emptied the hook and "the owner cannot reach it"
        // was trivially true because there was nothing there. Round 4 books the 70 bps to the sink,
        // so the hook now rests holding a market's money, and the claim has to be made about that
        // money rather than about an empty balance: it is exactly `owedSink`, and the owner has no
        // path to it either. `pullSink` answers only the snapshotted sink address, which this
        // contract is not.
        assertEq(quote.balanceOf(address(hook)), owedToSink, "the hook holds something no ledger claims");
        vm.expectRevert(DokuHook.NotSink.selector);
        hook.pullSink(id);
        assertEq(quote.balanceOf(address(hook)), owedToSink, "the owner moved a market's money");
    }

    // ------------------------------------------------------------------------- the levy split

    /// @notice Every unit of the levy is either taxed or booked — nothing evaporates, nothing is
    ///         minted twice, and since round 4 nothing leaves the hook at all.
    ///
    /// @dev REWRITTEN, not repaired. The original read:
    ///
    ///          assertLe(minted + donated, expectLevy)
    ///          assertGe(minted + donated + 2, expectLevy)   // "within the collect's own rounding"
    ///          assertEq(protDelta, minted, "the whole quote leg is the protocol's")
    ///
    ///      because `_settleLeg` spent 70 of the 100 bps back into the pool through
    ///      `poolManager.donate` and only minted the remainder, so the accounting had to be stated
    ///      across two places — the hook's claims and v4's fee growth — with a two-wei tolerance
    ///      for v4 truncating fee growth per position.
    ///
    ///      With the donate gone the statement gets STRICTER in three ways, which is why the
    ///      assertions are equalities now: the whole levy is minted (nothing is spent out), the
    ///      pool receives nothing (so a collect is exactly zero, not approximately), and the split
    ///      between the treasury and the sink is a division this test can predict to the unit.
    function test_oneSwapsLevyIsFullyAccountedFor() public {
        uint256 x = 100 ether;
        uint256 expectLevy = (x * (30 + 70)) / 10_000; // REWARDS quote leg, tax zero

        uint256 claims0 = IPoolManager(address(manager)).balanceOf(address(hook), Currency.wrap(address(quote)).toId());
        uint256 prot0 = hook.pendingProtocol(id);
        uint256 sink0 = hook.pendingSink(id);
        _swapIn(x);
        uint256 minted = IPoolManager(address(manager)).balanceOf(address(hook), Currency.wrap(address(quote)).toId()) - claims0;
        uint256 protDelta = hook.pendingProtocol(id) - prot0;
        uint256 sinkDelta = hook.pendingSink(id) - sink0;

        BalanceDelta d = lp.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -60000, tickUpper: 60000, liquidityDelta: 0, salt: 0}), ""
        );
        uint256 donated = d.amount0() > 0 ? uint256(uint128(d.amount0())) : 0;

        console2.log("levy expected :", expectLevy);
        console2.log("minted claims :", minted);
        console2.log("to the sink   :", sinkDelta);
        console2.log("to the treasury:", protDelta);
        console2.log("donated to LPs:", donated);

        assertEq(donated, 0, "the pool was paid: POOL_LP_FEE is non-zero or the donate is back");
        assertEq(minted, expectLevy, "the whole levy is minted as claims now, exactly");
        assertEq(sinkDelta, (expectLevy * 70) / 100, "the sink did not receive its 70 bps");
        assertEq(protDelta, expectLevy - sinkDelta, "the treasury did not receive the rest");
        assertEq(sinkDelta + protDelta, minted, "a minted claim belongs to no book");
    }

    /// @notice INVERTED BY ROUND 4. A REWARDS or CREATOR market's sink ledger is now fed by every
    ///         swap, directly, and the sweep materialises it.
    ///
    /// @dev This test used to assert the exact opposite — `pendingSink == 0` and `owedSink == 0`
    ///      across ten swaps — and the fact it recorded was load-bearing for a different finding:
    ///      M-01's fee-attribution problem turns on a quote-paying sink's income arriving only
    ///      through `creditCurveTax`, which is `SeedLocker.collect` materialising a v4
    ///      `feeGrowthInside` INTEGRAL that carries no per-block record. The premise of that
    ///      argument has changed: the swap levy now reaches the sink as a direct, per-swap ledger
    ///      write that the hook makes itself, so the information M-01 said was unavailable is in
    ///      fact available at accrual time. That does not fix M-01 — nothing here buckets by block
    ///      — but the reason it could not be fixed no longer applies, and it is recorded here
    ///      rather than left implied.
    ///
    ///      `SINK_LEVY_BPS` is still zero, and that is still not the same statement. The sink's
    ///      swap income is `LP_LEVY_BPS`; see its docblock for why the two constants stayed apart.
    function test_aQuotePayingSinkIsNowFedDirectlyBySwaps() public {
        assertEq(hook.SINK_LEVY_BPS(), 0, "SINK_LEVY_BPS moved: this test's premise is not what it says");
        for (uint256 i; i < 5; ++i) {
            _swapIn(1_000 ether);
            _swapOut(10 ether);
        }
        uint256 pending = hook.pendingSink(id);
        assertGt(pending, 0, "a REWARDS market accrued nothing from ten swaps");
        // Ten swaps on a 1,000/10 pattern, all levied on the quote leg at 100 bps with a zero
        // creator tax. The sink's share is 70 of every 100, so it must be the larger of the two
        // books by construction -- a sanity check on the direction of the split, not on its size.
        assertGt(pending, hook.pendingProtocol(id), "the sink's share is not the larger one");
        hook.sweep(id);
        assertEq(hook.pendingSink(id), 0, "the sweep left the sink's pending book behind");
        assertEq(hook.owedSink(id), pending, "the sweep did not materialise the sink's share");
    }

    /// @notice The maker levy is charged on ADD and on REMOVE, on both legs, at the RECORDED rates
    ///         — and never on the fees a position has accrued.
    function test_theMakerLevyIsChargedOnBothSidesAndNeverOnFees() public {
        uint256 p0 = hook.pendingProtocol(id);
        uint256 t0 = hook.pendingProtocolToken(id);
        lp.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 500 ether, salt: bytes32(uint256(7))}), ""
        );
        uint256 pAdd = hook.pendingProtocol(id) - p0;
        uint256 tAdd = hook.pendingProtocolToken(id) - t0;
        assertGt(pAdd, 0, "the quote leg of an add was not levied");
        assertGt(tAdd, 0, "the token leg of an add was not levied");

        // Generate fees for that position, then collect: a collect must be free. The swap is
        // deliberately small — a large one pushes the price out of [-6000, 6000], after which the
        // position is single-sided and the remove has no token leg to levy.
        _swapIn(20 ether);
        uint256 p1 = hook.pendingProtocol(id);
        uint256 t1 = hook.pendingProtocolToken(id);
        lp.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 0, salt: bytes32(uint256(7))}), ""
        );
        assertEq(hook.pendingProtocol(id), p1, "a fee collect was levied on the quote leg");
        assertEq(hook.pendingProtocolToken(id), t1, "a fee collect was levied on the token leg");

        lp.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: -500 ether, salt: bytes32(uint256(7))}), ""
        );
        assertGt(hook.pendingProtocol(id) - p1, 0, "the quote leg of a remove was not levied");
        assertGt(hook.pendingProtocolToken(id) - t1, 0, "the token leg of a remove was not levied");
    }

    /// @notice `pullTax` materialises and pays in one call and leaves the hook's resting balance
    ///         exactly where it found it.
    function test_pullTaxIsBalanceNeutralOnTheHook() public {
        // A taxed market, opened alongside.
        STok other = new STok("O");
        bool qFirst = address(quote) < address(other);
        PoolKey memory k2 = PoolKey({
            currency0: Currency.wrap(qFirst ? address(quote) : address(other)),
            currency1: Currency.wrap(qFirst ? address(other) : address(quote)),
            fee: 0,
            tickSpacing: SPACING,
            hooks: IHooks(address(hook))
        });
        vm.startPrank(graduator);
        manager.initialize(k2, SQRT_1_1);
        hook.registerPool(k2, address(other), REWARDS, sinkAddr, 1000);
        vm.stopPrank();
        other.approve(address(lp), type(uint256).max);
        other.approve(address(swapper), type(uint256).max);
        lp.modifyLiquidity(
            k2, ModifyLiquidityParams({tickLower: -60000, tickUpper: 60000, liquidityDelta: 2_000 ether, salt: 0}), ""
        );
        swapper.swap(
            k2,
            SwapParams({zeroForOne: qFirst, amountSpecified: -int256(1_000 ether), sqrtPriceLimitX96: qFirst ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        PoolId id2 = k2.toId();
        uint256 tax = hook.owedTax(id2);
        assertGt(tax, 0, "no tax accrued");

        uint256 hookBefore = quote.balanceOf(address(hook));
        uint256 sinkBefore = quote.balanceOf(creatorSinkAddr);
        vm.prank(creatorSinkAddr);
        hook.pullTax(id2);
        assertEq(quote.balanceOf(address(hook)), hookBefore, "pullTax moved the hook's resting balance");
        assertEq(quote.balanceOf(creatorSinkAddr) - sinkBefore, tax, "the creator sink was not paid the tax");
        assertEq(hook.owedTax(id2), 0);
    }

    function _swapIn(uint256 amount) internal {
        swapper.swap(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _swapOut(uint256 amount) internal {
        swapper.swap(
            key,
            SwapParams({
                zeroForOne: false,
                amountSpecified: int256(amount),
                sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }
}

/// @dev `SeedLocker`, constructed directly so this test contract is its `graduation`.
contract Round3SeedLockerTest is Test {
    SeedLocker locker;
    address constant PM = address(0xEEEE);
    address constant HOOK = address(0xFFFF);

    function setUp() public {
        locker = new SeedLocker(IPositionManager(address(0x1111)), HOOK, PM);
    }

    function _key() internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(0xAAAA)),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(0xFFFF))
        });
    }

    function test_lockIsGraduationOnlyAndWriteOnce() public {
        locker.lock(1, _key(), address(0x51), 1, true);

        vm.expectRevert(SeedLocker.AlreadyLocked.selector);
        locker.lock(1, _key(), address(0x52), 1, true);

        vm.prank(address(0xBAD));
        vm.expectRevert(SeedLocker.NotGraduation.selector);
        locker.lock(2, _key(), address(0x51), 1, true);

        vm.expectRevert(SeedLocker.UnknownPosition.selector);
        locker.lock(3, _key(), address(0), 1, true);

        (, address sink,,) = locker.positionOf(1);
        assertEq(sink, address(0x51), "the first lock did not stick");
    }

    function test_collectRefusesAnUnknownPosition() public {
        vm.expectRevert(SeedLocker.UnknownPosition.selector);
        locker.collect(99);
    }

    function test_receiveIsGatedToThePoolManager() public {
        vm.deal(address(this), 10 ether);
        (bool ok,) = address(locker).call{value: 1 ether}("");
        assertFalse(ok, "a stranger funded the locker");

        vm.deal(PM, 10 ether);
        vm.prank(PM);
        (ok,) = address(locker).call{value: 1 ether}("");
        assertTrue(ok, "the PoolManager could not pay the locker");
        assertEq(address(locker).balance, 1 ether);
    }

    /// @notice The ERC-1271 refusal that closes `permit` and `permitForAll` against this owner.
    function test_thereIsNoIsValidSignature() public {
        (bool ok,) = address(locker).staticcall(
            abi.encodeWithSelector(bytes4(0x1626ba7e), bytes32(uint256(1)), bytes(hex"00"))
        );
        assertFalse(ok, "the locker answered isValidSignature");
    }
}
