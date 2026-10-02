// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {PosmTestSetup} from "@uniswap/v4-periphery/test/shared/PosmTestSetup.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {DeployDoku} from "../script/DeployDoku.s.sol";
import {DokuFactory} from "../src/DokuFactory.sol";
import {DokuGraduation} from "../src/DokuGraduation.sol";
import {DokuHook} from "../src/v4/DokuHook.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {Sinks} from "../src/lib/Sinks.sol";
import {QuoteRegistry} from "../src/QuoteRegistry.sol";
import {CreatorSink} from "../src/sinks/CreatorSink.sol";
import {Launches} from "./helpers/Launches.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

// Compiled only so `vm.getCode` can find them; see GraduationV4.t.sol.
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {PositionDescriptor} from "@uniswap/v4-periphery/src/PositionDescriptor.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/**
 * The deployment, exercised rather than described.
 *
 * Every assertion here is a wiring mistake that would otherwise be discovered by the first curve to
 * fill, in public. The one at the bottom — launch a market and let it graduate itself — is the only
 * one whose answer a launch actually depends on; the rest check individual wires.
 *
 * There is no DEX to stand up any more. This used to deploy a whole Uniswap V3 stack first, take
 * ownership of its factory, and assert that handover. DOKU graduates into canonical v4 now, so the
 * setup is the canonical singletons and the deployment is DOKU's four contracts.
 */
contract DeployDokuTest is PosmTestSetup {
    using Launches for DokuFactory;

    address internal constant OWNER = address(0x0BEE);
    address internal constant PAUSER = address(0xBA5E);
    address internal constant FEE_RECIPIENT = address(0xFEE);
    address internal constant TREASURY = address(0x7EA);
    uint256 internal constant TARGET = 1_000e18;
    uint256 internal constant USDC_TARGET = 10_000e6;
    address internal constant BUYER = address(0xB0B);

    DeployDoku internal script;
    DeployDoku.Deployment internal d;
    MockUSDC internal usdc;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployPosm(manager);

        script = new DeployDoku();
        d = script.runWith(_config());
        vm.deal(BUYER, 100_000e18);
    }

    /// @dev A second quote asset, because the multi-quote registry is the thing that has to be
    ///      opened BY THE SCRIPT. Every launch set beyond native travels as two parallel lists, so
    ///      one entry exercises the same code path mainnet's six do.
    function _config() internal returns (DeployDoku.Config memory cfg) {
        if (address(usdc) == address(0)) usdc = new MockUSDC();
        cfg.poolManager = address(manager);
        cfg.positionManager = address(lpm);
        cfg.permit2 = address(permit2);
        cfg.owner = OWNER;
        cfg.pauser = PAUSER;
        cfg.feeRecipient = FEE_RECIPIENT;
        cfg.treasury = TREASURY;
        cfg.quoteTarget = TARGET;
        cfg.quoteAssets = new address[](1);
        cfg.quoteAssets[0] = address(usdc);
        cfg.quoteTargets = new uint256[](1);
        cfg.quoteTargets[0] = USDC_TARGET;
        cfg.launchFeeWei = 0.01 ether;
    }

    // ------------------------------------------------------------------------------ the wires

    function test_wiresTheGraduatorToTheGraduationContract() public view {
        assertEq(DokuFactory(d.dokuFactory).graduator(), d.graduation, "graduator not wired");
    }

    /// @dev Without this every pool a graduation tries to create reverts `NotGraduator` — and
    ///      `PoolInitializer_v4` catches that and returns a sentinel rather than bubbling, so the
    ///      symptom is a graduation that mints into a pool which does not exist.
    function test_allowsTheGraduatorOnTheHook() public view {
        assertTrue(DokuHook(payable(d.hook)).isGraduator(d.graduation), "graduator not allowed on the hook");
    }

    /// @dev v4 packs the permission set into the low fourteen bits of the address, so a hook that
    ///      deployed at all is a hook whose permissions match — but asserting it here catches a
    ///      mining routine that drifted from the contract rather than one that failed outright.
    function test_theHookLandedAtAnAddressEncodingItsPermissions() public view {
        assertEq(uint160(d.hook) & 0x3FFF, 0x2FCF, "hook address does not encode its permissions");
        assertGt(d.hook.code.length, 0, "hook has no code");
    }

    function test_theGraduatorPointsAtTheDeployedHook() public view {
        assertEq(address(DokuGraduation(payable(d.graduation)).hook()), d.hook, "graduator has the wrong hook");
    }

    function test_keepsTheThreeRolesDistinct() public view {
        DokuFactory factory = DokuFactory(d.dokuFactory);
        assertEq(factory.pauser(), PAUSER, "pauser did not take");
        assertEq(factory.feeRecipient(), FEE_RECIPIENT, "fee recipient did not take");
        assertEq(factory.pendingOwner(), OWNER, "owner is not pending");
    }

    /// @dev Two-step ownership on purpose: a mistyped owner is recoverable rather than permanent.
    ///      The cost is that the deployment is NOT finished when the script exits, and a protocol
    ///      whose hot deploy key still controls it is worth being loud about.
    function test_offersOwnershipRatherThanCompletingIt() public view {
        DokuFactory factory = DokuFactory(d.dokuFactory);
        assertEq(factory.pendingOwner(), OWNER, "ownership was not offered");
        assertTrue(factory.owner() != OWNER, "ownership completed without acceptance");
    }

    /// @dev Both contracts, because both are offered. A handover that completes on the factory and
    ///      leaves the hook with the deploy key is a protocol whose levy rates and graduator set are
    ///      still controlled by a hot key nobody is watching.
    function test_theDeployerRetainsNothingAfterAcceptance() public {
        DokuFactory factory = DokuFactory(d.dokuFactory);
        DokuHook hook = DokuHook(payable(d.hook));
        assertEq(hook.pendingOwner(), OWNER, "the hook's ownership was never offered");

        vm.startPrank(OWNER);
        factory.acceptOwnership();
        hook.acceptOwnership();
        vm.stopPrank();

        assertEq(factory.owner(), OWNER, "factory owner did not take");
        assertEq(factory.pendingOwner(), address(0), "a pending owner survived acceptance");
        assertEq(hook.owner(), OWNER, "hook owner did not take");
        assertEq(hook.pendingOwner(), address(0), "a pending hook owner survived acceptance");
    }

    /// @dev The registry the SCRIPT opened, not one a test topped up afterwards. A launch set that
    ///      has to be registered by hand after the deployment is a protocol that ships MON-only and
    ///      finds out at the first USDC launch.
    function test_registersMonAndUsdcInTheQuoteRegistry() public view {
        QuoteRegistry r = QuoteRegistry(d.quoteRegistry);
        assertTrue(r.isEnabled(address(0)), "native MON is not a registered quote");
        assertEq(r.quoteTarget(address(0)), TARGET);
        assertEq(r.decimalsOf(address(0)), 18);
        assertTrue(r.isEnabled(address(usdc)), "USDC is not a registered quote");
        assertEq(r.quoteTarget(address(usdc)), USDC_TARGET);
        assertEq(r.decimalsOf(address(usdc)), 6);
        assertEq(
            address(DokuFactory(d.dokuFactory).registry()), d.quoteRegistry, "the factory reads a different registry"
        );
    }

    /// @dev The sink's wires, and the hook's. `creatorSink` is an IMMUTABLE on the hook, folded
    ///      into its mined address — so a mismatch here is not a missing setter call but a hook
    ///      mined against one sink and deployed with another, which makes every creator tax on the
    ///      chain unreachable. Without the factory wire every deferred payment reverts `NotMarket`;
    ///      without the graduator wire no CREATOR market can be registered.
    function test_wiresTheCreatorSinkIntoTheHookAndTheFactory() public view {
        assertEq(DokuHook(payable(d.hook)).creatorSink(), d.creatorSink, "the hook does not know the CreatorSink");
        assertEq(DokuFactory(d.dokuFactory).creatorSink(), d.creatorSink, "the factory does not know the CreatorSink");
        CreatorSink sink = CreatorSink(payable(d.creatorSink));
        assertEq(sink.graduator(), d.graduation, "CreatorSink.setGraduator was not called");
        assertEq(sink.factory(), d.dokuFactory, "CreatorSink.setFactory was not called");
        assertEq(sink.hook(), d.hook, "CreatorSink did not learn the hook");
        assertTrue(d.creatorSink.code.length > 0 && d.quoteRegistry.code.length > 0 && d.seedLocker.code.length > 0);
    }

    /// @dev The indexer scans from here. Scanning from genesis on a live chain is a backfill that
    ///      never reaches the present.
    function test_reportsTheBlockToIndexFrom() public view {
        assertGt(d.startBlock, 0, "no start block reported");
        assertLe(d.startBlock, block.number, "start block is in the future");
    }

    // ------------------------------------------------------------------------- the whole thing

    /// @dev Every assertion above checks one wire. This checks that the wires together carry
    ///      current, which is a different question — and the only one a launch depends on.
    ///
    ///      Note there is nothing to call after the buy: under D3 the trade that fills the curve
    ///      graduates it, so a market that reaches its target and has no pool is a failure this
    ///      test would catch by the absence rather than by a revert.
    function test_aMarketLaunchedHereGraduatesItself() public {
        DokuFactory factory = DokuFactory(d.dokuFactory);

        vm.prank(BUYER);
        (address curveAddr,) =
            factory.launch{value: factory.launchFee(BUYER)}(factory.params(address(0), Sinks.BURN, 0));
        BondingCurve curve = BondingCurve(payable(curveAddr));
        vm.warp(block.timestamp + curve.TAX_WINDOW() + 1);

        // Overshoot is refunded, so buying past the target is the safe way to fill it.
        vm.prank(BUYER);
        curve.buy{value: 5 * TARGET}(0, block.timestamp + 1 hours);

        assertTrue(curve.readyToGraduate(), "curve did not fill");
        assertTrue(
            DokuGraduation(payable(d.graduation)).graduated(curveAddr),
            "the filling buy did not graduate the market"
        );
        assertTrue(
            DokuGraduation(payable(d.graduation)).sinkOf(curveAddr) != address(0),
            "no sink was deployed for the market"
        );
    }

    /// @dev And the same for a market in the quote the script had to register itself. Native works
    ///      whatever the registry holds; a USDC market is the one that proves step 7 ran.
    function test_aUsdcMarketLaunchedHereGraduatesItself() public {
        DokuFactory factory = DokuFactory(d.dokuFactory);
        usdc.mint(BUYER, 100_000e6);

        vm.prank(BUYER);
        (address curveAddr,) =
            factory.launch{value: factory.launchFee(BUYER)}(factory.params(address(usdc), Sinks.REWARDS, 0));
        BondingCurve curve = BondingCurve(payable(curveAddr));
        vm.warp(block.timestamp + curve.TAX_WINDOW() + 1);

        vm.startPrank(BUYER);
        usdc.approve(curveAddr, 50_000e6);
        curve.buyWithToken(50_000e6, 0, block.timestamp + 1 hours);
        vm.stopPrank();

        assertTrue(DokuGraduation(payable(d.graduation)).graduated(curveAddr), "the USDC market did not graduate");
    }

    // ------------------------------------------------------------------------- refused configs

    /// @dev Zero and the two values above it, because the interesting boundary is not zero. A
    ///      target of 1 or 2 truncates the curve's virtual quote reserve to zero and bricks every
    ///      market launched under it, and only zero used to be refused.
    function test_refusesAQuoteTargetBelowTheMinimum() public {
        for (uint256 target; target < 3; ++target) {
            DeployDoku.Config memory cfg = _config();
            cfg.quoteTarget = target;
            vm.expectRevert("DOKU_QUOTE_TARGET is below the minimum a working curve needs");
            script.runWith(cfg);
        }
    }

    /// @dev The rule that bricks a FILLED market rather than an empty one: the curve's virtual
    ///      quote floor is `target * 2 / 5`, so a target five does not divide truncates the seed
    ///      under what graduation demands. `QuoteRegistry.register` refuses it too — but from
    ///      inside the broadcast, with the whole stack already on chain.
    function test_refusesAQuoteTargetNotDivisibleByFive() public {
        DeployDoku.Config memory cfg = _config();
        cfg.quoteTarget = TARGET + 1;
        vm.expectRevert("DOKU_QUOTE_TARGET is not divisible by five: the curve's quote floor truncates");
        script.runWith(cfg);

        cfg = _config();
        cfg.quoteTargets[0] = 2_424_242;
        vm.expectRevert("a DOKU_QUOTE_TARGETS entry is not divisible by five: the curve's quote floor truncates");
        script.runWith(cfg);
    }

    /// @dev Two lists that have to line up, and nothing downstream would notice if they did not:
    ///      a short target list is an out-of-bounds panic halfway through the broadcast.
    function test_refusesAMismatchedQuoteSet() public {
        DeployDoku.Config memory cfg = _config();
        cfg.quoteTargets = new uint256[](0);
        vm.expectRevert("DOKU_QUOTE_ASSETS and DOKU_QUOTE_TARGETS are different lengths");
        script.runWith(cfg);

        cfg = _config();
        cfg.quoteAssets[0] = address(0xDEAD);
        vm.expectRevert("a DOKU_QUOTE_ASSETS entry has no code");
        script.runWith(cfg);
    }

    /// @dev An address with no code is the shape of a mistyped or wrong-network constant, and it is
    ///      worth refusing loudly here rather than at the first graduation.
    function test_refusesADependencyWithNoCode() public {
        DeployDoku.Config memory cfg = _config();
        cfg.poolManager = address(0xDEAD);
        vm.expectRevert("V4_POOL_MANAGER has no code");
        script.runWith(cfg);

        cfg = _config();
        cfg.permit2 = address(0xDEAD);
        vm.expectRevert("PERMIT2 has no code");
        script.runWith(cfg);
    }
}
