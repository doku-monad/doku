// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {Ownable} from "openzeppelin/access/Ownable.sol";
import {Pausable} from "openzeppelin/utils/Pausable.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {DokuFactory} from "../src/DokuFactory.sol";
import {DokuToken} from "../src/DokuToken.sol";
import {QuoteRegistry} from "../src/QuoteRegistry.sol";
import {CreatorSink} from "../src/sinks/CreatorSink.sol";
import {Sinks} from "../src/lib/Sinks.sol";
import {Launches} from "./helpers/Launches.sol";
import {Wiring, StubGraduator} from "./helpers/Wiring.sol";

/// @notice The factory's wiring and administration. The launch flow itself is `Launch.t.sol`.
contract DokuFactoryTest is Test {
    using Launches for DokuFactory;

    DokuFactory factory;
    QuoteRegistry registry;
    CreatorSink sink;
    address graduator;

    address constant OWNER = address(0x01);
    address constant PAUSER = address(0x02);
    address constant TREASURY = address(0x7EA);
    address constant CREATOR = address(0xC0DE);
    uint256 constant TARGET = 1_000e18;
    bytes32 constant MARKET_LAUNCHED_SIG =
        keccak256("MarketLaunched(address,address,address,address,uint256,uint8,address,uint16,address)");

    function setUp() public {
        registry = new QuoteRegistry(OWNER);
        vm.prank(OWNER);
        registry.register(address(0), TARGET);
        sink = new CreatorSink(OWNER);
        factory = new DokuFactory(OWNER, PAUSER, TREASURY, address(registry), address(sink), 0);
        vm.prank(OWNER);
        sink.setFactory(address(factory));
        // The factory is born paused with no graduator, so a unit test has to state a dependency
        // graph before it can launch anything. `Wiring` supplies a conforming one and returns the
        // graduator it deployed. See `test/helpers/Wiring.sol`.
        graduator = Wiring.wire(factory, OWNER);
        vm.deal(CREATOR, 100e18);
    }

    // -------------------------------------------------------------------------- happy path

    function test_launchDeploysAWiredMarket() public {
        vm.startPrank(CREATOR);
        (address curve, address token) = factory.launch(factory.native(Sinks.BURN));
        vm.stopPrank();
        BondingCurve c = BondingCurve(payable(curve));

        assertEq(DokuToken(token).balanceOf(curve), 1_000_000_000e18, "supply not on the curve");
        assertEq(DokuToken(token).symbol(), "FIRE", "symbol is not the ticker");
        assertEq(address(c.token()), token, "curve points elsewhere");
        assertEq(c.quoteAsset(), address(0));
        assertEq(c.quoteTarget(), TARGET);
        assertEq(c.protocolRecipient(), TREASURY);
        // It used to read `OWNER` here, because the factory shipped with its owner in the graduator
        // slot. That default is what the 2026-09-11 review's H-01 was about: an EOA in this slot is
        // the only address `release()` answers, and it can take a filled market's whole raise. The
        // factory now starts with NO graduator and refuses to launch until one with code has been
        // set and its whole dependency graph verified.
        assertEq(c.graduator(), graduator, "the market did not pin the activated graduator");
        assertGt(c.graduator().code.length, 0, "an EOA reached the graduator slot");
        assertEq(c.creatorSink(), address(sink));
        assertEq(c.factory(), address(factory));
        assertTrue(factory.isMarket(curve), "registry does not know the market");
        assertEq(factory.creatorOf(curve), CREATOR);
        assertFalse(factory.isMarket(token));
    }

    function test_launchedMarketIsTradeable() public {
        vm.startPrank(CREATOR);
        (address curve,) = factory.launch(factory.native(Sinks.BURN));
        vm.stopPrank();
        vm.prank(CREATOR);
        uint256 out = BondingCurve(payable(curve)).buy{value: 1e18}(0, block.timestamp);
        assertGt(out, 0, "fresh market could not be bought");
    }

    /// The target, the quote, the routing and both recipients ride the event: an indexer that
    /// cannot read them records zero, and every progress bar and every claim button is wrong.
    function test_launchEventCarriesTheWholeMarketRow() public {
        DokuFactory.LaunchParams memory p = factory.params(address(0), Sinks.CREATOR, 50);
        vm.recordLogs();
        vm.prank(CREATOR);
        (address curve, address token) = factory.launch(p);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != MARKET_LAUNCHED_SIG) continue;
            assertEq(address(uint160(uint256(logs[i].topics[1]))), curve);
            assertEq(address(uint160(uint256(logs[i].topics[2]))), token);
            assertEq(address(uint160(uint256(logs[i].topics[3]))), CREATOR);
            (address quote, uint256 target, uint8 kind, address routed, uint16 taxBps, address tax) =
                abi.decode(logs[i].data, (address, uint256, uint8, address, uint16, address));
            assertEq(quote, address(0));
            assertEq(target, TARGET, "event reported the wrong target");
            assertEq(kind, Sinks.CREATOR, "event reported the wrong sink");
            assertEq(routed, CREATOR, "routed recipient did not default to the creator");
            assertEq(taxBps, 50);
            assertEq(tax, CREATOR, "tax recipient did not default to the creator");
            found = true;
        }
        assertTrue(found, "no MarketLaunched event");
    }

    // ------------------------------------------------------------------------------ admin

    /// Pausing stops new launches and nothing else. An existing market must keep trading.
    function test_pauseStopsLaunchesButNotTrading() public {
        vm.startPrank(CREATOR);
        (address curve,) = factory.launch(factory.native(Sinks.BURN));
        vm.stopPrank();

        vm.prank(PAUSER);
        factory.pause();

        DokuFactory.LaunchParams memory p = factory.native(Sinks.BURN);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        factory.launch(p);

        vm.prank(CREATOR);
        assertGt(BondingCurve(payable(curve)).buy{value: 1e18}(0, block.timestamp), 0, "pause reached a live market");
    }

    function test_onlyPauserOrOwnerMayPause() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(0xBAD)));
        factory.pause();
    }

    function test_onlyOwnerMayUnpause() public {
        vm.prank(PAUSER);
        factory.pause();
        vm.prank(PAUSER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, PAUSER));
        factory.unpause();
    }

    function test_unpauseResumesLaunches() public {
        vm.prank(PAUSER);
        factory.pause();
        vm.prank(OWNER);
        factory.unpause();
        vm.startPrank(CREATOR);
        (address curve,) = factory.launch(factory.native(Sinks.BURN));
        vm.stopPrank();
        assertTrue(curve != address(0), "launch still blocked after unpause");
    }

    function test_setFeeRecipientAppliesToNewMarketsOnly() public {
        vm.startPrank(CREATOR);
        (address first,) = factory.launch(factory.native(Sinks.BURN));
        vm.stopPrank();
        vm.prank(OWNER);
        factory.setFeeRecipient(address(0xFEE5));
        assertEq(factory.feeRecipient(), address(0xFEE5));
        assertEq(BondingCurve(payable(first)).protocolRecipient(), TREASURY, "a live market's fee recipient moved");
    }

    function test_setFeeRecipientRejectsZero() public {
        vm.prank(OWNER);
        vm.expectRevert(DokuFactory.ZeroAddress.selector);
        factory.setFeeRecipient(address(0));
    }

    function test_onlyOwnerMaySetFeeRecipient() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(0xBAD)));
        factory.setFeeRecipient(address(0xFEE5));
    }

    function test_setGraduatorAppliesToNewMarketsOnly() public {
        vm.startPrank(CREATOR);
        (address first,) = factory.launch(factory.native(Sinks.BURN));
        vm.stopPrank();
        // A graduator must name this factory as the register it authenticates markets against;
        // otherwise every market launched under it fills, closes and can never graduate.
        GraduatorStub g = new GraduatorStub(address(factory));
        vm.prank(OWNER);
        factory.setGraduator(address(g));
        // Changing the graduator now SHUTS the factory: nothing the previous activation asserted is
        // true of the new one — not its hook, not its sink wiring, not its v4 singletons — so it has
        // to be read again before another market may pin it.
        assertFalse(factory.activated(), "a new graduator inherited the old sign-off");
        assertTrue(factory.paused(), "the factory stayed open across a custody change");
        Wiring.activate(factory, OWNER, address(g));

        vm.startPrank(CREATOR);
        (address second,) = factory.launch(factory.native(Sinks.BURN));
        vm.stopPrank();
        assertEq(BondingCurve(payable(first)).graduator(), graduator, "a live market's graduator moved");
        assertEq(BondingCurve(payable(second)).graduator(), address(g));
    }

    function test_setPauserRotatesTheRole() public {
        address newPauser = address(0xBEEF);
        vm.prank(OWNER);
        factory.setPauser(newPauser);
        assertEq(factory.pauser(), newPauser);
        vm.prank(PAUSER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, PAUSER));
        factory.pause();
        vm.prank(newPauser);
        factory.pause();
    }

    function test_setPauserRejectsZero() public {
        vm.prank(OWNER);
        vm.expectRevert(DokuFactory.ZeroAddress.selector);
        factory.setPauser(address(0));
    }

    function test_ownerMayAlsoPause() public {
        vm.prank(OWNER);
        factory.pause();
    }

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(DokuFactory.ZeroAddress.selector);
        new DokuFactory(OWNER, PAUSER, address(0), address(registry), address(sink), 0);
        vm.expectRevert(DokuFactory.ZeroAddress.selector);
        new DokuFactory(OWNER, PAUSER, TREASURY, address(0), address(sink), 0);
        vm.expectRevert(DokuFactory.ZeroAddress.selector);
        new DokuFactory(OWNER, PAUSER, TREASURY, address(registry), address(0), 0);
    }

    function test_ownershipTransferIsTwoStep() public {
        address next = address(0xDECAF);
        vm.prank(OWNER);
        factory.transferOwnership(next);
        assertEq(factory.owner(), OWNER, "ownership moved without acceptance");
        vm.prank(next);
        factory.acceptOwnership();
        assertEq(factory.owner(), next);
    }

    // ------------------------------------------------------------------------- the launch fee

    /// The launch fee is part of the constructor so a deployment never opens free by accident,
    /// and `launchFee(who)` is what the interface's "gas only" row reads.
    function test_theFeeIsConstructedAndReadPerCreator() public {
        DokuFactory paid = new DokuFactory(OWNER, PAUSER, TREASURY, address(registry), address(sink), 0.05 ether);
        assertEq(paid.launchFeeWei(), 0.05 ether);
        assertEq(paid.launchFee(CREATOR), 0.05 ether);
        vm.prank(OWNER);
        paid.setFeeExempt(CREATOR, true);
        assertEq(paid.launchFee(CREATOR), 0, "an exempt creator still reads a fee");
        assertEq(paid.launchFee(address(0xBEEF)), 0.05 ether);
    }

    function test_launchIsFreeUntilAFeeIsSet() public {
        vm.startPrank(CREATOR);
        factory.launch(factory.native(Sinks.BURN));
        vm.stopPrank();
        assertEq(factory.pendingLaunchFees(), 0);
    }

    function test_launchRequiresExactlyTheFeeOnceSet() public {
        vm.prank(OWNER);
        factory.setLaunchFee(0.02 ether);
        DokuFactory.LaunchParams memory p = factory.native(Sinks.BURN);

        vm.prank(CREATOR);
        vm.expectRevert(abi.encodeWithSelector(DokuFactory.ValueMismatch.selector, 0, 0.02 ether));
        factory.launch(p);

        // Exact, not `>=`: the pin already refuses a fee that moved between quote and send, so an
        // overpayment has no honest cause, and an exact value is what makes the first buy's size
        // unambiguous on a native market.
        vm.prank(CREATOR);
        vm.expectRevert(abi.encodeWithSelector(DokuFactory.ValueMismatch.selector, 0.5 ether, 0.02 ether));
        factory.launch{value: 0.5 ether}(p);

        vm.prank(CREATOR);
        factory.launch{value: 0.02 ether}(p);
        assertEq(factory.pendingLaunchFees(), 0.02 ether);
    }

    function test_feeExemptLaunchesForFree() public {
        vm.startPrank(OWNER);
        factory.setLaunchFee(0.02 ether);
        factory.setFeeExempt(CREATOR, true);
        vm.stopPrank();
        vm.startPrank(CREATOR);
        factory.launch(factory.native(Sinks.BURN));
        vm.stopPrank();
        assertEq(factory.pendingLaunchFees(), 0);
    }

    /// Pull, never push. A recipient that reverts on receive must not be able to brick launching —
    /// which is the one place a push would stop new markets existing at all.
    function test_launchFeesArePulledAndOnlyEverReachTheRecipient() public {
        vm.prank(OWNER);
        factory.setLaunchFee(0.02 ether);
        vm.startPrank(CREATOR);
        factory.launch{value: 0.02 ether}(factory.native(Sinks.BURN));
        vm.stopPrank();

        uint256 before = TREASURY.balance;
        vm.prank(address(0xA11CE)); // anyone may trigger it
        factory.collectLaunchFees();
        assertEq(TREASURY.balance - before, 0.02 ether, "fees did not reach the recipient");

        vm.expectRevert(DokuFactory.NothingToCollect.selector);
        factory.collectLaunchFees();
    }

    function test_onlyTheOwnerCanSetTheLaunchFee() public {
        vm.prank(CREATOR);
        vm.expectRevert();
        factory.setLaunchFee(1 ether);
    }
}

/// @dev The graduation contract as `setGraduator` checks it: one function, one answer.
contract GraduatorStub {
    address public factory;

    constructor(address f) {
        factory = f;
    }
}
