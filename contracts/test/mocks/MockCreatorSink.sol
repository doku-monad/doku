// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";

/// @notice Records what a curve credits, so the deferred path is asserted on rather than assumed.
contract MockCreatorSink {
    address public lastWho;
    address public lastQuote;
    uint256 public lastAmount;
    uint256 public received;
    uint256 public credits;

    function credit(address who, address quote, uint256 amount) external payable {
        lastWho = who;
        lastQuote = quote;
        lastAmount = amount;
        received += msg.value;
        credits += 1;
        if (quote != address(0)) IERC20(quote).transferFrom(msg.sender, address(this), amount);
    }
}
