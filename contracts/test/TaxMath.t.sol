// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TaxMath} from "../src/lib/TaxMath.sol";

contract TaxMathTest is Test {
    uint16 constant START = 5000; // 50%
    uint32 constant WINDOW = 300; // 5 minutes

    // ---------------------------------------------------------------- CLOCK (the launch config)

    function test_clockEndpoints() public pure {
        assertEq(TaxMath.rate(TaxMath.Mode.CLOCK, START, WINDOW, 0, 0), START, "not 50% at launch");
        assertEq(TaxMath.rate(TaxMath.Mode.CLOCK, START, WINDOW, WINDOW, 0), 0, "not 0% at window");
    }

    function test_clockStaysZeroAfterWindow() public pure {
        assertEq(TaxMath.rate(TaxMath.Mode.CLOCK, START, WINDOW, WINDOW * 10, 0), 0);
    }

    function test_clockMidpointIsHalf() public pure {
        assertEq(TaxMath.rate(TaxMath.Mode.CLOCK, START, WINDOW, 150, 0), 2500);
    }

    /// Documents the accepted equilibrium from 01-§9.1: under CLOCK the tax expires on time even
    /// if nothing has sold, so waiting out the window buys at the bottom untaxed. This test exists
    /// to make that behaviour deliberate and visible rather than a surprise in production.
    function test_clockExpiresEvenWithZeroProgress() public pure {
        assertEq(TaxMath.rate(TaxMath.Mode.CLOCK, START, WINDOW, WINDOW, 0), 0);
    }

    // ------------------------------------------------------------------------------- PROGRESS

    function test_progressEndpoints() public pure {
        assertEq(TaxMath.rate(TaxMath.Mode.PROGRESS, START, WINDOW, 0, 0), START);
        assertEq(TaxMath.rate(TaxMath.Mode.PROGRESS, START, WINDOW, 0, 1e18), 0);
    }

    /// The property CLOCK lacks: time alone cannot retire the tax.
    function test_progressDoesNotExpireOnTime() public pure {
        assertEq(TaxMath.rate(TaxMath.Mode.PROGRESS, START, WINDOW, WINDOW * 100, 0), START);
    }

    // ------------------------------------------------------------------------------------ MAX

    function test_maxTakesTheHigher() public pure {
        // Window elapsed (clock says 0) but nothing sold (progress says 50%).
        assertEq(TaxMath.rate(TaxMath.Mode.MAX, START, WINDOW, WINDOW, 0), START);
        // Half sold (progress 25%) but only a fifth of the window gone (clock 40%).
        assertEq(TaxMath.rate(TaxMath.Mode.MAX, START, WINDOW, 60, 0.5e18), 4000);
    }

    // ------------------------------------------------------------------------------ properties

    function testFuzz_clockIsMonotonic(uint32 a, uint32 b) public pure {
        vm.assume(a < b);
        assertGe(
            TaxMath.rate(TaxMath.Mode.CLOCK, START, WINDOW, a, 0),
            TaxMath.rate(TaxMath.Mode.CLOCK, START, WINDOW, b, 0),
            "clock tax increased with time"
        );
    }

    function testFuzz_progressIsMonotonic(uint256 a, uint256 b) public pure {
        a = bound(a, 0, 1e18);
        b = bound(b, 0, 1e18);
        vm.assume(a < b);
        assertGe(
            TaxMath.rate(TaxMath.Mode.PROGRESS, START, WINDOW, 0, a),
            TaxMath.rate(TaxMath.Mode.PROGRESS, START, WINDOW, 0, b),
            "progress tax increased as the curve filled"
        );
    }

    /// No mode may ever exceed the configured start rate — that is the user-facing promise.
    function testFuzz_neverExceedsStart(uint8 mode, uint32 elapsed, uint256 progress) public pure {
        TaxMath.Mode m = TaxMath.Mode(bound(mode, 0, 2));
        progress = bound(progress, 0, type(uint256).max);
        assertLe(TaxMath.rate(m, START, WINDOW, elapsed, progress), START, "tax exceeded start");
    }

    /// A zero window must disable the tax outright rather than divide by zero.
    function test_zeroWindowDisablesClock() public pure {
        assertEq(TaxMath.rate(TaxMath.Mode.CLOCK, START, 0, 0, 0), 0);
    }
}
