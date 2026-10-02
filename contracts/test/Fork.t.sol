// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {DokuToken} from "../src/DokuToken.sol";
import {DokuFactory} from "../src/DokuFactory.sol";
import {DokuGraduation} from "../src/DokuGraduation.sol";
import {DokuHook} from "../src/v4/DokuHook.sol";
import {QuoteRegistry} from "../src/QuoteRegistry.sol";
import {CreatorSink} from "../src/sinks/CreatorSink.sol";
import {RewardVault} from "../src/sinks/RewardVault.sol";
import {BurnSink} from "../src/sinks/BurnSink.sol";
import {Sinks} from "../src/lib/Sinks.sol";
import {DeployDoku} from "../script/DeployDoku.s.sol";

/// @notice Proves the fork target is really Monad, that the v4 this design graduates into is
///         actually deployed there, and that a market launched by the SHIPPED deployment script
///         completes its whole money path against the real singletons.
///
/// @dev Skips rather than fails when the RPC is unset, so the suite stays runnable offline. A wrong
///      chain id or a missing singleton is a hard failure — those are the cases worth catching.
///      `MONAD_FORK_BLOCK` pins a block for a local reproduction against an archive RPC only; CI
///      forks `latest`, because the public RPC keeps roughly 33–66 hours of state (08-§6) and a
///      pinned block therefore rots out of reach within days.
///
///      There used to be a WMON address here, because graduation wrapped MON to seed a V3 pool.
///      Nothing wraps anything now: v4 holds native MON as `Currency.wrap(address(0))`, which is
///      one of the incidental things the migration deleted rather than fixed.
contract ForkTest is Test {
    uint256 constant MONAD_MAINNET = 143;
    uint256 constant MONAD_TESTNET = 10143;

    /// @dev Canonical Uniswap v4 on Monad mainnet. Not this repo's deployment — the protocol's.
    address constant POOL_MANAGER = 0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e;
    address constant POSITION_MANAGER = 0x5b7eC4a94fF9beDb700fb82aB09d5846972F4016;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function test_forkIsMonadMainnet() public {
        if (!_fork("MONAD_RPC_URL")) return;
        assertEq(block.chainid, MONAD_MAINNET, "RPC is not Monad mainnet");
    }

    /// @dev The premise of the whole design, checked rather than assumed. Every one of these is a
    ///      contract this repo does NOT deploy and cannot substitute for, and a chain missing any of
    ///      them is a chain where graduation reverts.
    function test_theV4StackIsDeployedOnMainnet() public {
        if (!_fork("MONAD_RPC_URL")) return;
        assertGt(POOL_MANAGER.code.length, 0, "no PoolManager: nothing can graduate here");
        assertGt(POSITION_MANAGER.code.length, 0, "no PositionManager: the seed cannot be minted");
        assertGt(PERMIT2.code.length, 0, "no Permit2: POSM cannot be funded");
        // Foundry routes salted creates through this proxy, and the hook's mined salt is only valid
        // against it. A chain without it is a chain where the hook lands at an unmineable address.
        assertGt(CREATE2_DEPLOYER.code.length, 0, "no CREATE2 proxy: the hook salt does not apply");
    }

    /// @dev The finding that forced the testnet cohort to be abandoned, asserted rather than
    ///      remembered. v4 is not on 10143 — Uniswap's own SDK carries no PoolManager key for it —
    ///      so there is no testnet a DOKU market can graduate on. If this ever starts failing,
    ///      Uniswap deployed v4 to testnet and the deployment story should be revisited.
    function test_v4IsStillAbsentFromTestnet() public {
        if (!_fork("MONAD_TESTNET_RPC_URL")) return;
        assertEq(block.chainid, MONAD_TESTNET, "RPC is not Monad testnet");
        assertEq(POOL_MANAGER.code.length, 0, "v4 reached Monad testnet; see docs/doku/08");
    }

    function _fork(string memory key) internal returns (bool) {
        string memory url = vm.envOr(key, string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return false;
        }
        uint256 pinned = vm.envOr("MONAD_FORK_BLOCK", uint256(0));
        if (pinned == 0) vm.createSelectFork(url);
        else vm.createSelectFork(url, pinned);
        return true;
    }

    // ------------------------------------------------------------------- the gen-2 lifecycle

    /// @dev Circle's USDC on Monad. `FiatTokenV2_2` keeps balances in `balanceAndBlacklistStates`
    ///      at slot 9 with the blacklist flag in the top bit, which is why `deal()` cannot find it
    ///      and the slot is written by hand and then READ BACK.
    address constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    uint256 constant USDC_BALANCE_SLOT = 9;

    /// @dev XAUt0, Tether Gold bridged to Monad. SIX decimals and one whole token is one troy
    ///      ounce, so a raw unit is worth ~3,300x a raw unit of USDC — the coarsest quote on the
    ///      chain, and the only one on which a sell can round to nothing (R20) and the seed's dust
    ///      bound can fall below a single sell (R21). It is an EIP-1967 proxy whose balances live in
    ///      slot 51 of the PROXY; `deal()` cannot find that either, so it is written and read back.
    address constant XAUT0 = 0x01bFF41798a0BcF287b996046Ca68b395DbC1071;
    uint256 constant XAUT0_BALANCE_SLOT = 51;

    uint256 constant TARGET_MON = 1e18;
    /// @dev The figure `QuoteRegistry` ships for USDC, not a token-sized round number. It matters:
    ///      graduation's `_sqrtPriceX96` computes `amount1 * 2^192 / amount0` in 256 bits, which
    ///      overflowed (before B10a) once the seed's token/quote ratio reached 2^64 — i.e. whenever
    ///      the launch token sorts ABOVE the quote and the quote seed is under ~12,046,690 raw
    ///      units. A $10 USDC market is under that line; a real one is nowhere near it. Gold is not
    ///      so lucky — see `TARGET_GOLD`.
    uint256 constant TARGET_USDC = 8_000e6;
    /// @dev ~$8,000 of gold at 2026 prices, and DIVISIBLE BY FIVE (B9a): a target that is not makes
    ///      the curve's virtual quote floor (`0.4 * target`) truncate, which puts the seed below
    ///      what graduation demands and bricks any market that fills. 2_424_242 is not; this is.
    ///
    ///      A gold market cannot escape the `_sqrtPriceX96` overflow described on `TARGET_USDC` by
    ///      being sized sensibly: clearing it needs a quote seed above ~12,046,690 raw units, and on
    ///      a token where one raw unit is a millionth of a troy ounce that is ~12.05 oz, ~$40,000.
    ///      XAUt0's own address (0x01bF…) is low enough that almost every launch token sorts above
    ///      it, so before B10a both gold graduation tests below were red and every gold market this
    ///      protocol opened would have filled and then been stuck. Only this leg found it.
    uint256 constant TARGET_GOLD = 2_424_240;

    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);
    address constant TAXMAN = address(0x7A11);

    DokuFactory internal factory;
    DokuHook internal hook;
    DokuGraduation internal graduation;
    CreatorSink internal creatorSink;
    QuoteRegistry internal registry;
    PoolSwapTest internal swapper;

    receive() external payable {}

    function test_monLifecycleOnMainnetFork() public {
        if (!_fork("MONAD_RPC_URL")) return;
        _stack();
        _lifecycle(address(0));
    }

    function test_usdcLifecycleOnMainnetFork() public {
        if (!_fork("MONAD_RPC_URL")) return;
        _stack();
        _lifecycle(USDC);
    }

    /// @dev The leg a green MON-and-USDC run does not stand in for. Everything else about it is the
    ///      same lifecycle; what differs is that one raw unit of the quote is worth ~$0.0033 rather
    ///      than $0.000001, so every rounding step in the curve, the seed and the levy is ~3,300x
    ///      coarser and the two defects this project found by measurement become reachable.
    function test_goldLifecycleOnMainnetFork() public {
        if (!_fork("MONAD_RPC_URL")) return;
        _stack();
        _lifecycle(XAUT0);
    }

    /// @dev R20 against the real token. On a gold market a sell of an ordinary-looking number of
    ///      tokens pays out ZERO raw units, and `minQuoteOut = 0` — what every "sell all" button
    ///      sends — accepts it, so the seller burns tokens for nothing. The curve must refuse.
    function test_goldSellThatRoundsToZeroRevertsOnMainnetFork() public {
        if (!_fork("MONAD_RPC_URL")) return;
        _stack();
        (BondingCurve c, DokuToken t) = _launch(XAUT0, Sinks.REWARDS, 0, "GLDZ");

        (uint256 dustOut,,) = c.quoteSell(GOLD_SELL_ROUNDS_TO_ZERO);
        assertEq(dustOut, 0, "the quote no longer rounds to zero: re-measure GOLD_SELL_ROUNDS_TO_ZERO");
        (uint256 dustOut2,,) = c.quoteSell(GOLD_SELL_ALSO_ROUNDS_TO_ZERO);
        assertEq(dustOut2, 0, "re-measure GOLD_SELL_ALSO_ROUNDS_TO_ZERO");

        vm.startPrank(ALICE);
        t.approve(address(c), type(uint256).max);
        vm.expectRevert(BondingCurve.ZeroOutput.selector);
        c.sell(GOLD_SELL_ROUNDS_TO_ZERO, 0, block.timestamp + 1);
        vm.expectRevert(BondingCurve.ZeroOutput.selector);
        c.sell(GOLD_SELL_ALSO_ROUNDS_TO_ZERO, 0, block.timestamp + 1);

        // And the next size up is paid, in the real token, to the real seller.
        (uint256 paidOut,,) = c.quoteSell(GOLD_SELL_PAYS);
        assertGt(paidOut, 0, "the larger sell also rounds to zero: re-measure GOLD_SELL_PAYS");
        uint256 before = IERC20(XAUT0).balanceOf(ALICE);
        c.sell(GOLD_SELL_PAYS, 0, block.timestamp + 1);
        vm.stopPrank();
        assertEq(IERC20(XAUT0).balanceOf(ALICE) - before, paidOut, "the seller was not paid the quoted gold");
    }

    /// @dev R21 against the real token. Every sell leaves rounding residue in the curve's base
    ///      reserve, and graduation refuses a seed outside its dust bound. A FIXED bound sized for
    ///      an 18-decimal market leaves a gold market less than one sell of headroom — so a market
    ///      that traded at all would fill and then be permanently un-graduatable, with the raise
    ///      inside it. Ten alternating trades, then a fill, and the pool has to exist.
    function test_goldGraduatesAfterAlternatingTradesOnMainnetFork() public {
        if (!_fork("MONAD_RPC_URL")) return;
        _stack();
        (BondingCurve c, DokuToken t) = _launch(XAUT0, Sinks.REWARDS, 0, "GLDD");
        vm.warp(block.timestamp + c.TAX_WINDOW() + 1);

        vm.prank(BOB);
        t.approve(address(c), type(uint256).max);
        for (uint256 i; i < 5; ++i) {
            _buy(c, BOB, TARGET_GOLD / 5);
            // Read the balance BEFORE the prank. `vm.prank` arms the next external call, and an
            // argument that is itself a call consumes it — the sell would then come from this
            // contract, which holds neither the tokens nor the allowance.
            uint256 quarter = t.balanceOf(BOB) / 4;
            vm.prank(BOB);
            c.sell(quarter, 0, block.timestamp + 1);
        }
        assertFalse(c.readyToGraduate(), "the alternating trades filled the curve on their own");

        uint256 tokenId = _fill(c);
        assertGt(tokenId, 0, "no seed position");
    }

    /// @dev The SHIPPED deployment script against the REAL singletons, not a hand-wired stack. The
    ///      deployer is `tx.origin` inside the script, so the config names it for every role and no
    ///      two-step handover is left pending.
    ///
    ///      Nothing is wired from here. The sink is deployed BEFORE the hook and folded into its
    ///      mined address (`_check` asserts `hook.creatorSink()`), and the quote set — USDC and
    ///      XAUt0 here, six assets on mainnet — is registered by the script from `cfg.quoteAssets`.
    ///      Both used to be done from this test, which meant the fork suite proved the topology it
    ///      built rather than the one that ships.
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
        cfg.quoteAssets = new address[](2);
        cfg.quoteAssets[0] = USDC;
        cfg.quoteAssets[1] = XAUT0;
        cfg.quoteTargets = new uint256[](2);
        cfg.quoteTargets[0] = TARGET_USDC;
        cfg.quoteTargets[1] = TARGET_GOLD;
        cfg.launchFeeWei = 0.01 ether;

        DeployDoku.Deployment memory d = script.runWith(cfg);
        factory = DokuFactory(d.dokuFactory);
        hook = DokuHook(payable(d.hook));
        graduation = DokuGraduation(payable(d.graduation));
        creatorSink = CreatorSink(payable(d.creatorSink));
        registry = QuoteRegistry(d.quoteRegistry);

        assertEq(registry.decimalsOf(USDC), 6, "USDC is not six decimals on this chain");
        assertEq(registry.decimalsOf(XAUT0), 6, "XAUt0 is not six decimals on this chain");

        swapper = new PoolSwapTest(IPoolManager(POOL_MANAGER));

        vm.deal(ALICE, 1_000 ether);
        vm.deal(BOB, 1_000 ether);
        vm.deal(address(this), 1_000 ether);
        _dealToken(USDC, USDC_BALANCE_SLOT, 1_000_000e6);
        _dealToken(XAUT0, XAUT0_BALANCE_SLOT, 1_000_000e6);
        IERC20(USDC).approve(address(swapper), type(uint256).max);
        IERC20(XAUT0).approve(address(swapper), type(uint256).max);
    }

    /// @dev `deal()` cannot find either token's balance — USDC packs a blacklist flag into the top
    ///      bit of the same word, XAUt0 keeps its mapping behind a proxy at a slot no heuristic
    ///      guesses — so the slot is written directly and READ BACK. A silent miss here would make
    ///      every assertion below trivially true against a zero balance.
    function _dealToken(address token, uint256 slot, uint256 amount) internal {
        address[3] memory who = [ALICE, BOB, address(this)];
        for (uint256 i; i < who.length; ++i) {
            vm.store(token, keccak256(abi.encode(who[i], slot)), bytes32(amount));
            assertEq(IERC20(token).balanceOf(who[i]), amount, "token moved its balance slot: re-measure it");
        }
    }

    function _targetOf(address quote) internal pure returns (uint256) {
        if (quote == address(0)) return TARGET_MON;
        return quote == USDC ? TARGET_USDC : TARGET_GOLD;
    }

    function _bal(address quote, address who) internal view returns (uint256) {
        return quote == address(0) ? who.balance : IERC20(quote).balanceOf(who);
    }

    function _keyFor(address quote, address token) internal view returns (PoolKey memory) {
        (address c0, address c1) = quote < token ? (quote, token) : (token, quote);
        return PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
    }

    function _launch(address quote, uint8 sink, uint16 tax, string memory ticker)
        internal
        returns (BondingCurve c, DokuToken t)
    {
        DokuFactory.LaunchParams memory p;
        p.meta = DokuFactory.Metadata({
            name: "Fork Market",
            ticker: ticker,
            logoURI: "",
            bannerURI: "",
            description: "",
            website: "",
            x: "",
            telegram: ""
        });
        p.quoteAsset = quote;
        p.sink = sink;
        p.routedRecipient = address(0); // defaults to the creator on CREATOR, must be zero otherwise
        p.creatorTaxBps = tax;
        p.taxRecipient = TAXMAN;
        p.economicsPin = factory.economicsPin(quote, sink, tax);
        p.firstBuyQuote = _targetOf(quote) / 10;
        p.firstBuyMinOut = 0;
        p.deadline = block.timestamp + 1 hours;
        uint256 fee = factory.launchFee(ALICE);
        vm.startPrank(ALICE);
        address cv;
        address tk;
        if (quote == address(0)) {
            (cv, tk) = factory.launch{value: fee + p.firstBuyQuote}(p);
        } else {
            IERC20(quote).approve(address(factory), p.firstBuyQuote);
            (cv, tk) = factory.launch{value: fee}(p);
        }
        vm.stopPrank();
        c = BondingCurve(payable(cv));
        t = DokuToken(tk);
    }

    function _buy(BondingCurve c, address who, uint256 q) internal {
        address quote = c.quoteAsset();
        vm.startPrank(who);
        if (quote == address(0)) {
            c.buy{value: q}(0, block.timestamp + 1);
        } else {
            IERC20(quote).approve(address(c), q);
            c.buyWithToken(q, 0, block.timestamp + 1);
        }
        vm.stopPrank();
    }

    /// @dev Fills the curve with one overshooting buy — refunded by the curve — and returns the seed
    ///      position's tokenId, read from POSM's counter before the graduation mints it.
    function _fill(BondingCurve c) internal returns (uint256 tokenId) {
        vm.warp(block.timestamp + c.TAX_WINDOW() + 1);
        tokenId = IPositionManager(POSITION_MANAGER).nextTokenId();
        _buy(c, BOB, 5 * _targetOf(c.quoteAsset()));
        assertTrue(c.readyToGraduate(), "the curve did not fill");
        if (!graduation.graduated(address(c))) {
            // Auto-graduation swallows EVERY failure by design (D3), so the filling buyer is never
            // made to pay for a broken graduator. Retried in the open here purely so the fork
            // reports WHY, rather than "did not graduate" — this line does not make the test pass:
            // if the retry succeeds the assertion below still fails.
            graduation.graduate(address(c));
        }
        assertTrue(graduation.graduated(address(c)), "the filling buy did not graduate on the real v4");
        assertGt(
            StateLibrary.getLiquidity(IPoolManager(POOL_MANAGER), graduation.poolIdOf(address(c))),
            0,
            "no liquidity in the real pool"
        );
    }

    function _poolBuy(PoolKey memory k, address quote, uint256 amount) internal {
        bool zeroForOne = Currency.unwrap(k.currency0) == quote;
        swapper.swap{value: quote == address(0) ? amount : 0}(
            k,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @dev One quote, three routings, every money path a user can take — on the singletons the
    ///      protocol will actually run against. Split into three internal calls because the whole
    ///      sequence exceeds the stack limit, and `via_ir` — which would fix that — moves the hook's
    ///      mined address and must stay off (see foundry.toml).
    ///
    ///      Sizes are fractions of the market's own QUOTE TARGET rather than of a whole token. The
    ///      three quotes differ by twelve orders of magnitude per raw unit and by ~3,300x per
    ///      dollar, and the target is the only figure already normalised to a USD size — so "half a
    ///      token" is a $1,650 swap on gold and a $0.0000005 swap on MON, while "half a target" is
    ///      the same trade on all three.
    function _lifecycle(address quote) internal {
        _creatorLeg(quote);
        _holdersLeg(quote);
        _burnLeg(quote);
    }

    /// @dev CREATOR market, 5% tax: launch with a first buy → taxed buy inside the anti-sniper
    ///      window → sell → fill → auto-graduate → a pool swap that pays the tax → pull → claim.
    function _creatorLeg(address quote) internal {
        uint256 target = _targetOf(quote);
        (BondingCurve c, DokuToken t) = _launch(quote, Sinks.CREATOR, 500, "CRE");
        assertGt(t.balanceOf(ALICE), 0, "the first buy did not deliver");
        assertGt(c.taxRate(), 0, "the anti-sniper window is not open right after launch");
        {
            (,, uint256 sniper, uint256 ctax,) = c.quoteBuy(target / 10);
            assertGt(sniper, 0, "a buy inside the window is not anti-sniper taxed");
            assertGt(ctax, 0, "a buy is not creator taxed");
        }
        _buy(c, BOB, target / 10);
        assertGt(t.balanceOf(BOB), 0, "the taxed buy inside the window delivered nothing");
        {
            uint256 half = t.balanceOf(BOB) / 2;
            uint256 sellBefore = _bal(quote, BOB);
            vm.startPrank(BOB);
            t.approve(address(c), half);
            c.sell(half, 0, block.timestamp + 1);
            vm.stopPrank();
            assertGt(_bal(quote, BOB) - sellBefore, 0, "the sell paid the seller nothing");
        }
        // Per gross G: protocol = G·30/1e4, creatorTax = G·bps/1e4, routed = G/100 − protocol —
        // asserted only as "held", the exact split is FeeSplit.t.sol's (PART A).
        assertGt(c.pendingTax(), 0, "the curve holds no creator tax after a taxed buy and sell");

        uint256 tokenId = _fill(c);
        PoolId id = graduation.poolIdOf(address(c));
        assertEq(graduation.sinkOf(address(c)), address(creatorSink), "a CREATOR market did not use the shared sink");

        uint256 swapIn = target / 2;
        uint256 tax0 = hook.owedTax(id);
        _poolBuy(_keyFor(quote, address(t)), quote, swapIn);
        assertGe(hook.owedTax(id) - tax0, (swapIn * 500) / 10_000 - 1, "creator tax on the real PoolManager");
        graduation.locker().collect(tokenId); // the seed position's quote fees → hook ledger → routed

        creatorSink.pull(address(c));
        _claim(quote, TAXMAN, "the tax recipient was not paid");
        _claim(quote, ALICE, "the routed recipient was not paid the seed position's fees");
    }

    /// @dev Balance-based on purpose: `claim` succeeding proves nothing, the delta does.
    function _claim(address quote, address who, string memory why) internal {
        uint256 before = _bal(quote, who);
        vm.prank(who);
        creatorSink.claim(quote);
        assertGt(_bal(quote, who) - before, 0, why);
    }

    /// @dev HOLDERS market: fill → pool swap → collect → fund → epoch → dividend claim in the quote.
    function _holdersLeg(address quote) internal {
        uint256 target = _targetOf(quote);
        (BondingCurve h, DokuToken ht) = _launch(quote, Sinks.REWARDS, 0, "HOL");
        uint256 hTokenId = _fill(h);
        PoolId hid = graduation.poolIdOf(address(h));
        // 70 bps of the swap reaches the market's sink ledger, against a `minEpochAmount` of
        // `quoteTarget / 10_000`: a swap of one whole target leaves ~70x the floor on every one of
        // the three quotes. If `LP_LEVY_BPS` or `minEpochAmount` ever moves, this is the line that
        // turns into a mystery fork failure — raise the swap size rather than lowering the floor.
        //
        // ROUND 4 CHANGED THE ROUTE, NOT THE AMOUNT. The 70 bps used to be donated to the pool,
        // earned by the seed position, and forwarded by `collect` into `owedSink`. It is now booked
        // straight to `pendingSink` by `_settleLeg`, so it is the `sweep` two lines down rather than
        // the `collect` that materialises it. The `collect` stays because it is permissionless and
        // must remain a clean no-op on a pool that pays its positions nothing, and because a
        // stranger's `PoolManager.donate` can still put fees on the seed at any time.
        _poolBuy(_keyFor(quote, address(ht)), quote, target);
        graduation.locker().collect(hTokenId);
        hook.sweep(hid);
        RewardVault v = RewardVault(payable(graduation.sinkOf(address(h))));
        assertEq(v.quote(), quote, "the vault pays a currency this market never raised");
        v.fund();
        assertGe(v.unallocated(), v.minEpochAmount(), "the vault cannot open an epoch");
        // An epoch now OPENS at its own closing grid line, not its opening one.
        //
        // The M-01 rewrite made `pending[k]` the money that accrued inside interval k, so epoch k
        // cannot be opened until interval k is over — otherwise a fee arriving later in the same
        // interval would be locked out of the epoch it belongs to. `_openEpoch` and `claim` now
        // gate on the SAME line, `snapshotBlockFor(k + 1)`, which is why there is one roll here
        // where there used to be two: by the time the epoch exists it is already mature.
        vm.roll(v.snapshotBlockFor(1) + 1);
        uint256 epoch = v.createEpoch();
        uint256 divBefore = _bal(quote, BOB);
        vm.prank(BOB);
        uint256 paid = v.claim(BOB, epoch, epoch);
        assertGt(paid, 0, "the holder was paid nothing");
        assertEq(_bal(quote, BOB) - divBefore, paid, "the dividend did not arrive in the quote");
    }

    /// @dev BUYBACK market: fill → pool swap → collect → burn.
    function _burnLeg(address quote) internal {
        uint256 target = _targetOf(quote);
        (BondingCurve b, DokuToken bt) = _launch(quote, Sinks.BURN, 0, "BUY");
        uint256 bTokenId = _fill(b);
        _poolBuy(_keyFor(quote, address(bt)), quote, target / 2);
        graduation.locker().collect(bTokenId);
        BurnSink s = BurnSink(graduation.sinkOf(address(b)));
        uint256 supply = bt.totalSupply();
        uint256 burned = s.burn();
        assertGt(burned, 0, "nothing was burned");
        assertEq(bt.totalSupply(), supply - burned, "supply did not fall by the burn");
        assertEq(_bal(quote, address(s)), 0, "a BURN sink was handed the quote");
    }

    /// @dev Measured on this exact curve state — a gold market immediately after the factory's
    ///      first buy of `TARGET_GOLD / 10`. See `test_goldSellThatRoundsToZeroRevertsOnMainnetFork`;
    ///      both are asserted against `quoteSell` before they are used, so a curve change surfaces
    ///      as "re-measure", never as a silently weakened test.
    uint256 constant GOLD_SELL_ROUNDS_TO_ZERO = 100e18;
    /// @dev The plan expected 400 whole tokens to be paid. MEASURED against the real token it is
    ///      not: the boundary on this state sits between 750 and 1,000 whole tokens, so 400 is
    ///      still a sell that pays nothing. Both are asserted to revert, and the first size that
    ///      actually pays — one raw unit, a third of a US cent — is asserted to arrive.
    uint256 constant GOLD_SELL_ALSO_ROUNDS_TO_ZERO = 400e18;
    uint256 constant GOLD_SELL_PAYS = 1_000e18;
}
