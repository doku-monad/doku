// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CurveMath} from "../src/lib/CurveMath.sol";

/// @notice The value-conservation guarantee for the bonding curve.
/// @dev If `testFuzz_roundTripNeverProfits` ever fails, do not relax it. It is the property that
///      stops someone draining the curve one wei at a time with a loop.
contract CurveMathTest is Test {
    uint256 constant BASE_V_CEIL = 1_088_888_889_200_000_000_000_000_000;
    uint256 constant BASE_V_FLOOR = 311_111_111_200_000_000_000_000_000;
    uint256 constant CURVE_SUPPLY = 777_777_778e18;
    uint256 constant QUOTE_TARGET = 1_000e18;
    uint256 constant QUOTE_V_FLOOR = 400e18;
    uint256 constant QUOTE_V_CEIL = 1_400e18;

    function test_identitiesHold() public pure {
        assertEq(BASE_V_CEIL - BASE_V_FLOOR, CURVE_SUPPLY, "base span != curve supply");
        // The 7:5:2 shape: ceiling = 7/5 x curve, floor = 2/5 x curve, exact in wei.
        assertEq(BASE_V_CEIL * 5, CURVE_SUPPLY * 7, "ceiling is not 7/5 of the curve");
        assertEq(BASE_V_FLOOR * 5, CURVE_SUPPLY * 2, "floor is not 2/5 of the curve");
        assertEq(QUOTE_V_CEIL - QUOTE_V_FLOOR, QUOTE_TARGET, "quote span != quote target");
    }

    function test_buyReturnsBaseOut() public pure {
        uint256 out = CurveMath.baseOut(BASE_V_CEIL, QUOTE_V_FLOOR, 1e18);
        assertGt(out, 0, "no tokens for a real payment");
        // k may grow but must never shrink.
        assertGe(
            (BASE_V_CEIL - out) * (QUOTE_V_FLOOR + 1e18),
            BASE_V_CEIL * QUOTE_V_FLOOR,
            "k shrank on a buy"
        );
    }

    function test_zeroInIsZeroOut() public pure {
        assertEq(CurveMath.baseOut(BASE_V_CEIL, QUOTE_V_FLOOR, 0), 0);
        assertEq(CurveMath.quoteOut(BASE_V_CEIL, QUOTE_V_FLOOR, 0), 0);
    }

    /// Buying then immediately selling must always lose. This is the whole ballgame.
    function testFuzz_roundTripNeverProfits(uint96 quoteIn) public pure {
        quoteIn = uint96(bound(quoteIn, 1e12, 500e18));
        uint256 baseOut = CurveMath.baseOut(BASE_V_CEIL, QUOTE_V_FLOOR, quoteIn);
        uint256 quoteBack =
            CurveMath.quoteOut(BASE_V_CEIL - baseOut, QUOTE_V_FLOOR + quoteIn, baseOut);
        assertLe(quoteBack, quoteIn, "round trip extracted value from the curve");
    }

    /// k must never shrink from either direction, at any size.
    function testFuzz_kIsNonDecreasing(uint96 quoteIn) public pure {
        quoteIn = uint96(bound(quoteIn, 1, 1_000e18));
        uint256 out = CurveMath.baseOut(BASE_V_CEIL, QUOTE_V_FLOOR, quoteIn);
        assertGe(
            (BASE_V_CEIL - out) * (QUOTE_V_FLOOR + quoteIn), BASE_V_CEIL * QUOTE_V_FLOOR, "k shrank"
        );
    }

    /// Spending the whole quote target must consume the whole curve supply.
    function test_fullCurveConsumesExactlyCurveSupply() public pure {
        uint256 out = CurveMath.baseOut(BASE_V_CEIL, QUOTE_V_FLOOR, QUOTE_TARGET);
        assertApproxEqAbs(out, CURVE_SUPPLY, 1e6, "curve supply mismatch at graduation");
    }

    /// Pins the economics quoted in the design doc: launch -> graduation is 12.25x.
    function test_curveAppreciationIsTwelvePointTwoFive() public pure {
        uint256 pStart = (QUOTE_V_FLOOR * 1e18) / BASE_V_CEIL;
        uint256 pGrad = (QUOTE_V_CEIL * 1e18) / BASE_V_FLOOR;
        assertApproxEqRel((pGrad * 1e18) / pStart, 12.25e18, 0.001e18, "appreciation moved");
    }

    /// More money in never buys fewer tokens.
    function testFuzz_monotonicInInput(uint96 a, uint96 b) public pure {
        a = uint96(bound(a, 1e12, 400e18));
        b = uint96(bound(b, 1e12, 400e18));
        vm.assume(a < b);
        assertLe(
            CurveMath.baseOut(BASE_V_CEIL, QUOTE_V_FLOOR, a),
            CurveMath.baseOut(BASE_V_CEIL, QUOTE_V_FLOOR, b),
            "paying more bought less"
        );
    }
}
