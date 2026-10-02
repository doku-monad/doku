// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

// ---------------------------------------------------------------------------------------------
// FROZEN. A byte-for-byte copy of `src/sinks/RewardVault.sol` as it stood at commit 84a7ea4b —
// the generation-3 shape, before the 2026-09-11 review's findings were fixed — with two
// mechanical edits and no others: the contract and its interfaces are renamed with a `Gen3`
// suffix so both versions can be linked into one test binary, and the import paths are rewritten
// for this directory's depth.
//
// It is here so `RewardVaultFindings.t.sol` can go on DEMONSTRATING M-01, L-02 and I-02 after
// `src/` stops exhibiting them. A proof of a bug that is deleted the moment the bug is fixed
// leaves nothing behind that can tell a future reader why the fix is shaped the way it is, and
// nothing that fails if somebody reverts it.
//
// Nothing in `src/` imports this. Do not fix it.
// ---------------------------------------------------------------------------------------------

pragma solidity 0.8.26;

import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {ReentrancyGuard} from "openzeppelin/utils/ReentrancyGuard.sol";
import {IDokuSink} from "../../src/sinks/IDokuSink.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin/token/ERC20/utils/SafeERC20.sol";

interface IHookPullGen3 {
    function pullSink(PoolId id) external returns (uint256);
}

interface ICheckpointedTokenGen3 {
    function getPastBalance(address account, uint256 blockNumber) external view returns (uint256);
    function getPastTotalSupply(uint256 blockNumber) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

/// @title RewardVaultGen3
/// @notice One market's holder-reward destination. Pays the market's QUOTE out pro rata, by epoch,
///         on a pull.
///
/// @dev ## The novel part of the design, and it has no production precedent
///
///      Neither reference launchpad this design was built from ships holder rewards at all — both
///      route fees to creators and the protocol. So unlike the burn path, nothing here is validated
///      by someone else's live deployment, and the shape below is chosen to minimise what can go
///      wrong rather than to be clever.
///
///      ## Pull, never push, and no iteration anywhere
///
///      An epoch records `(snapshotBlock, amount, eligibleSupply)` and holders claim against it.
///      Nothing iterates a holder list — there is no holder list — so cost is O(1) per holder per
///      epoch and no keeper exists in the payout path. That is also why this contract does not copy
///      the reference token's enumerable `holders[]` array: with pull-based claims it would be a
///      permanent per-transfer gas tax funding a query nobody makes.
///
///      ## Quote in, quote out. No swap, ever
///
///      A REWARDS market's levy is taken in its QUOTE — native MON or the ERC-20 the curve raised
///      in — on every swap shape, so this contract is never handed a token it would have to sell.
///      Every keeper, price bound and sandwich surface that a converting design needs is absent
///      because the conversion is. Which quote is fixed at construction and decides only how the
///      money moves: `call{value}` or `safeTransfer`.
///
///      ## The three things that decide whether it is safe
///
///      1. **Weight is `min(pastBalance, currentBalance)`.** Without the second term the play is
///         buy → snapshot → claim → dump. Requiring the claimant to still hold costs one
///         `balanceOf` and removes it. Stated honestly: this makes the mechanism favour holders
///         who stay, and anyone who exits before claiming forfeits.
///      2. **The snapshot grid is fixed, so no one can choose the instant.** Epoch `k` snapshots at
///         `genesisBlock + k * EPOCH_BLOCKS` — not "at least N blocks since the last one", which
///         would let a caller land the snapshot in the block of their own buy. Creation is refused
///         before the grid block has passed, so the snapshot is always already in the past.
///      3. **Eligible supply excludes every address that is not a holder.** Miss one and the
///         unclaimable fraction grows with volume rather than staying fixed. The PoolManager is the
///         counterparty of every swap and the hook holds the pending levy, so both are excluded;
///         excluding the PoolManager is also solvency-safe, because parking `P` tokens there gives
///         a holder `H/(S−P)` instead of `(H+P)/S`, which is strictly worse for all `H + P < S`.
///         The full set is `{PoolManager, hook, curve, token, DEAD, Graduation, PositionManager,
///         this vault}`. PositionManager is in it for belt-and-braces only — under v4 it settles
///         straight through to the singleton and never holds a token — and the vault adds itself,
///         since it cannot be told its own address before it exists.
contract RewardVaultGen3 is IDokuSink, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Blocks between epoch snapshots. A fixed grid, not a minimum interval.
    uint256 public constant EPOCH_BLOCKS = 216_000;

    /// @notice The asset dividends are paid in: `address(0)` for native MON, else an ERC-20.
    address public immutable quote;

    /// @notice Anti-spam floor: an epoch worth less than this is not worth the claim gas.
    /// @dev One ten-thousandth of what this market must raise to graduate, NOT a fraction of one
    ///      whole token. A hundredth of a token is $0.01 of USDC but $1,000 of BTC and $33 of gold,
    ///      which would stall dividends on exactly the assets whose fees arrive slowest. The quote
    ///      target is the only per-asset figure already normalised to a USD size, because the admin
    ///      sets it that way when registering the asset.
    uint256 public immutable minEpochAmount;

    address public immutable hook;
    ICheckpointedTokenGen3 public immutable token;
    PoolId public immutable poolId;
    /// @notice The block epoch 0 is anchored to — the block the curve became ready to graduate.
    /// @dev At that key the PoolManager holds none of this token and the hook, vault and sink do
    ///      not yet exist, so every exclusion-set member contributes zero and eligible supply is
    ///      exactly `pastTotalSupply − curveBalance`. It also guarantees no epoch key can fall
    ///      inside the curve phase, so no epoch ever straddles a curve-phase burn.
    uint256 public immutable genesisBlock;

    /// @dev Immutable, set at construction, and deliberately not editable. A settable exclusion set
    ///      would be a lever over who gets paid.
    ///
    ///      The last slot is reserved for this contract and filled by the constructor. Graduation
    ///      cannot supply it — the vault's address does not exist until the `new` returns — but the
    ///      vault can, because `address(this)` is available inside its own constructor.
    address[8] private _excluded;

    error LastSlotIsReserved();
    /// @dev The address is one the denominator leaves out; it is owed nothing by construction.
    error HolderExcluded(address holder);
    /// @dev The epoch has not matured: its dividend opens once the next snapshot has passed.
    error NotMatured(uint256 epochIndex, uint256 claimableFrom);
    /// @dev The sum of an epoch's payouts exceeded the epoch. Unreachable unless the weight and the
    ///      denominator have stopped agreeing; see `claim`.
    error EpochOverspent(uint256 epochIndex, uint256 claimed, uint256 amount);

    struct Epoch {
        uint256 snapshotBlock;
        uint256 amount;
        uint256 eligibleSupply;
        uint256 claimed;
    }

    Epoch[] public epochs;
    /// @notice Unallocated quote held by this vault, awaiting the next epoch.
    uint256 public unallocated;

    mapping(uint256 => mapping(address => bool)) public hasClaimed;

    error TooEarly(uint256 availableAtBlock);
    error NotEnoughToDistribute(uint256 have, uint256 need);
    error NoEligibleSupply();
    error AlreadyClaimed(uint256 epoch);
    error NothingToClaim();
    error TransferFailed();
    error BadRange();

    event Funded(uint256 amount);
    event EpochCreated(uint256 indexed epoch, uint256 snapshotBlock, uint256 amount, uint256 eligibleSupply);
    event Claimed(address indexed holder, uint256 indexed epoch, uint256 amount);

    constructor(
        address hook_,
        address token_,
        PoolId poolId_,
        address quote_,
        uint256 quoteTarget_,
        uint256 genesisBlock_,
        address[8] memory excluded_
    ) {
        hook = hook_;
        token = ICheckpointedTokenGen3(token_);
        poolId = poolId_;
        quote = quote_;
        minEpochAmount = quoteTarget_ / 10_000;
        genesisBlock = genesisBlock_;
        if (excluded_[7] != address(0)) revert LastSlotIsReserved();
        _excluded = excluded_;

        /**
         * The vault excludes ITSELF, and the reason is not symmetry.
         *
         * A REWARDS market's vault is never *sent* the token by this protocol — graduation routes
         * its token dust to DEAD rather than here precisely because this contract has no use for
         * it. But anyone may transfer an ERC20 to any address, and tokens parked here would count
         * toward `eligibleSupply` while being unclaimable in practice: `claim` would pay the
         * vault's own share back into its `receive()`, where it is not added to `unallocated` and
         * is therefore stranded. Every holder is diluted and the difference is lost.
         *
         * That is the ratchet the exclusion set exists to prevent, so the vault belongs in it.
         */
        _excluded[7] = address(this);
    }

    /// @notice Native quote lands here for the length of one `fund`; anything else that arrives is
    ///         not counted — see `test_monSentDirectlyToTheVaultIsNotDistributable`.
    receive() external payable {}

    /// @notice Move this market's accrued levy out of the hook and into the vault. Permissionless.
    /// @dev Separate from `createEpoch` so a failure in one is not a failure in the other, and so
    ///      the cadence is not coupled to how often anyone bothers to sweep. Measured as a balance
    ///      delta in the quote, so anything that arrived by other means stays uncounted (see
    ///      `receive`).
    function fund() external nonReentrant returns (uint256 amount) {
        uint256 before = _held();
        IHookPullGen3(hook).pullSink(poolId);
        amount = _held() - before;
        unallocated += amount;
        emit Funded(amount);
    }

    /// @dev What this vault holds of the one currency it is allowed to hold.
    function _held() private view returns (uint256) {
        return quote == address(0) ? address(this).balance : IERC20(quote).balanceOf(address(this));
    }

    /// @dev The only place a dividend leaves. Native MON goes by raw call because a holder may be a
    ///      contract with a payable fallback; an ERC-20 goes through SafeERC20 because a quote that
    ///      returns nothing on success is still a legitimate quote.
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

    /// @notice Open the next epoch against everything currently unallocated. Permissionless.
    /// @dev There is no choosable instant here: the snapshot block is a function of the epoch index
    ///      alone, and creation is refused until that block is in the past. An attacker who wants a
    ///      snapshot in the block of their own buy would have to control which block that grid line
    ///      falls on, which is fixed at construction.
    function createEpoch() external nonReentrant returns (uint256 index) {
        index = epochs.length;
        uint256 snap = snapshotBlockFor(index);
        if (block.number <= snap) revert TooEarly(snap + 1);

        uint256 amount = unallocated;
        if (amount < minEpochAmount) revert NotEnoughToDistribute(amount, minEpochAmount);

        uint256 es = eligibleSupplyAt(snap);
        if (es == 0) revert NoEligibleSupply();

        unallocated = 0;
        epochs.push(Epoch({snapshotBlock: snap, amount: amount, eligibleSupply: es, claimed: 0}));
        emit EpochCreated(index, snap, amount, es);
    }

    /// @notice Supply that could actually claim, as of `blockNumber`.
    /// @dev `pastTotalSupply` rather than `totalSupply()` because supply shrinks: a BURN market
    ///      destroys its own token, and mixing today's supply with a historical balance would
    ///      silently under-pay every holder.
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
    /// @dev Public because the numerator and the denominator MUST answer this the same way, and the
    ///      only way to guarantee that is to have one function both of them call.
    function isExcluded(address who) public view returns (bool) {
        for (uint256 i; i < _excluded.length; ++i) {
            if (_excluded[i] == who && who != address(0)) return true;
        }
        return false;
    }

    /**
     * @notice This holder's weight in an epoch: what they held then, capped by what they hold now,
     *         and ZERO for an address the epoch's denominator excluded.
     *
     * @dev THE EXCLUSION HAS TO BE ON BOTH SIDES OF THE FRACTION. It was on one.
     *      `eligibleSupplyAt` subtracts the excluded balances from the denominator, and this
     *      function used to hand any of those same addresses a full weight in the numerator. The
     *      PoolManager holds ~22% of the supply — the graduation seed — and is excluded for exactly
     *      that reason, so `claim(poolManager, ...)` paid out roughly `0.22 / 0.78` of an epoch that
     *      the pot was never sized for. `claim` is permissionless, so any stranger could trigger it;
     *      the quote landed in the PoolManager as an unaccounted balance, where v4 lets anyone take
     *      it. Repeat per epoch and the vault empties into whoever is watching, and the holders it
     *      was raised for find it short.
     */
    function weightOf(address holder, uint256 epochIndex) public view returns (uint256) {
        if (isExcluded(holder)) return 0;
        Epoch storage e = epochs[epochIndex];
        uint256 opened = token.getPastBalance(holder, e.snapshotBlock);
        /*
         * BOTH checkpoints are HISTORICAL, and that is the second half of the maturity rule.
         *
         * The cap used to be `balanceOf(holder)` — the balance right now, at claim time — which
         * made the payout a function of WHEN somebody chose to call `claim`. Two things followed.
         * A flipper could satisfy it by holding for one block, buying before a snapshot everybody
         * can compute and claiming in the next block. And `claim` takes the holder as a free
         * parameter, so a stranger could call it for a victim at the instant their balance dipped
         * — mid-rebalance, mid-transfer — and latch `hasClaimed` at that lower number, permanently.
         *
         * Reading the balance at the NEXT grid line fixes both. It is a fact about the past, so no
         * caller can time it, and satisfying it means having held the position from one snapshot to
         * the next: a whole epoch, which is what the dividend is for.
         */
        uint256 closed = token.getPastBalance(holder, snapshotBlockFor(epochIndex + 1));
        return opened < closed ? opened : closed;
    }

    /// @notice Claim a contiguous range of epochs. Permissionless, and idempotent per epoch.
    /// @dev A per-epoch bitmap rather than a single cursor: a cursor lets one unclaimable epoch in
    ///      the middle strand every epoch behind it.
    function claim(address holder, uint256 from, uint256 to) external nonReentrant returns (uint256 total) {
        if (to < from || to >= epochs.length) revert BadRange();
        // Refused outright rather than silently paying zero, so a caller who meant it learns why.
        // `weightOf` returns zero for these too — this is the loud half of the same rule.
        if (isExcluded(holder)) revert HolderExcluded(holder);
        for (uint256 k = from; k <= to; ++k) {
            if (hasClaimed[k][holder]) continue;
            /*
             * MATURITY: an epoch is not claimable until the NEXT grid line has passed.
             *
             * Without it the dividend was collectable on a one-block hold, and the design's
             * anti-gaming claim — "a fixed grid, no choosable instant" — did not survive contact
             * with the fact that the grid is PUBLIC. The sequence: buy in the block before a
             * snapshot everyone can compute years ahead, let it pass, call the permissionless
             * `createEpoch` yourself in the very next block, claim in the same transaction, sell.
             * The `min(past, current)` cap was the only thing standing between a flipper and a
             * full epoch's dividend, and it is satisfied by holding for the length of one block.
             *
             * The cap is what makes this delay bite: the holder must ALSO still hold when they
             * claim, so the claim cannot be made until they have carried the position across a
             * whole epoch. Nothing strands — the epoch stays claimable forever after, by whoever
             * still holds.
             */
            if (block.number <= snapshotBlockFor(k + 1)) revert NotMatured(k, snapshotBlockFor(k + 1) + 1);
            Epoch storage e = epochs[k];
            uint256 w = weightOf(holder, k);
            if (w == 0) continue;
            uint256 share = (e.amount * w) / e.eligibleSupply;
            if (share == 0) continue;
            hasClaimed[k][holder] = true;
            e.claimed += share;
            /*
             * `claimed` was written and never read. It is bounded by construction — every weight is
             * a balance at the snapshot, and the denominator is the sum of exactly those balances —
             * but "bounded by construction" is a proof about code that changes. This is the
             * assertion that the proof still holds, and it costs one comparison.
             */
            if (e.claimed > e.amount) revert EpochOverspent(k, e.claimed, e.amount);
            total += share;
            emit Claimed(holder, k, share);
        }
        if (total == 0) revert NothingToClaim();
        _pay(holder, total);
    }

    function epochCount() external view returns (uint256) {
        return epochs.length;
    }

    function excluded() external view returns (address[8] memory) {
        return _excluded;
    }

    /// @inheritdoc IDokuSink
    function sinkCurrencyIsToken() external pure returns (bool) {
        return false;
    }
}
