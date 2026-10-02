// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

/// @title IDokuSink
/// @notice The minimum a market's sink must expose.
/// @dev The hook never calls a sink (it credits a ledger and the sink pulls), so a reverting sink
///      cannot brick a swap or a sweep.
interface IDokuSink {
    /// @notice True if this sink is paid in the launch token, false if in the quote.
    function sinkCurrencyIsToken() external pure returns (bool);
}
