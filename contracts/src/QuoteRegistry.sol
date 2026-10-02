// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Ownable2Step, Ownable} from "openzeppelin/access/Ownable2Step.sol";
import {IERC20Metadata} from "openzeppelin/token/ERC20/extensions/IERC20Metadata.sol";
import {DOKU_MIN_QUOTE_TARGET, DOKU_MAX_QUOTE_TARGET} from "./BondingCurve.sol";

/// @title QuoteRegistry
/// @notice Which assets a market may be priced in, and how much of each a curve must raise.
/// @dev Targets are per asset in RAW units. A market snapshots its target at launch, so retuning
///      here changes only future launches. `address(0)` is native MON (18 decimals); anything else
///      must answer `decimals()`.
contract QuoteRegistry is Ownable2Step {
    struct QuoteAsset {
        bool enabled;
        uint8 decimals;
        uint256 quoteTarget;
    }

    error AlreadyRegistered(address asset);
    error NotRegistered(address asset);
    error ZeroTarget();
    /// @dev Mirrors `BondingCurve.TargetTooSmall`; refused when configured, not at the next launch.
    error TargetTooSmall(uint256 target, uint256 minimum);
    /// @dev Mirrors `BondingCurve.TargetNotDivisibleByFive`. The curve's virtual floor is `target * 2 / 5`;
    ///      a truncated floor leaves a filled market un-graduatable, and the target is shared by every
    ///      market in the asset.
    error TargetNotDivisibleByFive(uint256 target);
    /// @dev Mirrors `BondingCurve.TargetTooLarge`; refused here so a bad target fails at configuration.
    error TargetTooLarge(uint256 target, uint256 maximum);

    /// @notice Per-asset terms. A `quoteTarget` of zero means "never registered".
    mapping(address => QuoteAsset) public assets;

    event QuoteAssetRegistered(address indexed asset, uint8 decimals, uint256 quoteTarget);
    event QuoteTargetChanged(address indexed asset, uint256 previous, uint256 current);
    event QuoteAssetEnabled(address indexed asset, bool enabled);

    constructor(address owner_) Ownable(owner_) {}

    /// @notice Add an asset. Reads its decimals; native is 18. Enabled immediately.
    function register(address asset, uint256 quoteTarget_) external onlyOwner {
        if (assets[asset].quoteTarget != 0) revert AlreadyRegistered(asset);
        _checkTarget(quoteTarget_);
        uint8 dec = asset == address(0) ? 18 : IERC20Metadata(asset).decimals();
        assets[asset] = QuoteAsset({enabled: true, decimals: dec, quoteTarget: quoteTarget_});
        emit QuoteAssetRegistered(asset, dec, quoteTarget_);
    }

    /// @notice Change what FUTURE markets in this asset raise. Live curves keep their snapshot.
    function setQuoteTarget(address asset, uint256 target) external onlyOwner {
        QuoteAsset storage a = assets[asset];
        if (a.quoteTarget == 0) revert NotRegistered(asset);
        _checkTarget(target);
        emit QuoteTargetChanged(asset, a.quoteTarget, target);
        a.quoteTarget = target;
    }

    /// @notice Open or close the asset for new launches. Never touches a live market.
    function setEnabled(address asset, bool on) external onlyOwner {
        if (assets[asset].quoteTarget == 0) revert NotRegistered(asset);
        assets[asset].enabled = on;
        emit QuoteAssetEnabled(asset, on);
    }

    function isEnabled(address asset) external view returns (bool) {
        return assets[asset].enabled;
    }

    function quoteTarget(address asset) external view returns (uint256) {
        return assets[asset].quoteTarget;
    }

    function decimalsOf(address asset) external view returns (uint8) {
        return assets[asset].decimals;
    }

    function _checkTarget(uint256 target) private pure {
        if (target == 0) revert ZeroTarget();
        if (target < DOKU_MIN_QUOTE_TARGET) revert TargetTooSmall(target, DOKU_MIN_QUOTE_TARGET);
        if (target > DOKU_MAX_QUOTE_TARGET) revert TargetTooLarge(target, DOKU_MAX_QUOTE_TARGET);
        if (target % 5 != 0) revert TargetNotDivisibleByFive(target);
    }
}
