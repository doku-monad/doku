// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "openzeppelin/token/ERC20/extensions/ERC20Burnable.sol";
import {Checkpoints} from "openzeppelin/utils/structs/Checkpoints.sol";
import {SafeCast} from "openzeppelin/utils/math/SafeCast.sol";

/// @title DokuToken
/// @notice One market's token: a plain ERC20 with no hooks, fees, blacklist, pause, owner or
///         post-launch mint. Both taxes live on the curve and in the hook so this can stay plain.
/// @dev A fee-on-transfer token cannot settle against the PoolManager's flash accounting, and would
///      tax a swap twice. See docs/doku/01-architecture-decisions.md §3.1.
///      EIP-1167 clone: state is set in `initialize`; `name`/`symbol` are overridden because
///      OpenZeppelin keeps them in constructor-set storage. `metadataURI()` (launchpad name) and
///      `contractURI()` (ERC-7572) return the HTTPS document the factory assigns at launch; no setter.
contract DokuToken is ERC20, ERC20Burnable {
    using Checkpoints for Checkpoints.Trace208;
    /// @notice Fixed forever at launch. 777,777,778 is sold on the curve, 222,222,222 seeds the pool.
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    error AlreadyInitialised();
    error ZeroCurve();
    error BlockNotYetMined(uint256 requested, uint256 current);
    error EmptyMetadataURI();

    /// @notice ERC-7572. Emitted once, at initialisation.
    event ContractURIUpdated();

    string private _tokenName;
    string private _tokenSymbol;
    bool private _initialised;

    /// @notice The curve that received the supply. Informational; it holds no privileges here.
    address public curve;

    /// @notice Whether this token records balance history. Set once; only a REWARDS market needs it.
    bool public trackHistory;

    mapping(address => Checkpoints.Trace208) private _balanceHistory;
    Checkpoints.Trace208 private _supplyHistory;

    /// @dev Appended after every earlier slot; `script/check-token-layout.sh` holds the layout.
    string private _metadataURI;

    /// @dev The implementation is initialised at construction so it can never be claimed.
    constructor() ERC20("", "") {
        _initialised = true;
    }

    /// @param metadataURI_ Where this token's metadata document lives. Set once, never changed.
    function initialize(
        string calldata name_,
        string calldata symbol_,
        address curve_,
        bool trackHistory_,
        string calldata metadataURI_
    ) external {
        if (_initialised) revert AlreadyInitialised();
        if (curve_ == address(0)) revert ZeroCurve();
        if (bytes(metadataURI_).length == 0) revert EmptyMetadataURI();
        _initialised = true;
        _tokenName = name_;
        _tokenSymbol = symbol_;
        curve = curve_;
        trackHistory = trackHistory_;
        _metadataURI = metadataURI_;
        emit ContractURIUpdated();
        // The only mint that will ever happen. There is no other path to `_mint`.
        _mint(curve_, TOTAL_SUPPLY);
    }

    /// @notice The URI of this token's metadata document (name, description, image, links). Fixed at launch.
    function metadataURI() external view returns (string memory) {
        return _metadataURI;
    }

    /// @notice ERC-7572 contract-level metadata: the same document as `metadataURI()`.
    function contractURI() external view returns (string memory) {
        return _metadataURI;
    }

    /// @notice This account's balance as of the end of `blockNumber`.
    /// @dev Reverts on an unmined block, so a snapshot is always in the past.
    function getPastBalance(address account, uint256 blockNumber) external view returns (uint256) {
        if (blockNumber >= block.number) revert BlockNotYetMined(blockNumber, block.number);
        return _balanceHistory[account].upperLookupRecent(SafeCast.toUint48(blockNumber));
    }

    /// @notice Total supply as of the end of `blockNumber`.
    /// @dev Checkpointed because supply shrinks (BURN markets burn their own token).
    function getPastTotalSupply(uint256 blockNumber) external view returns (uint256) {
        if (blockNumber >= block.number) revert BlockNotYetMined(blockNumber, block.number);
        return _supplyHistory.upperLookupRecent(SafeCast.toUint48(blockNumber));
    }

    /// @dev Records, never deducts: a transfer hook that took a cut would make the token untradeable in v4.
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (!trackHistory) return;
        uint48 key = SafeCast.toUint48(block.number);
        if (from == address(0) || to == address(0)) {
            _supplyHistory.push(key, SafeCast.toUint208(totalSupply()));
        }
        if (from != address(0)) {
            _balanceHistory[from].push(key, SafeCast.toUint208(balanceOf(from)));
        }
        if (to != address(0) && to != from) {
            _balanceHistory[to].push(key, SafeCast.toUint208(balanceOf(to)));
        }
    }

    function name() public view override returns (string memory) {
        return _tokenName;
    }

    function symbol() public view override returns (string memory) {
        return _tokenSymbol;
    }
}
