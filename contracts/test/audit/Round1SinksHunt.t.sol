// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {PosmTestSetup} from "@uniswap/v4-periphery/test/shared/PosmTestSetup.sol";
import {DeployDoku} from "../../script/DeployDoku.s.sol";
import {DokuFactory} from "../../src/DokuFactory.sol";
import {DokuGraduation} from "../../src/DokuGraduation.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {CreatorSink} from "../../src/sinks/CreatorSink.sol";
import {Sinks} from "../../src/lib/Sinks.sol";
import {Launches} from "../helpers/Launches.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {Test} from "forge-std/Test.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {HookStub, GraduatorStub, FactoryStub} from "./SinksHunt.t.sol";
import {CreatorSinkGen3} from "./CreatorSinkGen3.sol";

// Compiled only so `vm.getCode` can find them; see DeployDoku.t.sol.
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {PositionDescriptor} from "@uniswap/v4-periphery/src/PositionDescriptor.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/**
 * ROUND 1 — `CreatorSink`, the fix that made a stranded fee into a stranded RAISE.
 *
 * `CreatorSink.register` gained a guard today:
 *
 *     if (routed == address(this) || tax == address(this)) revert SinkIsNotARecipient();
 *
 * The reasoning in `docs/doku/audit/gen4/creator-sink.md` is sound as far as it goes — naming the
 * sink as a recipient books a claim that only the sink could make, and it cannot make one. What the
 * fix did not weigh is WHERE that revert lands.
 *
 * `DokuGraduation._register` is a step of `graduate()`, and `graduate()` is called from inside the
 * buy that fills the curve through `BondingCurve._tryAutoGraduate` — a RAW CALL whose failure is
 * SWALLOWED by design. So the revert is not a refused launch and not a refused buy. It is:
 *
 *   1. the market fills,
 *   2. `readyToGraduate` latches, which shuts `buy` AND `sell` (`CurveClosed`),
 *   3. `graduate()` reverts for ever, so `release()` — the only path that moves `quoteRaised` out
 *      of the curve — is unreachable,
 *   4. and the whole raise sits in the `BondingCurve` with no exit, in a contract with no owner
 *      rescue.
 *
 * The input that arms it is a plain launch parameter. `DokuFactory._recipients` reads
 * `p.taxRecipient` straight through, `BondingCurve.initialize` checks it only against zero, and
 * `DokuGraduation._register` hands it to the sink verbatim as `c.taxRecipient()`. Nothing between
 * `launch()` and graduation compares it to `creatorSink`.
 *
 * Under generation 3 the same input cost the CREATOR their own fees. Under this fix it costs every
 * BUYER the whole raise.
 */
contract Round1CreatorSinkBrick is PosmTestSetup {
    using Launches for DokuFactory;

    address internal constant OWNER = address(0x0BEE);
    address internal constant PAUSER = address(0xBA5E);
    address internal constant FEE_RECIPIENT = address(0xFEE);
    address internal constant TREASURY = address(0x7EA);
    uint256 internal constant TARGET = 1_000e18;
    uint256 internal constant USDC_TARGET = 10_000e6;
    address internal constant CREATOR = address(0xC12A);
    address internal constant BUYER = address(0xB0B);

    DeployDoku internal script;
    DeployDoku.Deployment internal d;
    MockUSDC internal usdc;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployPosm(manager);
        script = new DeployDoku();
        d = script.runWith(_config());
        vm.deal(CREATOR, 10_000e18);
        vm.deal(BUYER, 1_000_000e18);
    }

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

    /// @dev The control. The identical market with an ordinary tax recipient graduates itself on
    ///      the filling buy, so nothing below can be blamed on the harness.
    function test_control_theSameMarketWithAnOrdinaryTaxRecipientGraduates() public {
        address curveAddr = _launch(address(0xDEFA17));
        _fill(curveAddr);
        assertTrue(BondingCurve(payable(curveAddr)).readyToGraduate(), "control curve did not fill");
        assertTrue(
            DokuGraduation(payable(d.graduation)).graduated(curveAddr),
            "the control market did not graduate"
        );
    }

    /// @notice THE FINDING. A launch parameter nothing screens freezes the entire raise.
    function test_R1_aTaxRecipientOfTheSharedSinkIsRefusedAtLaunch() public {
        DokuFactory factory = DokuFactory(d.dokuFactory);
        address sink = factory.creatorSink();

        // Refused on the one input nobody has spent anything on yet. Before this guard the launch
        // was ACCEPTED, the market filled, and `graduate()` then reverted `SinkIsNotARecipient`
        // for ever behind `_tryAutoGraduate`'s swallowing call — with `buy` and `sell` answering
        // `CurveClosed`, `release()` graduator-only, and the graduator the thing that could not
        // finish. The whole raise was sealed in the curve with no owner power that reached it.
        DokuFactory.LaunchParams memory p = factory.params(address(0), Sinks.BURN, 100);
        p.taxRecipient = sink;
        // The fee is read BEFORE the cheatcodes are armed. `launch{value: factory.launchFee(...)}`
        // evaluates that inner call first, so it would consume both the prank and the
        // `expectRevert` and the test would pass for the wrong reason — or, as here, fail for one.
        uint256 fee = factory.launchFee(CREATOR);
        vm.prank(CREATOR);
        vm.expectRevert(DokuFactory.RecipientNotAllowed.selector);
        factory.launch{value: fee}(p);

        // Nothing was created, so there is nothing to strand: the nonce is untouched and the
        // address the launch would have taken is still empty.
        assertEq(factory.nonces(CREATOR), 0, "a refused launch consumed a nonce");
        (address predicted,) = factory.predictMarket(CREATOR);
        assertEq(predicted.code.length, 0, "a curve was deployed anyway");
    }

    /// @dev The routed leg of the same thing. It needs no creator tax at all — a CREATOR market
    ///      whose routed recipient is the sink was enough on its own.
    function test_R1b_aRoutedRecipientOfTheSharedSinkIsRefusedAtLaunchToo() public {
        DokuFactory factory = DokuFactory(d.dokuFactory);
        address sink = factory.creatorSink();

        DokuFactory.LaunchParams memory p = factory.params(address(0), Sinks.CREATOR, 0);
        p.routedRecipient = sink;
        uint256 fee = factory.launchFee(CREATOR);
        vm.prank(CREATOR);
        vm.expectRevert(DokuFactory.RecipientNotAllowed.selector);
        factory.launch{value: fee}(p);

        assertEq(factory.nonces(CREATOR), 0, "a refused launch consumed a nonce");
    }

    /// @dev The guard must refuse the sink and NOTHING ELSE. An ordinary market still launches,
    ///      fills and graduates — asserted by `test_control_...` below — and a recipient that
    ///      merely resembles the sink is fine.
    function test_R1c_theGuardRefusesOnlyTheSinkItself() public {
        DokuFactory factory = DokuFactory(d.dokuFactory);
        address notTheSink = address(uint160(factory.creatorSink()) ^ 1);

        DokuFactory.LaunchParams memory p = factory.params(address(0), Sinks.CREATOR, 0);
        p.routedRecipient = notTheSink;
        vm.prank(CREATOR);
        (address curveAddr,) = factory.launch{value: factory.launchFee(CREATOR)}(p);
        assertEq(BondingCurve(payable(curveAddr)).feeRecipient(), notTheSink, "an honest launch was refused");
    }

    // ------------------------------------------------------------------------------- machinery

    function _launch(address taxRecipient) internal returns (address curveAddr) {
        DokuFactory factory = DokuFactory(d.dokuFactory);
        DokuFactory.LaunchParams memory p = factory.params(address(0), Sinks.BURN, 100);
        p.taxRecipient = taxRecipient;
        vm.prank(CREATOR);
        (curveAddr,) = factory.launch{value: factory.launchFee(CREATOR)}(p);
    }

    function _fill(address curveAddr) internal {
        BondingCurve curve = BondingCurve(payable(curveAddr));
        vm.warp(vm.getBlockTimestamp() + curve.TAX_WINDOW() + 1);
        vm.prank(BUYER);
        curve.buy{value: 5 * TARGET}(0, vm.getBlockTimestamp() + 1 hours);
    }
}

/**
 * ROUND 1 — the THIRD door into `SinkIsNotARecipient`, which the fix did not close.
 *
 * `docs/doku/audit/gen4/creator-sink.md`: "Both doors — `register` and `credit` — now refuse it."
 * There are three. `transferRecipient` writes `e.routed` and checks the destination only against
 * zero, so the current routed recipient of any CREATOR market may hand their stream to the sink
 * itself — which is exactly the B3 dead end the round closed everywhere else: every later `pull`
 * books `claimable[sink][quote]`, and this contract has no way to spend a ledger entry of its own.
 *
 * Demoted deliberately: the money lost is the caller's OWN future income and no attacker profits.
 * It is here because the guard is free, the call is already validated, and a refusal costs the
 * caller nothing but a second transaction.
 */
contract Round1CreatorSinkThirdDoor is Test {
    address internal constant OWNER = address(0x01);
    address internal constant ROUTED_A = address(0xA0);
    address internal constant TAX_A = address(0xA1);
    PoolId internal constant ID_A = PoolId.wrap(bytes32(uint256(0xA)));

    CreatorSink internal sink;
    HookStub internal hook;
    FactoryStub internal factory;
    address internal GRADUATOR;
    address internal market;

    receive() external payable {}

    function setUp() public {
        hook = new HookStub();
        factory = new FactoryStub();
        GRADUATOR = address(new GraduatorStub(address(hook)));
        sink = new CreatorSink(OWNER);
        vm.startPrank(OWNER);
        sink.setGraduator(GRADUATOR);
        sink.setFactory(address(factory));
        vm.stopPrank();
        vm.deal(address(hook), 1_000 ether);

        market = address(0xBEEF);
        factory.set(market, true);
        vm.prank(GRADUATOR);
        sink.register(market, ID_A, address(0), ROUTED_A, TAX_A);
    }

    /// @notice Both closed doors, asserted, so the third one below is not confused with them.
    function test_R2a_theTwoClosedDoorsStayClosed() public {
        vm.prank(GRADUATOR);
        vm.expectRevert(CreatorSink.SinkIsNotARecipient.selector);
        sink.register(address(0xF00D), ID_A, address(0), address(sink), TAX_A);
    }

    /// @notice THE HUNT, against the frozen generation-3 sink. The routed recipient hands the
    ///         stream to the sink itself and everything the market earns from then on is booked to
    ///         an address that cannot spend it.
    function test_R2_hunt_gen3TransferRecipientStrandsEveryLaterFee() public {
        CreatorSinkGen3 old_ = new CreatorSinkGen3(OWNER);
        vm.startPrank(OWNER);
        old_.setGraduator(GRADUATOR);
        old_.setFactory(address(factory));
        vm.stopPrank();
        vm.prank(GRADUATOR);
        old_.register(market, ID_A, address(0), ROUTED_A, TAX_A);

        vm.prank(ROUTED_A);
        old_.transferRecipient(market, address(old_));
        (,, address routed,,) = old_.entries(market);
        assertEq(routed, address(old_), "gen 3 refused it, so there was never a finding");

        // The market earns. Every wei of it is now booked to the sink.
        hook.set(ID_A, address(0), 0, 9 ether, 0);
        old_.pull(market);
        assertEq(old_.claimable(address(old_), address(0)), 9 ether, "the pull did not book it to the sink");

        // And it can never leave. `claim` debits `msg.sender`'s ledger entry only, and the sink
        // has no function that calls itself.
        vm.prank(ROUTED_A);
        vm.expectRevert(CreatorSinkGen3.NothingToClaim.selector);
        old_.claim(address(0));

        // Nor can the recipient it came from take the stream back: only `e.routed` may move it,
        // and `e.routed` is now the one address that cannot exercise the right.
        vm.prank(ROUTED_A);
        vm.expectRevert(CreatorSinkGen3.NotRecipient.selector);
        old_.transferRecipient(market, ROUTED_A);

        assertEq(old_.claimable(address(old_), address(0)), 9 ether, "the stranded balance moved");
    }

    /// @notice THE PROOF. The same first move against `src/` is refused, and the stream stays where
    ///         the recipient can still spend it.
    function test_R2_proof_theThirdDoorIsClosed() public {
        vm.prank(ROUTED_A);
        vm.expectRevert(CreatorSink.SinkIsNotARecipient.selector);
        sink.transferRecipient(market, address(sink));
        assertEq(_routed(market), ROUTED_A, "the entry moved anyway");

        // An ordinary handover is untouched.
        vm.prank(ROUTED_A);
        sink.transferRecipient(market, address(0xB0B));
        assertEq(_routed(market), address(0xB0B), "a legitimate handover was refused");

        hook.set(ID_A, address(0), 0, 9 ether, 0);
        sink.pull(market);
        assertEq(sink.claimable(address(0xB0B), address(0)), 9 ether, "the fee did not reach the new recipient");
        vm.prank(address(0xB0B));
        sink.claim(address(0));
        assertEq(address(0xB0B).balance, 9 ether, "the money is not reachable");
    }

    function _routed(address m) internal view returns (address r) {
        (,, r,,) = sink.entries(m);
    }
}
