// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

/// @title CurveMath
/// @notice Constant-product pricing over virtual reserves, in 18-decimal uint256 arithmetic.
/// @dev Every rounding favours the pool (reserve kept rounds up, user output is the remainder), or a
///      buy-sell loop would net a wei per round. `fullMulDiv` keeps `base * quote` from overflowing.
library CurveMath {
    /// @notice Base tokens out for `quoteIn` of MON in.
    /// @dev Rounds the user's output DOWN.
    function baseOut(uint256 baseReserve, uint256 quoteReserve, uint256 quoteIn)
        internal
        pure
        returns (uint256)
    {
        if (quoteIn == 0) return 0;
        // k = baseReserve * quoteReserve; newBase = k / (quoteReserve + quoteIn), rounded up.
        uint256 newBase =
            FixedPointMathLib.fullMulDivUp(baseReserve, quoteReserve, quoteReserve + quoteIn);
        // newBase <= baseReserve for any quoteIn > 0, so this cannot underflow.
        return baseReserve - newBase;
    }

    /// @notice MON out for `baseIn` of base tokens in.
    /// @dev Rounds the user's output DOWN.
    function quoteOut(uint256 baseReserve, uint256 quoteReserve, uint256 baseIn)
        internal
        pure
        returns (uint256)
    {
        if (baseIn == 0) return 0;
        uint256 newQuote =
            FixedPointMathLib.fullMulDivUp(baseReserve, quoteReserve, baseReserve + baseIn);
        return quoteReserve - newQuote;
    }
}
