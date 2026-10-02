// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Mock", "MOCK") {
        _mint(msg.sender, 1_000_000_000e18);
    }
}

/// @notice The levy, on all four swap shapes and both sinks.
/// @dev The table in `test_levyCurrencyOnAllFourShapes` is the point of this file. An
///      `afterSwap`-only hook levies the currency the pool COMPUTES, which on an exact-input buy —
///      the dominant retail shape — is the token, not MON. Taking both callbacks is what makes the
///      levy currency a design choice, and that choice is what removes every internal swap, keeper
///      and trusted operator from the design.
contract HookLevyTest is Test {
    using CurrencyLibrary for Currency;

    uint160 internal constant FLAGS = 0x2FCF;
    address internal constant TREASURY = address(0xBEEF);
    address internal constant CREATOR_SINK = address(0xC5);
    uint160 internal constant SQRT_1_1 = 79228162514264337593543950336;

    PoolManager internal manager;
    DokuHook internal hook;
    PoolSwapTest internal swapper;
    PoolModifyLiquidityTest internal lp;

    MockToken internal burnTok;
    MockToken internal rewTok;
    PoolKey internal burnKey;
    PoolKey internal rewKey;

    address internal graduator = address(0x6AD);
    address internal sinkAddr = address(0x51);

    uint16 internal PROT;
    uint16 internal SINKB;

    /// @dev The v4 test routers refund unspent native MON with a full-gas call, so a
    ///      test contract that funds swaps must be able to receive it.
    receive() external payable {}

    function setUp() public {
        manager = new PoolManager(address(this));
        swapper = new PoolSwapTest(IPoolManager(address(manager)));
        lp = new PoolModifyLiquidityTest(IPoolManager(address(manager)));

        bytes memory args = abi.encode(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        hook = new DokuHook{salt: salt}(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        hook.setGraduator(graduator, true);

        PROT = hook.PROTOCOL_LEVY_BPS();
        SINKB = hook.SINK_LEVY_BPS();

        burnTok = new MockToken();
        rewTok = new MockToken();
        burnKey = _openMarket(burnTok, hook.SINK_BURN());
        rewKey = _openMarket(rewTok, hook.SINK_REWARDS());

        vm.deal(address(this), 10_000 ether);
    }

    function _openMarket(MockToken t, uint8 sink) internal returns (PoolKey memory k) {
        k = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(t)),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        vm.startPrank(graduator);
        manager.initialize(k, SQRT_1_1);
        hook.registerPool(k, address(t), sink, sinkAddr, 0);
        vm.stopPrank();

        t.approve(address(lp), type(uint256).max);
        t.approve(address(swapper), type(uint256).max);
        vm.deal(address(this), 10_000 ether);
        lp.modifyLiquidity{value: 1_000 ether}(
            k,
            ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 500 ether, salt: 0}),
            ""
        );
    }

    function _swap(PoolKey memory k, bool zeroForOne, int256 amountSpecified) internal returns (BalanceDelta) {
        uint160 limit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        uint256 val = (zeroForOne && amountSpecified < 0) ? uint256(-amountSpecified) : 20 ether;
        return swapper.swap{value: val}(
            k,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: amountSpecified, sqrtPriceLimitX96: limit}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _claims(Currency c) internal view returns (uint256) {
        return manager.balanceOf(address(hook), c.toId());
    }

    // -------------------------------------------------------------------------------- the table

    /// @dev The whole reason `beforeSwap` is declared. With MON always currency0:
    ///        exact-in BUY   -> specified = MON,   unspecified = token
    ///        exact-in SELL  -> specified = token, unspecified = MON
    ///        exact-out BUY  -> specified = token, unspecified = MON
    ///        exact-out SELL -> specified = MON,   unspecified = token
    ///      A REWARDS market must end up holding ONLY MON on every one of those, and a BURN market
    ///      must hold MON for the protocol and token for the sink, never the reverse.
    function test_levyCurrencyOnAllFourShapes() public {
        Currency mon = Currency.wrap(address(0));

        // --- REWARDS: MON on every shape, token never. ---
        //
        // Measured as a DELTA since generation 4. The SWAP path is unchanged — a REWARDS market's
        // token leg still carries a zero rate — but the MAKER levy is now symmetric across the legs
        // (see `registerPool`), so the LP adds in `setUp` have already put token claims here. The
        // property under test is that a SWAP adds none, which is what the delta says and what the
        // absolute figure used to say only because there was nothing else in the bucket.
        Currency rtok = Currency.wrap(address(rewTok));
        uint256 rtok0 = _claims(rtok);
        _swap(rewKey, true, -1 ether); // exact-in buy
        assertGt(_claims(mon), 0, "rewards/exactInBuy: no MON levied");
        assertEq(_claims(rtok), rtok0, "rewards/exactInBuy: token levied");

        _swap(rewKey, false, -1 ether); // exact-in sell
        assertEq(_claims(rtok), rtok0, "rewards/exactInSell: token levied");

        _swap(rewKey, true, 1 ether); // exact-out buy
        assertEq(_claims(rtok), rtok0, "rewards/exactOutBuy: token levied");

        _swap(rewKey, false, 1 ether); // exact-out sell
        assertEq(_claims(rtok), rtok0, "rewards/exactOutSell: token levied");

        // --- BURN: both currencies, each to its own destination. ---
        Currency btok = Currency.wrap(address(burnTok));
        uint256 monBefore = _claims(mon);
        uint256 btokBefore = _claims(btok);
        uint256 bSinkBefore = hook.pendingSink(PoolIdLibrary.toId(burnKey));
        _swap(burnKey, true, -1 ether);
        assertGt(_claims(mon), monBefore, "burn/exactInBuy: no MON levied");
        // The token leg is levied at the same rate and HELD, which is the round-4 change: it used to
        // be handed to `poolManager.donate`, so the hook's own claims did not grow and this line
        // asserted equality. It now grows by exactly what the sink's ledger grows by — the whole
        // leg, because `_tokenBps == _lpTokenBps == 70` on a BURN market. Deltas throughout,
        // because the symmetric maker levy has already put token claims here during setup.
        uint256 btokLevied = _claims(btok) - btokBefore;
        assertGt(btokLevied, 0, "burn/exactInBuy: the token leg was not levied");
        assertEq(
            hook.pendingSink(PoolIdLibrary.toId(burnKey)) - bSinkBefore,
            btokLevied,
            "burn/exactInBuy: the token levy did not reach the sink"
        );
    }

    /// @dev A REWARDS market's vault is paid in MON, so its token bucket must be identically zero
    ///      forever — otherwise it would have to sell, which is the entire thing this design avoids.
    function test_theHookNeverHoldsTheCurrencyItsSinkDoesNotWant() public {
        PoolId rid = PoolIdLibrary.toId(rewKey);
        uint256 tok0 = _claims(Currency.wrap(address(rewTok)));
        uint256 mon0 = _claims(Currency.wrap(address(0)));
        uint256 sink0 = hook.pendingSink(rid);
        _swap(rewKey, true, -2 ether);
        _swap(rewKey, false, -2 ether);
        _swap(rewKey, true, 1 ether);
        _swap(rewKey, false, 1 ether);
        assertEq(_claims(Currency.wrap(address(rewTok))), tok0, "REWARDS market accrued token");
        assertGt(hook.pendingProtocol(rid), 0, "treasury accrued nothing");

        // The claim that matters, and that neither generation 4 nor round 4 weakened: whatever the
        // hook holds, the SINK's ledger is only ever the currency its sink pays out in. The
        // token-leg maker levy goes to `pendingProtocolToken`, which is the treasury's, and the
        // treasury has always been able to hold whatever it is paid.
        //
        // The SHAPE of the assertion had to change, because the answer is no longer zero. Round 4
        // routes 70 bps of every swap to `pendingSink` instead of donating it, so a REWARDS sink IS
        // credited — in MON. Asserting "the sink's credit came out of the MON the hook minted" is
        // what the old `== 0` was standing in for, and it is the statement that still catches a
        // token unit reaching a quote-denominated book.
        uint256 sinkDelta = hook.pendingSink(rid) - sink0;
        assertGt(sinkDelta, 0, "a REWARDS sink accrued nothing from four swaps");
        assertLe(sinkDelta, _claims(Currency.wrap(address(0))) - mon0, "the sink's credit is not backed by MON claims");
    }

    /// @dev A BURN market levies BOTH currencies: MON for the treasury, the launch token for the
    ///      sink that destroys it.
    ///
    ///      THIS NAME AND THIS BODY HAVE NOW BEEN RIGHT, WRONG, AND RIGHT AGAIN, which is why the
    ///      history is here rather than a clean assertion with no explanation. Generation 1 asserted
    ///      a split by currency, exactly as below. Generation 2 donated the token leg to the pool's
    ///      LPs, so the hook kept none of it and this became
    ///      `test_burnMarketLeviesMonAndNothingElse` — one levied currency, and the sink funded
    ///      only by `SeedLocker.collect` forwarding the seed's fee growth. Round 3 measured what
    ///      that donation could be taken by (`test/audit/Round3Jit.t.sol`) and round 4 routed the
    ///      70 bps back to `pendingSink`, so the original split is the truth again — by a different
    ///      mechanism, and one nobody can stand in front of.
    ///
    ///      `SINK_LEVY_BPS` is STILL ZERO and still is not the statement. The sink's swap income is
    ///      `LP_LEVY_BPS`, whose name is ABI and whose docblock explains why the two constants are
    ///      not merged.
    function test_burnMarketLeviesBothLegsToTheirOwnBooks() public {
        PoolId bid = PoolIdLibrary.toId(burnKey);

        // DELTAS across the swap, not absolutes. The market's maker levy has already accrued to the
        // sink during setup when liquidity was added, and that is a different mechanism from the one
        // under test — reading the totals here measures the setup, not the trade.
        uint256 sinkBefore = hook.pendingSink(bid);
        uint256 protBefore = hook.pendingProtocol(bid);
        uint256 tokenBefore = _claims(Currency.wrap(address(burnTok)));

        _swap(burnKey, true, -5 ether);

        assertGt(hook.pendingProtocol(bid) - protBefore, 0, "treasury got nothing from the MON leg");
        // The token leg is levied and KEPT: minted as an ERC-6909 claim and booked to `pendingSink`.
        // The two deltas are asserted EQUAL rather than each asserted positive, because on a BURN
        // market `_tokenBps == _lpTokenBps == 70` makes the whole leg the sink's — a token claim
        // that did not land in `pendingSink` would be a unit of the sink's money in the treasury's
        // quote-denominated book, which is the failure the ledger partition exists to catch.
        uint256 tokenLevied = _claims(Currency.wrap(address(burnTok))) - tokenBefore;
        assertGt(tokenLevied, 0, "the token leg was not levied at all");
        assertEq(hook.pendingSink(bid) - sinkBefore, tokenLevied, "the token levy did not reach the sink");
    }

    /// @dev Exact-input: the trader pays exactly what they specified and the OUTPUT absorbs the
    ///      levy. Exact-output: they receive exactly what they specified and the INPUT grows.
    function test_theTraderPaysExactlyWhatTheySpecified() public {
        BalanceDelta d = _swap(rewKey, true, -3 ether);
        assertEq(d.amount0(), -3 ether, "exact-input: trader's MON in was not exactly what was specified");

        BalanceDelta e = _swap(rewKey, true, 1 ether);
        assertEq(e.amount1(), 1 ether, "exact-output: trader's token out was not exactly what was specified");
    }

    /// @dev `mint` rather than `take` is what makes this true. A `take` on the unspecified leg of an
    ///      exact-output swap draws on the singleton's SHARED balance — every other pool's reserves —
    ///      and reverts on the causing swap for reasons the swapper cannot see.
    function test_exactOutputDoesNotDrawOnTheSingletonsSharedBalance() public {
        // A second, unrelated market in the same currencies, deliberately left thin.
        MockToken other = new MockToken();
        _openMarket(other, hook.SINK_REWARDS());

        uint256 monInSingleton = address(manager).balance;
        BalanceDelta d = _swap(rewKey, true, 1 ether);
        assertEq(d.amount1(), 1 ether, "exact-output did not deliver exactly");
        assertGt(address(manager).balance, monInSingleton, "singleton lost MON on an exact-output swap");
    }

    /// @dev Truncation is fine, but it must be bounded by one unit and must never round up.
    function test_dustSwapsRoundToZeroAndThatIsFine() public {
        PoolId rid = PoolIdLibrary.toId(rewKey);
        uint256 before = hook.pendingProtocol(rid) + hook.pendingSink(rid);
        _swap(rewKey, true, -99); // 99 wei at 100 bps truncates to 0
        uint256 accrued = hook.pendingProtocol(rid) + hook.pendingSink(rid) - before;
        assertLe(accrued, 1, "dust swap over-levied");
    }

    /// @dev Fail closed on the swap path: an unregistered pool bearing this hook must not trade.
    function test_anUnregisteredHookedPoolCannotBeSwapped() public {
        MockToken orphan = new MockToken();
        PoolKey memory k = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(orphan)),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        vm.prank(graduator);
        manager.initialize(k, SQRT_1_1); // gate lets the graduator in; registerPool never runs

        orphan.approve(address(swapper), type(uint256).max);
        vm.expectRevert();
        _swap(k, true, -1 ether);
    }
}
