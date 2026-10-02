import type { Db } from "../../db/legacy.js";
import { servedFrom } from "../../repositories/served.js";
import { createLogger } from "../../utils/logger.js";
import { SINK_REWARDS } from "../generations.js";
import { type Job, startJob } from "../jobs.js";
import {
  type FundingChain,
  KeeperState,
  MAX_ATTEMPTS,
  type Purse,
  spend,
} from "./keeper.js";

/**
 * The payout pass: the keeper claims holders' dividends for them.
 *
 * `RewardVault.claim(holder, from, to)` is permissionless and pays the NAMED holder and nobody
 * else — the caller chooses who is paid and pays the gas, and can do nothing further. So a process
 * that is always there can claim on every holder's behalf once an epoch matures, and a holder who
 * never visits the site still receives what they are owed. That is what this pass does, for every
 * graduated dividends market this deployment serves.
 *
 * ## What it must never do
 *
 * - **Pay gas for dust.** Every claim costs a transaction. A holder is claimed for only when the
 *   total they can claim right now is worth at least `minUsd`, priced at the quote's catalogue
 *   price. A quote with no price cannot be valued and is left to the button.
 * - **Send a claim that would revert.** The planner mirrors the contract's own rules — matured,
 *   not expired, not yet claimed, weight above zero, pot not spent — and the adapter simulates
 *   before it sends, so a revert costs nothing. The contract skips claimed and zero-weight epochs
 *   inside a range itself, so the range is simply first claimable to last.
 * - **Dip under the reserve.** The same `spend` as the funding pass: a claim that would take the
 *   wallet under Monad's 10 MON reserve is refused before signing and reported on `/status`.
 * - **Loop for ever on a broken holder.** One holder's revert backs that holder off, like a vault
 *   that fails to fund, and gives up after `MAX_ATTEMPTS` until restart.
 *
 * ## Where the key is
 *
 * Nowhere here. This module is policy: it is driven against `PayoutChain`, a port, and the only
 * place a private key becomes an account is `keeper-chain.ts`. Nothing in this file logs, stores
 * or forwards anything but addresses, amounts and hashes.
 */

const log = createLogger().child({ component: "dividend-payout" });

/** How often the pass runs. Epochs open once a day; a half hour is prompt without being noisy. */
export const PAYOUT_INTERVAL_MS = 30 * 60_000;
/** The most claims one pass sends, so a market with thousands of holders is paid over passes. */
export const MAX_CLAIMS_PER_PASS = 100;
/** The most holders read for one market per pass; a longer list is walked across passes. */
export const MAX_HOLDERS_PER_MARKET = 2_000;
/** Holders read between fresh reads of the head, so a long walk never judges maturity on a stale block. */
export const HEAD_REFRESH_EVERY = 25;

export interface VaultEpoch {
  snapshotBlock: bigint;
  amount: bigint;
  eligibleSupply: bigint;
  claimed: bigint;
}

/** Everything the payout pass needs from the chain, as its own port. */
/** One holder's standing in a set of epochs, read in one round trip. */
export interface HolderEpochs {
  /** `RewardVault.isExcluded(holder)` — the pool, the vault, the locker: never paid. */
  excluded: boolean;
  /** `RewardVault.weightOf(holder, k)` per requested epoch, in order. */
  weights: bigint[];
  /** `RewardVault.hasClaimed(k, holder)` per requested epoch, in order. */
  claimed: boolean[];
}

export interface PayoutChain
  extends Pick<FundingChain, "address" | "balance" | "gasPrice" | "feePerGas" | "blockNumber" | "epochCount" | "snapshotBlockFor"> {
  /** `RewardVault.epochs(k)`. */
  epoch(vault: `0x${string}`, k: bigint): Promise<VaultEpoch>;
  /** `RewardVault.sweepableFrom(k)` — the block from which epoch `k` may no longer be claimed. */
  sweepableFrom(vault: `0x${string}`, k: bigint): Promise<bigint>;
  /** The holder's exclusion, weight and claimed flag for every epoch in `epochs`, batched. */
  holderEpochs(vault: `0x${string}`, holder: `0x${string}`, epochs: readonly bigint[]): Promise<HolderEpochs>;
  estimateClaim(vault: `0x${string}`, holder: `0x${string}`, from: bigint, to: bigint): Promise<bigint>;
  /** `RewardVault.claim(holder, from, to)`. Pays `holder`; the keeper pays the gas. */
  claim(vault: `0x${string}`, holder: `0x${string}`, from: bigint, to: bigint, gas: bigint, feePerGas?: bigint): Promise<`0x${string}`>;
}

/** One graduated REWARDS market, with what the payout pass needs to value and claim on it. */
export interface PayoutMarket {
  market: `0x${string}`;
  vault: `0x${string}`;
  token: `0x${string}`;
  quoteDecimals: number;
  /** The quote's dollar price from the catalogue, or `null` when it has none. */
  usdPrice: number | null;
}

/**
 * Every graduated REWARDS market this deployment serves, with its token and its quote's price.
 *
 * The same rows `findRewardsMarkets` names, for the same reasons (see there), joined to the
 * catalogue for the one thing the minimum needs: what a unit of the quote is worth.
 */
export async function findPayoutMarkets(db: Db): Promise<PayoutMarket[]> {
  const { rows } = await db.query<{
    market_address: string;
    sink: string;
    token_address: string;
    quote_decimals: number | string | null;
    usd_price: number | string | null;
  }>(
    `SELECT m.market_address, g.sink, m.token_address, m.quote_decimals,
            q.usd_price::float8 AS usd_price
       FROM markets m
       JOIN graduations g USING (market_address)
       LEFT JOIN quote_assets q ON LOWER(q.address) = LOWER(m.quote_asset)
      WHERE m.generation = 2
        AND m.block_number >= $1
        AND g.sink_kind = $2
        AND g.sink <> ''
      ORDER BY m.block_number ASC`,
    [servedFrom().toString(), SINK_REWARDS],
  );
  return rows.map((r) => {
    const price = r.usd_price === null ? null : Number(r.usd_price);
    return {
      market: r.market_address as `0x${string}`,
      vault: r.sink as `0x${string}`,
      token: r.token_address as `0x${string}`,
      quoteDecimals: Number(r.quote_decimals ?? 18),
      usdPrice: price !== null && Number.isFinite(price) && price > 0 ? price : null,
    };
  });
}

/**
 * One page of the token's holders with a balance, largest first, minus the addresses that are
 * never paid. `after` is the `balance:holder` cursor of the last row of the previous page; the
 * returned `next` is `null` once the tail has been reached, so the next walk starts from the top.
 */
export async function findHolders(
  db: Db,
  token: string,
  limit = MAX_HOLDERS_PER_MARKET,
  after: string | null = null,
): Promise<{ holders: `0x${string}`[]; cursors: string[]; next: string | null }> {
  const { rows } = await db.query<{ holder: string; balance: string }>(
    `SELECT holder, balance::text AS balance FROM token_balances
      WHERE token_address = $1 AND balance > 0
        AND holder NOT IN ('0x0000000000000000000000000000000000000000',
                           '0x000000000000000000000000000000000000dead')
        AND ($3::text IS NULL OR (balance, holder) < (SPLIT_PART($3, ':', 1)::numeric, SPLIT_PART($3, ':', 2)))
      ORDER BY balance DESC, holder DESC
      LIMIT $2`,
    [token, limit, after],
  );
  const holders = rows.map((r) => r.holder as `0x${string}`);
  // One cursor per row, so a pass that stops early can resume at the last holder it saw.
  const cursors = rows.map((r) => `${r.balance}:${r.holder}`);
  const last = rows[rows.length - 1];
  const next = rows.length === limit && last ? `${last.balance}:${last.holder}` : null;
  return { holders, cursors, next };
}

/** An epoch as the planner sees it: the vault's row plus the two blocks that bound its claim window. */
export interface PlannedEpoch extends VaultEpoch {
  index: bigint;
  /** `snapshotBlockFor(k + 1)`: claimable once the head is past this. */
  closes: bigint;
  /** `sweepableFrom(k)`: no longer claimable from this block. */
  sweepableFrom: bigint;
}

/** The contract's own payout for one epoch: `amount × weight / eligibleSupply`, in integers. */
export function shareOf(e: VaultEpoch, weight: bigint): bigint {
  if (e.eligibleSupply === 0n || weight === 0n || e.amount === 0n) return 0n;
  return (e.amount * weight) / e.eligibleSupply;
}

/**
 * What one holder can claim right now, and the one range that claims it.
 *
 * An epoch counts when the head is past its close and before its sweep, the holder has not
 * claimed it, their weight is above zero and the pot is not spent. The range runs from the first
 * such epoch to the last: the contract skips anything claimed or weightless in between, so the
 * gaps are harmless and one transaction covers everything.
 *
 * The sweep cut is this pass's own rule, not the contract's: `_claim` keeps paying an epoch until
 * somebody has actually called `sweepResidue` on it, so a late claim still works from the market
 * page. The keeper stops at the window so it never races a sweep; what is left after it belongs
 * to whoever presses the button first.
 */
export function planClaim(
  epochs: readonly PlannedEpoch[],
  weights: ReadonlyMap<bigint, bigint>,
  claimed: ReadonlySet<bigint>,
  head: bigint,
): { total: bigint; range: { from: bigint; to: bigint } | null; epochs: bigint[] } {
  let total = 0n;
  const picked: bigint[] = [];
  for (const e of epochs) {
    if (head <= e.closes) continue;
    if (head >= e.sweepableFrom) continue;
    if (claimed.has(e.index)) continue;
    if (e.amount <= e.claimed) continue;
    const share = shareOf(e, weights.get(e.index) ?? 0n);
    if (share === 0n) continue;
    total += share;
    picked.push(e.index);
  }
  if (picked.length === 0) return { total: 0n, range: null, epochs: [] };
  return { total, range: { from: picked[0]!, to: picked[picked.length - 1]! }, epochs: picked };
}

/** A raw quote amount in dollars at the catalogue price, or `null` when the quote has none. */
export function usdOf(amount: bigint, decimals: number, usdPrice: number | null): number | null {
  if (usdPrice === null) return null;
  return (Number(amount) / 10 ** decimals) * usdPrice;
}

/** Whether a payout is worth a transaction: at least `minUsd` at the quote's price. */
export function meetsMinimum(amount: bigint, decimals: number, usdPrice: number | null, minUsd: number): boolean {
  const usd = usdOf(amount, decimals, usdPrice);
  return usd !== null && usd >= minUsd;
}

export interface PayoutResult {
  /** Markets looked at. */
  markets: number;
  /** Claims sent, as `{ market, holder, from, to, amount }`. */
  claimed: { market: `0x${string}`; holder: `0x${string}`; from: bigint; to: bigint; amount: bigint }[];
  /** Holders with something claimable but under the minimum. */
  belowMinimum: number;
  /** Markets whose quote has no price and so could not be valued. */
  unpriced: number;
  failed: number;
  /** Claims that reverted because somebody had already claimed the same epochs; not failures. */
  preempted: number;
  /** True when the pass stopped at `MAX_CLAIMS_PER_PASS`; the rest wait for the next one. */
  capped: boolean;
}

/** Whether every epoch the keeper meant to claim for `holder` has been claimed since it planned to. */
async function claimedMeanwhile(
  chain: PayoutChain,
  vault: `0x${string}`,
  holder: `0x${string}`,
  epochs: readonly bigint[],
): Promise<boolean> {
  if (epochs.length === 0) return false;
  try {
    const read = await chain.holderEpochs(vault, holder, epochs);
    return read.claimed.every(Boolean);
  } catch {
    return false;
  }
}

export interface PayoutOptions {
  minUsd: number;
  maxClaims?: number;
  /** Holders read per market per pass; a test sets it small to exercise the walk. */
  pageSize?: number;
}

/** The claim window of every opened epoch, read once per market per pass. */
async function readEpochs(chain: PayoutChain, vault: `0x${string}`): Promise<PlannedEpoch[]> {
  const count = await chain.epochCount(vault);
  const out: PlannedEpoch[] = [];
  for (let k = 0n; k < count; k += 1n) {
    const [e, closes, sweepableFrom] = await Promise.all([
      chain.epoch(vault, k),
      chain.snapshotBlockFor(vault, k + 1n),
      chain.sweepableFrom(vault, k),
    ]);
    out.push({ ...e, index: k, closes, sweepableFrom });
  }
  return out;
}

/**
 * One pass over every dividends market: claim for every holder owed at least `minUsd`.
 *
 * Epochs that cannot be claimed by anybody yet — still inside their day, swept, or empty — are
 * dropped before a single holder is read, so a market with nothing to pay costs a handful of
 * reads and no more.
 */
export async function runPayoutPass(
  db: Db,
  chain: PayoutChain,
  state: KeeperState,
  opts: PayoutOptions,
  now: () => number = Date.now,
): Promise<PayoutResult> {
  const result: PayoutResult = { markets: 0, claimed: [], belowMinimum: 0, unpriced: 0, failed: 0, preempted: 0, capped: false };
  const maxClaims = opts.maxClaims ?? MAX_CLAIMS_PER_PASS;
  const markets = await findPayoutMarkets(db);
  result.markets = markets.length;
  if (markets.length === 0) return result;

  const purse: Purse = { wei: await chain.balance() };
  state.passed(purse.wei);

  for (const m of markets) {
    if (result.capped) break;
    if (m.usdPrice === null) {
      result.unpriced += 1;
      log.warn("payout skipped a market whose quote has no price; its holders claim by hand", {
        market: m.market,
      });
      continue;
    }
    let epochs: PlannedEpoch[];
    let head: bigint;
    try {
      [head, epochs] = await Promise.all([chain.blockNumber(), readEpochs(chain, m.vault)]);
    } catch (error) {
      result.failed += 1;
      log.warn("payout could not read a vault's epochs", { market: m.market, vault: m.vault, error });
      continue;
    }
    // Only epochs anybody could claim right now are worth reading holders against.
    const open = epochs.filter((e) => head > e.closes && head < e.sweepableFrom && e.amount > e.claimed);
    if (open.length === 0) continue;
    const openIndices = open.map((e) => e.index);

    // One page of holders, resumed from where the last pass stopped on this market.
    const page = await findHolders(db, m.token, opts.pageSize ?? MAX_HOLDERS_PER_MARKET, state.payoutCursor(m.market));
    /*
     * The cursor moves only over holders this pass actually SAW. A pass that stops at the claim
     * cap (or the reserve) parks the cursor on the last holder it visited, so the next pass
     * carries on from there; only a page walked to its end hands the walk the page's own `next`.
     * Advancing to `next` before the loop skipped every unvisited holder until the walk wrapped.
     */
    let stoppedEarly = false;
    let sinceHead = 0;
    for (const [i, holder] of page.holders.entries()) {
      if (result.claimed.length >= maxClaims) {
        result.capped = true;
        stoppedEarly = true;
        if (i > 0) state.setPayoutCursor(m.market, page.cursors[i - 1]!);
        break;
      }
      const key = `${m.vault}:${holder}`.toLowerCase();
      if (!state.due(key, now())) continue;
      let planned: readonly bigint[] = [];
      try {
        // A long walk is minutes; the head it judges maturity by must not be the one it started with.
        if (sinceHead >= HEAD_REFRESH_EVERY) {
          head = await chain.blockNumber();
          sinceHead = 0;
        }
        sinceHead += 1;
        const standing = await chain.holderEpochs(m.vault, holder, openIndices);
        if (standing.excluded) continue;
        const weights = new Map<bigint, bigint>();
        const claimed = new Set<bigint>();
        open.forEach((e, i) => {
          weights.set(e.index, standing.weights[i] ?? 0n);
          if (standing.claimed[i]) claimed.add(e.index);
        });
        const plan = planClaim(open, weights, claimed, head);
        if (plan.range === null) continue;
        planned = plan.epochs;
        if (!meetsMinimum(plan.total, m.quoteDecimals, m.usdPrice, opts.minUsd)) {
          result.belowMinimum += 1;
          continue;
        }
        const { from, to } = plan.range;
        const hash = await spend(
          chain,
          state,
          purse,
          "claim a holder's dividends",
          { market: m.market, vault: m.vault, holder, from: from.toString(), to: to.toString() },
          () => chain.estimateClaim(m.vault, holder, from, to),
          (gas, fee) => chain.claim(m.vault, holder, from, to, gas, fee),
        );
        if (hash === null) {
          // The reserve held it. Nothing else this pass will clear either; stop spending, and
          // resume at this holder next time.
          result.capped = true;
          stoppedEarly = true;
          if (i > 0) state.setPayoutCursor(m.market, page.cursors[i - 1]!);
          break;
        }
        state.paidOut(key, plan.epochs.length, hash);
        result.claimed.push({ market: m.market, holder, from, to, amount: plan.total });
        log.info("claimed a holder's dividends for them", {
          market: m.market,
          vault: m.vault,
          holder,
          epochs: plan.epochs.map((k) => k.toString()),
          amountRaw: plan.total.toString(),
          usd: usdOf(plan.total, m.quoteDecimals, m.usdPrice),
          hash,
        });
      } catch (error) {
        /*
         * A claim that reverted on chain after simulating clean has one likely cause: somebody —
         * the holder, or anyone front-running the keeper — claimed the same epochs first, so the
         * range had nothing left and the contract answered NothingToClaim. The holder is paid
         * either way; what must not happen is counting it as a failure and backing the holder
         * off as if the vault were broken. Re-read the epochs: if everything planned is now
         * claimed, it was a pre-emption, not a fault.
         */
        if (await claimedMeanwhile(chain, m.vault, holder, planned)) {
          state.preempted(key);
          result.preempted += 1;
          log.info("a holder's dividends were claimed by somebody else first; nothing to do", {
            market: m.market,
            holder,
          });
          continue;
        }
        const a = state.failed(key, error, now());
        result.failed += 1;
        const fields = { market: m.market, holder, error, failures: a.failures };
        if (a.failures >= MAX_ATTEMPTS) log.error("giving up on a holder's claims until restart", fields);
        else log.warn("a claim failed; backing off that holder", fields);
      }
    }
    if (!stoppedEarly) state.setPayoutCursor(m.market, page.next);
  }
  return result;
}

/**
 * The payout pass, on its own clock.
 *
 * Separate from the funding job for the same reason that one is separate from the graduation
 * job: a different cadence, and a pass whose length is a function of holder count rather than
 * market count. It shares `KeeperState`, so it shares the balance, the backoff, the reserve
 * counter and `/status`.
 */
export function startPayoutJob(
  db: Db,
  chain: PayoutChain,
  state: KeeperState,
  opts: PayoutOptions,
  onError: (e: unknown) => void,
  intervalMs = PAYOUT_INTERVAL_MS,
): Job {
  return startJob({
    name: "dividend-payout",
    intervalMs,
    run: async () => {
      await runPayoutPass(db, chain, state, opts);
    },
    onError,
  });
}
