// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {ReentrancyGuard} from "openzeppelin/utils/ReentrancyGuard.sol";
import {IDokuSink} from "./IDokuSink.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin/token/ERC20/utils/SafeERC20.sol";

interface IHookPull {
    function pullSink(PoolId id) external returns (uint256);
}

interface ICheckpointedToken {
    function getPastBalance(address account, uint256 blockNumber) external view returns (uint256);
    function getPastTotalSupply(uint256 blockNumber) external view returns (uint256);
}

/// @title RewardVault
/// @notice One market's holder-reward destination. Pays the market's QUOTE out pro rata, by epoch,
///         on a pull.
contract RewardVault is IDokuSink, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Blocks between epoch snapshots. A fixed grid, not a minimum interval.
    uint256 public constant EPOCH_BLOCKS = 216_000;

    /// @notice Epochs after an epoch's closing grid line before `sweepResidue` may carry its remainder forward.
    uint256 public constant RESIDUE_WINDOW_EPOCHS = 26;

    /// @notice The most intervals one `fund()` may spread its pull across.
    /// @dev Spreading forward stops a pull from being timed into one epoch's denominator.
    uint256 public constant MAX_SPREAD_INTERVALS = 7;

    /// @notice The asset dividends are paid in: `address(0)` for native MON, else an ERC-20.
    address public immutable quote;

    /// @notice Anti-spam floor: an epoch worth less than this is not worth the claim gas. Never
    ///         zero.
    uint256 public immutable minEpochAmount;

    address public immutable hook;
    ICheckpointedToken public immutable token;
    PoolId public immutable poolId;
    /// @notice The block epoch 0 is anchored to — the block the curve became ready to graduate.
    uint256 public immutable genesisBlock;

    address[9] private _excluded;

    error LastSlotIsReserved();
    error HolderExcluded(address holder);
    error NotMatured(uint256 epochIndex, uint256 claimableFrom);
    error EpochOverspent(uint256 epochIndex, uint256 claimed, uint256 amount);
    error ResidueNotMature(uint256 epochIndex, uint256 sweepableFrom);
    error NothingToSweep(uint256 epochIndex);

    struct Epoch {
        uint256 snapshotBlock;
        uint256 amount;
        uint256 eligibleSupply;
        uint256 claimed;
    }

    Epoch[] public epochs;
    /// @notice Total quote this vault holds that has been funded and not yet handed to an epoch.
    uint256 public unallocated;

    /// @notice Quote earned during interval `k`, awaiting epoch `k`.
    mapping(uint256 => uint256) public pending;

    mapping(uint256 => mapping(address => bool)) public hasClaimed;

    error TooEarly(uint256 availableAtBlock);
    error AlreadyClaimed(uint256 epoch);
    error NothingToClaim();
    error TransferFailed();
    error BadRange();
    error NotHolder(address holder, address caller);
    error ZeroAddress();
    error OnlyHookPays();

    event Funded(uint256 amount);
    event Bucketed(uint256 indexed interval, uint256 amount, uint256 total);
    event EpochCreated(uint256 indexed epoch, uint256 snapshotBlock, uint256 amount, uint256 eligibleSupply);
    event CarriedForward(uint256 indexed fromInterval, uint256 amount, string reason);
    event ResidueSwept(uint256 indexed epoch, uint256 indexed toInterval, uint256 amount);
    event Claimed(address indexed holder, uint256 indexed epoch, uint256 amount);

    constructor(
        address hook_,
        address token_,
        PoolId poolId_,
        address quote_,
        uint256 quoteTarget_,
        uint256 genesisBlock_,
        address[9] memory excluded_
    ) {
        hook = hook_;
        token = ICheckpointedToken(token_);
        poolId = poolId_;
        quote = quote_;
        uint256 floor_ = quoteTarget_ / 10_000;
        minEpochAmount = floor_ == 0 ? 1 : floor_;
        genesisBlock = genesisBlock_;
        if (excluded_[8] != address(0)) revert LastSlotIsReserved();
        _excluded = excluded_;

        // The vault itself never counts in the denominator.
        _excluded[8] = address(this);
    }

    /// @notice Native quote lands here for the length of one `fund`, and only the hook may send it.
    receive() external payable {
        if (msg.sender != hook) revert OnlyHookPays();
    }

    /// @notice Move this market's accrued levy out of the hook and into the vault. Permissionless.
    function fund() external nonReentrant returns (uint256 amount) {
        uint256 before = _held();
        IHookPull(hook).pullSink(poolId);
        amount = _held() - before;
        unallocated += amount;
        uint256 k = intervalAt(block.number);
        uint256 n = spreadWidth(amount);
        uint256 each = amount / n;
        uint256 first = amount - each * (n - 1);
        emit Funded(amount);
        for (uint256 j; j < n; ++j) {
            uint256 add = j == 0 ? first : each;
            uint256 total = pending[k + j] + add;
            pending[k + j] = total;
            emit Bucketed(k + j, add, total);
        }
    }

    /// @notice How many consecutive intervals a pull of `amount` is spread across, starting at the
    ///         interval it is pulled in: `clamp(amount / minEpochAmount, 1, MAX_SPREAD_INTERVALS)`.
    function spreadWidth(uint256 amount) public view returns (uint256 n) {
        n = amount / minEpochAmount;
        if (n == 0) return 1;
        if (n > MAX_SPREAD_INTERVALS) return MAX_SPREAD_INTERVALS;
    }

    function _held() private view returns (uint256) {
        return quote == address(0) ? address(this).balance : IERC20(quote).balanceOf(address(this));
    }

    function _pay(address to, uint256 amount) private {
        if (quote == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(quote).safeTransfer(to, amount);
        }
    }

    /// @notice The block epoch `k` snapshots at. A fixed grid — this is the anti-gaming property.
    function snapshotBlockFor(uint256 k) public view returns (uint256) {
        return genesisBlock + (k + 1) * EPOCH_BLOCKS;
    }

    /// @notice The interval — and therefore the epoch — a fee arriving at `blockNumber` belongs to.
    function intervalAt(uint256 blockNumber) public view returns (uint256) {
        uint256 firstLine = genesisBlock + EPOCH_BLOCKS; // == snapshotBlockFor(0)
        if (blockNumber <= firstLine) return 0;
        return (blockNumber - genesisBlock) / EPOCH_BLOCKS - 1;
    }

    /// @notice The interval `fund` would credit right now.
    function currentInterval() external view returns (uint256) {
        return intervalAt(block.number);
    }

    /// @notice Open the next epoch against the money ITS OWN interval earned. Permissionless.
    function createEpoch() external nonReentrant returns (uint256 index) {
        return _openEpoch();
    }

    /// @notice Catch a lagging grid up, up to `maxSteps` epochs in one transaction.
    function createEpochs(uint256 maxSteps) external nonReentrant returns (uint256 opened) {
        for (; opened < maxSteps; ++opened) {
            if (block.number <= snapshotBlockFor(epochs.length + 1)) break;
            _openEpoch();
        }
        if (opened == 0) revert TooEarly(snapshotBlockFor(epochs.length + 1) + 1);
    }

    function _openEpoch() private returns (uint256 index) {
        index = epochs.length;
        uint256 close = snapshotBlockFor(index + 1);
        if (block.number <= close) revert TooEarly(close + 1);

        uint256 snap = snapshotBlockFor(index);
        uint256 amount = pending[index];
        if (amount != 0) delete pending[index];

        uint256 es;
        if (amount != 0 && amount >= minEpochAmount) {
            es = eligibleSupplyAt(snap);
            if (es == 0) {
                pending[index + 1] += amount;
                emit CarriedForward(index, amount, "no eligible supply");
                amount = 0;
            } else {
                unallocated -= amount;
            }
        } else if (amount != 0) {
            pending[index + 1] += amount;
            emit CarriedForward(index, amount, "below minEpochAmount");
            amount = 0;
        }

        epochs.push(Epoch({snapshotBlock: snap, amount: amount, eligibleSupply: es, claimed: 0}));
        emit EpochCreated(index, snap, amount, es);
    }

    /// @notice The first block at which epoch `k`'s remainder may be swept forward. Up to it, the
    ///         money is still its own holders'.
    function sweepableFrom(uint256 k) public view returns (uint256) {
        return snapshotBlockFor(k + 1) + RESIDUE_WINDOW_EPOCHS * EPOCH_BLOCKS + 1;
    }

    /// @notice Carry a matured epoch's unreachable remainder forward into the current interval. Permissionless.
    function sweepResidue(uint256 k) external nonReentrant returns (uint256 moved) {
        if (k >= epochs.length) revert BadRange();
        uint256 opensAt = sweepableFrom(k);
        if (block.number < opensAt) revert ResidueNotMature(k, opensAt);

        Epoch storage e = epochs[k];
        moved = e.amount - e.claimed;
        if (moved == 0) revert NothingToSweep(k);
        e.claimed = e.amount;

        uint256 toInterval = intervalAt(block.number);
        pending[toInterval] += moved;
        unallocated += moved;
        emit ResidueSwept(k, toInterval, moved);
    }

    /// @notice Supply that could actually claim, as of `blockNumber`.
    /// @dev Reads `getPastTotalSupply`: a BURN market's supply shrinks, so today's supply would under-pay.
    function eligibleSupplyAt(uint256 blockNumber) public view returns (uint256 es) {
        es = token.getPastTotalSupply(blockNumber);
        for (uint256 i; i < _excluded.length; ++i) {
            address a = _excluded[i];
            if (a == address(0)) continue;
            uint256 b = token.getPastBalance(a, blockNumber);
            es = b >= es ? 0 : es - b;
        }
    }

    /// @notice Whether an address is one the denominator leaves out — and is therefore owed nothing.
    function isExcluded(address who) public view returns (bool) {
        for (uint256 i; i < _excluded.length; ++i) {
            if (_excluded[i] == who && who != address(0)) return true;
        }
        return false;
    }

    /// @notice This holder's weight in an epoch: the balance at the epoch's opening grid line, capped by
    ///         the balance at its closing one; zero for an excluded address.
    function weightOf(address holder, uint256 epochIndex) public view returns (uint256) {
        if (isExcluded(holder)) return 0;
        Epoch storage e = epochs[epochIndex];
        uint256 opened = token.getPastBalance(holder, e.snapshotBlock);
        uint256 closed = token.getPastBalance(holder, snapshotBlockFor(epochIndex + 1));
        return opened < closed ? opened : closed;
    }

    /// @notice Claim a contiguous range of epochs. Permissionless, and idempotent per epoch.
    /// @dev An epoch is claimable from `snapshotBlockFor(k + 1)` until `sweepableFrom(k)`; pays the named holder only.
    function claim(address holder, uint256 from, uint256 to) external nonReentrant returns (uint256 total) {
        return _claim(holder, from, to, holder);
    }

    /// @notice Claim your own dividends to `recipient`.
    function claimTo(address holder, uint256 from, uint256 to, address recipient)
        external
        nonReentrant
        returns (uint256 total)
    {
        if (msg.sender != holder) revert NotHolder(holder, msg.sender);
        if (recipient == address(0)) revert ZeroAddress();
        if (recipient == address(this)) revert ZeroAddress();
        return _claim(holder, from, to, recipient);
    }

    function _claim(address holder, uint256 from, uint256 to, address recipient)
        private
        returns (uint256 total)
    {
        if (to < from || to >= epochs.length) revert BadRange();
        if (isExcluded(holder)) revert HolderExcluded(holder);
        for (uint256 k = from; k <= to; ++k) {
            if (hasClaimed[k][holder]) continue;
            if (block.number <= snapshotBlockFor(k + 1)) revert NotMatured(k, snapshotBlockFor(k + 1) + 1);
            Epoch storage e = epochs[k];
            if (e.amount <= e.claimed) continue;
            uint256 w = weightOf(holder, k);
            if (w == 0) continue;
            uint256 share = (e.amount * w) / e.eligibleSupply;
            if (share == 0) continue;
            hasClaimed[k][holder] = true;
            e.claimed += share;
            if (e.claimed > e.amount) revert EpochOverspent(k, e.claimed, e.amount);
            total += share;
            emit Claimed(holder, k, share);
        }
        if (total == 0) revert NothingToClaim();
        _pay(recipient, total);
    }

    function epochCount() external view returns (uint256) {
        return epochs.length;
    }

    function excluded() external view returns (address[9] memory) {
        return _excluded;
    }

    /// @inheritdoc IDokuSink
    function sinkCurrencyIsToken() external pure returns (bool) {
        return false;
    }
}
