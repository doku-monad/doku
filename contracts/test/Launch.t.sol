// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {DokuFactory} from "../src/DokuFactory.sol";
import {DokuToken} from "../src/DokuToken.sol";
import {QuoteRegistry} from "../src/QuoteRegistry.sol";
import {CreatorSink} from "../src/sinks/CreatorSink.sol";
import {Sinks} from "../src/lib/Sinks.sol";
import {Launches} from "./helpers/Launches.sol";
import {Wiring} from "./helpers/Wiring.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @notice The launch flow: every cap and charset, the economics pin, recipients against routing,
///         the first buy's accounting in both quote kinds, and what `setMetadata` may change.
contract LaunchTest is Test {
    using Launches for DokuFactory;

    address constant OWNER = address(0x01);
    address constant TREASURY = address(0x7EA);
    address constant CREATOR = address(0xC0DE);
    address constant WALLET = address(0x5A11);
    uint256 constant MON_TARGET = 1_000e18;
    uint256 constant USDC_TARGET = 8_000e6;
    bytes32 constant METADATA_SET_SIG =
        keccak256("MetadataSet(address,string,string,string,string,string,string,string,string)");

    DokuFactory factory;
    QuoteRegistry registry;
    CreatorSink sink;
    MockUSDC usdc;

    function setUp() public {
        registry = new QuoteRegistry(OWNER);
        usdc = new MockUSDC();
        vm.startPrank(OWNER);
        registry.register(address(0), MON_TARGET);
        registry.register(address(usdc), USDC_TARGET);
        vm.stopPrank();
        sink = new CreatorSink(OWNER);
        factory = new DokuFactory(OWNER, OWNER, TREASURY, address(registry), address(sink), 0);
        Wiring.wire(factory, OWNER);
        vm.prank(OWNER);
        sink.setFactory(address(factory));
        vm.deal(CREATOR, 100_000e18);
        usdc.mint(CREATOR, 1_000_000e6);
    }

    function _str(uint256 n, bytes1 c) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        for (uint256 i; i < n; ++i) {
            b[i] = c;
        }
        return string(b);
    }

    function _expectLaunchRevert(DokuFactory.LaunchParams memory p, bytes memory err) internal {
        vm.prank(CREATOR);
        vm.expectRevert(err);
        factory.launch(p);
    }

    // ------------------------------------------------------------------------- the registry

    function test_aDisabledOrUnknownQuoteCannotLaunch() public {
        vm.prank(OWNER);
        registry.setEnabled(address(usdc), false);
        DokuFactory.LaunchParams memory p = factory.params(address(usdc), Sinks.BURN, 0);
        _expectLaunchRevert(p, abi.encodeWithSelector(DokuFactory.QuoteNotEnabled.selector, address(usdc)));
        p = factory.params(address(0xBEEF), Sinks.BURN, 0);
        _expectLaunchRevert(p, abi.encodeWithSelector(DokuFactory.QuoteNotEnabled.selector, address(0xBEEF)));
    }

    /// A market snapshots its target at launch. Retuning the registry afterwards must not reach it.
    function test_aTargetChangeNeverTouchesALiveCurve() public {
        vm.startPrank(CREATOR);
        (address curve,) = factory.launch(factory.native(Sinks.BURN));
        vm.stopPrank();
        vm.prank(OWNER);
        registry.setQuoteTarget(address(0), 5_000e18);
        assertEq(BondingCurve(payable(curve)).quoteTarget(), MON_TARGET, "a live market's target moved");
        vm.startPrank(CREATOR);
        (address next,) = factory.launch(factory.native(Sinks.BURN));
        vm.stopPrank();
        assertEq(BondingCurve(payable(next)).quoteTarget(), 5_000e18, "the new target did not take");
    }

    // ------------------------------------------------------------------------------- the pin

    /// A launch cannot settle on terms the creator did not read. Every input to the pin that the
    /// owner can move between quote and send is tried here.
    function test_thePinRefusesTermsThatMoved() public {
        DokuFactory.LaunchParams memory p = factory.native(Sinks.BURN);
        bytes memory err = abi.encodeWithSelector(DokuFactory.EconomicsChanged.selector);

        vm.prank(OWNER);
        // + 5, not + 1: a target must be a multiple of five or the registry refuses it outright,
        // and what is under test here is the pin noticing a change rather than the size of one.
        registry.setQuoteTarget(address(0), MON_TARGET + 5);
        _expectLaunchRevert(p, err);
        vm.prank(OWNER);
        registry.setQuoteTarget(address(0), MON_TARGET);

        vm.prank(OWNER);
        factory.setLaunchFee(1 wei);
        p.economicsPin = factory.economicsPin(address(0), Sinks.BURN, 0); // re-quoted, but sent the old value
        vm.prank(OWNER);
        factory.setLaunchFee(2 wei);
        vm.prank(CREATOR);
        vm.expectRevert(err);
        factory.launch{value: 2 wei}(p);
        vm.prank(OWNER);
        factory.setLaunchFee(0);

        // The pin binds the sink and the tax too: a client that swaps either after quoting fails.
        p = factory.native(Sinks.BURN);
        p.sink = Sinks.CREATOR;
        _expectLaunchRevert(p, err);
        p = factory.native(Sinks.BURN);
        p.creatorTaxBps = 10;
        _expectLaunchRevert(p, err);
        p = factory.params(address(0), Sinks.BURN, 10);
        p.quoteAsset = address(usdc);
        _expectLaunchRevert(p, err);
    }

    function test_thePinIsReproducible() public view {
        BondingCurve impl = BondingCurve(payable(factory.curveImplementation()));
        // The graduator and the dependency hash lead the encoding now. They are custody terms —
        // who ends up holding a filled market's raise — and a pin that caught a fee moving by one
        // wei while saying nothing about that was protecting the wrong thing.
        bytes32 expected = keccak256(
            abi.encode(
                factory.graduator(),
                factory.dependencyHash(),
                address(usdc),
                USDC_TARGET,
                uint256(0),
                uint16(30),
                uint16(70),
                uint16(5000),
                uint32(300),
                uint8(0), // TaxMath.Mode.CLOCK — the factory's tax terms are in the pin
                Sinks.REWARDS,
                uint16(120)
            )
        );
        assertEq(factory.economicsPin(address(usdc), Sinks.REWARDS, 120), expected, "a client cannot reproduce the pin");
        assertEq(impl.PROTOCOL_BPS(), 30);
    }

    // ------------------------------------------------------------------------- recipients

    function test_recipientsFollowTheRouting() public {
        DokuFactory.LaunchParams memory p = factory.native(Sinks.BURN);
        p.routedRecipient = WALLET;
        _expectLaunchRevert(p, abi.encodeWithSelector(DokuFactory.RecipientNotAllowed.selector));
        p = factory.native(Sinks.REWARDS);
        p.routedRecipient = WALLET;
        _expectLaunchRevert(p, abi.encodeWithSelector(DokuFactory.RecipientNotAllowed.selector));

        p = factory.native(Sinks.CREATOR);
        vm.prank(CREATOR);
        (address c1,) = factory.launch(p);
        assertEq(BondingCurve(payable(c1)).routedRecipient(), CREATOR, "CREATOR did not default to the sender");
        assertEq(BondingCurve(payable(c1)).feeRecipient(), CREATOR);

        p.routedRecipient = WALLET;
        vm.prank(CREATOR);
        (address c2,) = factory.launch(p);
        assertEq(BondingCurve(payable(c2)).routedRecipient(), WALLET);

        p = factory.native(Sinks.BURN);
        vm.prank(CREATOR);
        (address c3,) = factory.launch(p);
        assertEq(BondingCurve(payable(c3)).routedRecipient(), address(0), "a BURN market has no wallet");
    }

    function test_theCreatorTaxIsTenthsOfAPercentUpToTen() public {
        DokuFactory.LaunchParams memory p = factory.params(address(0), Sinks.BURN, 1010);
        _expectLaunchRevert(p, abi.encodeWithSelector(DokuFactory.InvalidCreatorTax.selector));
        p = factory.params(address(0), Sinks.BURN, 15);
        _expectLaunchRevert(p, abi.encodeWithSelector(DokuFactory.InvalidCreatorTax.selector));

        p = factory.params(address(0), Sinks.BURN, 1000);
        vm.prank(CREATOR);
        (address c1,) = factory.launch(p);
        assertEq(BondingCurve(payable(c1)).creatorTaxBps(), 1000);
        assertEq(BondingCurve(payable(c1)).taxRecipient(), CREATOR, "tax recipient did not default to the sender");

        p = factory.params(address(0), Sinks.BURN, 10);
        p.taxRecipient = WALLET;
        vm.prank(CREATOR);
        (address c2,) = factory.launch(p);
        assertEq(BondingCurve(payable(c2)).taxRecipient(), WALLET);
    }

    // ------------------------------------------------------------------------ the caps

    function test_nameIsTwoToFortyTwoBytes() public {
        DokuFactory.LaunchParams memory p = factory.native(Sinks.BURN);
        p.meta.name = "F";
        _expectLaunchRevert(p, abi.encodeWithSelector(DokuFactory.InvalidName.selector));
        p.meta.name = _str(43, "a");
        _expectLaunchRevert(p, abi.encodeWithSelector(DokuFactory.InvalidName.selector));
        p.meta.name = _str(42, "a");
        vm.prank(CREATOR);
        factory.launch(p);
        p.meta.name = unicode"🔥🔥"; // 8 bytes: any UTF-8 is fine in a NAME
        vm.prank(CREATOR);
        factory.launch(p);
    }

    function test_tickerIsTwoToTwelveAlphanumericBytes() public {
        DokuFactory.LaunchParams memory p = factory.native(Sinks.BURN);
        bytes4 err = DokuFactory.InvalidTicker.selector;
        p.meta.ticker = "F";
        _expectLaunchRevert(p, abi.encodeWithSelector(err));
        p.meta.ticker = _str(13, "A");
        _expectLaunchRevert(p, abi.encodeWithSelector(err));
        p.meta.ticker = "FI-RE";
        _expectLaunchRevert(p, abi.encodeWithSelector(err));
        p.meta.ticker = "FI RE";
        _expectLaunchRevert(p, abi.encodeWithSelector(err));
        p.meta.ticker = unicode"🔥";
        _expectLaunchRevert(p, abi.encodeWithSelector(err));
        p.meta.ticker = "fire01Z";
        vm.prank(CREATOR);
        (, address token) = factory.launch(p);
        assertEq(DokuToken(token).symbol(), "fire01Z", "the ticker is the symbol, verbatim");
        p.meta.ticker = _str(12, "z");
        vm.prank(CREATOR);
        factory.launch(p);
    }

    function test_everyOtherFieldHasItsCap() public {
        DokuFactory.LaunchParams memory p = factory.native(Sinks.BURN);
        p.meta.logoURI = _str(129, "l");
        _expectLaunchRevert(p, abi.encodeWithSelector(DokuFactory.FieldTooLong.selector, 2));
        p.meta.logoURI = "";
        p.meta.bannerURI = _str(129, "b");
        _expectLaunchRevert(p, abi.encodeWithSelector(DokuFactory.FieldTooLong.selector, 3));
        p.meta.bannerURI = "";
        p.meta.description = _str(241, "d");
        _expectLaunchRevert(p, abi.encodeWithSelector(DokuFactory.FieldTooLong.selector, 4));
        p.meta.description = _str(240, "d");
        p.meta.website = _str(129, "w");
        _expectLaunchRevert(p, abi.encodeWithSelector(DokuFactory.FieldTooLong.selector, 5));
        p.meta.website = _str(128, "w");
        p.meta.x = _str(129, "x");
        _expectLaunchRevert(p, abi.encodeWithSelector(DokuFactory.FieldTooLong.selector, 6));
        p.meta.x = _str(128, "x");
        p.meta.telegram = _str(129, "t");
        _expectLaunchRevert(p, abi.encodeWithSelector(DokuFactory.FieldTooLong.selector, 7));
        p.meta.telegram = _str(128, "t");
        p.meta.logoURI = _str(128, "l");
        p.meta.bannerURI = _str(128, "b");
        vm.prank(CREATOR);
        factory.launch(p);
    }

    // -------------------------------------------------------------------------- metadata

    function test_metadataIsEmittedAtLaunchAndStoredAsIdentityOnly() public {
        DokuFactory.LaunchParams memory p = factory.native(Sinks.BURN);
        p.meta.description = "hot";
        p.meta.website = "https://fire.example";
        vm.recordLogs();
        vm.prank(CREATOR);
        (address curve,) = factory.launch(p);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != METADATA_SET_SIG) continue;
            assertEq(address(uint160(uint256(logs[i].topics[1]))), curve);
            (string memory name, string memory ticker,,, string memory description, string memory website,,) =
                abi.decode(logs[i].data, (string, string, string, string, string, string, string, string));
            assertEq(name, "Fire Token");
            assertEq(ticker, "FIRE");
            assertEq(description, "hot");
            assertEq(website, "https://fire.example");
            found = true;
        }
        assertTrue(found, "no MetadataSet");
        assertEq(factory.identityOf(curve), keccak256(abi.encode("Fire Token", "FIRE")));
    }

    function test_setMetadataIsTheCreatorsAndLocksNameAndTicker() public {
        DokuFactory.LaunchParams memory p = factory.native(Sinks.BURN);
        vm.prank(CREATOR);
        (address curve,) = factory.launch(p);

        DokuFactory.Metadata memory m = p.meta;
        m.website = "https://fire.example";
        vm.prank(address(0xBAD));
        vm.expectRevert(DokuFactory.NotCreator.selector);
        factory.setMetadata(curve, m);

        vm.recordLogs();
        vm.prank(CREATOR);
        factory.setMetadata(curve, m);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], METADATA_SET_SIG);

        m.name = "Fire Token 2";
        vm.prank(CREATOR);
        vm.expectRevert(DokuFactory.IdentityLocked.selector);
        factory.setMetadata(curve, m);
        m.name = "Fire Token";
        m.ticker = "FIRE2";
        vm.prank(CREATOR);
        vm.expectRevert(DokuFactory.IdentityLocked.selector);
        factory.setMetadata(curve, m);

        // The caps still apply on an update.
        m.ticker = "FIRE";
        m.description = _str(241, "d");
        vm.prank(CREATOR);
        vm.expectRevert(abi.encodeWithSelector(DokuFactory.FieldTooLong.selector, 4));
        factory.setMetadata(curve, m);

        vm.prank(CREATOR);
        vm.expectRevert(DokuFactory.NotCreator.selector);
        factory.setMetadata(address(0xD00D), m);
    }

    // ------------------------------------------------------------------------- the first buy

    /// Untaxed by the anti-sniper rate ONCE, in the launch transaction. The creator's next buy is
    /// taxed like anyone's, and the first buy still pays the fee and the creator tax.
    function test_theFirstBuyIsUntaxedOnceAndEveryLaterBuyIsTaxed() public {
        DokuFactory.LaunchParams memory p = factory.params(address(0), Sinks.CREATOR, 100);
        p.firstBuyQuote = 10e18;
        vm.prank(CREATOR);
        (address curve, address token) = factory.launch{value: 10e18}(p);
        BondingCurve c = BondingCurve(payable(curve));
        assertGt(DokuToken(token).balanceOf(CREATOR), 0, "the creator holds nothing");
        assertEq(c.taxEscrow(), 0, "the launch buy was anti-sniped");
        assertEq(c.pendingProtocol(), 0.03e18, "the launch buy skipped the fee");
        assertEq(c.pendingFees(), 0.07e18);
        assertEq(c.pendingTax(), 0.1e18, "the launch buy skipped the creator tax");
        assertEq(c.quoteRaised(), 9.9e18 - 0.1e18);

        vm.prank(CREATOR);
        c.buy{value: 10e18}(0, block.timestamp);
        assertGt(c.taxEscrow(), 0, "the creator's second buy was not taxed");
    }

    function test_nativeValueIsFeePlusFirstBuyExactly() public {
        vm.prank(OWNER);
        factory.setLaunchFee(0.02 ether);
        DokuFactory.LaunchParams memory p = factory.native(Sinks.BURN);
        p.firstBuyQuote = 1e18;
        vm.prank(CREATOR);
        vm.expectRevert(abi.encodeWithSelector(DokuFactory.ValueMismatch.selector, 1e18, 0.02 ether + 1e18));
        factory.launch{value: 1e18}(p);

        uint256 before = CREATOR.balance;
        vm.prank(CREATOR);
        (address curve,) = factory.launch{value: 0.02 ether + 1e18}(p);
        assertEq(before - CREATOR.balance, 0.02 ether + 1e18);
        assertEq(factory.pendingLaunchFees(), 0.02 ether);
        assertEq(address(curve).balance, 1e18, "the first buy did not land on the curve");
        assertEq(address(factory).balance, 0.02 ether, "the factory holds more than the fee");
    }

    /// On an ERC-20 market the value is the fee alone; the first buy is pulled from the creator's
    /// allowance straight onto the curve.
    function test_anERC20FirstBuyIsPulledAndTheValueIsTheFeeAlone() public {
        vm.prank(OWNER);
        factory.setLaunchFee(0.02 ether);
        DokuFactory.LaunchParams memory p = factory.params(address(usdc), Sinks.CREATOR, 50);
        p.firstBuyQuote = 100e6;

        vm.prank(CREATOR);
        vm.expectRevert(abi.encodeWithSelector(DokuFactory.ValueMismatch.selector, 0.02 ether + 100e6, 0.02 ether));
        factory.launch{value: 0.02 ether + 100e6}(p);

        vm.startPrank(CREATOR);
        usdc.approve(address(factory), 100e6);
        (address curve, address token) = factory.launch{value: 0.02 ether}(p);
        vm.stopPrank();
        BondingCurve c = BondingCurve(payable(curve));
        assertEq(usdc.balanceOf(curve), 100e6, "the first buy did not land on the curve");
        assertEq(c.quoteRaised(), 100e6 - 0.3e6 - 0.7e6 - 0.5e6);
        assertEq(c.pendingTax(), 0.5e6);
        assertGt(DokuToken(token).balanceOf(CREATOR), 0);
        assertEq(c.taxEscrow(), 0);
        assertEq(factory.pendingLaunchFees(), 0.02 ether);
    }

    function test_theFirstBuyHonoursMinOutAndDeadline() public {
        DokuFactory.LaunchParams memory p = factory.native(Sinks.BURN);
        p.firstBuyQuote = 1e18;
        p.firstBuyMinOut = type(uint256).max;
        vm.prank(CREATOR);
        vm.expectRevert(BondingCurve.InsufficientOutput.selector);
        factory.launch{value: 1e18}(p);
        p.firstBuyMinOut = 0;
        p.deadline = block.timestamp - 1;
        vm.prank(CREATOR);
        vm.expectRevert(BondingCurve.Expired.selector);
        factory.launch{value: 1e18}(p);
        // Without a first buy the deadline is irrelevant.
        p.firstBuyQuote = 0;
        vm.prank(CREATOR);
        factory.launch(p);
    }

    /// A first buy large enough to fill the curve is refunded the overshoot and closes the market
    /// in the launch transaction; the swallowed auto-graduation leaves it filled and retryable.
    function test_aFillingFirstBuyRefundsTheOvershoot() public {
        DokuFactory.LaunchParams memory p = factory.native(Sinks.BURN);
        p.firstBuyQuote = 5_000e18;
        uint256 before = CREATOR.balance;
        vm.prank(CREATOR);
        (address curve,) = factory.launch{value: 5_000e18}(p);
        BondingCurve c = BondingCurve(payable(curve));
        assertTrue(c.readyToGraduate());
        assertEq(c.quoteRaised(), MON_TARGET);
        assertLt(before - CREATOR.balance, 5_000e18, "the overshoot was not refunded");
    }
}
