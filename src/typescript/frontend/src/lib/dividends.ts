import { formatUnits } from "viem";

import { formatCompact } from "./utils/format-compact";

/**
 * Per-epoch dividend arithmetic for a holder-rewards market.
 *
 * The vault stores one `Epoch` per interval it has funded: the balance snapshot block, the amount
 * attributed to it, the eligible supply at the snapshot, and what has been claimed. An epoch k is
 * claimable once the chain is past `snapshotBlockFor(k + 1)`; a holder's payout for it is
 * `amount × weight / eligibleSupply`, in bigint, the way the contract divides.
 *
 * Everything here is pure so the statuses and the shares can be pinned in a test without a chain.
 */

export type EpochStatus = "accruing" | "matured" | "claimable" | "claimed";

export interface EpochInput {
  index: number;
  snapshotBlock: bigint;
  amount: bigint;
  eligibleSupply: bigint;
  claimed: bigint;
  /** `snapshotBlockFor(index + 1)`: the block after which the epoch may be claimed. */
  opensAtBlock: bigint;
}

export interface HolderInput {
  /** `weightOf(holder, k)` per epoch index. */
  weights: Record<number, bigint>;
  /** `hasClaimed(k, holder)` per epoch index. */
  claimed: Record<number, boolean>;
}

export interface EpochRow {
  index: number;
  fromBlock: bigint;
  opensAtBlock: bigint;
  distributed: bigint;
  claimed: bigint;
  remaining: bigint;
  status: EpochStatus;
  /** The holder's entitlement for this epoch, or `null` when no holder was given. */
  holderShare: bigint | null;
  /** The part of `holderShare` still claimable: zero once claimed or before maturity. */
  holderClaimable: bigint;
}

export interface EpochLedger {
  rows: EpochRow[];
  totals: { distributed: bigint; claimed: bigint; remaining: bigint; holderClaimable: bigint };
  /** The contiguous epoch range the holder can claim in one call, oldest first, or `null`. */
  claimableRange: { from: number; to: number } | null;
}

/** A holder's payout for one epoch, in the contract's own integer arithmetic. */
export function holderShareOf(epoch: { amount: bigint; eligibleSupply: bigint }, weight: bigint): bigint {
  if (epoch.eligibleSupply === 0n || weight === 0n || epoch.amount === 0n) return 0n;
  return (epoch.amount * weight) / epoch.eligibleSupply;
}

export function epochRows(input: {
  epochs: EpochInput[];
  currentBlock: bigint;
  holder?: HolderInput;
}): EpochLedger {
  const { epochs, currentBlock, holder } = input;
  const rows: EpochRow[] = epochs
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((e) => {
      const matured = currentBlock > e.opensAtBlock;
      const share = holder ? holderShareOf(e, holder.weights[e.index] ?? 0n) : null;
      const holderClaimedIt = holder ? Boolean(holder.claimed[e.index]) : false;
      const remaining = e.amount > e.claimed ? e.amount - e.claimed : 0n;
      let status: EpochStatus;
      if (!matured) status = "accruing";
      else if (holder && holderClaimedIt) status = "claimed";
      else if (holder && share !== null && share > 0n) status = "claimable";
      else status = "matured";
      const holderClaimable = status === "claimable" && share !== null ? share : 0n;
      return {
        index: e.index,
        fromBlock: e.snapshotBlock,
        opensAtBlock: e.opensAtBlock,
        distributed: e.amount,
        claimed: e.claimed,
        remaining,
        status,
        holderShare: share,
        holderClaimable,
      };
    });

  const totals = rows.reduce(
    (acc, r) => ({
      distributed: acc.distributed + r.distributed,
      claimed: acc.claimed + r.claimed,
      remaining: acc.remaining + r.remaining,
      holderClaimable: acc.holderClaimable + r.holderClaimable,
    }),
    { distributed: 0n, claimed: 0n, remaining: 0n, holderClaimable: 0n },
  );

  // The contract claims a contiguous range and skips epochs already claimed or empty inside it,
  // so the range is the first claimable index to the last one; anything between is harmless.
  const claimable = rows.filter((r) => r.status === "claimable");
  const claimableRange =
    claimable.length === 0 ? null : { from: claimable[0]!.index, to: claimable[claimable.length - 1]!.index };

  return { rows, totals, claimableRange };
}

/** A quote amount for the ledger: a unit above a thousand, two decimals above one, three significant digits below. */
export function formatQuote(amount: bigint, decimals: number): string {
  const whole = Number(formatUnits(amount, decimals));
  if (!Number.isFinite(whole) || whole === 0) return "0";
  if (whole >= 1000) return formatCompact(whole, 2);
  if (whole >= 1) return whole.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return whole.toLocaleString("en-US", { maximumSignificantDigits: 3 });
}

/** Roughly when a block lands, from the current block and Monad's block time. */
export function estimateBlockTime(block: bigint, currentBlock: bigint, nowMs: number, blockMs = 400): Date {
  const delta = Number(block - currentBlock);
  return new Date(nowMs + delta * blockMs);
}

/**
 * How many epochs `createEpochs` can open right now: consecutive intervals from `epochCount`
 * whose closing block (`snapshotBlockFor(k + 1)`) the chain has passed, stopping at the first one
 * still open. `closes[i]` is the close of interval `epochCount + i`.
 */
export function openableEpochs(epochCount: number, closes: bigint[], currentBlock: bigint): number {
  let n = 0;
  for (const close of closes) {
    if (currentBlock > close) n += 1;
    else break;
  }
  return epochCount >= 0 ? Math.min(n, closes.length) : 0;
}

/**
 * The vault in four figures, the way a holder reads it.
 *
 *   - **funded**: everything that has ever reached the vault — paid, waiting and awaiting split.
 *   - **paid**: what holders have claimed out of opened epochs.
 *   - **waiting**: in opened epochs and not yet claimed — money that already belongs to someone.
 *   - **awaitingSplit**: funded but not yet in an epoch (`unallocated`); it joins the epochs as
 *     the intervals it fell in close and someone opens them.
 *
 * Read off the vault itself, not off the indexer's counters: a counter that misses one route
 * (the pool-side sweep) prints money as pending that is already in the vault.
 *
 * `waiting` is the vault's BALANCE less `unallocated`, not the sum of the epochs' remainders.
 * The two agree until `sweepResidue` runs: 26 epochs after an epoch closes, the vault moves its
 * unclaimed remainder into `unallocated` without touching that epoch's `amount` or `claimed`, so
 * summing the rows would count the same wei as both waiting and awaiting split. The balance
 * cannot double count anything.
 */
export function vaultSummary(
  rows: Pick<EpochRow, "distributed" | "claimed">[],
  unallocated: bigint,
  balance: bigint
): { funded: bigint; paid: bigint; waiting: bigint; awaitingSplit: bigint } {
  const paid = rows.reduce((acc, r) => acc + r.claimed, 0n);
  const awaitingSplit = unallocated > 0n ? (unallocated < balance ? unallocated : balance) : 0n;
  const waiting = balance > awaitingSplit ? balance - awaitingSplit : 0n;
  return { funded: paid + balance, paid, waiting, awaitingSplit };
}

/** A quote amount in dollars, when the quote has a price; `null` when it has none. */
export function usdOf(amount: bigint, decimals: number, usdPrice: number | null | undefined): number | null {
  if (usdPrice === null || usdPrice === undefined || !Number.isFinite(usdPrice) || usdPrice <= 0) return null;
  return Number(formatUnits(amount, decimals)) * usdPrice;
}

/** Dollars for a figure: cents above a dollar, three significant digits below, a dash for none. */
export function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "";
  if (value === 0) return "$0.00";
  if (value >= 1000) return `$${formatCompact(value, 2)}`;
  if (value >= 1) return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${value.toLocaleString("en-US", { maximumSignificantDigits: 3 })}`;
}

/**
 * What the epoch accruing NOW means for one wallet.
 *
 * An epoch pays a wallet on the LOWER of two balances: the one it held at the epoch's opening
 * snapshot and the one it holds at the closing snapshot, 216,000 blocks (about a day) later
 * (`RewardVault.weightOf`). Nothing in between is looked at. Run against the real vault on a fork of
 * mainnet, that rule paid nothing to a wallet that held for twenty minutes between two snapshots,
 * nothing to one that held across only one of them, nothing FOR THAT DAY to one that bought twenty
 * minutes after a snapshot and kept holding — and a full share to one that held only at the two
 * instants. A holder cannot work any of that out from "Nothing to claim yet.", which is what the
 * panel used to say to all of them alike.
 */
export type HolderStanding =
  /** Held none at the snapshot and holds none now. */
  | { kind: "none" }
  /** The snapshot balance could not be read. Said as such: a guess here is a promise about money. */
  | { kind: "unknown" }
  /** The market's first snapshot is still ahead: hold through it AND the next to earn the first epoch. */
  | { kind: "before-first-snapshot"; snapshotAtBlock: bigint; claimableAtBlock: bigint }
  /** Holds now, held none at the snapshot: this epoch pays it nothing. */
  | { kind: "bought-after-snapshot"; startsAtBlock: bigint; firstClaimAtBlock: bigint }
  /** Held at the snapshot and still holds: `counted` is what the epoch will pay on if nothing changes. */
  | { kind: "earning"; counted: bigint; soldSince: boolean; claimableAtBlock: bigint }
  /** Held at the snapshot and holds none now: paid nothing unless it holds again at the close. */
  | { kind: "sold-out"; heldAtOpen: bigint; closesAtBlock: bigint };

export function holderStanding(input: {
  currentBlock: bigint;
  /** `snapshotBlockFor(k)` for the accruing epoch `k`: its opening snapshot. */
  opensAtBlock: bigint;
  /** `snapshotBlockFor(k + 1)`: its closing snapshot, after which it can be claimed. */
  closesAtBlock: bigint;
  /** `getPastBalance(holder, opensAtBlock)`, or `null` when it was not or could not be read. */
  balanceAtOpen: bigint | null;
  balanceNow: bigint;
}): HolderStanding {
  const { currentBlock, opensAtBlock, closesAtBlock, balanceAtOpen, balanceNow } = input;
  // The token reverts on a snapshot at or after the head, so until the opening line has been
  // passed there is no balance to read — only on the first day of a graduated market's life.
  if (currentBlock <= opensAtBlock) {
    return balanceNow === 0n
      ? { kind: "none" }
      : { kind: "before-first-snapshot", snapshotAtBlock: opensAtBlock, claimableAtBlock: closesAtBlock };
  }
  if (balanceAtOpen === null) return balanceNow === 0n ? { kind: "none" } : { kind: "unknown" };
  if (balanceAtOpen === 0n) {
    if (balanceNow === 0n) return { kind: "none" };
    return {
      kind: "bought-after-snapshot",
      startsAtBlock: closesAtBlock,
      firstClaimAtBlock: closesAtBlock + (closesAtBlock - opensAtBlock),
    };
  }
  if (balanceNow === 0n) return { kind: "sold-out", heldAtOpen: balanceAtOpen, closesAtBlock };
  return {
    kind: "earning",
    counted: balanceNow < balanceAtOpen ? balanceNow : balanceAtOpen,
    soldSince: balanceNow < balanceAtOpen,
    claimableAtBlock: closesAtBlock,
  };
}

/**
 * The oldest epoch this holder can still claim: the one whose window closes first.
 *
 * A claim window is 26 epochs from the epoch's close (`RewardVault.sweepableFrom`). After it anyone
 * may call `sweepResidue`, which moves what is unclaimed into the CURRENT epoch for whoever holds
 * then — on the fork, a holder who waited was paid nothing for a day they had held in full.
 */
export function oldestClaimableEpoch(rows: readonly EpochRow[]): number | null {
  const claimable = rows.filter((r) => r.holderClaimable > 0n).map((r) => r.index);
  return claimable.length === 0 ? null : Math.min(...claimable);
}
