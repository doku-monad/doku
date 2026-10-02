// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

/// @notice The factory as `DokuGraduation` sees it: a register of what is a market.
/// @dev Every curve is a market unless a test says otherwise, so the suites that build curves by
///      hand — with no factory anywhere — keep working. `deny` is what lets a test prove the gate
///      actually refuses an impostor.
contract MarketsStub {
    mapping(address => bool) private _denied;

    function deny(address curve) external {
        _denied[curve] = true;
    }

    function isMarket(address curve) external view returns (bool) {
        return !_denied[curve];
    }
}
