// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {ReentrancyGuard} from "openzeppelin/utils/ReentrancyGuard.sol";
import {IDokuSink} from "../../src/sinks/IDokuSink.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin/token/ERC20/utils/SafeERC20.sol";

interface IHookPull {
    function pullSink(PoolId id) external returns (uint256);
    /// @dev Design B's read. `DokuHook.owedSink` is a public mapping, so this signature exists on
    ///      the real hook today; nothing in the shipped vault calls it.
    function owedSink(PoolId id) external view returns (uint256);
}

/// @dev HISTORY ONLY, and the omission is the point. `balanceOf` used to be declared here and the
///      declaration outlived the last call to it, which is how three separate comments in this file
///      came to describe a current-balance rule the code had stopped implementing. Nothing in this
///      contract may read a live balance of the launch token: a payout that depends on the instant
///      it is asked for is a payout a stranger can time on a holder's behalf. Leaving the function
///      out is the cheapest way to keep that true through the next edit.
interface ICheckpointedToken {
    function getPastBalance(address account, uint256 blockNumber) external view returns (uint256);
    function getPastTotalSupply(uint256 blockNumber) external view returns (uint256);
}

/**
 * MEASUREMENT ARTIFACT. NOT A DEPLOYABLE CONTRACT, NOT ON ANY DEPLOY PATH.
 *
 * A copy of `src/sinks/RewardVault.sol` with the four candidate generation-5 bucketing rules for
 * M-01's residual timing lever wired behind an immutable `mode` bitmask, so each can be measured
 * end to end against the same scenario rather than argued about. The precedent is
 * `test/audit/RewardVaultGen3.sol`: a frozen copy of a vault kept in the test tree so a claim about
 * a shape can be run rather than asserted.
 *
 *   MODE_SPREAD_BACK  the briefed design. Spread a pull backwards over the intervals it went
 *                     unfunded, floored at `max(lastFundedInterval + 1, epochs.length)`.
 *   MODE_GATE_GRID    the briefed dual. `_openEpoch` refuses while the hook holds unfunded fees.
 *   MODE_SPREAD_FWD   spread a pull FORWARDS over as many intervals as it went unfunded.
 *   MODE_DRIP         spread EVERY pull forwards over a fixed number of intervals.
 *
 * `mode == 0` is byte-for-byte the DEPLOYED GENERATION-4 rule — one pull, one bucket — and is the
 * control every measurement is taken against. Generation 5 shipped a fifth rule that is not in this
 * file: the floor-unit forward spread, in `src/sinks/RewardVault.sol`, which is `MODE_DRIP` with its
 * width read off the pull in units of `minEpochAmount` instead of fixed. `MODE_DRIP` is kept here
 * unrefined because the measurement of what the FIXED width costs an honest market is the reason the
 * shipped one reads the pull.
 *
 * Everything below this line except `fund`, `_openEpoch`'s first three lines and the constructor is
 * the generation-4 file as it stood at 4b9b0631; the NatSpec is that file's and describes the
 * one-pull-one-bucket rule, so read it against `mode == 0`.
 */
/// @title RewardVault
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
///      ## The four things that decide whether it is safe
///
///      1. **Weight is `min(balance at grid line k, balance at grid line k+1)`. BOTH TERMS ARE
///         HISTORICAL.** Without the second term the play is buy → snapshot → claim → dump; the
///         second term makes the dividend conditional on having carried the position from one grid
///         line to the next, which is a whole epoch and is what the dividend is for.
///
///         The cap is deliberately NOT the balance at claim time, and the difference matters
///         enough to spell out because the comments here once claimed the opposite. A current
///         balance makes the payout a function of WHEN somebody chose to call `claim` — and
///         `claim` takes the holder as a free parameter, so a stranger could call it for a victim
///         at the instant their balance dipped, mid-rebalance or mid-transfer, and latch
///         `hasClaimed` at that lower number permanently. Reading the second checkpoint instead
///         is a fact about the past that no caller can time.
///
///         So: an address that satisfied both checkpoints and has since sold every token it owned
///         IS STILL PAID for the epoch it held through. That is the rule. Integrations must not
///         read this contract as evidence of a continuing holder.
///      2. **The snapshot grid is fixed, so no one can choose the instant.** Epoch `k` snapshots at
///         `genesisBlock + (k + 1) * EPOCH_BLOCKS` — not "at least N blocks since the last one",
///         which would let a caller land the snapshot in the block of their own buy. (The `k + 1`
///         is not a typo and this line used to omit it: `snapshotBlockFor(0)` is one whole epoch
///         AFTER genesis, which is what keeps every grid line clear of the curve phase.) Creation
///         is refused until the epoch's CLOSING grid line has passed — `snapshotBlockFor(k + 1)`,
///         not its opening one — so both of the blocks the weight is read at are always already in
///         the past, and so is every fee the epoch is funded from.
///      3. **Eligible supply excludes every address that is not a holder.** Miss one and the
///         unclaimable fraction grows with volume rather than staying fixed. The PoolManager is the
///         counterparty of every swap and the hook holds the pending levy, so both are excluded;
///         excluding the PoolManager is also solvency-safe, because parking `P` tokens there gives
///         a holder `H/(S−P)` instead of `(H+P)/S`, which is strictly worse for all `H + P < S`.
///         The full set is `{PoolManager, hook, curve, token, DEAD, Graduation, PositionManager,
///         SeedLocker, this vault}`. PositionManager is in it for belt-and-braces only — under v4 it
///         settles straight through to the singleton and never holds a token — and the vault adds
///         itself, since it cannot be told its own address before it exists.
///      4. **Money is bucketed by the interval it ARRIVED in, and it only ever moves forward.**
///         `fund` credits `pending[intervalAt(block.number)]` and `_openEpoch` spends exactly that
///         bucket, so a caller decides when a fixed amount reaches a fixed grid line and nothing
///         else about it. THREE kinds of money cannot be paid to the holder set whose interval
///         earned it — an interval under `minEpochAmount`, an interval whose opening grid line had
///         no eligible supply, and the part of an OPENED epoch that no holder's weight ever reached
///         — and all three carry FORWARD into the current interval rather than being written off or
///         stranded. The first two carry in `_openEpoch`, at the moment the epoch opens; the third
///         cannot be known then, so it carries in `sweepResidue`, once the epoch has had
///         `RESIDUE_WINDOW_EPOCHS` to be claimed in. Forward is the only safe direction: it can only
///         ever reach a holder set at or after the one that earned it, never an earlier one that has
///         since sold.
///
///      ## What can leave this vault, and what cannot
///
///      Exactly one function moves the quote out — `_pay`, reachable only from `claim` and
///      `claimTo` — and every such payment is a debit of one OPENED epoch against one holder's
///      weight. There is no admin withdrawal, no rescue, no sweep-to-treasury and no owner.
///
///      `sweepResidue` is NOT an exit and the name is the only thing about it that suggests one: it
///      moves an epoch's unreachable remainder from one of this contract's own ledger slots into
///      another and the quote never crosses the contract boundary. `unallocated` and the vault's
///      balance are the same after it as before.
///
///      Quote that arrives by any route other than `fund` is stuck here for good, and that is why
///      `receive()` is gated: `fund` measures the hook's payment as a balance DELTA, so a bare
///      native send would sit in no bucket, therefore in no epoch, and every exit is an epoch debit.
///      The gate bounces it. An ERC-20 donation has no equivalent gate and cannot be given one —
///      `transfer` needs no cooperation from the recipient — so on the six ERC-20 quotes a donation
///      to this address is a burn. Nothing in the protocol sends one.
contract Gen5Candidate is IDokuSink, ReentrancyGuard {
    /// @dev DESIGN A. Spread a pull BACKWARDS over the intervals it went unfunded, floored at the
    ///      first interval no epoch has opened against: `max(lastFundedInterval + 1, epochs.length)`.
    uint8 internal constant MODE_SPREAD_BACK = 1;
    /// @dev DESIGN B. `_openEpoch` refuses to advance the grid while the hook still holds unfunded
    ///      `owedSink` for this market.
    uint8 internal constant MODE_GATE_GRID = 2;
    /// @dev DESIGN E. Spread a pull FORWARDS over as many intervals as it went unfunded.
    uint8 internal constant MODE_SPREAD_FWD = 4;
    /// @dev DESIGN F. Spread every pull forwards over a FIXED number of intervals, unconditionally.
    uint8 internal constant MODE_DRIP = 8;

    uint256 internal constant MAX_SPREAD = 26;
    uint256 internal constant DRIP_INTERVALS = 7;

    uint8 public immutable mode;
    /// @notice One past the interval the last non-empty `fund()` was booked from.
    uint256 public fundedThrough;

    /// @dev Design B's refusal.
    error UnfundedFeesOutstanding(uint256 owed);
    using SafeERC20 for IERC20;

    /// @notice Blocks between epoch snapshots. A fixed grid, not a minimum interval.
    uint256 public constant EPOCH_BLOCKS = 216_000;

    /**
     * @notice How long an opened epoch's remainder stays that epoch's own before `sweepResidue` may
     *         carry it forward. Counted in epochs from the epoch's CLOSING grid line — the block
     *         `claim` first pays out at — so it is a window on the claiming period, not on the
     *         earning one. 26 × 216,000 blocks is about 26 days on Monad.
     *
     * @dev THE NUMBER IS THE WHOLE OF THIS FEATURE'S RISK, and it is a trade-off with no free end.
     *
     *      Too SHORT and the sweep is a race: a holder who is genuinely owed the money — travelling,
     *      on a hardware wallet, waiting for gas, or simply not watching a market they hold — is
     *      dispossessed by whoever runs the sweep first, and `sweepResidue` is permissionless, so
     *      that is whoever watches hardest. Every unclaimed wei is a wei somebody was owed until the
     *      window closes on it.
     *
     *      Too LONG and the money idles. The remainder is not the slow claimant's alone: most of it
     *      is arithmetic — `weightOf` is `min(open, close)` while the denominator is the OPENING
     *      balance of every non-excluded address, so every address whose balance moved inside the
     *      interval contributes less to the numerator than to the denominator, and on a churny
     *      market that difference is most of the epoch. It is money the CURRENT holders earned the
     *      right to, sitting behind a grid line that has closed.
     *
     *      26 epochs is a month of claiming for a dividend that accrues daily, and it is picked from
     *      that side of the trade: long enough that no realistic claimant is racing, short enough
     *      that a churny market's leak is a month's worth rather than for ever. It is a constant and
     *      not a setting, because a settable window is a lever over who gets paid — the same reason
     *      the exclusion set is immutable.
     */
    uint256 public constant RESIDUE_WINDOW_EPOCHS = 26;

    /// @notice The asset dividends are paid in: `address(0)` for native MON, else an ERC-20.
    address public immutable quote;

    /// @notice Anti-spam floor: an epoch worth less than this is not worth the claim gas. Never
    ///         zero.
    /// @dev One ten-thousandth of what this market must raise to graduate, NOT a fraction of one
    ///      whole token. A hundredth of a token is $0.01 of USDC but $1,000 of BTC and $33 of gold,
    ///      which would stall dividends on exactly the assets whose fees arrive slowest. The quote
    ///      target is the only per-asset figure already normalised to a USD size, because the admin
    ///      sets it that way when registering the asset.
    ///
    ///      THE `max(1, ...)` IS LOAD-BEARING and the reason is integer division. `quoteTarget` is
    ///      raw units of an asset the registry owner chose, and `BondingCurve.MIN_QUOTE_TARGET` is
    ///      5 — so a target under 10,000 raw units is permitted by every contract upstream of this
    ///      one and floors the quotient at zero. A floor of zero is not a slack floor, it is a
    ///      different rule: with the floor at zero the guard reads `amount < 0`, which is false for
    ///      `amount == 0`, so it would ADMIT an epoch worth nothing to anybody. Nothing on the live registry is close to the threshold
    ///      — the smallest target is XAUt0's 1,809,590, which floors at 180 — but "no currently
    ///      registered asset trips it" is a fact about a registry the owner can add to, not a
    ///      property of this contract, and this is the line that makes it one.
    uint256 public immutable minEpochAmount;

    address public immutable hook;
    ICheckpointedToken public immutable token;
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
    address[9] private _excluded;

    error LastSlotIsReserved();
    /// @dev The address is one the denominator leaves out; it is owed nothing by construction.
    error HolderExcluded(address holder);
    /// @dev The epoch has not matured: its dividend opens once the next snapshot has passed.
    error NotMatured(uint256 epochIndex, uint256 claimableFrom);
    /// @dev The sum of an epoch's payouts exceeded the epoch. Unreachable unless the weight and the
    ///      denominator have stopped agreeing; see `claim`.
    error EpochOverspent(uint256 epochIndex, uint256 claimed, uint256 amount);
    /// @dev The epoch's claiming window is still open. It is still its holders' money until
    ///      `sweepableFrom`, which this names.
    error ResidueNotMature(uint256 epochIndex, uint256 sweepableFrom);
    /// @dev The epoch has nothing left in it — never funded, fully claimed, or already swept. Loud
    ///      rather than a zero return, the same choice `NothingToClaim` makes.
    error NothingToSweep(uint256 epochIndex);

    struct Epoch {
        uint256 snapshotBlock;
        uint256 amount;
        uint256 eligibleSupply;
        uint256 claimed;
    }

    Epoch[] public epochs;
    /// @notice Total quote this vault holds that has been funded and not yet handed to an epoch.
    /// @dev Exactly `sum(pending[k])` over every k. Kept as its own number because it is the one
    ///      figure a reader wants and the mapping cannot be summed on chain.
    uint256 public unallocated;

    /// @notice Quote earned during interval `k`, awaiting epoch `k`. The heart of the fix in §4.
    /// @dev Interval `k` is exactly epoch `k`'s own weighting window, `[snapshotBlockFor(k),
    ///      snapshotBlockFor(k + 1))` — see `intervalAt`. THREE things move money into a bucket:
    ///      `fund`, which credits the CURRENT interval; `createEpoch`, which carries an interval's
    ///      dust or an unpayable amount FORWARD to `k + 1`; and `sweepResidue`, which carries a
    ///      matured epoch's unreachable remainder forward into the current interval. Nothing ever
    ///      moves money backwards, which is the property that stops a former holder being paid out
    ///      of a later holder set's fees.
    ///
    ///      NO BUCKET CAN BE CREDITED AFTER ITS EPOCH HAS SPENT IT, and the proof is short enough
    ///      to keep here because the alternative is money that is stranded rather than merely
    ///      mis-timed. Epoch `k` opens only once `block.number > snapshotBlockFor(k + 1)`, and
    ///      `intervalAt` of any such block is at least `k + 1`. So the current interval is always
    ///      strictly greater than the highest epoch opened, `fund` can only ever credit the current
    ///      one, and a carry only ever writes `index + 1`, which is the next epoch to open and by
    ///      the same argument not yet open. Every bucket is therefore written before it is read and
    ///      never after, and `unallocated == sum(pending[k])` holds at every point.
    ///
    ///      `sweepResidue` RESTS ON THE SAME FACT and adds nothing to the proof. It writes
    ///      `pending[intervalAt(block.number)]`, which is the bucket `fund` would credit in the same
    ///      block; the argument above says that index is at least `epochs.length`, i.e. at least the
    ///      next epoch to open, so a sweep can never write into a bucket an epoch has already spent
    ///      — it cannot even reach the epoch it is sweeping, which is `RESIDUE_WINDOW_EPOCHS + 1`
    ///      grid lines behind. It is also the only one of the three that credits `unallocated`
    ///      again, because the amount it moves left `unallocated` when its epoch opened.
    mapping(uint256 => uint256) public pending;

    mapping(uint256 => mapping(address => bool)) public hasClaimed;

    error TooEarly(uint256 availableAtBlock);
    error AlreadyClaimed(uint256 epoch);
    error NothingToClaim();
    error TransferFailed();
    error BadRange();
    /// @dev Only the holder may name where their own dividend goes. See `claimTo`.
    error NotHolder(address holder, address caller);
    /// @dev A destination that would burn the payout: the zero address, or this vault.
    error ZeroAddress();
    /// @dev Bare native from anything but the hook. See `receive`.
    error OnlyHookPays();

    event Funded(uint256 amount);
    /// @dev Emitted alongside `Funded` rather than folded into it. `Funded(uint256)` is already
    ///      indexed downstream and a signature change would silently orphan every historical row;
    ///      the interval is a new fact and rides its own log. `total` is the bucket AFTER the
    ///      credit, so an indexer can reconstruct `pending` from logs alone.
    event Bucketed(uint256 indexed interval, uint256 amount, uint256 total);
    /// @dev Also emitted for an EMPTY epoch, with `amount == 0`. An interval that earned nothing
    ///      still has to open so the grid can move past it, and an indexer that only saw funded
    ///      epochs would see gaps it could not explain.
    event EpochCreated(uint256 indexed epoch, uint256 snapshotBlock, uint256 amount, uint256 eligibleSupply);
    /// @dev An interval's money moving forward one grid line, because it was under the floor or
    ///      because nobody at that grid line could have claimed it.
    event CarriedForward(uint256 indexed fromInterval, uint256 amount, string reason);
    /// @dev The third carry, and the only one that names an EPOCH rather than an interval on its
    ///      left-hand side: `CarriedForward` moves a bucket that was never handed to an epoch, this
    ///      moves what is left of one that was. An indexer that reconstructs `pending` from logs
    ///      needs both, and needs to know that this one also raises `epochs[epoch].claimed` to
    ///      `amount` without a matching `Claimed`.
    event ResidueSwept(uint256 indexed epoch, uint256 indexed toInterval, uint256 amount);
    event Claimed(address indexed holder, uint256 indexed epoch, uint256 amount);

    constructor(
        address hook_,
        address token_,
        PoolId poolId_,
        address quote_,
        uint256 quoteTarget_,
        uint256 genesisBlock_,
        address[9] memory excluded_,
        uint8 mode_
    ) {
        mode = mode_;
        hook = hook_;
        token = ICheckpointedToken(token_);
        poolId = poolId_;
        quote = quote_;
        uint256 floor_ = quoteTarget_ / 10_000;
        minEpochAmount = floor_ == 0 ? 1 : floor_;
        genesisBlock = genesisBlock_;
        if (excluded_[8] != address(0)) revert LastSlotIsReserved();
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
         *
         * The array is nine wide, not eight, and the ninth entry is the `SeedLocker`. It had been
         * deleted on purpose — `docs/doku/08-plan-v4-hook-tax.md` §9.1 writes the v4 membership
         * change as a diff whose third line is literally `- locker  deleted`, correct at the time
         * because the seed was going to `0x…dEaD`. The locker was then brought back (a dead owner
         * cannot collect the LP donation) and the set never was. So the set excluded the address
         * that CANNOT hold this token under v4 (the PositionManager) and admitted the one that CAN.
         * The cost, measured: a 1%-of-float donation to the locker pays 1% of every epoch into it
         * for ever on an ERC-20 quote, and makes 1% claimable by nobody on a native one, because
         * the locker's `receive` is gated. Same shape as the vault's own exclusion, one door over.
         */
        _excluded[8] = address(this);
    }

    /// @notice Native quote lands here for the length of one `fund`, and only the hook may send it.
    ///
    /// @dev The gate is the same one `CreatorSink.receive` got this round, for the same reason and
    ///      with more force. Native arriving from anywhere else is in no `pending` bucket, therefore
    ///      in no epoch, and every exit from this contract is a debit of an epoch — so it could
    ///      never leave. An open `receive` turned a mistyped address into a permanent burn the
    ///      sender got no warning about.
    ///
    ///      `fund()` measures the hook's payment as a balance delta, so it does not depend on this
    ///      gate; the gate is only here to make the mistake bounce instead of vanishing.
    receive() external payable {
        if (msg.sender != hook) revert OnlyHookPays();
    }

    /// @notice Move this market's accrued levy out of the hook and into the vault. Permissionless.
    /// @dev Separate from `createEpoch` so a failure in one is not a failure in the other, and so
    ///      the cadence is not coupled to how often anyone bothers to sweep. Measured as a balance
    ///      delta in the quote, so anything that arrived by other means stays uncounted (see
    ///      `receive`).
    function fund() external nonReentrant returns (uint256 amount) {
        uint256 before = _held();
        IHookPull(hook).pullSink(poolId);
        amount = _held() - before;
        unallocated += amount;
        uint256 k = intervalAt(block.number);

        if (amount == 0) {
            emit Funded(0);
            emit Bucketed(k, 0, pending[k]);
            return 0;
        }

        uint256 lo = k;
        uint256 hi = k;
        if (mode & MODE_SPREAD_BACK != 0) {
            // `max(lastFundedInterval + 1, epochs.length) .. k`, exactly as briefed. The floor is
            // the bucket-safety rule: no epoch that has already opened may be credited.
            lo = fundedThrough > epochs.length ? fundedThrough : epochs.length;
            if (lo > k) lo = k;
        } else if (mode & MODE_SPREAD_FWD != 0) {
            uint256 from = fundedThrough > k + 1 ? k + 1 : fundedThrough;
            uint256 w = k + 1 - from;
            if (w == 0) w = 1;
            if (w > MAX_SPREAD) w = MAX_SPREAD;
            hi = k + w - 1;
        } else if (mode & MODE_DRIP != 0) {
            hi = k + DRIP_INTERVALS - 1;
        }
        fundedThrough = k + 1;

        uint256 n = hi - lo + 1;
        uint256 each = amount / n;
        uint256 rem = amount - each * n;
        for (uint256 j = lo; j <= hi; ++j) {
            uint256 add = each + (j == lo ? rem : 0);
            if (add == 0) continue;
            uint256 total = pending[j] + add;
            pending[j] = total;
            emit Bucketed(j, add, total);
        }
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

    /**
     * @notice The interval — and therefore the epoch — a fee arriving at `blockNumber` belongs to.
     *
     * @dev Interval `k` is `[snapshotBlockFor(k), snapshotBlockFor(k + 1))`, which is precisely the
     *      window epoch `k`'s weight is measured across: `min(balance at the opening grid line,
     *      balance at the closing one)`. So the holder set an interval's money is paid to is the
     *      set that carried a position through the interval that EARNED it. Lining those two up is
     *      the entire point; everything else here is bookkeeping.
     *
     *      Everything before grid line 0 answers 0. That window — graduation up to
     *      `genesisBlock + EPOCH_BLOCKS` — is the market's first epoch of life, and epoch 0's own
     *      weighting window has not opened yet, so there is no earlier holder set to pay. Handing
     *      it to epoch 0 pays the FIRST set that can be measured, which is the nearest thing that
     *      exists and, being later than the money, is on the safe side of the rule in §4. It also
     *      keeps the subtraction below from underflowing for a vault whose genesis is in the
     *      future, which cannot happen through `DokuGraduation` but is not this function's to
     *      assume.
     */
    function intervalAt(uint256 blockNumber) public view returns (uint256) {
        uint256 firstLine = genesisBlock + EPOCH_BLOCKS; // == snapshotBlockFor(0)
        if (blockNumber <= firstLine) return 0;
        return (blockNumber - genesisBlock) / EPOCH_BLOCKS - 1;
    }

    /// @notice The interval `fund` would credit right now.
    function currentInterval() external view returns (uint256) {
        return intervalAt(block.number);
    }

    /**
     * @notice Open the next epoch against the money ITS OWN interval earned. Permissionless.
     *
     * @dev There is no choosable instant and, now, no choosable amount either. The snapshot block
     *      is a function of the epoch index alone and the amount is a function of the same index
     *      through `pending`, so a caller decides only WHEN a fixed transfer of a fixed bucket to a
     *      fixed grid line happens. That is what took the discretion — and the money — out of this
     *      function; see §4 on the contract.
     *
     *      Creation now waits for the interval to CLOSE (`snapshotBlockFor(index + 1)`) rather than
     *      to open. It has to: a fee arriving at any point inside interval `index` belongs to this
     *      bucket, and opening the epoch while the interval is still running would lock out every
     *      fee that arrived after the call. Nothing is lost by waiting, because `claim` already
     *      refused to pay until that same block — the closing checkpoint is half the weight.
     *
     *      AN EMPTY INTERVAL OPENS AN EMPTY EPOCH. It does not revert, and that is deliberate: the
     *      old shape refused, the index stopped advancing, and the next interval's money was then
     *      handed to this interval's grid line. Advancing costs one array push and keeps epoch
     *      index and interval index the same number forever, which is what every other rule here
     *      relies on. `createEpochs` exists for the case where several are owed at once.
     *
     *      A SPARSE MAPPING keyed by interval would avoid the empty pushes entirely, and it was
     *      the first shape tried. It was dropped because `claim(holder, from, to)` and
     *      `hasClaimed` both key off a dense, monotonically-growing index that a reader can bound
     *      with `epochCount()`; making it sparse means every caller needs an out-of-band list of
     *      which indices exist, and an off-by-one there is a silently unclaimed epoch. An empty
     *      push is ~22k gas, once per epoch, paid by whoever wants the grid to move.
     */
    function createEpoch() external nonReentrant returns (uint256 index) {
        return _openEpoch();
    }

    /// @notice Catch a lagging grid up, up to `maxSteps` epochs in one transaction.
    /// @dev A vault first funded long after graduation owes one epoch per grid line since. They are
    ///      almost all empty and each is a cheap push, but they are not free, and forcing a caller
    ///      to send one transaction per epoch is the kind of friction that leaves a grid parked
    ///      forever. Bounded rather than unbounded so the caller, not the chain, decides the gas.
    function createEpochs(uint256 maxSteps) external nonReentrant returns (uint256 opened) {
        for (; opened < maxSteps; ++opened) {
            if (block.number <= snapshotBlockFor(epochs.length + 1)) break;
            _openEpoch();
        }
        // Refused rather than returning zero, so a caller who mistimed it learns why — the same
        // choice `claim` makes about `NothingToClaim`.
        if (opened == 0) revert TooEarly(snapshotBlockFor(epochs.length + 1) + 1);
    }

    /**
     * @dev The single place an epoch comes into existence. `nonReentrant` is on the two external
     *      entry points; nothing in here re-enters (no value leaves, and the only external calls
     *      are `view`s on the launch token).
     *
     *      TWO OF THE THREE CARRY-FORWARD CASES ARE BELOW, and the third is `sweepResidue`. They
     *      are the same rule applied at the two moments it can be applied at. Here, at the instant
     *      the epoch opens, the contract can already see that this interval's money can reach
     *      nobody — it is under the floor, or the grid line it would be divided at had no eligible
     *      supply — so it never becomes an epoch's `amount` at all and goes straight into
     *      `pending[index + 1]`.
     *
     *      The third case is not visible here and cannot be: whether an opened epoch's money
     *      reaches its holders is a fact about `min(open, close)` summed over addresses this
     *      contract has no list of, and it is not settled until every holder who is going to claim
     *      has claimed. So that one waits `RESIDUE_WINDOW_EPOCHS` and carries in `sweepResidue`.
     *      All three move money FORWARD into a bucket no epoch has opened against, for the reason
     *      spelled out on the zero-supply branch.
     */
    function _openEpoch() private returns (uint256 index) {
        if (mode & MODE_GATE_GRID != 0) {
            uint256 owed = IHookPull(hook).owedSink(poolId);
            if (owed != 0) revert UnfundedFeesOutstanding(owed);
        }
        index = epochs.length;
        uint256 close = snapshotBlockFor(index + 1);
        if (block.number <= close) revert TooEarly(close + 1);

        uint256 snap = snapshotBlockFor(index);
        uint256 amount = pending[index];
        if (amount != 0) delete pending[index];

        /*
         * TWO INDEPENDENT REASONS NOT TO OPEN A PAYING EPOCH, and they are written as two checks on
         * purpose. `amount >= minEpochAmount` is the anti-spam floor and depends on the floor being
         * right; `amount != 0` does not depend on anything. The floor was zero for any quote target
         * under 10,000 raw units until the constructor was fixed, and `0 < 0` is false, so the
         * floor alone once admitted an epoch worth nothing. This is the check that would still have
         * held.
         */
        uint256 es;
        if (amount != 0 && amount >= minEpochAmount) {
            es = eligibleSupplyAt(snap);
            if (es == 0) {
                /*
                 * NOBODY AT THIS GRID LINE COULD HAVE CLAIMED IT. Every token sat in an excluded
                 * address, so the denominator is zero and there is no holder set to divide by.
                 *
                 * The money carries FORWARD to the next interval rather than reverting (which
                 * would stall the grid and re-open the misdirection this whole function exists to
                 * close) or being written off. Forward is the only safe direction: it can only
                 * ever reach a holder set at or after the one that earned it, never an earlier one
                 * that has since sold. If eligible supply is zero for good — a market whose whole
                 * float burned — the money carries for ever and pays nobody, which is correct,
                 * because there is nobody left it belongs to.
                 */
                pending[index + 1] += amount;
                emit CarriedForward(index, amount, "no eligible supply");
                amount = 0;
            } else {
                unallocated -= amount;
            }
        } else if (amount != 0) {
            // Under the floor. Not worth the claim gas on its own, so it joins the next interval's
            // takings instead of being stranded behind a grid line that will never open again.
            pending[index + 1] += amount;
            emit CarriedForward(index, amount, "below minEpochAmount");
            amount = 0;
        }

        epochs.push(Epoch({snapshotBlock: snap, amount: amount, eligibleSupply: es, claimed: 0}));
        emit EpochCreated(index, snap, amount, es);
    }

    /// @notice The first block at which epoch `k`'s remainder may be swept forward. Up to it, the
    ///         money is still its own holders'.
    /// @dev Measured from the CLOSING grid line, `snapshotBlockFor(k + 1)`, which is the first block
    ///      `claim` pays this epoch out at — so the window is `RESIDUE_WINDOW_EPOCHS` of actual
    ///      claiming time and not a figure that is partly spent before claiming opens.
    function sweepableFrom(uint256 k) public view returns (uint256) {
        return snapshotBlockFor(k + 1) + RESIDUE_WINDOW_EPOCHS * EPOCH_BLOCKS + 1;
    }

    /**
     * @notice Carry a matured epoch's unreachable remainder forward into the current interval, where
     *         the holders who are here now can claim it. Permissionless, and pays the caller
     *         nothing.
     *
     * @dev THE THIRD UNCLAIMABLE CASE, and it is the largest one. `_openEpoch` already carries the
     *      other two; this one is the same rule, applied to money that was already handed to an
     *      epoch.
     *
     *      WHY AN OPENED EPOCH HAS A REMAINDER AT ALL. `weightOf` is `min(balance at the opening
     *      grid line, balance at the closing one)` while `eligibleSupplyAt` is the balance of every
     *      non-excluded address at the OPENING line alone. So the numerator is measured across the
     *      interval and the denominator only at its start, and every address whose balance moved
     *      inside the interval — which is every trader on a live market, because the PoolManager is
     *      excluded and a buy takes a balance up from zero — contributes strictly less to the
     *      numerator than it does to the denominator. `sum(weightOf) <= eligibleSupply` is the
     *      property that keeps `claim` from overspending; the slack in it is this remainder. It was
     *      measured at 2,500 bps of an epoch from one mid-interval transfer of a quarter of the
     *      float, and on a churny market the churn fraction IS the leak fraction, every epoch.
     *
     *      Before this function the slack was unreachable by anything: `unallocated` had already
     *      been debited for it when the epoch opened, nothing re-bucketed it, and the epoch stayed
     *      nominally claimable for ever by a holder set that had long since sold. The vault held the
     *      money and no expression in the contract named it.
     *
     *      WHAT IT COSTS. After the window, a holder who never claimed is dispossessed — this is
     *      deliberate and it is the price of the fix; see `RESIDUE_WINDOW_EPOCHS` for why 26 epochs
     *      is where the trade-off was taken. Nothing is dispossessed before the window: a claim at
     *      any block up to `sweepableFrom(k) - 1` pays in full.
     *
     *      THE LEDGER MOVE IS `claimed`, NOT `amount`, and the direction matters. Raising `claimed`
     *      to `amount` leaves the epoch's funded size as it was created and logged — `amount` is
     *      history an indexer already has from `EpochCreated` and must keep matching — while making
     *      the epoch's outstanding obligation exactly zero, which is what every solvency statement
     *      here is written in terms of (`balance >= sum(amount - claimed) + unallocated`). Lowering
     *      `amount` to `claimed` instead would say the same thing about solvency and two wrong
     *      things besides: a never-claimed epoch would end up with `amount == 0` against a non-zero
     *      `eligibleSupply`, which is the one combination "an empty epoch stores no denominator"
     *      forbids, and `claim`'s share would still be computed from a positive `amount`, so a late
     *      claimant would be paid out of money that is now in somebody else's bucket until
     *      `EpochOverspent` caught it — as a revert that takes their whole range down with it.
     *      `claim` skips on `amount <= claimed` for exactly this reason.
     *
     *      `nonReentrant` for the same reason `createEpoch` carries it: the guard is shared with
     *      `fund` and `claim`, so a holder whose native `receive` runs inside `_pay` cannot move
     *      the ledger underneath the payout it is in the middle of. Nothing here calls out — the
     *      ordering alone would survive — but this contract keeps one guard across every writer
     *      rather than reasoning about each caller's ordering separately.
     */
    function sweepResidue(uint256 k) external nonReentrant returns (uint256 moved) {
        // Same refusal, same error, as naming an epoch that does not exist in `claim`'s range.
        if (k >= epochs.length) revert BadRange();
        uint256 opensAt = sweepableFrom(k);
        if (block.number < opensAt) revert ResidueNotMature(k, opensAt);

        Epoch storage e = epochs[k];
        // Cannot underflow: `claim` asserts `claimed <= amount` on every payout and reverts
        // otherwise, and this is the only other writer of either field.
        moved = e.amount - e.claimed;
        if (moved == 0) revert NothingToSweep(k);
        e.claimed = e.amount;

        /*
         * The destination is the bucket `fund` would credit in this same block, and it is provably
         * not a bucket any epoch has spent: `intervalAt(block.number) >= epochs.length` at every
         * point in this contract's life — see the proof on `pending` — so the money lands at or
         * after the next epoch to open. It could not reach epoch `k` even if the arithmetic allowed
         * it, since `k` closed `RESIDUE_WINDOW_EPOCHS + 1` grid lines ago.
         *
         * `unallocated` is credited because the epoch debited it when it opened. Net effect on this
         * contract's balance: none. Net effect on `unallocated == sum(pending[j])`: none.
         */
        uint256 toInterval = intervalAt(block.number);
        pending[toInterval] += moved;
        unallocated += moved;
        emit ResidueSwept(k, toInterval, moved);
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
     * @notice This holder's weight in an epoch: what they held at the epoch's OPENING grid line,
     *         capped by what they held at its CLOSING one, and ZERO for an address the epoch's
     *         denominator excluded. BOTH TERMS ARE HISTORICAL: this function never reads a
     *         current balance, and an address that satisfied both checkpoints is paid whether or
     *         not it still holds a single token. See §1 on the contract for why that is the rule
     *         and not an oversight.
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
    ///
    /// @dev A per-epoch bitmap rather than a single cursor: a cursor lets one unclaimable epoch in
    ///      the middle strand every epoch behind it.
    ///
    ///      AN EPOCH IS CLAIMABLE FROM `snapshotBlockFor(k + 1)` UNTIL `sweepableFrom(k)`, and that
    ///      upper bound is new. It used to be "for ever after", which was true and was the problem:
    ///      the part of an epoch no holder's weight reaches — see `sweepResidue` — sat behind a
    ///      grid line that had closed, reachable by nobody and named by nothing. The window is 26
    ///      epochs of claiming time; a claim inside it pays in full, a claim after a sweep pays
    ///      nothing for that epoch. Every other reason a claim pays nothing is unchanged: an
    ///      excluded holder is refused loudly, an empty epoch is skipped, and an already-claimed
    ///      epoch is skipped.
    function claim(address holder, uint256 from, uint256 to) external nonReentrant returns (uint256 total) {
        return _claim(holder, from, to, holder);
    }

    /// @notice Claim your own dividends to `recipient`.
    ///
    /// @dev Why this exists, and why only the holder may call it.
    ///
    ///      `claim` pays the NAMED holder, which is what makes it safe to leave permissionless: a
    ///      stranger can crystallise your dividend but cannot redirect it. The cost of that
    ///      property is that a holder who cannot receive the quote never collects — a frozen USDC or
    ///      USDT0 address, a contract whose fallback broke after it bought in — and the money then
    ///      sits in the epoch for ever, because every exit from this contract is a debit of an
    ///      epoch. `CreatorSink` was given `claim(quote, amount, to)` this round for exactly that
    ///      reason; the sibling did not get it, and the frozen-HOLDER population is strictly larger
    ///      than the frozen-creator one.
    ///
    ///      So the destination is added here rather than to `claim`, gated on `msg.sender == holder`.
    ///      That keeps both properties at once: anyone may still pay you, and only you may say where.
    ///      A third party calling this for somebody else would be the redirect the design forbids.
    function claimTo(address holder, uint256 from, uint256 to, address recipient)
        external
        nonReentrant
        returns (uint256 total)
    {
        if (msg.sender != holder) revert NotHolder(holder, msg.sender);
        if (recipient == address(0)) revert ZeroAddress();
        // Paying the vault burns the dividend, and this guard is the only thing that stops it.
        //
        // The epoch is marked claimed either way, so the money leaves the ledger; it just does not
        // leave the contract. `receive()` credits nothing to any epoch and every exit here is an
        // epoch debit, so it could never come back out.
        //
        // The gated `receive()` is NOT a substitute, and the difference is the quote asset. On a
        // native vault `_pay` is a `call` that the gate bounces, which makes this guard look
        // redundant. On an ERC-20 vault — six of the seven registered quotes — `_pay` is
        // `safeTransfer`, which succeeds perfectly well against `address(this)`. That is the
        // configuration where the dividend is silently burned, and it is the one no test covered
        // until `Round2HuntB` added it.
        //
        // (An earlier version of this note said the parked quote would "dilute every later holder
        // through `eligibleSupply`". It would not: `eligibleSupplyAt` is a past TOKEN supply less
        // the excluded addresses' TOKEN balances and never reads a quote balance at all. The
        // constructor's reasoning about parked tokens was borrowed for a payment made in the quote.
        // The guard is right; that mechanism was not.)
        if (recipient == address(this)) revert ZeroAddress();
        return _claim(holder, from, to, recipient);
    }

    function _claim(address holder, uint256 from, uint256 to, address recipient)
        private
        returns (uint256 total)
    {
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
             * The cap is what makes this delay bite, and it is worth being exact about how,
             * because this comment used to say "the holder must ALSO still hold when they claim"
             * and the code has never done that. What the cap requires is that the holder held at
             * the CLOSING grid line — `snapshotBlockFor(k + 1)`, the same block this check waits
             * for. So the dividend cannot be collected until the position has been carried across
             * a whole epoch, which is the property the delay is for. It says nothing whatever
             * about the balance at claim time: an address that held through the epoch and sold
             * every token the block afterwards is still owed this, and is still paid it.
             *
             * Nothing strands behind this check — the epoch stays claimable from that block until
             * `sweepableFrom(k)`, by whoever held it through, in any order and at any time in
             * between. It is not claimable for ever, which this comment used to say: after 26
             * epochs `sweepResidue` may carry what is left of it to the holders of a later
             * interval, and a claimant who waited that long is deliberately dispossessed.
             */
            if (block.number <= snapshotBlockFor(k + 1)) revert NotMatured(k, snapshotBlockFor(k + 1) + 1);
            Epoch storage e = epochs[k];
            /*
             * NOTHING LEFT IN THIS EPOCH, in either of the two ways that can happen, and both must
             * skip rather than divide.
             *
             * An EMPTY epoch — an interval that earned nothing, opened only to move the grid on —
             * carries `amount == 0` against `eligibleSupply == 0`, so this skip is also what keeps
             * the division below from dividing by zero. Third and last of the independent guards
             * against a zero-value epoch; the other two are in `_openEpoch`.
             *
             * A SWEPT epoch carries `claimed == amount`, both possibly non-zero, because
             * `sweepResidue` raised `claimed` to say the remainder now belongs to a later interval.
             * The test is therefore `amount <= claimed` and not `amount == 0`: a part-claimed epoch
             * that was then swept still has a positive `amount`, and computing a share of it here
             * would spend money that is in somebody else's bucket. `EpochOverspent` below would
             * catch it — but as a revert that takes the caller's whole range down with it, which is
             * a denial of service, not a refusal. The assertion stays for the case it was written
             * for: `claimed` overtaking `amount` through the arithmetic rather than through a sweep.
             */
            if (e.amount <= e.claimed) continue;
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
