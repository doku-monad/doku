// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IStateView} from "@uniswap/v4-periphery/src/interfaces/IStateView.sol";
import {IV4Quoter} from "@uniswap/v4-periphery/src/interfaces/IV4Quoter.sol";
import {Deploy} from "@uniswap/v4-periphery/test/shared/Deploy.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {DokuFactory} from "../../src/DokuFactory.sol";
import {DokuGraduation} from "../../src/DokuGraduation.sol";
import {Sinks} from "../../src/lib/Sinks.sol";
import {DeployDoku} from "../DeployDoku.s.sol";
import {NetworkConfig} from "../config/NetworkConfig.sol";
// A quote asset the local node has none of. Anvil has no USDC, and a scenario that only ever
// launches in native MON leaves the whole ERC-20 quote path — `buyWithToken`, the pulled first
// buy, the six-decimal targets — unexercised by the indexer's end-to-end tests.
import {MockUSDC} from "../../test/mocks/MockUSDC.sol";

// Compiled only so `Deploy`'s `vm.getCode` can find them — it resolves against build OUTPUT, so a
// contract nothing imports is never compiled and the lookup fails with "no matching artifact".
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {StateView} from "@uniswap/v4-periphery/src/lens/StateView.sol";
import {V4Quoter} from "@uniswap/v4-periphery/src/lens/V4Quoter.sol";

/**
 * The whole protocol on a local node, driven through one market's entire life.
 *
 * @dev This exists for the indexer's end-to-end tests. It is deliberately *not* a deployment path:
 *      it stands up Uniswap v4 itself, which on any real chain is already there and is not ours to
 *      deploy. What it gives the indexer is the one thing a hand-written log fixture cannot — logs
 *      emitted by the real contracts, in the real order, with the real ABI encoding. A fixture that
 *      drifts from the contracts is worse than no fixture, because it keeps passing.
 *
 *      Three phases, and they are separate because the middle one is the script that ships:
 *
 *        1. The v4 singletons anvil has none of. On Monad mainnet these exist and this phase is
 *           skipped entirely; here they are deployed so there is a PoolManager to graduate into.
 *        2. `DeployDoku`, called rather than reimplemented. A scenario that deployed the protocol
 *           its own way would prove the indexer works against a topology nothing ships.
 *        3. One market: launch, a taxed buy, a sell, and the buy that fills the curve — which
 *           graduates it in the same transaction under D3, with no separate call.
 *
 *      Each call lands in its own block under anvil's auto-mining, which is what makes the
 *      range-scanning and reorg tests meaningful.
 */
contract LocalScenario is Script {
    /// @dev Canonical, and planted by the harness with `anvil_setCode` from the precompiled
    ///      bytecode in `lib/v4-periphery/lib/permit2`. Permit2 needs `via_ir` to compile from
    ///      source, which this project cannot turn on — it would move the hook's creation code and
    ///      void its mined salt. The address itself lives in `NetworkConfig`, which is the only
    ///      copy of it in this directory.
    address constant PERMIT2 = NetworkConfig.PERMIT2;

    /// @dev Both are stubs the harness plants. PositionManager stores them immutably and requires
    ///      code at each, but graduation touches neither: the descriptor only serves `tokenURI`,
    ///      and the wrapper only serves the WRAP/UNWRAP actions, which a native-MON pool never uses.
    address constant DESCRIPTOR = 0x00000000000000000000000000000000000de5C1;
    address constant STUB_WETH = 0x00000000000000000000000000000000000De5C2;

    uint256 constant TARGET = 1_000e18;
    /// @dev Six decimals, and divisible by five — a target that is not truncates the curve's
    ///      virtual quote floor and bricks every market launched against it.
    uint256 constant USDC_TARGET = 10_000e6;
    int24 constant TICK_SPACING = 60;

    struct Deployed {
        address poolManager;
        address positionManager;
        address swapRouter;
        address stateView;
        address quoter;
        address dokuFactory;
        address graduation;
        address hook;
        address quoteRegistry;
        address creatorSink;
        address usdc;
        address curve;
        address token;
        bytes32 poolId;
        address curveUsdc;
        address tokenUsdc;
        address curveHolders;
        address tokenHolders;
    }

    function run() external {
        Deployed memory dep;

        /**
         * Phase 1, unless the chain already has v4.
         *
         * On a FORK of Monad mainnet every singleton is already there — PoolManager,
         * PositionManager, Permit2, V4Quoter, and crucially UniversalRouter, which this repository
         * does not vendor and cannot deploy. Passing them in is what lets the frontend's swap path
         * be integration-tested against the router wallets actually use, rather than against a
         * test double that shares none of its encoding.
         *
         * Unset, everything is deployed locally and the run is offline — which is the gate, and
         * what CI uses.
         */
        vm.startBroadcast();
        /**
         * Opt IN explicitly, rather than inferring from `V4_POOL_MANAGER` being set.
         *
         * forge auto-loads `contracts/.env`, and that file legitimately carries the mainnet v4
         * addresses for deployments — so keying off their presence made every local run try to
         * integrate with a PoolManager that has no code on anvil, and the whole anvil-backed suite
         * failed with "V4_POOL_MANAGER has no code". The address being present says nothing about
         * whether this run is forking.
         */
        bool useExisting = vm.envOr("DOKU_USE_EXISTING_V4", false);
        address existing = useExisting ? vm.envAddress("V4_POOL_MANAGER") : address(0);
        PoolManager pm;
        if (existing == address(0)) {
            pm = new PoolManager(msg.sender);
            dep.poolManager = address(pm);
            dep.positionManager =
                address(Deploy.positionManager(address(pm), PERMIT2, 100_000, DESCRIPTOR, STUB_WETH, hex"03"));
            dep.usdc = address(new MockUSDC());
        } else {
            dep.poolManager = existing;
            dep.positionManager = vm.envAddress("V4_POSITION_MANAGER");
            pm = PoolManager(payable(existing));
            // On a fork the real one, if the caller named it. Optional: a MON-only registry is a
            // legitimate scenario and the second market is opt-in anyway.
            dep.usdc = vm.envOr("USDC", address(0));
        }
        dep.swapRouter = address(new PoolSwapTest(IPoolManager(dep.poolManager)));
        // v4 exposes pool state through `extsload` rather than getters, so reading a pool's price
        // from outside Solidity means computing a storage slot by hand. StateView is the canonical
        // lens that does it — it is deployed on Monad mainnet too, so a test that reads through it
        // reads the way a client would.
        dep.stateView = address(Deploy.stateView(dep.poolManager, hex"04"));
        // The quoter the FRONTEND uses. Not a `view` function — it performs the swap and reverts
        // with the result — so the app must simulate it, and a local one is what lets that path be
        // integration-tested rather than only reasoned about.
        dep.quoter = existing == address(0)
            ? address(Deploy.v4Quoter(dep.poolManager, hex"05"))
            : vm.envOr("V4_QUOTER", address(Deploy.v4Quoter(dep.poolManager, hex"05")));
        vm.stopBroadcast();

        // Phase 2. `runWith` opens its own broadcast, so this must be outside one.
        _deployProtocol(dep);

        // Phase 3.
        vm.startBroadcast();
        _launch(dep);
        if (vm.envOr("DOKU_SCENARIO_USDC", false)) _launchExtraMarkets(dep);
        // The reorg test drives its own trades so it can roll the chain back between them, and
        // needs a launched-but-empty curve to start from.
        if (!vm.envOr("DOKU_LAUNCH_ONLY", false)) _trade(dep);
        vm.stopBroadcast();

        console.log("DOKU_POOL_MANAGER", dep.poolManager);
        console.log("DOKU_POSITION_MANAGER", dep.positionManager);
        console.log("DOKU_SWAP_ROUTER", dep.swapRouter);
        console.log("DOKU_STATE_VIEW", dep.stateView);
        console.log("DOKU_V4_QUOTER", dep.quoter);
        console.log("DOKU_FACTORY", dep.dokuFactory);
        console.log("DOKU_GRADUATION", dep.graduation);
        console.log("DOKU_HOOK", dep.hook);
        console.log("DOKU_QUOTE_REGISTRY", dep.quoteRegistry);
        console.log("DOKU_CREATOR_SINK", dep.creatorSink);
        console.log("DOKU_USDC", dep.usdc);
        console.log("DOKU_CURVE", dep.curve);
        console.log("DOKU_TOKEN", dep.token);
        console.log("DOKU_POOL_ID", vm.toString(dep.poolId));
        if (dep.curveUsdc != address(0)) {
            console.log("DOKU_CURVE_USDC", dep.curveUsdc);
            console.log("DOKU_TOKEN_USDC", dep.tokenUsdc);
            console.log("DOKU_CURVE_HOLDERS", dep.curveHolders);
            console.log("DOKU_TOKEN_HOLDERS", dep.tokenHolders);
        }
    }

    /// @dev Split out to keep `run` under the stack limit; `via_ir` is off and must stay off.
    function _deployProtocol(Deployed memory dep) internal {
        DeployDoku.Config memory cfg;
        cfg.poolManager = dep.poolManager;
        cfg.positionManager = dep.positionManager;
        cfg.permit2 = PERMIT2;
        // One key for every role. A testnet convenience and not a design — see the note on roles in
        // `DeployDoku.s.sol` — but here it also means the scenario can drive the protocol without
        // an ownership handover in the middle of it.
        cfg.owner = msg.sender;
        cfg.pauser = msg.sender;
        cfg.feeRecipient = msg.sender;
        cfg.treasury = msg.sender;
        cfg.quoteTarget = TARGET;
        // The second quote, registered BY THE SCRIPT — the scenario never touches the registry, so
        // what the indexer reads is the topology a real deployment produces.
        if (dep.usdc != address(0)) {
            cfg.quoteAssets = new address[](1);
            cfg.quoteAssets[0] = dep.usdc;
            cfg.quoteTargets = new uint256[](1);
            cfg.quoteTargets[0] = USDC_TARGET;
        }
        cfg.launchFeeWei = 0;

        // The sink's `setGraduator`/`setFactory` happen inside `runWith`, so the scenario inherits
        // them and `_check` has already asserted them.
        DeployDoku.Deployment memory d = new DeployDoku().runWith(cfg);
        dep.dokuFactory = d.dokuFactory;
        dep.graduation = d.graduation;
        dep.hook = d.hook;
        dep.quoteRegistry = d.quoteRegistry;
        dep.creatorSink = d.creatorSink;
    }

    function _launch(Deployed memory dep) internal {
        DokuFactory factory = DokuFactory(dep.dokuFactory);
        DokuFactory.LaunchParams memory p;
        p.meta.name = "Hash";
        p.meta.ticker = "HASH";
        p.sink = Sinks.BURN;
        p.economicsPin = factory.economicsPin(address(0), Sinks.BURN, 0);
        // An untaxed first buy in the launch transaction itself, because that is the shape the
        // frontend sends and the indexer has to read a launch and a trade out of one receipt.
        p.firstBuyQuote = 1e18;
        p.deadline = block.timestamp + 1 hours;
        (dep.curve, dep.token) = factory.launch{value: 1e18}(p);
        dep.poolId = PoolId.unwrap(
            PoolIdLibrary.toId(
                PoolKey({
                    currency0: Currency.wrap(address(0)),
                    currency1: Currency.wrap(dep.token),
                    fee: 0,
                    tickSpacing: TICK_SPACING,
                    hooks: IHooks(dep.hook)
                })
            )
        );
    }

    /**
     * One market of each routing, which the native BURN market above cannot stand in for.
     *
     * The backend's ingest asserts `pending` against the chain for all three sinks — BURN reports
     * zero, HOLDERS escrows until graduation, CREATOR accrues to the shared sink — so a scenario
     * with one routing leaves two of those three unexercised. Opt-in, because it needs a quote
     * asset the fork case may not have been given.
     */
    function _launchExtraMarkets(Deployed memory dep) internal {
        DokuFactory factory = DokuFactory(dep.dokuFactory);
        MockUSDC(dep.usdc).mint(msg.sender, 100_000e6);

        // CREATOR, in USDC, with a 5% creator tax — the routing whose money lands in the shared
        // `CreatorSink` rather than in a sink deployed per market.
        DokuFactory.LaunchParams memory p;
        p.meta.name = "Dollar";
        p.meta.ticker = "DOLR";
        p.quoteAsset = dep.usdc;
        p.sink = Sinks.CREATOR;
        p.creatorTaxBps = 500;
        p.economicsPin = factory.economicsPin(dep.usdc, Sinks.CREATOR, 500);
        p.deadline = block.timestamp + 1 hours;
        (dep.curveUsdc, dep.tokenUsdc) = factory.launch(p);

        // HOLDERS, in native MON, whose share escrows until graduation deploys its vault.
        DokuFactory.LaunchParams memory h;
        h.meta.name = "Holders";
        h.meta.ticker = "HOLD";
        h.sink = Sinks.REWARDS;
        h.economicsPin = factory.economicsPin(address(0), Sinks.REWARDS, 0);
        h.deadline = block.timestamp + 1 hours;
        (dep.curveHolders, dep.tokenHolders) = factory.launch(h);
    }

    function _trade(Deployed memory dep) internal {
        BondingCurve curve = BondingCurve(payable(dep.curve));
        uint256 deadline = block.timestamp + 1 hours;

        // A buy inside the tax window, so the indexer sees a non-zero `tax` on a swap row.
        curve.buy{value: 10e18}(0, deadline);

        // A sell, so the ingest test covers both directions rather than only the happy one.
        uint256 half = curve.token().balanceOf(msg.sender) / 2;
        curve.token().approve(dep.curve, half);
        curve.sell(half, 0, deadline);

        // The buy that fills it. Overshoot is refunded by the curve, so overpaying is safe — and
        // under D3 this call also graduates the market, with no `graduate()` afterwards. A scenario
        // that still called one would be testing a path the protocol no longer takes.
        curve.buy{value: 5_000e18}(0, deadline);
        require(curve.readyToGraduate(), "curve did not fill");
        require(DokuGraduation(payable(dep.graduation)).graduated(dep.curve), "the filling buy did not graduate");
    }
}
