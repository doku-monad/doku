// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {Ownable} from "openzeppelin/access/Ownable.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {DokuFactory} from "../src/DokuFactory.sol";
import {DokuToken} from "../src/DokuToken.sol";
import {QuoteRegistry} from "../src/QuoteRegistry.sol";
import {CreatorSink} from "../src/sinks/CreatorSink.sol";
import {Sinks} from "../src/lib/Sinks.sol";
import {TaxMath} from "../src/lib/TaxMath.sol";
import {Launches} from "./helpers/Launches.sol";
import {Wiring} from "./helpers/Wiring.sol";

/// @notice Anti-snipe terms, generation 8: the start rate, the window and the decay mode are
///         factory defaults the owner can move, snapshotted into every curve at launch, and part
///         of the economics pin a launcher signs.
contract TaxTermsTest is Test {
    using Launches for DokuFactory;

    address constant OWNER = address(0x01);
    address constant TREASURY = address(0x7EA);
    address constant CREATOR = address(0xC0DE);
    address constant BUYER = address(0xB0B);
    address constant OTHER = address(0x0DD);
    uint256 constant MON_TARGET = 1_000e18;

    DokuFactory factory;
    QuoteRegistry registry;
    CreatorSink sink;

    function setUp() public {
        registry = new QuoteRegistry(OWNER);
        vm.prank(OWNER);
        registry.register(address(0), MON_TARGET);
        sink = new CreatorSink(OWNER);
        factory = new DokuFactory(OWNER, OWNER, TREASURY, address(registry), address(sink), 0);
        Wiring.wire(factory, OWNER);
        vm.prank(OWNER);
        sink.setFactory(address(factory));
        vm.deal(CREATOR, 100_000e18);
        vm.deal(BUYER, 100_000e18);
    }

    function _launch() internal returns (BondingCurve c) {
        DokuFactory.LaunchParams memory p = factory.native(Sinks.BURN);
        vm.prank(CREATOR);
        (address curve,) = factory.launch(p);
        c = BondingCurve(payable(curve));
    }

    function _terms() internal view returns (uint16 s, uint32 w, uint8 m) {
        (s, w, m) = factory.taxTerms();
    }

    // ---------------------------------------------------------------- the factory's defaults

    /// A factory nobody has configured launches exactly what generation 7 launched.
    function test_defaultsAreTheOldConstants() public view {
        (uint16 s, uint32 w, uint8 m) = _terms();
        BondingCurve impl = BondingCurve(payable(factory.curveImplementation()));
        assertEq(s, impl.TAX_START_BPS());
        assertEq(w, impl.TAX_WINDOW());
        assertEq(m, uint8(TaxMath.Mode.CLOCK));
    }

    function test_ownerSetsTheTerms_andTheyReachTheNextLaunch() public {
        BondingCurve before = _launch();
        vm.prank(OWNER);
        vm.expectEmit(true, true, true, true, address(factory));
        emit DokuFactory.TaxTermsChanged(5000, 3, uint8(TaxMath.Mode.CLOCK));
        factory.setTaxTerms(5000, 3, uint8(TaxMath.Mode.CLOCK));
        BondingCurve later = _launch();
        assertEq(before.taxWindow(), 300, "an existing curve moved");
        assertEq(later.taxWindow(), 3);
        assertEq(later.taxStartBps(), 5000);
        assertEq(uint8(later.taxMode()), uint8(TaxMath.Mode.CLOCK));
    }

    function test_onlyOwnerSetsTheTerms() public {
        vm.prank(OTHER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, OTHER));
        factory.setTaxTerms(5000, 3, 0);
        vm.prank(CREATOR);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, CREATOR));
        factory.setTaxTerms(5000, 3, 0);
    }

    function test_boundsAreEnforcedOnTheFactoryAndOnTheCurve() public {
        vm.startPrank(OWNER);
        vm.expectRevert(DokuFactory.TaxTermsOutOfRange.selector);
        factory.setTaxTerms(5001, 3, 0); // above the 50% ceiling
        vm.expectRevert(DokuFactory.TaxTermsOutOfRange.selector);
        factory.setTaxTerms(5000, 3601, 0); // above an hour
        vm.expectRevert(DokuFactory.TaxTermsOutOfRange.selector);
        factory.setTaxTerms(5000, 3, 3); // no such mode
        factory.setTaxTerms(0, 0, 0); // switched off is a legal choice
        vm.stopPrank();
        BondingCurve impl = new BondingCurve();
        BondingCurve c = BondingCurve(payable(Clones.clone(address(impl))));
        DokuToken t = DokuToken(Clones.clone(address(new DokuToken())));
        t.initialize("A", "AAA", address(c), false, "https://x/a.json");
        vm.expectRevert(BondingCurve.TaxTermsOutOfRange.selector);
        c.initialize(address(t), address(0), MON_TARGET, Sinks.BURN, address(0), 0, address(0), TREASURY, address(this), address(sink), 6000, 3, 0);
    }

    /// The pin a launcher signs covers the terms: a change between quote and send is a refusal.
    function test_termsAreInTheEconomicsPin() public {
        DokuFactory.LaunchParams memory p = factory.native(Sinks.BURN);
        vm.prank(OWNER);
        factory.setTaxTerms(5000, 3, 0);
        vm.prank(CREATOR);
        vm.expectRevert(DokuFactory.EconomicsChanged.selector);
        factory.launch(p);
        p.economicsPin = factory.economicsPin(address(0), Sinks.BURN, 0);
        vm.prank(CREATOR);
        factory.launch(p);
    }

    // ------------------------------------------------------------------- the curve's decay

    /// A three-second window: 50% in the launch block, ~25% halfway, nothing at three seconds.
    function test_threeSecondWindowDecaysAsPromised() public {
        vm.prank(OWNER);
        factory.setTaxTerms(5000, 3, uint8(TaxMath.Mode.CLOCK));
        BondingCurve c = _launch();
        uint256 t0 = vm.getBlockTimestamp();
        assertEq(c.taxRate(), 5000);
        vm.warp(t0 + 1);
        assertEq(c.taxRate(), 3333);
        vm.warp(t0 + 2);
        assertEq(c.taxRate(), 1666);
        vm.warp(t0 + 3);
        assertEq(c.taxRate(), 0);
        vm.warp(t0 + 400);
        assertEq(c.taxRate(), 0);
    }

    /// And the money follows the rate: a buy in the launch block pays it, a buy four seconds later does not.
    function test_theTaxIsLeviedInsideTheWindowAndNotAfter() public {
        vm.prank(OWNER);
        factory.setTaxTerms(5000, 3, uint8(TaxMath.Mode.CLOCK));
        BondingCurve c = _launch();
        (,, uint256 taxNow,,) = c.quoteBuy(1e18);
        assertGt(taxNow, 0);
        vm.prank(BUYER);
        c.buy{value: 1e18}(0, vm.getBlockTimestamp() + 1 hours);
        uint256 escrowed = c.taxEscrow();
        assertGt(escrowed, 0, "a buy in the launch block paid no anti-sniper tax");
        vm.warp(vm.getBlockTimestamp() + 4);
        (,, uint256 taxLater,,) = c.quoteBuy(1e18);
        assertEq(taxLater, 0);
        vm.prank(BUYER);
        c.buy{value: 1e18}(0, vm.getBlockTimestamp() + 1 hours);
        // `burnedByTax` also counts a BURN market's buyback; the anti-sniper leg alone is escrowed.
        assertEq(c.taxEscrow(), escrowed, "a buy after the window paid anti-sniper tax");
    }

    function test_progressModeIgnoresTheClock() public {
        vm.prank(OWNER);
        factory.setTaxTerms(5000, 3, uint8(TaxMath.Mode.PROGRESS));
        BondingCurve c = _launch();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        assertEq(c.taxRate(), 5000, "progress mode decays with the raise, not time");
        vm.prank(BUYER);
        c.buy{value: 500e18}(0, vm.getBlockTimestamp() + 1 hours);
        assertLt(c.taxRate(), 5000);
    }

    function test_switchedOffLeviesNothing() public {
        vm.prank(OWNER);
        factory.setTaxTerms(0, 0, 0);
        BondingCurve c = _launch();
        assertEq(c.taxRate(), 0);
        (,, uint256 tax,,) = c.quoteBuy(1e18);
        assertEq(tax, 0);
    }

    /// The ten-argument initialise still exists for everything that clones a curve directly, and
    /// still means what it meant: the constants.
    function test_directInitialiseKeepsTheDefaults() public {
        BondingCurve impl = new BondingCurve();
        BondingCurve c = BondingCurve(payable(Clones.clone(address(impl))));
        DokuToken t = DokuToken(Clones.clone(address(new DokuToken())));
        t.initialize("A", "AAA", address(c), false, "https://x/a.json");
        c.initialize(address(t), address(0), MON_TARGET, Sinks.BURN, address(0), 0, address(0), TREASURY, address(this), address(sink));
        assertEq(c.taxWindow(), c.TAX_WINDOW());
        assertEq(c.taxStartBps(), c.TAX_START_BPS());
        vm.expectRevert(BondingCurve.AlreadyInitialised.selector);
        c.initialize(address(t), address(0), MON_TARGET, Sinks.BURN, address(0), 0, address(0), TREASURY, address(this), address(sink), 5000, 3, 0);
    }
}
