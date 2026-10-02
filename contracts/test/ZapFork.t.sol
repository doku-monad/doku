// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PathKey} from "@uniswap/v4-periphery/src/libraries/PathKey.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {DokuToken} from "../src/DokuToken.sol";
import {DokuFactory} from "../src/DokuFactory.sol";
import {DokuGraduation} from "../src/DokuGraduation.sol";
import {QuoteRegistry} from "../src/QuoteRegistry.sol";
import {ZapRouter} from "../src/ZapRouter.sol";
import {Sinks} from "../src/lib/Sinks.sol";
import {DeployDoku} from "../script/DeployDoku.s.sol";

/// @notice The zap router against the real Uniswap v4 on Monad mainnet.
///
/// @dev A SIBLING of `Fork.t.sol` rather than an extension of it, for one mechanical reason: that
///      file's `_lifecycle` already sits at the stack limit and is split into three internal calls
///      to stay under it. Adding a second suite's locals to the same contract is how that file
///      starts failing to compile for reasons unrelated to what it tests.
///      Run both with `forge test --match-path 'test/*Fork*.t.sol'`.
///
///      This used to say `via_ir` "must stay off" because it moves the hook's mined address. It is
///      ON now — the 2026-09-09 audit found production had been running the IR build while every
///      test compiled the legacy one, and `foundry.toml` carries that story. The conclusion above
///      is unchanged (keep the suites apart, do not widen shared helpers); only its reason moved,
///      because IR does not remove the stack limit so much as relocate where you hit it.
///
///      Everything here needs real liquidity, so every test forks or skips. The skip is what keeps
///      the offline `forge test` count stable — a skipped test is not a passing one.
contract ZapForkTest is Test {
    // ---------------------------------------------------------------- the chain

    address constant POOL_MANAGER = 0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e;
    address constant POSITION_MANAGER = 0x5b7eC4a94fF9beDb700fb82aB09d5846972F4016;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    address constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603; // 6 dec
    address constant USDT0 = 0xe7cd86e13AC4309349F30B3435a9d337750fC82D; // 6 dec
    address constant WBTC = 0x0555E30da8f98308EdB960aa94C0Db47230d2B9c; // 8 dec
    address constant CBBTC = 0xd18B7EC58Cdf4876f6AFebd3Ed1730e4Ce10414b; // 8 dec
    address constant XAUT0 = 0x01bFF41798a0BcF287b996046Ca68b395DbC1071; // 6 dec, gold

    /// @dev The shipped mainnet targets (docs/doku/deployments.md), not round test numbers. Every
    ///      one is ~$8,000 and divisible by five; a target that is not truncates the curve's
    ///      virtual floor and leaves a filled market unable to graduate.
    uint256 constant TARGET_MON = 305_868_390_948_742_537_150_460;
    uint256 constant TARGET_USDC = 8_000_000_000;
    uint256 constant TARGET_USDT0 = 8_000_000_000;
    uint256 constant TARGET_WBTC = 10_170_090;
    uint256 constant TARGET_CBBTC = 10_170_090;
    uint256 constant TARGET_GOLD = 1_809_590;

    /// @dev Measured, not assumed — `test_theRouteTableIsStillTheRealOne` asserts every one of
    ///      these pools is initialised and holds liquidity before any zap relies on it.
    ///
    ///      Only MON/USDC and MON/USDT0 are real direct routes. The MON/cbBTC (fee 500) and
    ///      MON/WETH (fee 10000) pools exist but hold roughly one MON of usable depth: quoting
    ///      through them costs -40% at 10 MON and -88% at 100 MON. WBTC and XAUt0 have no direct
    ///      MON pool at all. So everything except the two stablecoins hops.
    uint24 constant FEE_LOWEST = 100;
    int24 constant SPACING_LOWEST = 1;
    uint24 constant FEE_LOW = 500;
    int24 constant SPACING_LOW = 10;
    uint24 constant FEE_MED = 3000;
    int24 constant SPACING_MED = 60;

    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);
    address constant TAXMAN = address(0x7A11);

    /// @dev Sized to sit inside the FLAT part of every route in the table. MON/USDC is flat to
    ///      10,000 MON and MON/USDT0 to ~1,000, so 100 MON — about $2.60 — never pays for depth it
    ///      is not using, and leaves the price the next test reads unmoved.
    uint256 constant ZAP = 100 ether;

    /// @dev What a transaction pays BEFORE its first opcode, so an execution figure measured with
    ///      `gasleft()` can be compared with a limit a wallet actually sends. 21,000 flat, plus the
    ///      calldata: a two-hop `zapSellToNative` is 676 bytes, and at 16 gas a non-zero byte and 4
    ///      a zero one that is under 4,000. Rounded up to 30,000 so this errs the safe way — an
    ///      under-set limit reverts, and on Monad you are billed the limit regardless.
    uint256 constant TX_INTRINSIC = 30_000;

    /// @dev The floor and the ceiling `zapSellGasLimit` applies in
    ///      `src/typescript/frontend/src/lib/chain/zap.ts`, restated here so the two cannot drift
    ///      in silence. `test_whatASellCostsInIsolationOnMainnetFork` is what fails the day the
    ///      measured sell outgrows either, and that file's docblock points back at this one.
    ///
    ///      Both are derived from the same three numbers that test prints, on 2026-09-10 at fork
    ///      block ~103,649,665:
    ///        270,699  the dearest of the three shapes (gold, two hops)
    ///         30,873  what one more hop costs — the two-hop shape minus the one-hop shape
    ///         30,000  `TX_INTRINSIC`
    ///      floor = 270,699 + 30,873 + 30,000, a three-hop sell, which is the longest route this
    ///      app will ever build (`MAX_ZAP_HOPS` is 3). Ceiling = floor + four more hops.
    uint256 constant FRONTEND_SELL_GAS_FLOOR = 331_572;
    uint256 constant FRONTEND_SELL_GAS_CAP = 455_064;

    /// @dev `PoolSwapTest` returns unspent MON with a raw send, and `_poolQuote` deals this
    ///      contract the MON it swaps. Nothing else here is paid in native.
    receive() external payable {}

    DokuFactory internal factory;
    DokuGraduation internal graduation;
    QuoteRegistry internal registry;
    ZapRouter internal router;

    // ---------------------------------------------------------------- the happy paths

    /// @dev The case the owner asked for by name: MARS, a coin priced in cbBTC, bought with MON in
    ///      one transaction. Two hops, because the direct MON/cbBTC pool is a dust pool.
    function test_zapIntoACbbtcMarketOnMainnetFork() public {
        if (!_fork()) return;
        _stack();
        (BondingCurve c, DokuToken t) = _launch(CBBTC, "MARS");
        uint256 baseOut = _zap(ALICE, c, _twoHop(USDC, FEE_LOW, SPACING_LOW, CBBTC, FEE_LOW, SPACING_LOW), 0, 0);
        assertGt(baseOut, 0, "the cbBTC zap delivered nothing");
        assertEq(t.balanceOf(ALICE), baseOut, "the market tokens did not reach the caller");
        assertGt(c.quoteRaised(), 0, "the curve did not register the raise");
        _assertRouterIsEmpty(t);
    }

    /// @dev A six-decimal quote and the only single-hop route worth having. Same assertions, and
    ///      the leg where a raw unit is a millionth rather than a hundred-millionth.
    function test_zapIntoAUsdcMarketOnMainnetFork() public {
        if (!_fork()) return;
        _stack();
        (BondingCurve c, DokuToken t) = _launch(USDC, "USDM");
        uint256 baseOut = _zap(ALICE, c, _oneHop(USDC, FEE_LOW, SPACING_LOW), 0, 0);
        assertGt(baseOut, 0, "the USDC zap delivered nothing");
        assertEq(t.balanceOf(ALICE), baseOut, "the market tokens did not reach the caller");
        _assertRouterIsEmpty(t);
    }

    /// @dev Gold, reachable only through USDT0 — nothing else on the chain pairs with XAUt0. Also
    ///      the coarsest quote there is: one raw unit is a millionth of a troy ounce, ~$0.0033, so
    ///      this is where a swap leg that rounds badly shows up first.
    function test_zapIntoAGoldMarketOnMainnetFork() public {
        if (!_fork()) return;
        _stack();
        (BondingCurve c, DokuToken t) = _launch(XAUT0, "GLDZ");
        uint256 baseOut = _zap(ALICE, c, _twoHop(USDT0, FEE_MED, SPACING_MED, XAUT0, FEE_LOW, SPACING_LOW), 0, 0);
        assertGt(baseOut, 0, "the gold zap delivered nothing");
        assertEq(t.balanceOf(ALICE), baseOut, "the market tokens did not reach the caller");
        _assertRouterIsEmpty(t);
    }

    /// @dev WBTC has NO direct MON pool. Before the route became a path this market was
    ///      unreachable from native MON entirely, which is the whole reason the signature takes a
    ///      path rather than a single pool key.
    function test_zapIntoAWbtcMarketOnMainnetFork() public {
        if (!_fork()) return;
        _stack();
        (BondingCurve c, DokuToken t) = _launch(WBTC, "SATS");
        uint256 baseOut = _zap(ALICE, c, _twoHop(USDC, FEE_LOW, SPACING_LOW, WBTC, FEE_LOW, SPACING_LOW), 0, 0);
        assertGt(baseOut, 0, "the WBTC zap delivered nothing");
        assertEq(t.balanceOf(ALICE), baseOut, "the market tokens did not reach the caller");
        _assertRouterIsEmpty(t);
    }

    // ---------------------------------------------------------------- the guards

    /// @dev The swap leg's bound, and the reason it exists. The 0.01% MON/USDC pool holds about a
    ///      dollar; the 0.05% pool next to it is flat to 10,000 MON. A caller who picks the wrong
    ///      one must be stopped by the bound rather than by luck — this asserts the same 100 MON
    ///      through the thin pool cannot clear a bound the deep pool clears easily.
    function test_theSwapBoundCatchesTheThinPoolOnMainnetFork() public {
        if (!_fork()) return;
        _stack();
        (BondingCurve c,) = _launch(USDC, "USDM");

        // What each pool really pays for 100 MON, MEASURED against the chain and then rolled back,
        // so the numbers the assertion below uses are the ones the router would have seen.
        uint256 snap = vm.snapshotState();
        uint256 deep = _poolQuote(USDC, FEE_LOW, SPACING_LOW, ZAP);
        vm.revertToState(snap);
        uint256 thin = _poolQuote(USDC, FEE_LOWEST, SPACING_LOWEST, ZAP);
        vm.revertToState(snap);
        assertGt(deep, thin * 10, "the 0.01% pool is no longer the thin one: re-measure the table");

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(ZapRouter.InsufficientQuoteOut.selector, deep, thin));
        router.zapBuyWithNative{value: ZAP}(
            address(c), _oneHop(USDC, FEE_LOWEST, SPACING_LOWEST), deep, 0, block.timestamp + 1
        );
    }

    /// @dev The buy leg's bound. Unreachable `minBaseOut`, and the curve — not the router — is what
    ///      refuses it, which is the point: the router does not reimplement the curve's arithmetic.
    function test_theBuyBoundRevertsOnMainnetFork() public {
        if (!_fork()) return;
        _stack();
        (BondingCurve c,) = _launch(USDC, "USDM");
        vm.prank(ALICE);
        vm.expectRevert(BondingCurve.InsufficientOutput.selector);
        router.zapBuyWithNative{value: ZAP}(
            address(c), _oneHop(USDC, FEE_LOW, SPACING_LOW), 0, type(uint128).max, block.timestamp + 1
        );
    }

    function test_anExpiredDeadlineRevertsOnMainnetFork() public {
        if (!_fork()) return;
        _stack();
        (BondingCurve c,) = _launch(USDC, "USDM");
        vm.prank(ALICE);
        vm.expectRevert(ZapRouter.Expired.selector);
        router.zapBuyWithNative{value: ZAP}(address(c), _oneHop(USDC, FEE_LOW, SPACING_LOW), 0, 0, block.timestamp - 1);
    }

    /// @dev A router that will call any address a caller hands it is a router that can be pointed
    ///      at a contract which takes the quote and returns nothing.
    function test_anUnknownCurveIsRefusedOnMainnetFork() public {
        if (!_fork()) return;
        _stack();
        address impostor = address(0xDEAD);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(ZapRouter.UnknownMarket.selector, impostor));
        router.zapBuyWithNative{value: ZAP}(impostor, _oneHop(USDC, FEE_LOW, SPACING_LOW), 0, 0, block.timestamp + 1);
    }

    /// @dev A path that ends somewhere other than the market's own quote. Left unchecked the router
    ///      would approve the WRONG token to the curve, the curve's `transferFrom` would take
    ///      nothing, and the swapped balance would sit in the router for the next caller to sweep.
    function test_aPathEndingAtTheWrongAssetIsRefusedOnMainnetFork() public {
        if (!_fork()) return;
        _stack();
        (BondingCurve c,) = _launch(CBBTC, "MARS");
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(ZapRouter.PathDoesNotEndAtQuote.selector, CBBTC, USDC));
        router.zapBuyWithNative{value: ZAP}(
            address(c), _oneHop(USDC, FEE_LOW, SPACING_LOW), 0, 0, block.timestamp + 1
        );
    }

    function test_anEmptyPathIsRefusedOnMainnetFork() public {
        if (!_fork()) return;
        _stack();
        (BondingCurve c,) = _launch(USDC, "USDM");
        vm.prank(ALICE);
        vm.expectRevert(ZapRouter.EmptyPath.selector);
        router.zapBuyWithNative{value: ZAP}(address(c), new PathKey[](0), 0, 0, block.timestamp + 1);
    }

    /// @dev A MON-quoted market has nothing to swap. Refused rather than passed through, so a
    ///      caller cannot be handed a `minQuoteOut` that silently means nothing. See the router.
    function test_aNativeQuotedMarketIsRefusedOnMainnetFork() public {
        if (!_fork()) return;
        _stack();
        (BondingCurve c,) = _launch(address(0), "MONM");
        vm.prank(ALICE);
        vm.expectRevert(ZapRouter.NativeQuoteNeedsNoZap.selector);
        router.zapBuyWithNative{value: ZAP}(
            address(c), _oneHop(USDC, FEE_LOW, SPACING_LOW), 0, 0, block.timestamp + 1
        );
    }

    /// @dev The hop cap. A gas bound, not an opinion about routes — but an unbounded array is a
    ///      transaction whose cost a caller sets from calldata, and Monad bills the LIMIT.
    function test_anOverlongPathIsRefusedOnMainnetFork() public {
        if (!_fork()) return;
        _stack();
        (BondingCurve c,) = _launch(USDC, "USDM");
        // Read BEFORE the prank and before `expectRevert` is armed. Both cheatcodes arm the NEXT
        // call, and an argument that is itself a call consumes the arming — the same footgun
        // `Fork.t.sol` documents on `vm.prank`.
        uint256 cap = router.MAX_HOPS();
        PathKey[] memory p = new PathKey[](cap + 1);
        for (uint256 i; i < p.length; ++i) {
            p[i] = PathKey({
                intermediateCurrency: Currency.wrap(USDC),
                fee: FEE_LOW,
                tickSpacing: SPACING_LOW,
                hooks: IHooks(address(0)),
                hookData: ""
            });
        }
        bytes memory expected = abi.encodeWithSelector(ZapRouter.PathTooLong.selector, p.length, cap);
        vm.prank(ALICE);
        vm.expectRevert(expected);
        router.zapBuyWithNative{value: ZAP}(address(c), p, 0, 0, block.timestamp + 1);
    }

    /// @dev A hop back into native MON. Never useful — the route starts there — and forbidding it
    ///      is what lets the router have no `receive()`, so the only native movement it can make is
    ///      the settle it owes.
    function test_aHopBackIntoNativeIsRefusedOnMainnetFork() public {
        if (!_fork()) return;
        _stack();
        (BondingCurve c,) = _launch(USDC, "USDM");
        PathKey[] memory p = _twoHop(address(0), FEE_LOW, SPACING_LOW, USDC, FEE_LOW, SPACING_LOW);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(ZapRouter.NativeIntermediate.selector, 0));
        router.zapBuyWithNative{value: ZAP}(address(c), p, 0, 0, block.timestamp + 1);
    }

    /// @dev The swap callback, reachable by anybody who can send a transaction. Both doors: the
    ///      caller must be the PoolManager, and a zap must actually be in flight. The second is
    ///      unreachable through the real PoolManager — it only ever calls back the address that
    ///      called `unlock` — and is asserted anyway, because "some other contract behaves" is not
    ///      a guarantee this contract gets to make.
    function test_theUnlockCallbackIsClosedOnMainnetFork() public {
        if (!_fork()) return;
        _stack();
        vm.prank(ALICE);
        vm.expectRevert(ZapRouter.NotPoolManager.selector);
        router.unlockCallback("");

        vm.prank(POOL_MANAGER);
        vm.expectRevert(ZapRouter.UnexpectedUnlock.selector);
        router.unlockCallback("");
    }

    // ---------------------------------------------------------------- the invariants

    /// @dev Four zaps by two callers across three quotes, then every balance the router could be
    ///      holding. It must be able to hold nothing between transactions — a router with a balance
    ///      is a router the next caller sweeps.
    function test_theRouterKeepsNothingOnMainnetFork() public {
        if (!_fork()) return;
        _stack();
        (BondingCurve c, DokuToken t) = _launch(CBBTC, "MARS");
        PathKey[] memory p = _twoHop(USDC, FEE_LOW, SPACING_LOW, CBBTC, FEE_LOW, SPACING_LOW);
        _zap(ALICE, c, p, 0, 0);
        _zap(BOB, c, p, 0, 0);
        _zap(ALICE, c, p, 0, 0);

        (BondingCurve u, DokuToken ut) = _launch(USDC, "USDM");
        _zap(BOB, u, _oneHop(USDC, FEE_LOW, SPACING_LOW), 0, 0);

        _assertRouterIsEmpty(t);
        _assertRouterIsEmpty(ut);
        assertEq(IERC20(CBBTC).allowance(address(router), address(c)), 0, "a live allowance survived the zap");
        assertEq(IERC20(USDC).allowance(address(router), address(u)), 0, "a live allowance survived the zap");
    }

    /// @dev The finding that decides the router's SHAPE. A buy that fills the curve graduates it in
    ///      the same transaction, and graduation calls `PositionManager`, which calls
    ///      `PoolManager.unlock`. v4 reverts `AlreadyUnlocked` on a nested unlock — so a router that
    ///      did the curve buy INSIDE its own unlock callback would fill the market and fail to
    ///      graduate it. Silently: `BondingCurve._tryAutoGraduate` swallows every failure by design,
    ///      so nothing would revert and nothing would tell the buyer.
    ///
    ///      The target is lowered first, because filling a real $8,000 market from MON would need
    ///      ~306,000 MON through a pool that is only flat to 10,000.
    function test_aFillingZapStillGraduatesOnMainnetFork() public {
        if (!_fork()) return;
        _stack();
        // Asked of whoever actually holds the registry, rather than assumed: `DeployDoku` only
        // OFFERS ownership, so the owner here is still the address that ran the script.
        vm.prank(registry.owner());
        registry.setQuoteTarget(USDC, 25_000_000); // $25, so ~1,000 MON fills it
        (BondingCurve c, DokuToken t) = _launch(USDC, "FILL");
        vm.warp(block.timestamp + c.TAX_WINDOW() + 1);

        uint256 baseOut = _zap(ALICE, c, _oneHop(USDC, FEE_LOW, SPACING_LOW), 2_000 ether, 0);
        assertGt(baseOut, 0, "the filling zap delivered nothing");
        assertTrue(c.readyToGraduate(), "the zap did not fill the curve");
        assertTrue(graduation.graduated(address(c)), "the filling zap did not graduate the market");
        assertGt(
            StateLibrary.getLiquidity(IPoolManager(POOL_MANAGER), graduation.poolIdOf(address(c))),
            0,
            "no liquidity in the graduated pool"
        );
        // The overshoot the curve refuses is refunded to the router in USDC, and must not stay
        // there. This is the leg that proves the quote-side sweep runs.
        _assertRouterIsEmpty(t);
    }

    /// @dev What a zap COSTS, measured on the real singletons and printed rather than asserted
    ///      against a magic number that would rot on the next Uniswap or Monad change. The one
    ///      thing asserted is the shape: a zap must stay far below the block limit, and a caller
    ///      expecting to FILL a curve must add `autoGraduationGasHint()` on top of this.
    function test_whatAZapCostsOnMainnetFork() public {
        if (!_fork()) return;
        _stack();
        (BondingCurve u,) = _launch(USDC, "USDM");
        (BondingCurve m,) = _launch(CBBTC, "MARS");

        vm.prank(ALICE);
        uint256 g0 = gasleft();
        router.zapBuyWithNative{value: ZAP}(
            address(u), _oneHop(USDC, FEE_LOW, SPACING_LOW), 0, 0, block.timestamp + 1
        );
        uint256 oneHop = g0 - gasleft();

        vm.prank(ALICE);
        g0 = gasleft();
        router.zapBuyWithNative{value: ZAP}(
            address(m), _twoHop(USDC, FEE_LOW, SPACING_LOW, CBBTC, FEE_LOW, SPACING_LOW), 0, 0, block.timestamp + 1
        );
        uint256 twoHop = g0 - gasleft();

        emit log_named_uint("zap gas, one hop ", oneHop);
        emit log_named_uint("zap gas, two hops", twoHop);
        emit log_named_uint("auto-graduation hint on top", u.autoGraduationGasHint());
        assertLt(oneHop, 1_000_000, "a one-hop zap got expensive: re-measure before shipping");
        assertLt(twoHop, 1_500_000, "a two-hop zap got expensive: re-measure before shipping");
        assertGt(twoHop, oneHop, "the second hop was free, which cannot be right");
    }

    /// @dev The table this suite's paths are built from, asserted against the chain rather than
    ///      trusted. A pool that has been drained or re-keyed shows up here as a named failure
    ///      instead of as an unexplained slippage revert three tests later.
    function test_theRouteTableIsStillTheRealOneOnMainnetFork() public {
        if (!_fork()) return;
        _live(address(0), USDC, FEE_LOW, SPACING_LOW, "MON/USDC 0.05%");
        _live(address(0), USDT0, FEE_MED, SPACING_MED, "MON/USDT0 0.3%");
        _live(USDC, CBBTC, FEE_LOW, SPACING_LOW, "USDC/cbBTC 0.05%");
        _live(USDC, WBTC, FEE_LOW, SPACING_LOW, "USDC/WBTC 0.05%");
        _live(USDT0, XAUT0, FEE_LOW, SPACING_LOW, "USDT0/XAUt0 0.05%");
    }

    // ---------------------------------------------------------------- the sell direction

    /// @dev The mirror of `test_zapIntoAUsdcMarketOnMainnetFork`, and the first proof that the
    ///      route runs BACKWARDS through real pools. Local tests prove the arithmetic against a
    ///      pool this suite seeded itself; only a fork proves that the USDC the curve pays can
    ///      actually be turned into MON at the other end.
    ///
    ///      Bought into first, because a sell needs something to sell and this file's `_launch`
    ///      deliberately buys nothing — so the buy leg is the only source of market tokens that
    ///      does not mean writing balance slots. That also makes this a ROUND TRIP: MON in through
    ///      the zap, MON out through the unzap, on the one route that is a single hop each way.
    ///
    ///      Asserted on the seller's MEASURED MON delta rather than on the returned `nativeOut`.
    ///      The two agree today; if they ever stopped agreeing, the delta is the only one that
    ///      describes what the seller can spend.
    function test_aCurveSellReturnsNativeOnMainnetFork() public {
        if (!_fork()) return;
        _stack();
        (BondingCurve c, DokuToken t) = _launch(USDC, "USDM");
        uint256 baseIn = _zap(ALICE, c, _oneHop(USDC, FEE_LOW, SPACING_LOW), 0, 0);
        assertGt(baseIn, 0, "the buy leg delivered nothing to sell");

        uint256 monBefore = ALICE.balance;
        uint256 curveBefore = t.balanceOf(address(c));
        uint256 nativeOut = _sellZap(ALICE, c, _oneHop(address(0), FEE_LOW, SPACING_LOW), baseIn, 0);

        emit log_named_uint("USDC market  : base sold, wei ", baseIn);
        emit log_named_uint("USDC market  : MON back, wei  ", nativeOut);
        emit log_named_uint("USDC market  : MON in, wei    ", ZAP);

        assertGt(nativeOut, 0, "the sell produced no MON at all");
        assertEq(ALICE.balance - monBefore, nativeOut, "the seller's MON did not rise by what was returned");
        assertEq(t.balanceOf(ALICE), 0, "the seller was not debited the tokens they sold");
        // The curve's side too, because "the seller's MON went up" is also what a router that paid
        // out of a float and never sold anything would look like.
        assertEq(t.balanceOf(address(c)) - curveBefore, baseIn, "the curve did not take the tokens");
        // MEASURED: 100 MON in, ~49 MON back. Most of that gap is not the route at all — a buy
        // inside `TAX_WINDOW` escrows the anti-sniper levy, which starts at 50% and never comes
        // back out through a sell. Two pool fees each way and the curve's 1% are the rest. So the
        // only safe assertion is the direction, and a round trip that MADE money would mean one of
        // the two legs is paying out of something that is not the caller's own trade.
        assertLt(nativeOut, ZAP, "the round trip made money, which no fee schedule on this route allows");
        _assertRouterIsEmpty(t);
    }

    /// @dev THE MULTI-HOP PROOF for the sell direction. Gold's only pool anywhere on this chain is
    ///      USDT0, so the way out is `XAUt0 -> USDT0 -> MON` and there is no other. A router that
    ///      handled one hop and silently mis-netted the second would still pass every test above
    ///      this one.
    ///
    ///      It is also the coarsest quote in the table: one raw XAUt0 unit is a millionth of a troy
    ///      ounce, so the first hop starts from a number small enough that a swap leg which rounds
    ///      badly produces nothing at all rather than producing something wrong.
    function test_aTwoHopSellReturnsNativeOnMainnetFork() public {
        if (!_fork()) return;
        _stack();
        (BondingCurve c, DokuToken t) = _launch(XAUT0, "GLDZ");
        uint256 baseIn = _zap(ALICE, c, _twoHop(USDT0, FEE_MED, SPACING_MED, XAUT0, FEE_LOW, SPACING_LOW), 0, 0);
        assertGt(baseIn, 0, "the buy leg delivered nothing to sell");

        // What the CURVE alone would pay, asked of the curve rather than assumed, so the number
        // below can be attributed to the right leg when it moves.
        (uint256 quoteOut,,) = c.quoteSell(baseIn);

        uint256 monBefore = ALICE.balance;
        uint256 nativeOut =
            _sellZap(ALICE, c, _twoHop(USDT0, FEE_LOW, SPACING_LOW, address(0), FEE_MED, SPACING_MED), baseIn, 0);

        emit log_named_uint("gold market  : base sold, wei ", baseIn);
        emit log_named_uint("gold market  : XAUt0 out, raw ", quoteOut);
        emit log_named_uint("gold market  : MON back, wei  ", nativeOut);

        assertGt(quoteOut, 0, "the curve leg paid no gold, so the hops below prove nothing");
        assertGt(nativeOut, 0, "the two-hop sell produced no MON at all");
        assertEq(ALICE.balance - monBefore, nativeOut, "the seller's MON did not rise by what was returned");
        assertEq(t.balanceOf(ALICE), 0, "the seller was not debited the tokens they sold");
        _assertRouterIsEmpty(t);
    }

    /// @dev An eight-decimal quote, and the reason it gets a test of its own rather than a line in
    ///      the one above: `BondingCurve.sell` documents `ZeroOutput` as REACHABLE with ordinary
    ///      amounts on a coarse quote, because the gross rounds to nothing before the fee is even
    ///      taken. That is a curve-side failure a local suite with an 18-decimal mock cannot
    ///      produce, and a real bitcoin-priced market is where it would first be met.
    ///
    ///      Two hops out — `cbBTC -> USDC -> MON` — because the direct MON/cbBTC pool holds about
    ///      one MON and quoting through it costs -40% at ten.
    function test_aSellOnACbbtcMarketReturnsNativeOnMainnetFork() public {
        if (!_fork()) return;
        _stack();
        (BondingCurve c, DokuToken t) = _launch(CBBTC, "MARS");
        uint256 baseIn = _zap(ALICE, c, _twoHop(USDC, FEE_LOW, SPACING_LOW, CBBTC, FEE_LOW, SPACING_LOW), 0, 0);
        assertGt(baseIn, 0, "the buy leg delivered nothing to sell");

        (uint256 quoteOut,,) = c.quoteSell(baseIn);

        uint256 monBefore = ALICE.balance;
        uint256 nativeOut =
            _sellZap(ALICE, c, _twoHop(USDC, FEE_LOW, SPACING_LOW, address(0), FEE_LOW, SPACING_LOW), baseIn, 0);

        emit log_named_uint("cbBTC market : base sold, wei ", baseIn);
        emit log_named_uint("cbBTC market : cbBTC out, raw ", quoteOut);
        emit log_named_uint("cbBTC market : MON back, wei  ", nativeOut);

        // Named separately from the MON assertion: a satoshi-scale sale that rounds to nothing
        // reverts `ZeroOutput` inside the curve, and that is a different bug from a swap leg that
        // pays nothing. The test would tell you which without this line, but only from a trace.
        assertGt(quoteOut, 0, "the curve leg rounded a real sale to zero cbBTC");
        assertGt(nativeOut, 0, "the cbBTC sell produced no MON at all");
        assertEq(ALICE.balance - monBefore, nativeOut, "the seller's MON did not rise by what was returned");
        assertEq(t.balanceOf(ALICE), 0, "the seller was not debited the tokens they sold");
        _assertRouterIsEmpty(t);
    }

    /// @dev The seller's only real bound, against real pools. `minQuoteOut` bounds the curve and
    ///      `minNativeOut` bounds the route, and it is the second one a seller cares about: the
    ///      quote asset is an intermediate they never hold.
    ///
    ///      The floor is set ONE WEI above what the route was MEASURED to return, so this cannot
    ///      pass by sitting far away from the boundary, and both of the error's arguments are
    ///      asserted — a bare selector is satisfied by a router that reverts with the wrong
    ///      numbers, which is exactly what a wallet would then display to the seller.
    ///
    ///      The boundary case is asserted afterwards, because without it every line above would
    ///      also pass on a router that refused every sell there is.
    function test_aSellRefusesWhenTheRouteMovedAgainstItOnMainnetFork() public {
        if (!_fork()) return;
        _stack();
        (BondingCurve c,) = _launch(USDC, "USDM");
        uint256 baseIn = _zap(ALICE, c, _oneHop(USDC, FEE_LOW, SPACING_LOW), 0, 0);
        PathKey[] memory out = _oneHop(address(0), FEE_LOW, SPACING_LOW);

        // MEASURED against the same state the revert below runs against, then rolled back, so the
        // floor is the route's own answer rather than a magic number that rots on the next change.
        uint256 produced = _measureSell(ALICE, c, out, baseIn);
        assertGt(produced, 0, "nothing was produced, so the floor below would be meaningless");
        emit log_named_uint("USDC market  : route pays, wei", produced);

        IERC20 base = c.token();
        bytes memory expected =
            abi.encodeWithSelector(ZapRouter.InsufficientNativeOut.selector, produced + 1, produced);
        vm.startPrank(ALICE);
        base.approve(address(router), baseIn);
        vm.expectRevert(expected);
        router.zapSellToNative(address(c), out, baseIn, 0, produced + 1, block.timestamp + 1);
        vm.stopPrank();

        assertEq(_sellZap(ALICE, c, out, baseIn, produced), produced, "the exact floor was refused");
    }

    /// @dev THE INVARIANT, against real pools: after any zap in either direction this contract
    ///      holds nothing. A router with a balance is a router the next caller sweeps.
    ///
    ///      DUST IS DONATED FIRST, AND THAT IS WHAT MAKES THIS A TEST. On a clean sell the two
    ///      token sweeps have nothing to move — the curve's quote is entirely consumed by the swap
    ///      and the curve takes every base token offered — so all three balance assertions would
    ///      pass on a router whose token sweeps had been deleted outright. Seeding a few wei of
    ///      each is what forces those two lines to run, and the seller's balances are checked
    ///      afterwards so the dust has to ARRIVE somewhere rather than merely leave.
    ///
    ///      The quote dust is BOUGHT on the chain rather than written into a storage slot: a
    ///      `deal` into cbBTC would be this suite guessing at another team's balance layout, and
    ///      the point of a fork test is not to guess.
    ///
    ///      The MON assertion needs no help. On a sell the native sweep IS the payout, so deleting
    ///      it strands the whole proceeds here.
    function test_theRouterKeepsNothingAfterASellOnMainnetFork() public {
        if (!_fork()) return;
        _stack();
        (BondingCurve c, DokuToken t) = _launch(CBBTC, "MARS");
        uint256 baseOut = _zap(ALICE, c, _twoHop(USDC, FEE_LOW, SPACING_LOW, CBBTC, FEE_LOW, SPACING_LOW), 0, 0);
        assertGt(baseOut, 0, "the buy leg delivered nothing to sell");

        uint256 dust = 7;
        _hopQuote(address(0), USDC, FEE_LOW, SPACING_LOW, 1 ether);
        uint256 held = _hopQuote(USDC, CBBTC, FEE_LOW, SPACING_LOW, IERC20(USDC).balanceOf(address(this)));
        assertGt(held, dust, "no cbBTC to donate, so the quote sweep below is not exercised");
        IERC20(CBBTC).transfer(address(router), dust);
        vm.prank(ALICE);
        t.transfer(address(router), dust);
        assertEq(IERC20(CBBTC).balanceOf(address(router)), dust, "the quote dust did not land");
        assertEq(t.balanceOf(address(router)), dust, "the base dust did not land");

        uint256 baseIn = t.balanceOf(ALICE);
        uint256 monBefore = ALICE.balance;
        uint256 quoteBefore = IERC20(CBBTC).balanceOf(ALICE);
        uint256 nativeOut =
            _sellZap(ALICE, c, _twoHop(USDC, FEE_LOW, SPACING_LOW, address(0), FEE_LOW, SPACING_LOW), baseIn, 0);

        _assertRouterIsEmpty(t);
        assertEq(IERC20(CBBTC).allowance(address(router), address(c)), 0, "a live quote allowance survived the sell");
        assertEq(t.allowance(address(router), address(c)), 0, "a live base allowance survived the sell");

        // And it all went to the seller rather than nowhere.
        assertEq(ALICE.balance - monBefore, nativeOut, "the payout did not reach the seller");
        assertEq(IERC20(CBBTC).balanceOf(ALICE) - quoteBefore, dust, "the donated quote did not reach the seller");
        assertEq(t.balanceOf(ALICE), dust, "the donated base did not reach the seller");
    }

    /// @dev The mirror of `test_theRouteTableIsStillTheRealOneOnMainnetFork`, and the test that
    ///      fails the day liquidity moves — which is the point of having it. Without it a drained
    ///      or re-keyed pool shows up as an unexplained slippage revert three tests later.
    ///
    ///      The `_live` half is deliberately the same four pools the buy table names, because a
    ///      pool has no direction and the sell walks the same ones backwards. The half that is NOT
    ///      a duplicate is below it: a pool can be initialised, hold liquidity, and still pay
    ///      NOTHING in one direction, because all of its liquidity sits on one side of the current
    ///      tick. The buy table cannot see that. So every hop a sell depends on is swapped in the
    ///      SELL direction and asserted to pay — the token acquired first through the forward leg,
    ///      on the chain, so nothing here depends on a guessed balance slot.
    ///
    ///      Each measurement is rolled back and the snapshot retaken, so no leg is measured
    ///      against a price an earlier leg moved.
    function test_theSellRouteTableIsStillTheRealOneOnMainnetFork() public {
        if (!_fork()) return;
        _live(address(0), USDC, FEE_LOW, SPACING_LOW, "MON/USDC 0.05%");
        _live(address(0), USDT0, FEE_MED, SPACING_MED, "MON/USDT0 0.3%");
        _live(USDC, CBBTC, FEE_LOW, SPACING_LOW, "USDC/cbBTC 0.05%");
        _live(USDT0, XAUT0, FEE_LOW, SPACING_LOW, "USDT0/XAUt0 0.05%");

        uint256 snap = vm.snapshotState();

        uint256 back = _reverseToNative(USDC, FEE_LOW, SPACING_LOW);
        emit log_named_uint("USDC  -> MON  pays, wei", back);
        assertGt(back, 0, "USDC -> MON pays nothing: the last hop of every USDC sell is dead");
        vm.revertToState(snap);
        snap = vm.snapshotState();

        back = _reverseToNative(USDT0, FEE_MED, SPACING_MED);
        emit log_named_uint("USDT0 -> MON  pays, wei", back);
        assertGt(back, 0, "USDT0 -> MON pays nothing: the last hop of every gold sell is dead");
        vm.revertToState(snap);
        snap = vm.snapshotState();

        back = _reverseToStable(USDC, FEE_LOW, SPACING_LOW, CBBTC, FEE_LOW, SPACING_LOW);
        emit log_named_uint("cbBTC -> USDC pays, raw", back);
        assertGt(back, 0, "cbBTC -> USDC pays nothing: the first hop of every cbBTC sell is dead");
        vm.revertToState(snap);
        snap = vm.snapshotState();

        back = _reverseToStable(USDT0, FEE_MED, SPACING_MED, XAUT0, FEE_LOW, SPACING_LOW);
        emit log_named_uint("XAUt0 -> USDT0 pays, raw", back);
        assertGt(back, 0, "XAUt0 -> USDT0 pays nothing: the first hop of every gold sell is dead");
        vm.revertToState(snap);
    }

    // ---------------------------------------------------------------- what it costs

    /// @dev WHAT A SELL COSTS, and the evidence a frontend gas cap has to rest on.
    ///
    ///      The reason this exists: on 2026-09-10 two real mainnet zaps went out at 446,442 gas
    ///      (buy) and 4,795,725 (sell). Monad bills the LIMIT rather than the usage, so the second
    ///      one paid 0.489 MON in gas to deliver 0.489 MON of proceeds, and `gasUsed` on the
    ///      receipt reads back as the limit and therefore says nothing about what was consumed.
    ///      The only place the real number can be read is here.
    ///
    ///      MEASURED IN ISOLATION, which is the whole point. `test_whatAZapCostsOnMainnetFork`
    ///      brackets the buy alone and this brackets each leg alone; the whole-lifecycle figure a
    ///      test's own `(gas: ...)` line reports is ~71M for both directions and hides a 10x
    ///      difference inside a rounding error.
    ///
    ///      THE APPROVAL IS OUTSIDE THE BRACKET. A sell is a pulled ERC-20, so the seller approves
    ///      in a separate transaction; folding that in would charge the sell for gas the sell does
    ///      not pay.
    ///
    ///      THE WORLD IS COOLED BETWEEN THE LEGS. A Foundry test body is ONE transaction, so
    ///      everything the buy touched is warm by the time the sell runs, and a warm sell measures
    ///      ~30-60k light. `vm.cool` puts the curve, the token, the singleton and every quote asset
    ///      back to cold, which is the state a standalone sell transaction actually starts from.
    ///      The tx sender and the router are deliberately NOT cooled: EIP-2929 warms `tx.origin`
    ///      and the `to` address at the start of every transaction.
    ///
    ///      Three shapes, because that is the spread the cap's margin is derived from: a one-hop
    ///      sell, a two-hop sell, and an eight-decimal quote.
    function test_whatASellCostsInIsolationOnMainnetFork() public {
        if (!_fork()) return;
        _stack();

        uint256 worst;
        uint256 g = _shapeGas(
            "USDC  1-hop ",
            USDC,
            "USDM",
            _oneHop(USDC, FEE_LOW, SPACING_LOW),
            _oneHop(address(0), FEE_LOW, SPACING_LOW)
        );
        uint256 cheapest = g;
        if (g > worst) worst = g;

        g = _shapeGas(
            "gold  2-hop ",
            XAUT0,
            "GLDZ",
            _twoHop(USDT0, FEE_MED, SPACING_MED, XAUT0, FEE_LOW, SPACING_LOW),
            _twoHop(USDT0, FEE_LOW, SPACING_LOW, address(0), FEE_MED, SPACING_MED)
        );
        if (g > worst) worst = g;
        if (g < cheapest) cheapest = g;

        g = _shapeGas(
            "cbBTC 2-hop ",
            CBBTC,
            "MARS",
            _twoHop(USDC, FEE_LOW, SPACING_LOW, CBBTC, FEE_LOW, SPACING_LOW),
            _twoHop(USDC, FEE_LOW, SPACING_LOW, address(0), FEE_LOW, SPACING_LOW)
        );
        if (g > worst) worst = g;
        if (g < cheapest) cheapest = g;

        emit log_named_uint("sell, dearest shape, exec gas", worst);
        emit log_named_uint("sell, cheapest shape         ", cheapest);
        emit log_named_uint("shape spread, bps            ", ((worst - cheapest) * 10_000) / cheapest);
        emit log_named_uint("dearest + intrinsic          ", worst + TX_INTRINSIC);
        emit log_named_uint("the frontend floor           ", FRONTEND_SELL_GAS_FLOOR);
        emit log_named_uint("the frontend cap             ", FRONTEND_SELL_GAS_CAP);

        // THE FINDING, asserted rather than only printed: the sell is not an order of magnitude
        // dearer than the buy. If this line ever fails the sell genuinely got expensive, and
        // capping the estimator in the frontend would be the wrong fix.
        assertLt(worst, 1_500_000, "a sell got expensive: re-measure before trusting the frontend cap");

        // THE TRIPWIRE between this measurement and `zapSellGasLimit` in
        // `src/typescript/frontend/src/lib/chain/zap.ts`. Both of that function's bounds are
        // derived from the three numbers printed above, so both are checked here — an under-set
        // limit reverts AND is billed on Monad, which is the worst outcome available.
        //
        // The fork is unpinned, so these numbers drift a little between runs as pool state moves.
        // Both assertions are stated with real slack for that reason: they fail when the sell path
        // genuinely got dearer, not when a tick moved.
        assertLe(
            worst + TX_INTRINSIC,
            FRONTEND_SELL_GAS_FLOOR,
            "the dearest measured sell no longer fits the frontend FLOOR: re-derive it in zap.ts"
        );
        // And the floor's own derivation: the dearest shape plus one more hop, which is the
        // three-hop sell `MAX_ZAP_HOPS` allows and nothing here can launch a market for.
        assertLe(
            worst + (worst - cheapest) + TX_INTRINSIC,
            FRONTEND_SELL_GAS_CAP,
            "a three-hop sell no longer fits the frontend CAP: re-derive it in zap.ts"
        );
    }

    // ---------------------------------------------------------------- helpers

    function _fork() internal returns (bool) {
        string memory url = vm.envOr("MONAD_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return false;
        }
        uint256 pinned = vm.envOr("MONAD_FORK_BLOCK", uint256(0));
        if (pinned == 0) vm.createSelectFork(url);
        else vm.createSelectFork(url, pinned);
        return true;
    }

    function _live(address a, address b, uint24 fee, int24 spacing, string memory name) internal view {
        PoolId id = _poolIdOf(a, b, fee, spacing);
        (uint160 sqrtP,,,) = StateLibrary.getSlot0(IPoolManager(POOL_MANAGER), id);
        assertGt(sqrtP, 0, string.concat(name, " is not initialised"));
        assertGt(
            StateLibrary.getLiquidity(IPoolManager(POOL_MANAGER), id), 0, string.concat(name, " holds no liquidity")
        );
    }

    function _stack() internal {
        DeployDoku script = new DeployDoku();
        DeployDoku.Config memory cfg;
        cfg.poolManager = POOL_MANAGER;
        cfg.positionManager = POSITION_MANAGER;
        cfg.permit2 = PERMIT2;
        cfg.owner = tx.origin;
        cfg.pauser = tx.origin;
        cfg.feeRecipient = tx.origin;
        cfg.treasury = tx.origin;
        cfg.quoteTarget = TARGET_MON;
        cfg.quoteAssets = new address[](5);
        cfg.quoteTargets = new uint256[](5);
        cfg.quoteAssets[0] = USDC;
        cfg.quoteTargets[0] = TARGET_USDC;
        cfg.quoteAssets[1] = USDT0;
        cfg.quoteTargets[1] = TARGET_USDT0;
        cfg.quoteAssets[2] = WBTC;
        cfg.quoteTargets[2] = TARGET_WBTC;
        cfg.quoteAssets[3] = CBBTC;
        cfg.quoteTargets[3] = TARGET_CBBTC;
        cfg.quoteAssets[4] = XAUT0;
        cfg.quoteTargets[4] = TARGET_GOLD;
        cfg.launchFeeWei = 0.01 ether;

        DeployDoku.Deployment memory d = script.runWith(cfg);
        factory = DokuFactory(d.dokuFactory);
        graduation = DokuGraduation(payable(d.graduation));
        registry = QuoteRegistry(d.quoteRegistry);

        /* Deployed with NO ceiling, because these tests are about the swap and the buy. The cap has
           its own suite in `ZapCap.t.sol`, where it is exercised without a fork — every one of its
           cases is refused before a pool is touched. */
        router = new ZapRouter(IPoolManager(POOL_MANAGER), factory, address(this), 0);

        vm.deal(ALICE, 100_000 ether);
        vm.deal(BOB, 100_000 ether);
        vm.deal(address(this), 10 ether);
    }

    /// @dev `firstBuyQuote` is deliberately ZERO. A launch that bought would need the creator to
    ///      already hold the exotic quote — cbBTC, WBTC, gold — which on a fork means writing a
    ///      balance slot per token and getting five of them right. With no first buy the only
    ///      asset any of this needs is native MON, which is also exactly what the router promises.
    function _launch(address quote, string memory ticker) internal returns (BondingCurve c, DokuToken t) {
        DokuFactory.LaunchParams memory p;
        p.meta = DokuFactory.Metadata({
            name: string.concat("Zap ", ticker),
            ticker: ticker,
            logoURI: "",
            bannerURI: "",
            description: "",
            website: "",
            x: "",
            telegram: ""
        });
        p.quoteAsset = quote;
        p.sink = Sinks.REWARDS;
        p.routedRecipient = address(0);
        p.creatorTaxBps = 0;
        p.taxRecipient = TAXMAN;
        p.economicsPin = factory.economicsPin(quote, Sinks.REWARDS, 0);
        p.firstBuyQuote = 0;
        p.firstBuyMinOut = 0;
        p.deadline = block.timestamp + 1 hours;

        uint256 fee = factory.launchFee(ALICE);
        vm.prank(ALICE);
        (address cv, address tk) = factory.launch{value: fee}(p);
        c = BondingCurve(payable(cv));
        t = DokuToken(tk);
    }

    function _zap(address who, BondingCurve c, PathKey[] memory path, uint256 value, uint256 minQuoteOut)
        internal
        returns (uint256 baseOut)
    {
        vm.prank(who);
        baseOut = router.zapBuyWithNative{value: value == 0 ? ZAP : value}(
            address(c), path, minQuoteOut, 0, block.timestamp + 1
        );
    }

    function _oneHop(address out, uint24 fee, int24 spacing) internal pure returns (PathKey[] memory p) {
        p = new PathKey[](1);
        p[0] = PathKey({
            intermediateCurrency: Currency.wrap(out),
            fee: fee,
            tickSpacing: spacing,
            hooks: IHooks(address(0)),
            hookData: ""
        });
    }

    function _twoHop(address mid, uint24 f1, int24 s1, address out, uint24 f2, int24 s2)
        internal
        pure
        returns (PathKey[] memory p)
    {
        p = new PathKey[](2);
        p[0] = PathKey({
            intermediateCurrency: Currency.wrap(mid),
            fee: f1,
            tickSpacing: s1,
            hooks: IHooks(address(0)),
            hookData: ""
        });
        p[1] = PathKey({
            intermediateCurrency: Currency.wrap(out),
            fee: f2,
            tickSpacing: s2,
            hooks: IHooks(address(0)),
            hookData: ""
        });
    }

    /// @dev Every asset that could possibly land in the router, checked at once. Balance-based:
    ///      a router that "should" hold nothing and a router that holds nothing are different
    ///      claims, and only one of them is testable.
    function _assertRouterIsEmpty(DokuToken t) internal view {
        assertEq(address(router).balance, 0, "the router kept native MON");
        assertEq(IERC20(USDC).balanceOf(address(router)), 0, "the router kept USDC");
        assertEq(IERC20(USDT0).balanceOf(address(router)), 0, "the router kept USDT0");
        assertEq(IERC20(WBTC).balanceOf(address(router)), 0, "the router kept WBTC");
        assertEq(IERC20(CBBTC).balanceOf(address(router)), 0, "the router kept cbBTC");
        assertEq(IERC20(XAUT0).balanceOf(address(router)), 0, "the router kept gold");
        assertEq(t.balanceOf(address(router)), 0, "the router kept the market token");
    }

    /// @dev One 100-MON swap through a named pool, using v4-core's own test router, purely to
    ///      MEASURE what that pool pays. Rolled back by the caller; nothing here reaches a zap.
    function _poolQuote(address out, uint24 fee, int24 spacing, uint256 amount) internal returns (uint256) {
        PoolSwapTest s = new PoolSwapTest(IPoolManager(POOL_MANAGER));
        vm.deal(address(this), amount);
        PoolKey memory k = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(out),
            fee: fee,
            tickSpacing: spacing,
            hooks: IHooks(address(0))
        });
        uint256 before = IERC20(out).balanceOf(address(this));
        s.swap{value: amount}(
            k,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        return IERC20(out).balanceOf(address(this)) - before;
    }

    function _poolIdOf(address a, address b, uint24 fee, int24 spacing) internal pure returns (PoolId) {
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        return PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: fee,
            tickSpacing: spacing,
            hooks: IHooks(address(0))
        }).toId();
    }

    // ---------------------------------------------------------------- helpers, the sell direction

    /// @dev OWN helpers rather than additions to the ones above, for the reason this file's header
    ///      gives about `Fork.t.sol`: the shared ones sit at the stack limit, and a suite that
    ///      grows by widening someone else's helper is a suite that eventually fails to compile for
    ///      reasons unrelated to what it tests.
    ///
    ///      The seller approves THIS ROUTER, not the curve. Approving the curve instead — the
    ///      spender on the direct path — is an allowance nothing uses, and is the single most
    ///      likely mistake an integrator makes here.
    ///
    ///      `minQuoteOut` is left at zero on purpose: the curve leg's own bound has a local suite,
    ///      and the figure a seller actually receives is `minNativeOut`, which is the one these
    ///      tests exercise.
    function _sellZap(address who, BondingCurve c, PathKey[] memory path, uint256 baseIn, uint256 minNativeOut)
        internal
        returns (uint256 nativeOut)
    {
        IERC20 base = c.token();
        vm.startPrank(who);
        base.approve(address(router), baseIn);
        nativeOut = router.zapSellToNative(address(c), path, baseIn, 0, minNativeOut, block.timestamp + 1);
        vm.stopPrank();
    }

    /// @dev What the route ACTUALLY pays, run against the same state the assertion will run against
    ///      and then rolled back. Every bound in the sell tests is derived from this rather than
    ///      from a constant that would rot on the next curve, pool or fee change.
    function _measureSell(address who, BondingCurve c, PathKey[] memory path, uint256 baseIn)
        internal
        returns (uint256 produced)
    {
        uint256 snap = vm.snapshotState();
        produced = _sellZap(who, c, path, baseIn, 0);
        vm.revertToState(snap);
    }

    /// @dev One swap through one named pool in whichever direction is asked for, using v4-core's
    ///      own test router, purely to MEASURE. Native in is paid as value; an ERC-20 in is
    ///      approved to the test router, which settles by pulling from `data.sender` — this
    ///      contract. Nothing here reaches a zap; the caller rolls it back.
    function _hopQuote(address inTok, address outTok, uint24 fee, int24 spacing, uint256 amountIn)
        internal
        returns (uint256)
    {
        PoolSwapTest s = new PoolSwapTest(IPoolManager(POOL_MANAGER));
        (address c0, address c1) = inTok < outTok ? (inTok, outTok) : (outTok, inTok);
        bool zeroForOne = inTok == c0;

        PoolKey memory k = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: fee,
            tickSpacing: spacing,
            hooks: IHooks(address(0))
        });
        // Field by field. A one-expression struct literal with the nested casts below inside a
        // helper this deep is how a via-IR build discovers it has run out of stack.
        SwapParams memory p;
        p.zeroForOne = zeroForOne;
        p.amountSpecified = -int256(amountIn);
        p.sqrtPriceLimitX96 = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;

        if (inTok == address(0)) vm.deal(address(this), address(this).balance + amountIn);
        else IERC20(inTok).approve(address(s), amountIn);

        uint256 before = _held(outTok);
        if (inTok == address(0)) {
            s.swap{value: amountIn}(k, p, PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}), "");
        } else {
            s.swap(k, p, PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}), "");
        }
        return _held(outTok) - before;
    }

    function _held(address tok) internal view returns (uint256) {
        return tok == address(0) ? address(this).balance : IERC20(tok).balanceOf(address(this));
    }

    /// @dev The LAST hop of a sell: buy the token forward with `ZAP` MON, then sell it straight
    ///      back through the same pool and report what the reverse leg pays.
    function _reverseToNative(address tok, uint24 fee, int24 spacing) internal returns (uint256) {
        uint256 got = _hopQuote(address(0), tok, fee, spacing, ZAP);
        assertGt(got, 0, "the forward leg paid nothing, so the reverse measurement means nothing");
        return _hopQuote(tok, address(0), fee, spacing, got);
    }

    /// @dev The FIRST hop of an exotic sell: MON into the stable, the stable into the exotic, and
    ///      then the exotic back out — which is the leg a `cbBTC` or `XAUt0` sell actually walks.
    function _reverseToStable(address stable, uint24 fs, int24 ss, address exotic, uint24 fe, int24 se)
        internal
        returns (uint256)
    {
        uint256 mid = _hopQuote(address(0), stable, fs, ss, ZAP);
        assertGt(mid, 0, "no stable to convert, so the reverse measurement means nothing");
        uint256 got = _hopQuote(stable, exotic, fe, se, mid);
        assertGt(got, 0, "the forward leg paid nothing, so the reverse measurement means nothing");
        return _hopQuote(exotic, stable, fe, se, got);
    }

    // ---------------------------------------------------------------- helpers, the cost

    /// @dev One market's whole round trip, with each leg bracketed by `gasleft()` on its own.
    ///
    ///      Returns the SELL, because that is the number the frontend cap is derived from; the buy
    ///      is measured and logged beside it only so the two are comparable, and nothing here
    ///      changes the buy path.
    function _shapeGas(
        string memory label,
        address quote,
        string memory ticker,
        PathKey[] memory inPath,
        PathKey[] memory outPath
    ) internal returns (uint256 sellGas) {
        (BondingCurve c, DokuToken t) = _launch(quote, ticker);

        vm.prank(ALICE);
        uint256 g0 = gasleft();
        uint256 baseOut = router.zapBuyWithNative{value: ZAP}(address(c), inPath, 0, 0, block.timestamp + 1);
        uint256 buyGas = g0 - gasleft();
        assertGt(baseOut, 0, string.concat(label, ": the buy delivered nothing to sell"));

        // Read and approve BEFORE the bracket, then cool everything the buy warmed.
        IERC20 base = c.token();
        vm.prank(ALICE);
        base.approve(address(router), baseOut);
        _coolTheWorld(c, t);

        vm.prank(ALICE);
        g0 = gasleft();
        uint256 nativeOut = router.zapSellToNative(address(c), outPath, baseOut, 0, 0, block.timestamp + 1);
        sellGas = g0 - gasleft();
        assertGt(nativeOut, 0, string.concat(label, ": the sell paid nothing, so its gas measures nothing"));

        emit log_named_uint(string.concat(label, "buy  gas"), buyGas);
        emit log_named_uint(string.concat(label, "sell gas"), sellGas);
    }

    /// @dev Everything a standalone sell transaction would touch cold, put back to cold. `vm.cool`
    ///      resets both the account and its storage. The sender and the router are left warm on
    ///      purpose — EIP-2929 pre-warms `tx.origin` and the `to` address.
    function _coolTheWorld(BondingCurve c, DokuToken t) internal {
        vm.cool(address(c));
        vm.cool(address(t));
        vm.cool(address(factory));
        vm.cool(address(graduation));
        vm.cool(address(registry));
        vm.cool(POOL_MANAGER);
        vm.cool(USDC);
        vm.cool(USDT0);
        vm.cool(WBTC);
        vm.cool(CBBTC);
        vm.cool(XAUT0);
        vm.cool(TAXMAN);
    }
}
