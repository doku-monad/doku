// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Pausable} from "openzeppelin/utils/Pausable.sol";
import {Ownable} from "openzeppelin/access/Ownable.sol";
import {DokuFactory} from "../src/DokuFactory.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {QuoteRegistry} from "../src/QuoteRegistry.sol";
import {CreatorSink} from "../src/sinks/CreatorSink.sol";
import {Sinks} from "../src/lib/Sinks.sol";
import {Launches} from "./helpers/Launches.sol";
import {Wiring, StubGraduator} from "./helpers/Wiring.sol";

/// @dev A graduator wired to a DIFFERENT factory. What `setGraduator` has always refused.
contract ForeignGraduator {
    address public factory;

    constructor(address f) {
        factory = f;
    }
}

/// @notice The two findings of the 2026-09-11 external review, as tests.
///
/// @dev H-01 said an EOA in the graduator slot can take a filled market's whole raise, and that the
///      factory put one there by default and exempted it from the only check. H-02 said a market can
///      launch into a dependency graph nobody verified, fill, and then be unable to graduate for
///      good. Both were true of the source; neither was true of the deployment, because the deploy
///      script happened to do the right things in the right order. This file is about removing the
///      word "happened".
///
///      The shape of every test here is the same: state the thing that must be impossible, then
///      show the contract refusing it. `Wiring` supplies a conforming dependency graph so a test
///      about ONE broken wire is not also a test about standing up Uniswap v4.
contract Gen4ActivationTest is Test {
    using Launches for DokuFactory;

    DokuFactory internal factory;
    QuoteRegistry internal registry;
    CreatorSink internal sink;
    StubGraduator internal grad;

    address internal constant OWNER = address(0xA0);
    address internal constant PAUSER = address(0xA1);
    address internal constant TREASURY = address(0xA2);
    address internal constant CREATOR = address(0xC0);
    uint256 internal constant TARGET = 1_000e18;

    function setUp() public {
        registry = new QuoteRegistry(OWNER);
        vm.prank(OWNER);
        registry.register(address(0), TARGET);
        sink = new CreatorSink(OWNER);
        factory = new DokuFactory(OWNER, PAUSER, TREASURY, address(registry), address(sink), 0);
        grad = new StubGraduator(address(factory));
        vm.deal(CREATOR, 1_000e18);
    }

    // ------------------------------------------------------- 1. an EOA can never be the graduator

    /// @dev THE H-01 REGRESSION. The old check read
    ///      `if (graduator_ != owner() && IDokuGraduator(graduator_).factory() != address(this))`,
    ///      so the owner's own address — an EOA on mainnet — walked straight past it. `release()`
    ///      pays `msg.sender` the entire raise and the entire seed and asks nothing else, so that
    ///      slot is custody of every market the factory makes.
    function test_setGraduatorRefusesTheOwnersOwnAddress() public {
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(DokuFactory.GraduatorHasNoCode.selector, OWNER));
        factory.setGraduator(OWNER);
    }

    function test_setGraduatorRefusesAnyEoa() public {
        address eoa = address(0xBEEF);
        assertEq(eoa.code.length, 0, "the fixture is not an EOA");
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(DokuFactory.GraduatorHasNoCode.selector, eoa));
        factory.setGraduator(eoa);
    }

    /// @dev The old exemption's real cost was not that an EOA could be set deliberately — it is that
    ///      one was set BY DEFAULT and no call anywhere had to be made for it to be so.
    function test_theFactoryIsBornWithNoGraduatorAndPaused() public view {
        assertEq(factory.graduator(), address(0), "a placeholder graduator is still a graduator");
        assertTrue(factory.paused(), "an un-activated factory must not be launchable");
        assertFalse(factory.activated(), "activated before anything was verified");
        assertEq(factory.dependencyHash(), bytes32(0), "a dependency hash with no dependencies");
    }

    /// @dev Still refused, still for the same reason.
    function test_setGraduatorStillRefusesAForeignFactory() public {
        ForeignGraduator foreign = new ForeignGraduator(address(0xF00));
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(DokuFactory.GraduatorNotWiredHere.selector, address(foreign)));
        factory.setGraduator(address(foreign));
    }

    function test_setGraduatorIsStillOwnerOnly() public {
        vm.prank(CREATOR);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, CREATOR));
        factory.setGraduator(address(grad));
    }

    // ------------------------------------------------------------- 2. launch reverts before activate

    /// @dev THE H-02 REGRESSION. A market that launches into an unverified graph pins that graph's
    ///      custody terms into an immutable slot; the cost of getting it wrong is the whole raise of
    ///      every market launched in the meantime, and it is not recoverable.
    function test_launchRevertsBeforeActivation() public {
        vm.prank(OWNER);
        factory.setGraduator(address(grad));

        // Hoisted: `native()` reads the pin off the factory, and a `vm.prank` applies to the very
        // next call — which would be that read, not the launch.
        DokuFactory.LaunchParams memory p = factory.native(Sinks.BURN);
        vm.prank(CREATOR);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        factory.launch(p);
    }

    /// @dev And unpausing is not activation. The two are separate on purpose: the pauser may shut
    ///      the door, but only a completed identity check may open it.
    function test_unpauseAloneDoesNotMakeTheFactoryLaunchable() public {
        vm.prank(OWNER);
        factory.setGraduator(address(grad));
        vm.prank(OWNER);
        factory.unpause();
        assertFalse(factory.paused(), "the fixture did not unpause");

        DokuFactory.LaunchParams memory p = factory.native(Sinks.BURN);
        vm.prank(CREATOR);
        vm.expectRevert(DokuFactory.NotActivated.selector);
        factory.launch(p);
    }

    function test_activateOpensTheFactoryAndPublishesTheGraph() public {
        vm.prank(OWNER);
        factory.setGraduator(address(grad));
        DokuFactory.Dependencies memory d = Wiring.activate(factory, OWNER, address(grad));

        assertTrue(factory.activated(), "activate did not activate");
        assertFalse(factory.paused(), "activate did not unpause");
        assertEq(factory.dependencyHash(), keccak256(abi.encode(d)), "the published hash is not the graph");
        factory.validateDeployment();
        assertTrue(factory.isDeploymentValid(), "the graph it just verified does not verify");
    }

    /// @dev Each of the three unrecoverable wires, broken one at a time. Every one of these is a
    ///      deployment that launches markets cleanly and can graduate none of them.
    function test_activateRefusesAHookThatDoesNotAllowlistTheGraduator() public {
        vm.prank(OWNER);
        factory.setGraduator(address(grad));
        DokuFactory.Dependencies memory d = Wiring.declare(factory, address(grad));
        vm.mockCall(d.hook, abi.encodeWithSignature("isGraduator(address)"), abi.encode(false));

        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(DokuFactory.DependencyMismatch.selector, 6, address(grad), address(0)));
        factory.activate(d);
    }

    function test_activateRefusesASinkWiredToAnotherGraduator() public {
        vm.prank(OWNER);
        factory.setGraduator(address(grad));
        DokuFactory.Dependencies memory d = Wiring.declare(factory, address(grad));
        address other = address(0xDEAD);
        vm.mockCall(d.creatorSink, abi.encodeWithSignature("graduator()"), abi.encode(other));

        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(DokuFactory.DependencyMismatch.selector, 6, address(grad), other));
        factory.activate(d);
    }

    function test_activateRefusesASinkWiredToAnotherFactory() public {
        vm.prank(OWNER);
        factory.setGraduator(address(grad));
        DokuFactory.Dependencies memory d = Wiring.declare(factory, address(grad));
        address other = address(0xF00);
        vm.mockCall(d.creatorSink, abi.encodeWithSignature("factory()"), abi.encode(other));

        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(DokuFactory.DependencyMismatch.selector, 2, address(factory), other)
        );
        factory.activate(d);
    }

    function test_activateRefusesACounterfeitPoolManager() public {
        vm.prank(OWNER);
        factory.setGraduator(address(grad));
        DokuFactory.Dependencies memory d = Wiring.declare(factory, address(grad));
        address fake = address(0xBAD1);
        vm.etch(fake, hex"fe");
        address declaredReal = d.poolManager;
        d.poolManager = fake; // the owner declares the canonical one; the graduator holds another

        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(DokuFactory.DependencyMismatch.selector, 3, fake, declaredReal));
        factory.activate(d);
    }

    function test_activateRefusesAnEoaAnywhereInTheGraph() public {
        vm.prank(OWNER);
        factory.setGraduator(address(grad));
        DokuFactory.Dependencies memory d = Wiring.declare(factory, address(grad));
        d.permit2 = address(0xE0A);

        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(DokuFactory.DependencyNotAContract.selector, 5, address(0xE0A)));
        factory.activate(d);
    }

    function test_activateIsOwnerOnly() public {
        vm.prank(OWNER);
        factory.setGraduator(address(grad));
        DokuFactory.Dependencies memory d = Wiring.declare(factory, address(grad));
        vm.prank(CREATOR);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, CREATOR));
        factory.activate(d);
    }

    /// @dev The hook's allowlist is the one wire that can rot after sign-off, so it is the one wire
    ///      `launch` re-reads. A market created into a revoked allowlist fills and then reverts
    ///      `DependenciesNotWired` on every graduation attempt, forever.
    function test_launchRefusesAfterTheHookAllowlistIsRevoked() public {
        _activated();
        DokuFactory.LaunchParams memory p = factory.native(Sinks.BURN);
        vm.prank(CREATOR);
        factory.launch(p);

        Wiring.revokeHookAllowlist(factory);

        DokuFactory.LaunchParams memory q = factory.native(Sinks.BURN);
        vm.prank(CREATOR);
        vm.expectRevert(DokuFactory.DependenciesChanged.selector);
        factory.launch(q);
        assertFalse(factory.isDeploymentValid(), "a revoked allowlist still reads as a valid graph");
    }

    // ------------------------------------------------- 3. a stale pin cannot survive a graduator change

    /// @dev The pin used to cover what a launch COSTS and nothing about who ends up holding the
    ///      money, so a graduator change between a creator's quote and their transaction landing
    ///      settled the launch against custody they never read. Same fee, same target, same tax,
    ///      different address holding the only key to `release()`.
    function test_aPinTakenBeforeAGraduatorChangeIsRefused() public {
        _activated();
        DokuFactory.LaunchParams memory quoted = factory.native(Sinks.BURN);

        StubGraduator next = new StubGraduator(address(factory));
        vm.prank(OWNER);
        factory.setGraduator(address(next));
        Wiring.activate(factory, OWNER, address(next));

        vm.prank(CREATOR);
        vm.expectRevert(DokuFactory.EconomicsChanged.selector);
        factory.launch(quoted);

        // And the same launch, re-quoted against the terms that are now live, goes through.
        DokuFactory.LaunchParams memory fresh = factory.native(Sinks.BURN);
        vm.prank(CREATOR);
        (address curve,) = factory.launch(fresh);
        assertEq(BondingCurve(payable(curve)).graduator(), address(next), "the new market pinned the old graduator");
    }

    /// @dev The graph moving without the graduator moving is the same problem wearing a different
    ///      hat: the hook, the shared sink and the v4 singletons are all custody too.
    function test_aPinTakenBeforeAReActivationOntoADifferentGraphIsRefused() public {
        _activated();
        DokuFactory.LaunchParams memory quoted = factory.native(Sinks.BURN);

        DokuFactory.Dependencies memory d = Wiring.declare(factory, address(grad));
        address otherPm = address(0xB0B1);
        vm.etch(otherPm, hex"fe");
        vm.mockCall(address(grad), abi.encodeWithSignature("poolManager()"), abi.encode(otherPm));
        d.poolManager = otherPm;
        vm.prank(OWNER);
        factory.activate(d);

        vm.prank(CREATOR);
        vm.expectRevert(DokuFactory.EconomicsChanged.selector);
        factory.launch(quoted);
    }

    /// @dev Changing the graduator shuts the protocol rather than quietly redirecting it. Nothing
    ///      about the previous activation is true of the new graduator: not its hook, not its sink
    ///      wiring, not its v4 singletons.
    function test_setGraduatorDeactivatesAndPauses() public {
        _activated();
        StubGraduator next = new StubGraduator(address(factory));

        vm.prank(OWNER);
        factory.setGraduator(address(next));

        assertFalse(factory.activated(), "a new graduator inherited the old sign-off");
        assertTrue(factory.paused(), "the factory stayed open across a custody change");
        assertEq(factory.dependencyHash(), bytes32(0), "the old hash outlived the graph it described");

        DokuFactory.LaunchParams memory p = factory.native(Sinks.BURN);
        vm.prank(CREATOR);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        factory.launch(p);
    }

    // ------------------------------------------------------------------ 4. the canary still launches

    /// @dev The whole point of the gate is that it stops nothing legitimate. A launch after
    ///      activation behaves exactly as it did: the market exists, the supply is on the curve, and
    ///      the graduator pinned into it is the contract that was signed off.
    function test_launchWorksAfterActivation() public {
        _activated();
        DokuFactory.LaunchParams memory p = factory.native(Sinks.BURN);
        vm.prank(CREATOR);
        (address curve, address token) = factory.launch(p);

        assertTrue(factory.isMarket(curve), "the market was not registered");
        assertEq(factory.creatorOf(curve), CREATOR, "the creator was not recorded");
        assertEq(BondingCurve(payable(curve)).graduator(), address(grad), "the market pinned something else");
        assertEq(address(BondingCurve(payable(curve)).token()), token, "the curve and the token disagree");
        assertGt(BondingCurve(payable(curve)).launchSupply(), 0, "no supply on the curve");
    }

    /// @dev Activation is idempotent, because "read the graph again and tell me it is still whole"
    ///      is a thing an operator should be able to do at any time.
    function test_reActivatingTheSameGraphIsAnoOp() public {
        _activated();
        bytes32 before = factory.dependencyHash();
        DokuFactory.LaunchParams memory quoted = factory.native(Sinks.BURN);

        DokuFactory.Dependencies memory d = Wiring.declare(factory, address(grad));
        vm.prank(OWNER);
        factory.activate(d);

        assertEq(factory.dependencyHash(), before, "an unchanged graph produced a different hash");
        // A pin taken before a no-op re-activation still settles, which is what makes it a no-op.
        vm.prank(CREATOR);
        factory.launch(quoted);
    }

    function _activated() private {
        vm.prank(OWNER);
        factory.setGraduator(address(grad));
        Wiring.activate(factory, OWNER, address(grad));
    }
}
