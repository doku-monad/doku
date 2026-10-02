// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

/// @title Sinks
/// @notice Where a market's routed share goes. Chosen by the creator at launch, immutable for the
///         life of the market.
/// @dev One definition shared by factory, curve, graduator and hook. The discriminant also fixes
///      the levy currency: BURN is paid in the token, REWARDS and CREATOR in the quote, so no sink
///      ever has to swap.
library Sinks {
    /// @notice Buy the token back and burn it. Levy is taken in the token. The UI calls this "buyback".
    uint8 internal constant BURN = 0;
    /// @notice Pay the quote out to holders pro rata. Levy is taken in the quote. The UI: "holders".
    uint8 internal constant REWARDS = 1;
    /// @notice Pay the quote to a wallet the creator named. Levy is taken in the quote. The UI: "creator".
    /// @dev Same levy currency as REWARDS; only the destination differs.
    uint8 internal constant CREATOR = 2;

    function isValid(uint8 sink) internal pure returns (bool) {
        return sink <= CREATOR;
    }
}
