// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {ERC20Burnable} from "openzeppelin/token/ERC20/extensions/ERC20Burnable.sol";
import {IDokuSink} from "./IDokuSink.sol";

interface IHookPull {
    function pullSink(PoolId id) external returns (uint256);
}

/// @title BurnSink
/// @notice One market's burn destination. Pulls the market's share of the levy and destroys it.
contract BurnSink is IDokuSink {
    /// @notice The hook holding this market's levy.
    address public immutable hook;
    /// @notice The launch token this sink destroys.
    ERC20Burnable public immutable token;
    /// @notice The market this sink belongs to. One sink per market, never shared.
    PoolId public immutable poolId;

    error NothingToBurn();

    event Burned(uint256 amount, uint256 newTotalSupply);

    constructor(address hook_, address token_, PoolId poolId_) {
        hook = hook_;
        token = ERC20Burnable(token_);
        poolId = poolId_;
    }

    /// @notice Pull whatever this market has accrued and burn it. Permissionless.
    function burn() external returns (uint256 amount) {
        IHookPull(hook).pullSink(poolId);
        amount = token.balanceOf(address(this));
        if (amount == 0) revert NothingToBurn();
        token.burn(amount);
        emit Burned(amount, token.totalSupply());
    }

    /// @inheritdoc IDokuSink
    function sinkCurrencyIsToken() external pure returns (bool) {
        return true;
    }
}
