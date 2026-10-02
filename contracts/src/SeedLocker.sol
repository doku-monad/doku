// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin/token/ERC20/utils/SafeERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";

/// @title SeedLocker
/// @notice Holds a graduated market's liquidity position forever, and forwards only its FEES.
interface IDokuHookCredit {
    function creditCurveTax(PoolId id) external payable;
    function creditCurveTax(PoolId id, uint256 amount) external;
}

contract SeedLocker {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    /// @notice The v4 PositionManager holding the position this contract owns.
    IPositionManager public immutable positionManager;

    /// @notice The levy hook, which is also the ledger a quote-paying market's fees are credited
    ///         through.
    address public immutable hook;
    /// @notice The only address that ever pays this contract. See `receive`.
    address public immutable poolManager;

    /// @notice The only address that may lock a position here.
    address public immutable graduation;

    struct Locked {
        PoolKey key;
        address sink;
        uint8 sinkKind;
        bool quoteIsCurrency0;
    }

    mapping(uint256 tokenId => Locked) private _locked;

    /// @notice A position was locked here at graduation.
    event Locked_(uint256 indexed tokenId, address indexed sink);
    /// @notice A position's accrued fees were forwarded to its sink.
    event Collected(uint256 indexed tokenId, address indexed sink);

    error NotGraduation();
    error OnlyPoolManagerPays();
    error AlreadyLocked();
    error UnknownPosition();

    uint8 private constant BURN = 0;

    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;

    constructor(IPositionManager positionManager_, address hook_, address poolManager_) {
        positionManager = positionManager_;
        hook = hook_;
        poolManager = poolManager_;
        graduation = msg.sender;
    }

    receive() external payable {
        if (msg.sender != poolManager) revert OnlyPoolManagerPays();
    }

    /// @notice Records where a newly minted seed position's fees should go.
    function lock(uint256 tokenId, PoolKey calldata key, address sink, uint8 sinkKind, bool quoteIsCurrency0)
        external
    {
        if (msg.sender != graduation) revert NotGraduation();
        if (sink == address(0)) revert UnknownPosition();
        if (_locked[tokenId].sink != address(0)) revert AlreadyLocked();

        _locked[tokenId] = Locked({key: key, sink: sink, sinkKind: sinkKind, quoteIsCurrency0: quoteIsCurrency0});
        emit Locked_(tokenId, sink);
    }

    /// @notice Forwards a locked position's accrued fees to its sink. Permissionless.
    function collect(uint256 tokenId) external {
        Locked memory position = _locked[tokenId];
        if (position.sink == address(0)) revert UnknownPosition();

        bytes memory actions = abi.encodePacked(uint8(Actions.DECREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));

        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(tokenId, uint256(0), uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(position.key.currency0, position.key.currency1, address(this));

        (Currency quote, Currency tokenC) = position.quoteIsCurrency0
            ? (position.key.currency0, position.key.currency1)
            : (position.key.currency1, position.key.currency0);

        uint256 qBefore = _held(quote);
        uint256 tBefore = _held(tokenC);

        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);

        uint256 qNow = _held(quote);
        uint256 q = qNow > qBefore ? qNow - qBefore : 0;
        if (q != 0 && position.sinkKind != BURN) {
            PoolId id = position.key.toId();
            if (quote.isAddressZero()) {
                IDokuHookCredit(hook).creditCurveTax{value: q}(id);
            } else {
                IERC20(Currency.unwrap(quote)).forceApprove(hook, q);
                IDokuHookCredit(hook).creditCurveTax(id, q);
            }
        }

        uint256 tNow = _held(tokenC);
        uint256 tokens = tNow > tBefore ? tNow - tBefore : 0;
        if (tokens != 0) {
            IERC20(Currency.unwrap(tokenC)).safeTransfer(position.sinkKind == BURN ? position.sink : DEAD, tokens);
        }

        emit Collected(tokenId, position.sink);
    }

    function _held(Currency c) private view returns (uint256) {
        return c.isAddressZero() ? address(this).balance : IERC20(Currency.unwrap(c)).balanceOf(address(this));
    }

    /// @notice The pool and sink a locked position belongs to.
    function positionOf(uint256 tokenId)
        external
        view
        returns (PoolKey memory key, address sink, uint8 sinkKind, bool quoteIsCurrency0)
    {
        Locked memory position = _locked[tokenId];
        return (position.key, position.sink, position.sinkKind, position.quoteIsCurrency0);
    }
}
