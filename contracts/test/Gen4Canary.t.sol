// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {PosmTestSetup} from "@uniswap/v4-periphery/test/shared/PosmTestSetup.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {DokuFactory} from "../src/DokuFactory.sol";
import {DokuGraduation} from "../src/DokuGraduation.sol";
import {DokuHook} from "../src/v4/DokuHook.sol";
import {QuoteRegistry} from "../src/QuoteRegistry.sol";
import {CreatorSink} from "../src/sinks/CreatorSink.sol";
import {Sinks} from "../src/lib/Sinks.sol";

// Imported ONLY so forge compiles their artifacts: v4-periphery's test `Deploy` library builds
// these through `vm.getCode`, which resolves against the build OUTPUT, so a contract nothing in this
// repo imports is never compiled and the lookup fails at setUp.
// solhint-disable-next-line no-unused-import
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {PositionDescriptor} from "@uniswap/v4-periphery/src/PositionDescriptor.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/// @notice The canary: the whole protocol, wired the way `activate` demands, taken from an empty
///         chain to a graduated Uniswap v4 pool.
///
/// @dev `Gen4Activation.t.sol` proves each gate refuses what it should. That is only half the
///      claim. A gate that also refuses the legitimate deployment is not a fix, it is an outage —
///      and the failure mode this whole change is about (a market that launches and then cannot
///      graduate) is exactly the one a unit test with a stubbed graduator cannot see.
///
///      So this stands up the real thing: a real `CreatorSink` with its two one-shots consumed in
///      the order the deploy script uses them, a real `DokuHook` at a mined address, a real
///      `DokuGraduation` holding a real PoolManager, PositionManager and Permit2, and a real
///      `DokuFactory` that begins paused with no graduator. Only then does it launch, fill, and
///      require a pool to exist.
///
///      The market is a CREATOR market deliberately. That is the sink kind whose graduation calls
///      `CreatorSink.register` — the one-shot wire that, mis-set, freezes every taxed market this
///      protocol would ever launch and can never be repaired.
contract Gen4CanaryTest is PosmTestSetup {
    /// @dev The hook's permission set, encoded in the low 14 bits of its address.
    uint160 internal constant FLAGS = 0x2FCF;

    address internal constant OWNER = address(0xA0);
    address internal constant PAUSER = address(0xA1);
    address internal constant TREASURY = address(0xA2);
    address internal constant CREATOR = address(0xC0);
    address internal constant BUYER = address(0xB0B);
    uint256 internal constant TARGET = 1_000e18;
    uint256 internal constant LAUNCH_FEE = 10 ether; // the live mainnet fee

    QuoteRegistry internal registry;
    CreatorSink internal creatorSink;
    DokuHook internal dokuHook;
    DokuFactory internal factory;
    DokuGraduation internal graduation;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployPosm(manager);

        // 1 and 2. The sink first: its address is folded into the hook's mined one, so nothing that
        //          comes after can move without moving the hook.
        registry = new QuoteRegistry(OWNER);
        creatorSink = new CreatorSink(OWNER);

        // 3. The hook, at an address whose low bits ARE its permission set.
        bytes memory args = abi.encode(IPoolManager(address(manager)), OWNER, TREASURY, address(creatorSink));
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        dokuHook = new DokuHook{salt: salt}(IPoolManager(address(manager)), OWNER, TREASURY, address(creatorSink));

        // 4. The factory BEFORE the graduation contract, because graduation takes the factory as an
        //    immutable. This is the ordering that used to force a placeholder graduator into the
        //    factory's storage; it no longer needs one, and the factory is simply paused until the
        //    rest of the graph exists.
        factory = new DokuFactory(OWNER, PAUSER, TREASURY, address(registry), address(creatorSink), LAUNCH_FEE);
        assertTrue(factory.paused(), "the factory did not ship paused");
        assertEq(factory.graduator(), address(0), "the factory shipped with a placeholder graduator");

        graduation =
            new DokuGraduation(address(manager), address(lpm), address(permit2), address(dokuHook), address(factory));

        // 5 and 6. Every wire, in the deploy script's order.
        vm.startPrank(OWNER);
        dokuHook.setGraduator(address(graduation), true);
        factory.setGraduator(address(graduation));
        creatorSink.setGraduator(address(graduation));
        creatorSink.setFactory(address(factory));
        registry.register(address(0), TARGET);
        vm.stopPrank();

        vm.deal(CREATOR, 1_000_000e18);
        vm.deal(BUYER, 1_000_000e18);
    }

    /// @dev Before activation the protocol launches nothing, however complete its wiring happens to
    ///      be. The gate is a statement that somebody READ the graph, not a guess about it.
    function test_theFullyWiredStackStillRefusesToLaunchBeforeActivate() public {
        DokuFactory.LaunchParams memory p = _params();
        vm.prank(CREATOR);
        vm.expectRevert();
        factory.launch{value: LAUNCH_FEE}(p);
    }

    /// @dev And the real graph passes the real check.
    function test_activateAcceptsTheRealDeployment() public {
        DokuFactory.Dependencies memory d = _deps();
        vm.prank(OWNER);
        factory.activate(d);

        assertTrue(factory.activated(), "the real deployment failed its own activation check");
        assertFalse(factory.paused(), "activation did not open the factory");
        assertEq(factory.dependencyHash(), keccak256(abi.encode(d)), "the published hash is not the graph");
        factory.validateDeployment();
    }

    /// @dev THE CANARY. Launch, fill, and require a Uniswap v4 pool at the other end. The filling
    ///      buy is what graduates the market, and `_tryAutoGraduate` swallows failures — so the
    ///      assertion is on the POOL existing, never on the buy reverting, which would pass
    ///      vacuously against a graduator that did nothing at all.
    function test_canaryLaunchFillsAndGraduatesAfterActivate() public {
        vm.prank(OWNER);
        factory.activate(_deps());

        DokuFactory.LaunchParams memory p = _params();
        vm.prank(CREATOR);
        (address curveAddr, address token) = factory.launch{value: LAUNCH_FEE}(p);
        BondingCurve c = BondingCurve(payable(curveAddr));
        assertEq(c.graduator(), address(graduation), "the market pinned something other than the signed-off graduator");

        // Past the anti-sniper window. `via_ir` folds `block.timestamp` across `vm.warp`, so the
        // clock is read through the cheatcode rather than the global.
        vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);
        vm.prank(BUYER);
        c.buy{value: 3 * TARGET}(0, vm.getBlockTimestamp() + 1 hours);

        assertTrue(c.readyToGraduate(), "the curve did not fill");
        assertTrue(c.released(), "the curve filled and the raise stayed inside it");
        assertTrue(graduation.graduated(curveAddr), "graduation never recorded this market");
        assertTrue(PoolId.unwrap(graduation.poolIdOf(curveAddr)) != bytes32(0), "no pool was created");
        assertEq(graduation.sinkOf(curveAddr), address(creatorSink), "a CREATOR market's sink is not the shared sink");

        // The one-shot wire H-02 is really about: the shared sink accepted the registration, which
        // it only does from the graduator its own `setGraduator` consumed.
        (,,,, bool registered) = creatorSink.entries(curveAddr);
        assertTrue(registered, "the shared sink never registered the market");
        assertGt(token.code.length, 0, "no token");
    }

    function _deps() private view returns (DokuFactory.Dependencies memory) {
        return DokuFactory.Dependencies({
            graduator: address(graduation),
            hook: address(dokuHook),
            creatorSink: address(creatorSink),
            poolManager: address(manager),
            positionManager: address(lpm),
            permit2: address(permit2)
        });
    }

    function _params() private view returns (DokuFactory.LaunchParams memory p) {
        p.meta.name = "Canary";
        p.meta.ticker = "CNRY";
        p.quoteAsset = address(0);
        p.sink = Sinks.CREATOR;
        p.routedRecipient = CREATOR;
        p.economicsPin = factory.economicsPin(address(0), Sinks.CREATOR, 0);
        p.deadline = vm.getBlockTimestamp() + 1 hours;
    }
}
