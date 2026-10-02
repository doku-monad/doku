// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {DokuToken} from "../src/DokuToken.sol";
import {Sinks} from "../src/lib/Sinks.sol";

/// @notice Quote views must agree with execution, exactly.
///
/// @dev These exist so the interface does not have to reimplement the curve in JavaScript. That
///      duplicate would start correct and drift — a fee ordering changed here, a tax window
///      retuned there — and the symptom is a quoted number that does not match the fill, which
///      users read as the protocol taking more than it said. Agreement is asserted against actual
///      trades rather than against a second copy of the same arithmetic.
contract QuoteTest is Test {
    address constant TRADER = address(0x77AD);
    address constant TREASURY = address(0x7EA);
    uint256 constant TARGET = 1_000e18;

    BondingCurve curve;
    DokuToken token;

    function setUp() public {
        curve = BondingCurve(payable(Clones.clone(address(new BondingCurve()))));
        token = DokuToken(Clones.clone(address(new DokuToken())));
        token.initialize("Quote", "QUOTE", address(curve), false, "https://cdn.doku.family/metadata/test.json");
        curve.initialize(
            address(token), address(0), TARGET, Sinks.BURN, address(0), 0, address(0), TREASURY, address(this), address(0)
        );
        vm.deal(TRADER, 100_000e18);
    }

    /// Inside the tax window, where the quote is hardest to get right.
    function test_quoteBuyMatchesExecutionWhileTaxed() public {
        (uint256 quoted, uint256 fee, uint256 tax,,) = curve.quoteBuy(10e18);

        vm.prank(TRADER);
        uint256 actual = curve.buy{value: 10e18}(0, block.timestamp);

        assertEq(actual, quoted, "quote disagreed with the fill");
        // The quoted fee is the whole 1%; the protocol booked 30 bps of it and a BURN market
        // spent the rest on the curve.
        assertEq(curve.pendingProtocol(), (fee * 30) / 100, "quoted fee wrong");
        assertEq(curve.taxEscrow(), tax, "quoted tax wrong");
    }

    function test_quoteBuyMatchesExecutionAfterTheWindow() public {
        vm.warp(block.timestamp + curve.TAX_WINDOW() + 1);
        (uint256 quoted,, uint256 tax,,) = curve.quoteBuy(10e18);
        assertEq(tax, 0, "tax should be zero after the window");

        vm.prank(TRADER);
        assertEq(curve.buy{value: 10e18}(0, block.timestamp), quoted);
    }

    /// The overshoot path, which unwinds fee and tax on the refunded portion. This is where a
    /// naive quote is most likely to be wrong, and where being wrong looks like theft.
    function test_quoteBuyMatchesExecutionWhenOvershooting() public {
        (uint256 quoted,,,, uint256 refund) = curve.quoteBuy(5_000e18);
        assertGt(refund, 0, "expected a refund on a filling buy");

        uint256 balanceBefore = TRADER.balance;
        vm.prank(TRADER);
        uint256 actual = curve.buy{value: 5_000e18}(0, block.timestamp);

        assertEq(actual, quoted, "quote disagreed with the fill");
        assertEq(balanceBefore - TRADER.balance, 5_000e18 - refund, "quoted refund wrong");
    }

    function test_quoteSellMatchesExecution() public {
        vm.prank(TRADER);
        curve.buy{value: 100e18}(0, block.timestamp);

        uint256 half = token.balanceOf(TRADER) / 2;
        (uint256 quoted, uint256 fee,) = curve.quoteSell(half);

        vm.startPrank(TRADER);
        token.approve(address(curve), half);
        uint256 before = TRADER.balance;
        uint256 actual = curve.sell(half, 0, block.timestamp);
        vm.stopPrank();

        assertEq(actual, quoted, "quote disagreed with the fill");
        assertEq(TRADER.balance - before, quoted, "seller received something else");
        assertGt(fee, 0, "sells carry a fee");
    }

    /// Fuzzed, because agreement at three hand-picked sizes is agreement at three hand-picked
    /// sizes. Rounding is where a quote and a fill part company.
    function testFuzz_quoteBuyAlwaysMatchesExecution(uint96 amount) public {
        vm.assume(amount > 1_000 && amount < 5_000e18);
        (uint256 quoted,,,,) = curve.quoteBuy(amount);
        vm.prank(TRADER);
        assertEq(curve.buy{value: amount}(0, block.timestamp), quoted);
    }

    function test_quoteBuyOnAClosedCurveIsZero() public {
        vm.prank(TRADER);
        curve.buy{value: 5_000e18}(0, block.timestamp);
        assertTrue(curve.readyToGraduate());

        (uint256 quoted,,,, uint256 refund) = curve.quoteBuy(1e18);
        // A closed curve cannot sell, and a quote that says otherwise invites a doomed signature.
        assertEq(quoted, 0);
        assertEq(refund, 1e18);
    }
}
