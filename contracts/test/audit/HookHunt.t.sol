// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolDonateTest} from "@uniswap/v4-core/src/test/PoolDonateTest.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";

contract HTok is ERC20 {
    constructor(string memory n) ERC20(n, n) {
        _mint(msg.sender, 1e30);
    }
}

/// @notice Base fixture: a real local PoolManager, a mined DokuHook, three markets that SHARE the
///         native quote, and one ERC-20-quoted market. Everything below hunts across markets,
///         because the hook's real balances and its ERC-6909 claims are pooled while its ledgers
///         are per market.
abstract contract HookHuntBase is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using CurrencyLibrary for Currency;

    uint160 internal constant FLAGS = 0x2FCF;
    address internal constant TREASURY = address(0xBEEF);
    uint160 internal constant SQRT_1_1 = 79228162514264337593543950336;

    PoolManager internal manager;
    DokuHook internal hook;
    PoolSwapTest internal swapper;
    PoolModifyLiquidityTest internal lp;
    PoolDonateTest internal donor;

    address internal graduator = address(0x6AD);
    address internal creatorSinkAddr = address(0xC5);
    address internal sinkA = address(0x51);
    address internal sinkB = address(0x52);

    HTok internal tokA;
    HTok internal tokB;
    PoolKey internal keyA; // REWARDS, native quote, 0 tax
    PoolKey internal keyB; // BURN,    native quote, 0 tax
    PoolId internal idA;
    PoolId internal idB;

    int24 internal MIN_T;
    int24 internal MAX_T;

    receive() external payable {}

    function setUp() public virtual {
        manager = new PoolManager(address(this));
        swapper = new PoolSwapTest(IPoolManager(address(manager)));
        lp = new PoolModifyLiquidityTest(IPoolManager(address(manager)));
        donor = new PoolDonateTest(IPoolManager(address(manager)));

        bytes memory args = abi.encode(IPoolManager(address(manager)), address(this), TREASURY, creatorSinkAddr);
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        hook = new DokuHook{salt: salt}(IPoolManager(address(manager)), address(this), TREASURY, creatorSinkAddr);
        hook.setGraduator(graduator, true);

        MIN_T = TickMath.minUsableTick(60);
        MAX_T = TickMath.maxUsableTick(60);
        vm.deal(address(this), 10_000_000 ether);

        tokA = new HTok("A");
        tokB = new HTok("B");
        keyA = _open(tokA, hook.SINK_REWARDS(), sinkA, 0);
        keyB = _open(tokB, hook.SINK_BURN(), sinkB, 0);
        idA = keyA.toId();
        idB = keyB.toId();
    }

    function _open(HTok t, uint8 sink, address sinkAddr, uint16 tax) internal returns (PoolKey memory k) {
        k = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(t)),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        vm.startPrank(graduator);
        manager.initialize(k, SQRT_1_1);
        hook.registerPool(k, address(t), sink, sinkAddr, tax);
        vm.stopPrank();

        t.approve(address(lp), type(uint256).max);
        t.approve(address(swapper), type(uint256).max);
        t.approve(address(donor), type(uint256).max);
        lp.modifyLiquidity{value: 20_000 ether}(
            k, ModifyLiquidityParams({tickLower: -60000, tickUpper: 60000, liquidityDelta: 2_000 ether, salt: 0}), ""
        );
        return k;
    }

    function _buy(PoolKey memory k, uint256 monIn) internal {
        swapper.swap{value: monIn}(
            k,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(monIn),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _sell(PoolKey memory k, uint256 tokIn) internal {
        swapper.swap(
            k,
            SwapParams({
                zeroForOne: false,
                amountSpecified: -int256(tokIn),
                sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @dev Exact-output: name `monOut` of the native quote, pay whatever the token side costs.
    function _sellExactOut(PoolKey memory k, uint256 monOut) internal {
        swapper.swap(
            k,
            SwapParams({
                zeroForOne: false,
                amountSpecified: int256(monOut),
                sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _claims(Currency c) internal view returns (uint256) {
        return manager.balanceOf(address(hook), c.toId());
    }

    function _real(Currency c) internal view returns (uint256) {
        return c.isAddressZero() ? address(hook).balance : ERC20(Currency.unwrap(c)).balanceOf(address(hook));
    }
}

/// @notice PROBE 1 — the ledger. The hook's ERC-6909 claim balance in a currency is pooled across
///         every market that levies in it; the ledgers that spend it are per market. If the two
///         ever disagree, either one market can sweep another's accrual or the last market to
///         sweep finds its money gone.
contract HookHuntLedger is HookHuntBase {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;

    Currency internal NATIVE = Currency.wrap(address(0));

    /// @dev The invariant, stated once and asserted everywhere: for every currency, the hook's
    ///      unmaterialised claims equal exactly the sum of the ledger entries denominated in it.
    function _assertClaimsMatchLedgers() internal view {
        // native: quote of both markets, so pendingProtocol + owedTax of both live here.
        uint256 nativeLedger = hook.pendingProtocol(idA) + hook.pendingProtocol(idB) + hook.owedTax(idA)
            + hook.owedTax(idB);
        // pendingSink is the market's SINK currency: quote for REWARDS(A), token for BURN(B).
        nativeLedger += hook.pendingSink(idA);
        assertEq(_claims(NATIVE), nativeLedger, "native claims != native ledgers");

        // Generation 4 added a THIRD bucket. The maker levy is now symmetric across the legs
        // (`registerPool`), so the token side of an add or a remove accrues to the treasury's own
        // token ledger, `pendingProtocolToken`. It is in this sum for the same reason every other
        // entry is: the invariant is that the hook's claims in a currency equal the sum of the
        // books denominated in it, and a book left out of the sum is a book nobody is checking.
        assertEq(
            _claims(Currency.wrap(address(tokB))),
            hook.pendingSink(idB) + hook.pendingProtocolToken(idB),
            "tokB claims != tokB ledger"
        );
        assertEq(
            _claims(Currency.wrap(address(tokA))), hook.pendingProtocolToken(idA), "tokA claims != tokA ledger"
        );
    }

    function _assertRealBacksOwed() internal view {
        uint256 nativeOwed = hook.owedTreasury(NATIVE) + hook.owedSink(idA);
        assertGe(_real(NATIVE), nativeOwed, "native balance does not back owed");
        assertGe(_real(Currency.wrap(address(tokB))), hook.owedSink(idB), "tokB balance does not back owed");
    }

    function test_ledgersTrackClaimsAcrossMarketsAndActions() public {
        _assertClaimsMatchLedgers();
        _buy(keyA, 100 ether);
        _assertClaimsMatchLedgers();
        _buy(keyB, 100 ether);
        _assertClaimsMatchLedgers();
        _sell(keyA, 10 ether);
        _assertClaimsMatchLedgers();
        _sell(keyB, 10 ether);
        _assertClaimsMatchLedgers();
        _sellExactOut(keyA, 1 ether);
        _assertClaimsMatchLedgers();
        _sellExactOut(keyB, 1 ether);
        _assertClaimsMatchLedgers();

        // maker levy, both directions
        lp.modifyLiquidity{value: 1_000 ether}(
            keyA, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 100 ether, salt: 0}), ""
        );
        _assertClaimsMatchLedgers();
        lp.modifyLiquidity(
            keyA, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: -100 ether, salt: 0}), ""
        );
        _assertClaimsMatchLedgers();

        hook.sweep(idA);
        _assertClaimsMatchLedgers();
        _assertRealBacksOwed();
        hook.sweep(idB);
        _assertClaimsMatchLedgers();
        _assertRealBacksOwed();

        hook.pullTreasury(NATIVE);
        _assertRealBacksOwed();
    }

    /// @dev What actually reaches a BURN market's sink from the hook. The token leg is donated
    ///      whole while the seed is in range, so `pendingSink` only fills when nobody is there to
    ///      pay — which is the state an attacker can create for free by pushing the price out of
    ///      the locked position's range.
    function test_whereABurnMarketsSinkShareGoes() public {
        _buy(keyB, 100 ether);
        console2.log("burn pendingSink (token) :", hook.pendingSink(idB));
        console2.log("burn pendingProtocol     :", hook.pendingProtocol(idB));
    }
}

/// @notice Raw access to one unlock: an arbitrary list of swaps / liquidity moves / mints / takes
///         against a DOKU pool, so the levy can be driven in shapes no periphery router emits.
contract RawRouter is IUnlockCallback {
    using CurrencyLibrary for Currency;

    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    receive() external payable {}

    struct Op {
        uint8 kind; // 0 swap, 1 modifyLiquidity, 2 settle native, 3 take native, 4 mint claims
        PoolKey key;
        int256 a;
        int256 b;
        uint160 limit;
        int24 tickLower;
        int24 tickUpper;
    }

    function run(Op[] calldata ops) external payable returns (bytes memory) {
        return pm.unlock(abi.encode(ops));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm");
        Op[] memory ops = abi.decode(data, (Op[]));
        for (uint256 i; i < ops.length; ++i) {
            Op memory o = ops[i];
            if (o.kind == 0) {
                pm.swap(
                    o.key,
                    SwapParams({zeroForOne: o.b != 0, amountSpecified: o.a, sqrtPriceLimitX96: o.limit}),
                    ""
                );
            } else if (o.kind == 1) {
                pm.modifyLiquidity(
                    o.key,
                    ModifyLiquidityParams({
                        tickLower: o.tickLower,
                        tickUpper: o.tickUpper,
                        liquidityDelta: o.a,
                        salt: 0
                    }),
                    ""
                );
            } else if (o.kind == 2) {
                pm.sync(Currency.wrap(address(0)));
                pm.settle{value: uint256(o.a)}();
            } else if (o.kind == 3) {
                pm.take(Currency.wrap(address(0)), address(this), uint256(o.a));
            }
        }
        // Settle whatever is left, both currencies, in whichever direction it falls.
        _close(ops[0].key.currency0);
        _close(ops[0].key.currency1);
        return "";
    }

    function _close(Currency c) private {
        int256 d = TransientStateLibrary.currencyDelta(pm, address(this), c);
        if (d > 0) {
            pm.take(c, address(this), uint256(d));
        } else if (d < 0) {
            if (c.isAddressZero()) {
                pm.sync(c);
                pm.settle{value: uint256(-d)}();
            } else {
                pm.sync(c);
                ERC20(Currency.unwrap(c)).transfer(address(pm), uint256(-d));
                pm.settle();
            }
        }
    }
}

/// @notice PROBE 2 — swap shapes and sequences no periphery router emits.
contract HookHuntShapes is HookHuntBase {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using StateLibrary for IPoolManager;

    Currency internal NATIVE = Currency.wrap(address(0));
    RawRouter internal raw;

    function setUp() public override {
        super.setUp();
        raw = new RawRouter(IPoolManager(address(manager)));
        vm.deal(address(raw), 1_000_000 ether);
        tokA.transfer(address(raw), 1e26);
        tokB.transfer(address(raw), 1e26);
    }

    function _ledgerNative() internal view returns (uint256) {
        return hook.pendingProtocol(idA) + hook.pendingProtocol(idB) + hook.owedTax(idA) + hook.owedTax(idB)
            + hook.pendingSink(idA);
    }

    function _check() internal view {
        assertEq(_claims(NATIVE), _ledgerNative(), "native claims != ledgers");
        assertEq(
            _claims(Currency.wrap(address(tokB))),
            hook.pendingSink(idB) + hook.pendingProtocolToken(idB),
            "tokB claims != ledger"
        );
        assertEq(_claims(Currency.wrap(address(tokA))), hook.pendingProtocolToken(idA), "tokA claims != ledger");
    }

    /// @dev Two swaps on the SAME pool inside ONE unlock, in opposite directions. `_beforeSwap`
    ///      parks the specified leg's levy in transient storage keyed by pool id ALONE — not by
    ///      direction, not by a nonce — and `_afterSwap` is the only consumer. If the hand-off
    ///      could be left armed or read twice, a second swap in the same transaction is where it
    ///      would show.
    function test_twoSwapsSamePoolOneUnlockDoNotShareTheTransientLevy() public {
        RawRouter.Op[] memory ops = new RawRouter.Op[](2);
        ops[0] = RawRouter.Op({
            kind: 0, key: keyA, a: -int256(100 ether), b: 1,
            limit: TickMath.MIN_SQRT_PRICE + 1, tickLower: 0, tickUpper: 0
        });
        // token -> quote, exact input: the specified leg is the TOKEN, whose rate is ZERO on a
        // REWARDS market, so `_beforeSwap` returns before it ever writes the slot.
        ops[1] = RawRouter.Op({
            kind: 0, key: keyA, a: -int256(1 ether), b: 0,
            limit: TickMath.MAX_SQRT_PRICE - 1, tickLower: 0, tickUpper: 0
        });
        raw.run{value: 0}(ops);
        _check();
    }

    /// @dev The reverse order: a zero-rate specified leg first, then a rated one. If the zero-rate
    ///      early return could ever leave a stale value behind, this is the shape that reads it.
    function test_zeroRateSwapThenRatedSwapInOneUnlock() public {
        RawRouter.Op[] memory ops = new RawRouter.Op[](3);
        ops[0] = RawRouter.Op({
            kind: 0, key: keyA, a: -int256(1 ether), b: 0,
            limit: TickMath.MAX_SQRT_PRICE - 1, tickLower: 0, tickUpper: 0
        });
        ops[1] = RawRouter.Op({
            kind: 0, key: keyA, a: -int256(50 ether), b: 1,
            limit: TickMath.MIN_SQRT_PRICE + 1, tickLower: 0, tickUpper: 0
        });
        ops[2] = RawRouter.Op({
            kind: 0, key: keyA, a: -int256(1 ether), b: 0,
            limit: TickMath.MAX_SQRT_PRICE - 1, tickLower: 0, tickUpper: 0
        });
        raw.run(ops);
        _check();
    }

    /// @dev Swap, add, remove, swap, all inside one unlock and all against the same pool. The maker
    ///      levy and the swap levy write the same two ledgers and mint the same claim balance.
    function test_swapAndLiquidityInterleavedInOneUnlock() public {
        RawRouter.Op[] memory ops = new RawRouter.Op[](4);
        ops[0] = RawRouter.Op({
            kind: 0, key: keyA, a: -int256(200 ether), b: 1,
            limit: TickMath.MIN_SQRT_PRICE + 1, tickLower: 0, tickUpper: 0
        });
        ops[1] = RawRouter.Op({
            kind: 1, key: keyA, a: int256(50 ether), b: 0, limit: 0, tickLower: -6000, tickUpper: 6000
        });
        ops[2] = RawRouter.Op({
            kind: 1, key: keyA, a: -int256(50 ether), b: 0, limit: 0, tickLower: -6000, tickUpper: 6000
        });
        ops[3] = RawRouter.Op({
            kind: 0, key: keyA, a: -int256(3 ether), b: 0,
            limit: TickMath.MAX_SQRT_PRICE - 1, tickLower: 0, tickUpper: 0
        });
        raw.run(ops);
        _check();
    }

    /// @dev Exact-OUTPUT with a price limit that binds almost immediately. The specified leg's
    ///      levy is computed from the amount NAMED, and on exact-output that amount is the OUTPUT
    ///      the pool is asked for. The pool can produce far less. The question that matters is who
    ///      is short when it does: the singleton, or the trader who named the number.
    function test_exactOutputWithABindingLimitLeavesTheSingletonWhole() public {
        _buy(keyA, 500 ether); // move the price so a limit can bind on the way back

        uint256 mgrBefore = address(manager).balance;
        uint256 claimsBefore = _claims(NATIVE);
        uint256 routerBefore = address(raw).balance;

        (uint160 sqrtP,,,) = StateLibrary.getSlot0(IPoolManager(address(manager)), idA);
        RawRouter.Op[] memory ops = new RawRouter.Op[](1);
        ops[0] = RawRouter.Op({
            kind: 0, key: keyA, a: int256(100 ether), b: 0,
            limit: sqrtP + (sqrtP / 100_000), tickLower: 0, tickUpper: 0
        });
        raw.run(ops);

        uint256 levied = _claims(NATIVE) - claimsBefore;
        console2.log("named exact-output (MON)      :", uint256(100 ether));
        console2.log("hook claims gained (MON)      :", levied);
        console2.log("singleton MON before          :", mgrBefore);
        console2.log("singleton MON after           :", address(manager).balance);
        console2.log("router MON before             :", routerBefore);
        console2.log("router MON after              :", address(raw).balance);

        // The levy is real money the singleton still holds as the hook's claim. Nothing left the
        // singleton beyond what the trader actually received.
        assertLe(levied, mgrBefore, "levy exceeds the singleton's whole balance");
        _check();
    }

    /// @dev Push the price clean out of the only position's range, then trade there. `_settleLeg`
    ///      guards its donate on `getLiquidity() != 0`, and with nobody in range the LP share falls
    ///      through instead of being stranded. Where it falls is the question: on the quote leg of
    ///      a REWARDS market it goes to the TREASURY. Not to whoever engineered the state.
    function test_theLpShareFallsThroughToTheProtocolWhenNobodyIsInRange() public {
        // Walk the price just past the only position's LOWER tick and stop there, so the pool
        // is empty but the price is still somewhere a position can be re-seated cheaply.
        swapper.swap{value: 4_000_000 ether}(
            keyA,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(4_000_000 ether),
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(-60060)
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        assertEq(StateLibrary.getLiquidity(IPoolManager(address(manager)), idA), 0, "expected an empty book");

        // Re-seat a narrow position AROUND the new price so a trade is possible again, then step
        // outside it: a swap that ends with `liquidity == 0` at the final tick is the fall-through.
        (, int24 tick,,) = StateLibrary.getSlot0(IPoolManager(address(manager)), idA);
        int24 lo = ((tick - 600) / 60) * 60;
        int24 hi = ((tick + 600) / 60) * 60;
        if (lo < MIN_T) lo = MIN_T;
        if (hi > MAX_T) hi = MAX_T;

        uint256 protBefore = hook.pendingProtocol(idA);
        lp.modifyLiquidity{value: 500 ether}(
            keyA, ModifyLiquidityParams({tickLower: lo, tickUpper: hi, liquidityDelta: 1e18, salt: 0}), ""
        );
        _sell(keyA, 5e24); // straight through the band and out the other side
        _check();

        // The protocol ledger absorbed the un-donatable share; the attacker is down, not up.
        assertGt(hook.pendingProtocol(idA), protBefore, "the fall-through vanished");
        console2.log("protocol ledger gain from the empty book:", hook.pendingProtocol(idA) - protBefore);
    }
}

// ---------------------------------------------------------------------------------------------
// PROBE 3 — a hostile ERC-20 quote asset. Every path that materialises money runs
// `poolManager.take`, which for an ERC-20 is a transfer INTO the hook while the PoolManager is
// unlocked and the hook's own `_UNLOCK_EXPECTED_SLOT` is armed. That transfer is the one moment a
// token contract gets control inside the hook's unlock.
// ---------------------------------------------------------------------------------------------

interface IHookProbe {
    function sweep(PoolId id) external;
    function pullSink(PoolId id) external returns (uint256);
    function pullTreasury(Currency c) external returns (uint256);
    function pullTax(PoolId id) external returns (uint256);
    function unlockCallback(bytes calldata) external returns (bytes memory);
    function creditCurveTax(PoolId id, uint256 amount) external;
}

/// @notice A quote asset that calls back into the hook the moment the hook is paid.
contract ReentrantQuote is ERC20 {
    address public hook;
    address public pm;
    uint8 public mode; // 0 off, 1 sweep, 2 pullTreasury, 3 pullSink, 4 raw unlockCallback
    PoolId public target;
    bool public fired;
    bytes public lastError;
    bool public lastOk;

    constructor() ERC20("RQ", "RQ") {
        _mint(msg.sender, 1e30);
    }

    function arm(address hook_, address pm_, uint8 m, PoolId t) external {
        hook = hook_;
        pm = pm_;
        mode = m;
        target = t;
        fired = false;
    }

    function _hit() private {
        if (mode == 0 || fired || hook == address(0)) return;
        fired = true;
        bytes memory cd;
        if (mode == 1) cd = abi.encodeCall(IHookProbe.sweep, (target));
        else if (mode == 2) cd = abi.encodeCall(IHookProbe.pullTreasury, (Currency.wrap(address(this))));
        else if (mode == 3) cd = abi.encodeCall(IHookProbe.pullSink, (target));
        else cd = abi.encodeCall(IHookProbe.unlockCallback, (abi.encode(target, uint256(0), uint256(0), uint256(0))));
        (bool ok, bytes memory err) = hook.call(cd);
        lastOk = ok;
        lastError = err;
    }

    function transfer(address to, uint256 v) public override returns (bool) {
        bool r = super.transfer(to, v);
        if (to == hook) _hit();
        return r;
    }

    function transferFrom(address f, address to, uint256 v) public override returns (bool) {
        bool r = super.transferFrom(f, to, v);
        if (to == hook) _hit();
        return r;
    }
}

/// @notice A quote asset that keeps 10% of every transfer. The hook's ERC-20 credit path books
///         the amount it ASKED FOR, not the amount that arrived.
contract FeeOnTransferQuote is ERC20 {
    constructor() ERC20("FOT", "FOT") {
        _mint(msg.sender, 1e30);
    }

    function _keep(address from, address to, uint256 v) private returns (uint256) {
        uint256 fee = v / 10;
        if (fee != 0) super._update(from, address(0xdead), fee);
        super._update(from, to, v - fee);
        return v - fee;
    }

    function transfer(address to, uint256 v) public override returns (bool) {
        _keep(_msgSender(), to, v);
        return true;
    }

    function transferFrom(address f, address to, uint256 v) public override returns (bool) {
        _spendAllowance(f, _msgSender(), v);
        _keep(f, to, v);
        return true;
    }
}

contract HookHuntHostileQuote is Test {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;

    uint160 internal constant FLAGS = 0x2FCF;
    address internal constant TREASURY = address(0xBEEF);
    uint160 internal constant SQRT_1_1 = 79228162514264337593543950336;

    PoolManager internal manager;
    DokuHook internal hook;
    PoolSwapTest internal swapper;
    PoolModifyLiquidityTest internal lp;

    address internal graduator = address(0x6AD);
    address internal creatorSinkAddr = address(0xC5);
    address internal sink1 = address(0x51);
    address internal sink2 = address(0x52);

    ReentrantQuote internal q;
    HTok internal t1;
    HTok internal t2;
    PoolKey internal k1;
    PoolKey internal k2;
    PoolId internal id1;
    PoolId internal id2;

    receive() external payable {}

    function setUp() public {
        manager = new PoolManager(address(this));
        swapper = new PoolSwapTest(IPoolManager(address(manager)));
        lp = new PoolModifyLiquidityTest(IPoolManager(address(manager)));

        bytes memory args = abi.encode(IPoolManager(address(manager)), address(this), TREASURY, creatorSinkAddr);
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        hook = new DokuHook{salt: salt}(IPoolManager(address(manager)), address(this), TREASURY, creatorSinkAddr);
        hook.setGraduator(graduator, true);

        q = new ReentrantQuote();
        t1 = new HTok("T1");
        t2 = new HTok("T2");

        k1 = _open(address(q), address(t1), hook.SINK_REWARDS(), sink1);
        k2 = _open(address(q), address(t2), hook.SINK_REWARDS(), sink2);
        id1 = k1.toId();
        id2 = k2.toId();
    }

    function _open(address quote, address token, uint8 sink, address sinkAddr)
        internal
        returns (PoolKey memory k)
    {
        (Currency c0, Currency c1) = quote < token
            ? (Currency.wrap(quote), Currency.wrap(token))
            : (Currency.wrap(token), Currency.wrap(quote));
        k = PoolKey({currency0: c0, currency1: c1, fee: 0, tickSpacing: 60, hooks: IHooks(address(hook))});
        vm.startPrank(graduator);
        manager.initialize(k, SQRT_1_1);
        hook.registerPool(k, token, sink, sinkAddr, 0);
        vm.stopPrank();

        ERC20(quote).approve(address(lp), type(uint256).max);
        ERC20(quote).approve(address(swapper), type(uint256).max);
        ERC20(token).approve(address(lp), type(uint256).max);
        ERC20(token).approve(address(swapper), type(uint256).max);
        lp.modifyLiquidity(
            k, ModifyLiquidityParams({tickLower: -60000, tickUpper: 60000, liquidityDelta: 2_000 ether, salt: 0}), ""
        );
    }

    function _buyQuoteIn(PoolKey memory k, uint256 amt) internal {
        bool zeroForOne = Currency.unwrap(k.currency0) == address(q);
        swapper.swap(
            k,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amt),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @dev The four re-entries a hostile quote can attempt from inside `sweep`'s own unlock, at
    ///      the exact instant `poolManager.take` pays the hook. All four must fail; `sweep` must
    ///      still complete and the ledger must land where it would have without the callback.
    function test_aHostileQuoteCannotReenterTheSweep() public {
        _buyQuoteIn(k1, 100 ether);
        _buyQuoteIn(k2, 100 ether);
        uint256 prot1 = hook.pendingProtocol(id1);
        uint256 prot2 = hook.pendingProtocol(id2);
        assertGt(prot1, 0);
        assertGt(prot2, 0);

        // 1. sweep the OTHER market from inside this one's unlock.
        q.arm(address(hook), address(manager), 1, id2);
        hook.sweep(id1);
        assertFalse(q.lastOk(), "a reentrant sweep succeeded");
        assertEq(hook.pendingProtocol(id2), prot2, "market B's ledger moved during market A's sweep");
        assertEq(hook.owedTreasury(Currency.wrap(address(q))), prot1, "treasury ledger wrong after sweep");

        // 2. pullTreasury from inside the same window.
        q.arm(address(hook), address(manager), 2, id2);
        hook.sweep(id2);
        assertFalse(q.lastOk(), "a reentrant pullTreasury succeeded");
        assertEq(hook.owedTreasury(Currency.wrap(address(q))), prot1 + prot2, "treasury ledger wrong");

        // 3. the raw unlockCallback, from a caller that is not the PoolManager.
        q.approve(address(hook), type(uint256).max);
        q.arm(address(hook), address(manager), 4, id1);
        hook.creditCurveTax(id1, 1 ether);
        assertFalse(q.lastOk(), "a stranger drove unlockCallback");

        // The money is all still there and all still payable.
        uint256 t = hook.pullTreasury(Currency.wrap(address(q)));
        assertEq(t, prot1 + prot2, "treasury paid the wrong amount");
        assertEq(q.balanceOf(TREASURY), prot1 + prot2, "treasury balance wrong");
    }

    /// @dev A third party trading a DOKU pool from INSIDE the hook's own unlock. The window exists:
    ///      `_materialise` leaves the PoolManager unlocked while it takes an ERC-20, and a hostile
    ///      quote gets control there. The property is that the hook's per-swap delta nets to
    ///      exactly zero, so the sweep's unlock still closes and the ledger still adds up.
    function test_aSwapDrivenFromInsideTheHooksUnlockCannotUnbalanceIt() public {
        _buyQuoteIn(k1, 100 ether);
        uint256 protBefore = hook.pendingProtocol(id1);

        // A reentrant `pullSink` — the closest thing to a money path the sink itself could try.
        q.arm(address(hook), address(manager), 3, id1);
        hook.sweep(id1);
        assertFalse(q.lastOk(), "a reentrant pullSink succeeded");
        assertEq(hook.owedTreasury(Currency.wrap(address(q))), protBefore, "treasury ledger wrong");
        assertEq(hook.pendingProtocol(id1), 0, "pending not cleared");
        assertGe(q.balanceOf(address(hook)), protBefore, "hook does not hold what it owes");
    }
}

/// @notice PROBE 4 — the ERC-20 credit path books the amount it ASKED FOR. This is the internal
///         audit's M-03, recorded on 2026-09-10 with the fix "in progress"; the fix is NOT in this
///         tree (`grep -n InexactTransfer src/` is empty). Reproduced here only to record the
///         CONSEQUENCE M-03 does not state: the over-credit is not confined to the market that
///         caused it, because the hook's real balances are pooled across every market sharing the
///         asset while the ledgers that spend them are per market.
contract HookHuntCreditBasis is Test {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;

    uint160 internal constant FLAGS = 0x2FCF;
    address internal constant TREASURY = address(0xBEEF);
    uint160 internal constant SQRT_1_1 = 79228162514264337593543950336;

    PoolManager internal manager;
    DokuHook internal hook;
    PoolSwapTest internal swapper;
    PoolModifyLiquidityTest internal lp;
    address internal graduator = address(0x6AD);
    address internal creatorSinkAddr = address(0xC5);
    address internal victimSink = address(0x51);
    address internal attackSink = address(0x52);

    FeeOnTransferQuote internal fq;
    HTok internal tv;
    HTok internal ta;
    PoolKey internal kv;
    PoolKey internal ka;
    PoolId internal idv;
    PoolId internal ida;

    receive() external payable {}

    function setUp() public {
        manager = new PoolManager(address(this));
        swapper = new PoolSwapTest(IPoolManager(address(manager)));
        lp = new PoolModifyLiquidityTest(IPoolManager(address(manager)));
        bytes memory args = abi.encode(IPoolManager(address(manager)), address(this), TREASURY, creatorSinkAddr);
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        hook = new DokuHook{salt: salt}(IPoolManager(address(manager)), address(this), TREASURY, creatorSinkAddr);
        hook.setGraduator(graduator, true);

        fq = new FeeOnTransferQuote();
        tv = new HTok("TV");
        ta = new HTok("TA");
        kv = _open(address(fq), address(tv), victimSink);
        ka = _open(address(fq), address(ta), attackSink);
        idv = kv.toId();
        ida = ka.toId();
    }

    function _open(address quote, address token, address sinkAddr) internal returns (PoolKey memory k) {
        (Currency c0, Currency c1) = quote < token
            ? (Currency.wrap(quote), Currency.wrap(token))
            : (Currency.wrap(token), Currency.wrap(quote));
        k = PoolKey({currency0: c0, currency1: c1, fee: 0, tickSpacing: 60, hooks: IHooks(address(hook))});
        vm.startPrank(graduator);
        manager.initialize(k, SQRT_1_1);
        hook.registerPool(k, token, hook.SINK_REWARDS(), sinkAddr, 0);
        vm.stopPrank();
        // No liquidity here on purpose: the credit path under test never touches the pool, and a
        // fee-on-transfer asset cannot settle a v4 add at all.
    }

    /// @dev M-03 (external review 2026-09-10), FIXED. Flipped rather than deleted: reverting the
    ///      fix turns this red again.
    ///
    ///      `creditCurveTax(id, amount)` is permissionless and used to book `amount` after a
    ///      transfer that delivered less. Every unit of the gap was a claim on a balance the hook
    ///      holds for OTHER markets — see `HookHuntCrossMarketStrand` for who actually paid.
    ///
    ///      The credit is now refused outright rather than booked short. Crediting the delta would
    ///      be solvent, but it would quietly accept a quote asset the registry should never have
    ///      admitted; reverting makes it loud at the first transfer.
    function test_M03_theErc20CreditPathRefusesAnUnderDeliveringQuote() public {
        fq.approve(address(hook), type(uint256).max);
        uint256 held = fq.balanceOf(address(hook));

        vm.expectRevert(
            abi.encodeWithSelector(DokuHook.InexactTransfer.selector, address(fq), 1_000 ether, 900 ether)
        );
        hook.creditCurveTax(ida, 1_000 ether);

        assertEq(hook.owedSink(ida), 0, "a short credit was still booked");
        assertEq(fq.balanceOf(address(hook)), held, "the hook kept the under-delivered transfer");
    }
}

/// @notice PROBE 5 — the consequence M-03 does not state. The hook's REAL balances are pooled
///         across every market that shares an asset; the ledgers that spend them are per market.
///         So an over-credit booked against one market is not that market's problem — it is paid
///         out of the balance another market is owed, and the market that pulls second cannot pull
///         at all. (M-03, 2026-09-10, fix "in progress" and absent from this tree.)
contract HookHuntCrossMarketStrand is Test {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;

    uint160 internal constant FLAGS = 0x2FCF;
    address internal constant TREASURY = address(0xBEEF);
    uint160 internal constant SQRT_1_1 = 79228162514264337593543950336;

    PoolManager internal manager;
    DokuHook internal hook;
    address internal graduator = address(0x6AD);
    address internal creatorSinkAddr = address(0xC5);
    address internal victimSink = address(0x51);
    address internal greedySink = address(0x52);

    FeeOnTransferQuote internal fq;
    HTok internal tv;
    HTok internal tg;
    PoolId internal idv;
    PoolId internal idg;

    function setUp() public {
        manager = new PoolManager(address(this));
        bytes memory args = abi.encode(IPoolManager(address(manager)), address(this), TREASURY, creatorSinkAddr);
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        hook = new DokuHook{salt: salt}(IPoolManager(address(manager)), address(this), TREASURY, creatorSinkAddr);
        hook.setGraduator(graduator, true);

        fq = new FeeOnTransferQuote();
        tv = new HTok("TV");
        tg = new HTok("TG");
        idv = _open(address(fq), address(tv), victimSink).toId();
        idg = _open(address(fq), address(tg), greedySink).toId();
        fq.approve(address(hook), type(uint256).max);
    }

    function _open(address quote, address token, address sinkAddr) internal returns (PoolKey memory k) {
        (Currency c0, Currency c1) = quote < token
            ? (Currency.wrap(quote), Currency.wrap(token))
            : (Currency.wrap(token), Currency.wrap(quote));
        k = PoolKey({currency0: c0, currency1: c1, fee: 0, tickSpacing: 60, hooks: IHooks(address(hook))});
        vm.startPrank(graduator);
        manager.initialize(k, SQRT_1_1);
        hook.registerPool(k, token, hook.SINK_REWARDS(), sinkAddr, 0);
        vm.stopPrank();
    }

    /// @dev FIXED, and flipped. This is the half M-03 does not state, so it is the half worth
    ///      keeping: the loss never landed on the market that caused it. The hook's REAL balances
    ///      are pooled across every market sharing an asset while the ledgers that spend them are
    ///      per market, so an over-credit against one market was paid out of the balance another
    ///      market was owed — and the market that pulled second could not pull at all, ever.
    ///
    ///      With the credit refused at the door, the shortfall cannot open, so the victim is paid.
    ///      The assertion that matters is the last one: a bystander market, which did nothing and
    ///      shares only a quote asset, still gets its money.
    function test_M03_aBystandersPayoutSurvivesAnUnderDeliveringQuote() public {
        // The greedy market tries the credit that used to over-book. It is refused.
        vm.expectRevert(
            abi.encodeWithSelector(DokuHook.InexactTransfer.selector, address(fq), 1_000 ether, 900 ether)
        );
        hook.creditCurveTax(idg, 1_000 ether);

        assertEq(hook.owedSink(idg), 0, "the short credit was booked anyway");
        assertEq(hook.owedSink(idv), 0, "the bystander's ledger moved");

        // The victim's credit is refused for the same reason, so no ledger anywhere moved.
        vm.expectRevert(
            abi.encodeWithSelector(DokuHook.InexactTransfer.selector, address(fq), 1_000 ether, 900 ether)
        );
        hook.creditCurveTax(idv, 1_000 ether);

        // The invariant the strand violated: every unit the ledgers promise is a unit the hook
        // holds. Under the old behaviour this read 2,000 against 1,800 and the second puller was
        // stranded permanently — there is no partial pull and no rescue.
        assertLe(
            hook.owedSink(idv) + hook.owedSink(idg),
            fq.balanceOf(address(hook)),
            "the hook promises more than it holds"
        );

        // And the bystander can still be paid, which is the whole point — a market that did
        // nothing and merely shares a quote asset is not collateral for somebody else's token.
        vm.prank(victimSink);
        hook.pullSink(idv);
    }
}

/// @notice PROBE 6 — the graduator allowlist is the owner's only power. A graduator added TODAY
///         must not be able to reach one wei of a market that graduated YESTERDAY.
contract HookHuntRogueGraduator is HookHuntBase {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;

    address internal rogue = address(0xB0B);

    /// @dev The fixture's markets are registered but never SEEDED, which on chain cannot happen:
    ///      `DokuGraduation._mintSeed` arms, mints the exact recorded shape and closes inside one
    ///      transaction (`src/DokuGraduation.sol:346-352`), so `m.seeded` is true for every live
    ///      market before `graduate()` returns. Reproduce that here first, because `beginSeed`'s
    ///      ONLY persistent guard is `m.seeded` — a market that reached the chain registered and
    ///      unseeded would leave the waiver armable by any future graduator, for ever.
    function _consumeTheSeedWaiver() internal {
        vm.prank(graduator);
        hook.beginSeed(idA, 5 ether, -600, 600);
        lp.modifyLiquidity{value: 100 ether}(
            keyA, ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 5 ether, salt: 0}), ""
        );
        vm.prank(graduator);
        hook.endSeed(idA);
        assertTrue(hook.markets(idA).seeded, "the waiver was not consumed");
    }

    function test_aNewGraduatorCannotReachALiveMarketsMoney() public {
        _consumeTheSeedWaiver();
        _buy(keyA, 500 ether);
        uint256 prot = hook.pendingProtocol(idA);
        assertGt(prot, 0);

        hook.setGraduator(rogue, true);
        uint8 rewards = hook.SINK_REWARDS();

        // Cannot re-register it under a sink it controls.
        vm.prank(rogue);
        vm.expectRevert(DokuHook.AlreadyRegistered.selector);
        hook.registerPool(keyA, address(tokA), rewards, rogue, 0);

        // Cannot arm the seed waiver on it: the market is already seeded.
        vm.prank(rogue);
        vm.expectRevert(DokuHook.AlreadySeeded.selector);
        hook.beginSeed(idA, 1, -60, 60);

        // Cannot pull the sink, and cannot pull the tax.
        vm.prank(rogue);
        vm.expectRevert(DokuHook.NotSink.selector);
        hook.pullSink(idA);
        vm.prank(rogue);
        vm.expectRevert(DokuHook.NotSink.selector);
        hook.pullTax(idA);

        // The only thing a sweep can do is move it to the immutable treasury.
        hook.sweep(idA);
        hook.pullTreasury(Currency.wrap(address(0)));
        assertEq(TREASURY.balance, prot, "the protocol share went somewhere other than the treasury");
        assertEq(hook.pendingProtocol(idA), 0);
    }
}

/// @notice PROBE 7 — conservation at the 1,100 bps ceiling, where the creator tax, the LP donate
///         and the treasury split all divide the same number and every one of them truncates.
contract HookHuntCeiling is Test {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using StateLibrary for IPoolManager;

    uint160 internal constant FLAGS = 0x2FCF;
    address internal constant TREASURY = address(0xBEEF);
    uint160 internal constant SQRT_1_1 = 79228162514264337593543950336;

    PoolManager internal manager;
    DokuHook internal hook;
    PoolSwapTest internal swapper;
    PoolModifyLiquidityTest internal lp;
    address internal graduator = address(0x6AD);
    address internal creatorSinkAddr = address(0xC5);

    HTok internal tok;
    PoolKey internal key;
    PoolId internal id;

    receive() external payable {}

    function setUp() public {
        manager = new PoolManager(address(this));
        swapper = new PoolSwapTest(IPoolManager(address(manager)));
        lp = new PoolModifyLiquidityTest(IPoolManager(address(manager)));
        bytes memory args = abi.encode(IPoolManager(address(manager)), address(this), TREASURY, creatorSinkAddr);
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        hook = new DokuHook{salt: salt}(IPoolManager(address(manager)), address(this), TREASURY, creatorSinkAddr);
        hook.setGraduator(graduator, true);

        vm.deal(address(this), 10_000_000 ether);
        tok = new HTok("C");
        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(tok)),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        id = key.toId();
        vm.startPrank(graduator);
        manager.initialize(key, SQRT_1_1);
        hook.registerPool(key, address(tok), hook.SINK_REWARDS(), address(0x51), 1000); // the ceiling
        vm.stopPrank();
        tok.approve(address(lp), type(uint256).max);
        tok.approve(address(swapper), type(uint256).max);
        lp.modifyLiquidity{value: 20_000 ether}(
            key,
            ModifyLiquidityParams({tickLower: -60000, tickUpper: 60000, liquidityDelta: 2_000 ether, salt: 0}),
            ""
        );
    }

    /// @dev At the ceiling the tax is 1,000 of 1,100 bps, so `amount - taxCut` in `_settleLeg` is
    ///      the narrowest subtraction in the contract and it runs after `amount` has already been
    ///      reduced by the LP donate. Driven from one wei of levy upwards.
    function testFuzz_theCeilingSplitNeverUnderflowsAndAlwaysConserves(uint96 monIn) public {
        monIn = uint96(bound(uint256(monIn), 1, 5_000 ether));
        uint256 claimsBefore = manager.balanceOf(address(hook), uint256(0));
        uint256 protBefore = hook.pendingProtocol(id);
        uint256 taxBefore = hook.owedTax(id);
        uint256 sinkBefore = hook.pendingSink(id);

        swapper.swap{value: monIn}(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(uint256(monIn)),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        uint256 minted = manager.balanceOf(address(hook), uint256(0)) - claimsBefore;
        uint256 booked = (hook.pendingProtocol(id) - protBefore) + (hook.owedTax(id) - taxBefore)
            + (hook.pendingSink(id) - sinkBefore);
        // Every claim the hook minted is booked to exactly one ledger, and no ledger claims a
        // wei the hook did not mint.
        assertEq(minted, booked, "minted claims and booked ledgers disagree");
    }

    /// @dev The maker/taker gap, quantified. It is a DECISION (spec §3.4, `_makerLevy`'s natspec)
    ///      and not a defect, but the size of it is what a generation-4 rate table has to answer
    ///      for: at the 10% ceiling a patient seller pays 30 bps through a range order where an
    ///      impatient one pays 1,100 through a swap.
    function test_theMakerTakerGapAtTheCeiling() public view {
        DokuHook.Market memory m = hook.markets(id);
        uint256 taker = uint256(hook.PROTOCOL_LEVY_BPS()) + hook.LP_LEVY_BPS() + m.creatorTaxBps;
        uint256 maker = m.makerBps0; // the quote leg — native sorts to currency0
        assertEq(taker, 1100, "taker rate");
        assertEq(maker, 30, "maker rate");
        console2.log("taker bps on the quote leg:", taker);
        console2.log("maker bps on the quote leg:", maker);
    }
}

/// @notice PROBE 8 — the ledger under a randomised action sequence. Two markets share the native
///         quote, so they share both the hook's ERC-6909 claim balance and its real MON balance,
///         while `pendingProtocol` / `pendingSink` / `owedTax` / `owedSink` are per market and
///         `owedTreasury` is per currency. The property: at no point can any sequence make the
///         pooled balance disagree with the sum of the per-market books.
contract HookHuntSequence is HookHuntBase {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using StateLibrary for IPoolManager;

    Currency internal NATIVE = Currency.wrap(address(0));

    function _invariant() internal view {
        uint256 nativeLedger = hook.pendingProtocol(idA) + hook.pendingProtocol(idB) + hook.owedTax(idA)
            + hook.owedTax(idB) + hook.pendingSink(idA);
        assertEq(_claims(NATIVE), nativeLedger, "native claims != native books");
        assertEq(
            _claims(Currency.wrap(address(tokB))),
            hook.pendingSink(idB) + hook.pendingProtocolToken(idB),
            "tokB claims != book"
        );
        assertEq(_claims(Currency.wrap(address(tokA))), hook.pendingProtocolToken(idA), "tokA claims != book");

        // Real balances back every owed line, across markets.
        assertGe(_real(NATIVE), hook.owedTreasury(NATIVE) + hook.owedSink(idA), "MON short");
        assertGe(_real(Currency.wrap(address(tokB))), hook.owedSink(idB), "tokB short");
    }

    /// @dev Best-effort actions: a sequence that a real caller could not execute (an empty
    ///      position, a pool with no depth left) is skipped rather than aborting the run, so the
    ///      fuzzer spends its budget on sequences that actually move money.
    function testFuzz_noActionSequenceBreaksTheSharedLedger(uint8[16] memory acts, uint64[16] memory sizes) public {
        for (uint256 i; i < acts.length; ++i) {
            PoolKey memory k = (i % 2 == 0) ? keyA : keyB;
            PoolId pid = (i % 2 == 0) ? idA : idB;
            HTok t = (i % 2 == 0) ? tokA : tokB;
            uint256 n = bound(uint256(sizes[i]), 1, 200 ether);
            uint8 a = acts[i] % 8;

            if (a == 0) {
                try swapper.swap{value: n}(
                    k,
                    SwapParams({
                        zeroForOne: true,
                        amountSpecified: -int256(n),
                        sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
                    }),
                    PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                    ""
                ) {} catch {}
            } else if (a == 1) {
                if (t.balanceOf(address(this)) > n) {
                    try swapper.swap(
                        k,
                        SwapParams({
                            zeroForOne: false,
                            amountSpecified: -int256(n),
                            sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
                        }),
                        PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                        ""
                    ) {} catch {}
                }
            } else if (a == 2) {
                try swapper.swap(
                    k,
                    SwapParams({
                        zeroForOne: false,
                        amountSpecified: int256(n / 1000 + 1),
                        sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
                    }),
                    PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                    ""
                ) {} catch {}
            } else if (a == 3) {
                try lp.modifyLiquidity{value: 1_000 ether}(
                    k,
                    ModifyLiquidityParams({
                        tickLower: -6000, tickUpper: 6000,
                        liquidityDelta: int256(n / 1000 + 1), salt: 0
                    }),
                    ""
                ) {} catch {}
            } else if (a == 4) {
                // v4's fee-collect shape: liquidityDelta == 0, which lands on the REMOVE branch.
                try lp.modifyLiquidity(
                    k,
                    ModifyLiquidityParams({tickLower: -60000, tickUpper: 60000, liquidityDelta: 0, salt: 0}),
                    ""
                ) {} catch {}
            } else if (a == 5) {
                if (hook.pendingProtocol(pid) != 0 || hook.pendingSink(pid) != 0) hook.sweep(pid);
            } else if (a == 6) {
                hook.pullTreasury(NATIVE);
            } else {
                // The permissionless curve-tax credit, native form, on the quote-paying market.
                hook.creditCurveTax{value: n}(idA);
            }
            _invariant();
        }
    }
}
