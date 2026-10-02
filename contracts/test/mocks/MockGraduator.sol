// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {BondingCurve} from "../../src/BondingCurve.sol";

/// @notice The graduator's two curve-facing calls: the escrow credit, and the sink lookup
///         `feeRecipient` resolves through.
///
/// @dev `graduate` is deliberately absent — the auto-graduation attempt fails and is swallowed,
///      which is the state a REWARDS market's escrow test needs to exercise `release` by hand.
contract MockGraduator {
    address public sink;
    address public lastCurve;
    uint256 public lastAmount;
    uint256 public received;

    function setSink(address s) external {
        sink = s;
    }

    function sinkOf(address) external view returns (address) {
        return sink;
    }

    function creditCurveTax(address curve) external payable {
        lastCurve = curve;
        lastAmount = msg.value;
        received += msg.value;
    }

    function creditCurveTax(address curve, uint256 amount) external {
        lastCurve = curve;
        lastAmount = amount;
    }

    function release(BondingCurve c) external {
        c.release();
    }

    receive() external payable {}
}
