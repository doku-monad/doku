import type { Db } from "../../db/legacy.js";
import { servedFrom } from "../../repositories/served.js";
import { createLogger } from "../../utils/logger.js";
import { redactUrls } from "../../utils/redact.js";
import { SINK_REWARDS } from "../generations.js";
import { type Job, startJob } from "../jobs.js";
import type { KeeperSnapshot } from "../state.js";

/**
 * The keeper: the caller two different parts of this protocol were missing.
 *
 * Two jobs, one wallet, one `KeeperState`, and one property they share — **every function either
 * job signs is permissionless**. The keeper has no role on chain and is granted nothing; it is
 * only the caller who is always there. Job one graduates stranded markets (below); job two funds
 * every REWARDS market's `RewardVault` once per interval (further below).
 *
 * ## The state this exists for
 *
 * A curve fills and graduates in one transaction — the filling buy calls `graduate()` on the way
 * out. That call is a raw `call(gas(), …)` whose failure is SWALLOWED, on purpose: the buyer who
 * happens to fill a curve did not choose to be the one who graduates it, and a revert there would
 * make the last slice of every curve unbuyable. But EIP-150 forwards at most 63/64 of what is left,
 * so a buy sent with a wallet's ordinary gas estimate fills the curve, starves the graduation, and
 * lands as a SUCCESS with `AutoGraduationFailed(gasLeft)` in its logs. What that leaves behind is
 * a market nobody can trade: `readyToGraduate` latched, both curve legs shut, no pool, no sink.
 * `graduate()` still works — it is permissionless by design — but somebody has to send it.
 *
 * The frontend widened its gas trigger and grew a "Graduate this market" button. That is a retry
 * with a caller who has to notice. This is the retry with a caller who is always there.
 *
 * ## Why it lives in the indexer
 *
 * The indexer is the one process that already sees every `ReadyToGraduate` and every `Graduated`,
 * already holds the difference between them in `market_state`, and already runs clocks beside the
 * ingest loop. A stranded market is one row: `ready_to_graduate AND pool_address IS NULL`. Nothing
 * new has to be discovered, only acted on.
 *
 * ## What it must never do
 *
 * - **Race the filling buy.** The database is behind the chain by the confirmation lag, so a row
 *   that reads stranded may already have graduated. `graduated(curve)` is read on chain first, and
 *   a market that has is skipped without a transaction.
 * - **Burn the balance on a market that cannot graduate.** Monad bills the gas LIMIT, so every
 *   attempt costs the full limit whether or not it succeeds. Each attempt is simulated first — a
 *   revert in simulation is free — and a market that keeps failing backs off exponentially and is
 *   given up on, loudly, rather than retried forever at ~0.3 MON a time.
 * - **Dip under the reserve.** Monad refuses a balance-decrementing transaction that would end
 *   below 10 MON. The keeper refuses one itself, before signing, and reports why — a revert there
 *   would still be billed.
 * - **Touch a retired generation.** The query is cut by `servedFrom()` like every read, so a
 *   generation-2 market — which this deployment no longer speaks to, and whose graduator is a
 *   different contract — is never a candidate.
 *
 * ## The second job: funding every REWARDS market's vault, once per interval
 *
 * `RewardVault` attributes money to the interval it ARRIVED in — `fund()` credits
 * `pending[intervalAt(block.number)]` and nothing moves it backwards. (Generation 5 spreads a
 * large pull FORWARD over up to `MAX_SPREAD_INTERVALS = 7` buckets starting at that interval, so a
 * late catch-up can concentrate at most ~1/7 of a backlog in one epoch; it never writes an earlier
 * bucket, so this job's cadence logic is unchanged.) `fund()` is permissionless
 * and uncadenced, so WHO calls it decides nothing but WHEN decides everything: the audit record
 * (`docs/doku/audit/gen4/README.md`, "M-01's timing lever") measured a newcomer funding late being
 * paid for intervals they were not present for — 1,333 MON in the worked case — and established
 * that the on-chain repair is not implementable, because Uniswap hands the hook a `feeGrowthInside`
 * INTEGRAL with no timeline inside it. The finding's own conclusion is that the mitigation is
 * operational: "a keeper calling `fund()` once per interval". This is that keeper. The lever is not
 * removed; it is made worthless, because the interval is always already funded when a newcomer
 * arrives.
 *
 * ## The money path, which is moving underneath this
 *
 * `fund()` pulls `DokuHook.owedSink[id]` and nothing else, so the pass has to put the money THERE
 * first, and there are two routes into it:
 *
 * - `DokuHook.sweep(id)` materialises `pendingSink[id]` into `owedSink[id]`. With `SINK_LEVY_BPS`
 *   at zero this is empty today; once the hook credits the 70 bps LP share straight to
 *   `pendingSink[poolId]` instead of donating it to the seed position, it is the WHOLE path.
 * - `SeedLocker.collect(tokenId)` forwards the seed position's accrued fees through
 *   `DokuHook.creditCurveTax`, which credits `owedSink[id]` directly with no sweep. That is the
 *   whole path TODAY, and after the hook change it is a path that carries nothing.
 *
 * The pass reads both and acts on what it finds, so the same code is correct on either side of that
 * contract change. Nothing here assumes a collect is worth sending: `seedFees()` is asked first,
 * and when the chain cannot answer (v4 exposes no fee getter and StateView is not deployed on
 * Monad mainnet — see `frontend/src/lib/chain/position-fees.ts`, which reaches the same wall and
 * reports "not quoted" rather than zero) the pass falls back to the one thing this process knows
 * for certain: fee growth changes only on a swap, and it has every swap in `swaps`.
 *
 * ## What the funding pass must never do
 *
 * - **Fund twice in one interval.** A second `fund()` in the same interval is not a loss — the
 *   money still lands in the right bucket — but it is a second gas limit for nothing, every ten
 *   seconds, for ever. The interval is read from the vault and remembered per vault.
 * - **Send a transaction that moves nothing.** A `fund()` with `owedSink == 0` succeeds, emits
 *   `Funded(0)`, and costs the full limit. Gated on a non-zero hook-side balance, read first. The
 *   same applies to `collect`, which is why the pass MEASURES what a collect forwarded and stops
 *   collecting a market whose seed position has proven it forwards nothing — otherwise a market
 *   that keeps trading buys one pointless collect per interval for ever, once the hook change
 *   takes the seed position off the money path.
 * - **Dip under the reserve, or retry a broken market for ever.** The same guard and the same
 *   backoff as a graduation, over the same counters.
 *
 * ## Rollback
 *
 * Unset `KEEPER_PRIVATE_KEY`. Neither job starts, `/status` reports `keeper: null`, and the
 * process is exactly what it was before this file existed. Unsetting `DOKU_HOOK2` alone stops the
 * funding pass and leaves graduations running.
 */

const log = createLogger().child({ component: "graduation-keeper" });

export const KEEPER_INTERVAL_MS = 10_000;

/**
 * How often the funding pass looks.
 *
 * Not the graduation cadence, and deliberately far slower. A vault's interval is
 * `RewardVault.EPOCH_BLOCKS` = 216,000 blocks, which on Monad's 0.4 s blocks is about a day, so
 * looking every ten seconds would be 8,640 identical answers a day per market — every one of them
 * an RPC read, on a node that rate-limits. Five minutes is still three hundred looks per interval:
 * the money is funded within minutes of an interval turning over, and the read budget is a
 * thirtieth.
 */
export const FUND_INTERVAL_MS = 5 * 60_000;

/**
 * Monad's minimum balance. A transaction that would leave the sender below it is refused by the
 * chain unless it empties the account entirely, and a `graduate()` never does.
 */
export const MONAD_RESERVE_WEI = 10n * 10n ** 18n;

/** After the Nth consecutive failure on one market, wait this long before trying it again. */
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 15 * 60_000;
/** Consecutive failures after which a market is left alone until the process restarts. */
export const MAX_ATTEMPTS = 6;

/** How long after a `collectFees()` was SENT for a curve before this process will send another. */
export const CURVE_FEES_RETRY_MS = 24 * 60 * 60_000;

/**
 * Everything the keeper needs from the chain, as a port.
 *
 * Narrow on purpose: the unit tests drive the whole policy — skipping, backing off, the reserve
 * guard, the counters — against a fake, and only the anvil suite pays for a real client. Amounts
 * are `bigint` wei; nothing here is ever a float.
 */
export interface KeeperChain {
  /** The keeper's own address, for the log and for `/status`. */
  address: `0x${string}`;
  /** `DokuGraduation.graduated(curve)`. */
  graduated(curve: `0x${string}`): Promise<boolean>;
  /** `BondingCurve.readyToGraduate()`. */
  ready(curve: `0x${string}`): Promise<boolean>;
  /** `BondingCurve.autoGraduationGasHint()`, the limit the protocol itself asks for. */
  gasHint(curve: `0x${string}`): Promise<bigint>;
  balance(): Promise<bigint>;
  gasPrice(): Promise<bigint>;
  /**
   * What a unit of gas is RESERVED at: the 1559 `maxFeePerGas` a send will carry, or the legacy
   * price with a quarter's margin where the node offers no estimate. The reserve guard prices with
   * this rather than `gasPrice`, because the node checks the balance against the max fee, and a
   * guard priced below it passes transactions the node then refuses.
   */
  feePerGas(): Promise<bigint>;
  /**
   * Simulate, then send, then wait. Resolves with the hash on success; rejects on a simulation
   * revert, a send failure, or a reverted receipt. The gas is the LIMIT the transaction is sent
   * with, and on Monad it is also what the transaction costs.
   *
   * `feePerGas`, on this and every write below, is the fee the caller's guards were priced at. The
   * adapter SIGNS with it rather than letting the wallet make an estimate of its own: left to
   * itself viem asks the node again at signing time, and the reserve and ceiling checks then bound
   * a number that is not the one on the transaction.
   */
  graduate(curve: `0x${string}`, gas: bigint, feePerGas?: bigint): Promise<`0x${string}`>;
}

/**
 * Everything the funding pass needs from the chain, as a second port.
 *
 * Separate from `KeeperChain` rather than bolted onto it, for one reason: the graduation policy's
 * fake would otherwise have to grow eleven methods it never calls, and a fake that implements more
 * than the thing under test is a fake that stops documenting it. The viem adapter returns one
 * object satisfying both, so the process still has a single port.
 *
 * The three writes mirror `graduate` exactly: an `estimate*` that costs nothing, and a `send` that
 * takes the LIMIT as an argument — because on Monad the limit is the price, so the caller and not
 * the adapter decides what an attempt may cost.
 */
export interface FundingChain extends Pick<KeeperChain, "address" | "balance" | "gasPrice" | "feePerGas"> {
  /** `RewardVault.currentInterval()` — the bucket `fund()` would credit right now. */
  currentInterval(vault: `0x${string}`): Promise<bigint>;
  /**
   * `BondingCurve.pendingFees()` — the holders' 0.7% of every trade the market made ON THE CURVE.
   * It stays on the curve through graduation: `release()` leaves the fee buckets behind, no trade
   * moves them, and only `collectFees()` does.
   */
  curveFees(curve: `0x${string}`): Promise<bigint>;
  estimateCollectFees(curve: `0x${string}`): Promise<bigint>;
  /**
   * `BondingCurve.collectFees()`. Permissionless. On a graduated REWARDS market it credits the
   * hook's `owedSink` through the graduator — the ledger `fund()` pulls — and can pay nobody else.
   */
  collectFees(curve: `0x${string}`, gas: bigint, feePerGas?: bigint): Promise<`0x${string}`>;
  /** `DokuHook.pendingSink(id)` — accrued, and NOT yet reachable by `fund()`. Needs a sweep. */
  pendingSink(poolId: `0x${string}`): Promise<bigint>;
  /** `DokuHook.owedSink(id)` — swept or credited, and exactly what `fund()` pulls. */
  owedSink(poolId: `0x${string}`): Promise<bigint>;
  /**
   * What `SeedLocker.collect(tokenId)` would forward, or `null` when the chain cannot be asked.
   *
   * `null` is not zero and must not be read as it. v4 exposes no fee getter on a position, and the
   * two honest reconstructions — a simulated zero-liquidity decrease, or `StateView`'s
   * `feeGrowthInside` — are respectively unavailable through `eth_call` and unavailable on Monad
   * mainnet, where `StateView` is not deployed. The caller has a fallback for `null`; it has none
   * for a fabricated zero.
   */
  seedFees(tokenId: bigint): Promise<bigint | null>;
  estimateCollect(tokenId: bigint): Promise<bigint>;
  /** `SeedLocker.collect(tokenId)`. Permissionless; the recipient was fixed at graduation. */
  collect(tokenId: bigint, gas: bigint, feePerGas?: bigint): Promise<`0x${string}`>;
  estimateSweep(poolId: `0x${string}`): Promise<bigint>;
  /** `DokuHook.sweep(id)`. Permissionless; calls no sink and so cannot be bricked by one. */
  sweep(poolId: `0x${string}`, gas: bigint, feePerGas?: bigint): Promise<`0x${string}`>;
  estimateFund(vault: `0x${string}`): Promise<bigint>;
  /** `RewardVault.fund()`. Permissionless; pulls the hook's `owedSink` into this interval. */
  fund(vault: `0x${string}`, gas: bigint, feePerGas?: bigint): Promise<`0x${string}`>;
  /** The head, for deciding which epochs have matured. */
  blockNumber(): Promise<bigint>;
  /** `RewardVault.epochCount()` — epochs materialised so far. */
  epochCount(vault: `0x${string}`): Promise<bigint>;
  /** `RewardVault.snapshotBlockFor(k)` — the block epoch `k` snapshots at; epoch `k` opens once the head passes `snapshotBlockFor(k + 1)`. */
  snapshotBlockFor(vault: `0x${string}`, k: bigint): Promise<bigint>;
  estimateCreateEpochs(vault: `0x${string}`, maxSteps: bigint): Promise<bigint>;
  /** `RewardVault.createEpochs(maxSteps)`. Permissionless; materialises matured epochs so holders can claim. */
  createEpochs(vault: `0x${string}`, maxSteps: bigint, gas: bigint, feePerGas?: bigint): Promise<`0x${string}`>;
}

/** The most epochs one `createEpochs` opens: the vault's own forward spread, `MAX_SPREAD_INTERVALS`. */
export const MAX_EPOCHS_PER_OPEN = 7n;

/**
 * How many consecutive epochs from `epochCount` have matured at `head`, capped at
 * `MAX_EPOCHS_PER_OPEN`. Epoch `k` matures once `head > closes[k - epochCount]`, where `closes`
 * holds `snapshotBlockFor(k + 1)` in order. Stops at the first epoch that has not.
 */
export function maturedEpochs(head: bigint, closes: readonly bigint[]): bigint {
  let n = 0n;
  for (const close of closes) {
    if (n >= MAX_EPOCHS_PER_OPEN) break;
    if (head <= close) break;
    n += 1n;
  }
  return n;
}

/** What the keeper remembers about one market between passes. */
interface Attempt {
  failures: number;
  notBefore: number;
  lastError: string | null;
}

export class KeeperState {
  private readonly attempts = new Map<string, Attempt>();
  /** vault → the interval its last successful `fund()` credited. The once-per-interval rule. */
  private readonly fundedInterval = new Map<string, bigint>();
  /**
   * market → the pool-swap height the last seed collect was decided against.
   *
   * A v4 position's fee growth moves on a swap and on nothing else, so a height that has not
   * advanced is proof that a `collect` would forward zero — which is the only kind of proof
   * available while no fee getter exists. Seeded on first sight rather than at zero: a fresh
   * process must not conclude that every market it has ever seen is owed a collect and send one
   * transaction per market at the full gas limit before it has watched a single swap.
   */
  private readonly collectWatermark = new Map<string, bigint>();
  /**
   * Markets whose seed position has PROVEN it forwards nothing.
   *
   * The swap watermark can only say that a collect *might* move something, and after the hook
   * change that credits the LP share straight to `pendingSink` the seed position stops earning
   * entirely — so a market that keeps trading would otherwise buy one pointless collect per
   * interval, for ever, at a full gas limit each. One collect that moves the hook's owed ledger by
   * zero is the measurement that settles it, and it is not re-taken until the process restarts.
   */
  private readonly seedExhausted = new Set<string>();
  private graduatedCount = 0;
  private fundedCount = 0;
  /** Successful `createEpochs` calls, and per vault the epoch count after the last one. */
  private epochsOpenedCount = 0;
  private readonly openedEpochs = new Map<string, bigint>();
  /** Successful `claim` calls sent for holders, and the epochs they covered. */
  private payoutCount = 0;
  private payoutEpochCount = 0;
  private preemptedCount = 0;
  private lastPayoutTx: string | null = null;
  /** Successful `BurnSink.burn()` calls, and sink → when this process last sent one. */
  private burnCount = 0;
  private lastBurnTx: string | null = null;
  private readonly burnedAt = new Map<string, number>();
  /** sink → when the burn pass last swept its market: one sweep a day, however the burn goes. */
  private readonly sweptAt = new Map<string, number>();
  /**
   * curve → what this process knows about the holders' fees it was left holding at graduation.
   *
   * `drained` is final: a graduated curve is closed to trading, so a `pendingFees` of zero can
   * never become anything else and is not worth a read every five minutes for ever.
   */
  private readonly curvePots = new Map<string, { drained: boolean; attemptedAt: number | null }>();
  private failedCount = 0;
  private skippedReserve = 0;
  private lastTx: string | null = null;
  private lastError: string | null = null;
  private lastPassAt: Date | null = null;
  private balanceWei: bigint | null = null;

  constructor(private readonly address: `0x${string}`) {}

  /** Whether a market may be attempted now, given its history. */
  due(curve: string, now: number): boolean {
    const a = this.attempts.get(curve);
    if (!a) return true;
    if (a.failures >= MAX_ATTEMPTS) return false;
    return now >= a.notBefore;
  }

  gaveUp(curve: string): boolean {
    return (this.attempts.get(curve)?.failures ?? 0) >= MAX_ATTEMPTS;
  }

  succeeded(curve: string, hash: string): void {
    this.attempts.delete(curve);
    this.graduatedCount += 1;
    this.lastTx = hash;
  }

  failed(curve: string, error: unknown, now: number): Attempt {
    const prior = this.attempts.get(curve)?.failures ?? 0;
    const failures = prior + 1;
    const wait = Math.min(BACKOFF_BASE_MS * 2 ** prior, BACKOFF_MAX_MS);
    const a = {
      failures,
      notBefore: now + wait,
      lastError: redactUrls(error instanceof Error ? error.message : String(error)),
    };
    this.attempts.set(curve, a);
    this.failedCount += 1;
    this.lastError = a.lastError;
    return a;
  }

  /** The interval this vault was last funded in, or `null` while this process has never funded it. */
  lastFundedInterval(vault: string): bigint | null {
    return this.fundedInterval.get(vault.toLowerCase()) ?? null;
  }

  /**
   * Record that this vault's interval is accounted for.
   *
   * `hash` is null when the interval was found already funded on chain rather than funded here —
   * the startup fallback. Nothing was sent, so nothing is counted; only the "do not fund again"
   * fact is kept.
   */
  funded(vault: string, interval: bigint, hash: string | null): void {
    this.fundedInterval.set(vault.toLowerCase(), interval);
    if (hash === null) return;
    this.attempts.delete(vault.toLowerCase());
    this.fundedCount += 1;
    this.lastTx = hash;
  }

  /** Record a `createEpochs` that opened `opened` epochs, leaving the vault at `count`. */
  epochsOpened(vault: string, opened: bigint, count: bigint, hash: string): void {
    this.epochsOpenedCount += Number(opened);
    this.openedEpochs.set(vault.toLowerCase(), count);
    this.lastTx = hash;
  }

  /**
   * market → where the payout pass's holder walk resumes next pass, as a `balance:holder` cursor.
   *
   * A market with more holders than one pass reads is walked across passes rather than having its
   * tail never reached; `null` means start from the top.
   */
  private readonly payoutCursors = new Map<string, string>();

  payoutCursor(market: string): string | null {
    return this.payoutCursors.get(market.toLowerCase()) ?? null;
  }

  /** Where the next pass resumes; `null` when the walk reached the tail and starts over. */
  setPayoutCursor(market: string, cursor: string | null): void {
    if (cursor === null) this.payoutCursors.delete(market.toLowerCase());
    else this.payoutCursors.set(market.toLowerCase(), cursor);
  }

  /** A claim the keeper meant to send was made redundant by somebody else's: not a failure. */
  preempted(key: string): void {
    this.attempts.delete(key.toLowerCase());
    this.preemptedCount += 1;
  }

  /** Record a `claim` sent for one holder (`key` is `vault:holder`) covering `epochs` epochs. */
  paidOut(key: string, epochs: number, hash: string): void {
    this.attempts.delete(key.toLowerCase());
    this.payoutCount += 1;
    this.payoutEpochCount += epochs;
    this.lastPayoutTx = hash;
    this.lastTx = hash;
  }

  /**
   * When this process last burned for `sink`, in epoch milliseconds, or `null` if it never has.
   *
   * The burn pass's clock is the indexed `Burned` event, which survives a restart; this is only
   * the minutes between a burn landing and the ingest loop writing it down.
   */
  lastBurnAt(sink: string): number | null {
    return this.burnedAt.get(sink.toLowerCase()) ?? null;
  }

  /** Whether the funding pass should look at this curve's holder fees now. */
  curveFeesDue(curve: string, now: number): boolean {
    const p = this.curvePots.get(curve.toLowerCase());
    if (!p) return true;
    if (p.drained) return false;
    return p.attemptedAt === null || now - p.attemptedAt >= CURVE_FEES_RETRY_MS;
  }

  /** A `collectFees()` is ABOUT to be sent for this curve: the day's attempt, however it ends. */
  curveFeesAttempted(curve: string, at: number): void {
    this.curvePots.set(curve.toLowerCase(), { drained: false, attemptedAt: at });
  }

  /** The curve holds no holder fees, and being closed, never will again. */
  curveIsDrained(curve: string): void {
    this.curvePots.set(curve.toLowerCase(), { drained: true, attemptedAt: null });
  }

  /** When this process last swept the hook for `sink`'s market, or `null` if it never has. */
  lastSweepAt(sink: string): number | null {
    return this.sweptAt.get(sink.toLowerCase()) ?? null;
  }

  /**
   * Record that the burn pass is ABOUT to send a `DokuHook.sweep` for `sink`'s market.
   *
   * Before the send, not after it: a transaction that is broadcast and then reverts, runs out of
   * gas or loses its receipt is billed in full on Monad, and if only successes were remembered
   * every pass would buy another. Whatever happens next, this was the day's sweep.
   */
  swept(sink: string, at: number): void {
    this.sweptAt.set(sink.toLowerCase(), at);
  }

  /** A sweep the burn pass sent has landed. */
  sweepLanded(hash: string): void {
    this.lastTx = hash;
  }

  /** Record that the burn pass is ABOUT to send a `BurnSink.burn()`: the day's burn, however it ends. */
  burnAttempted(sink: string, at: number): void {
    this.burnedAt.set(sink.toLowerCase(), at);
  }

  /** Record a `BurnSink.burn()` that landed. */
  burned(sink: string, at: number, hash: string): void {
    this.attempts.delete(sink);
    this.burnedAt.set(sink.toLowerCase(), at);
    this.burnCount += 1;
    this.lastBurnTx = hash;
    this.lastTx = hash;
  }

  /**
   * A pass read this market cleanly and found nothing to do: whatever failed before is over.
   *
   * Without this, failures are cumulative rather than consecutive. A buyback market sits under its
   * floor for weeks, read three times a pass, and six unrelated RPC hiccups over that time would
   * end in "given up until restart" for a sink that was never broken.
   */
  cleared(key: string): void {
    this.attempts.delete(key);
  }

  /** The burn pass stood down because the wallet is under the burn job's own floor. */
  burnsHeldForBalance(balance: bigint, floor: bigint): void {
    this.lastError =
      `buyback burns are paused: keeper balance ${balance} wei is under the burn floor of ${floor} wei; ` +
      "graduations and dividends are unaffected — top the keeper up to resume burning";
  }

  /**
   * Whether a seed collect could possibly move anything, given how far the pool has traded.
   *
   * First sight seeds the watermark and answers no: see `collectWatermark`. Every later call
   * answers whether a swap has landed since the last collect this process decided on.
   */
  seedCollectDue(market: string, lastSwapBlock: bigint): boolean {
    if (this.seedExhausted.has(market)) return false;
    const seen = this.collectWatermark.get(market);
    if (seen === undefined) {
      this.collectWatermark.set(market, lastSwapBlock);
      return false;
    }
    return lastSwapBlock > seen;
  }

  /** A collect was sent: the pool has to move again before another one could forward anything. */
  collected(market: string, lastSwapBlock: bigint): void {
    this.collectWatermark.set(market, lastSwapBlock);
  }

  /** That collect moved nothing. The seed position is off the money path; stop paying to ask. */
  seedForwardedNothing(market: string): void {
    this.seedExhausted.add(market);
  }

  heldByReserve(): void {
    this.skippedReserve += 1;
    this.lastError = "balance would fall below Monad's 10 MON reserve; keeper needs topping up";
  }

  passed(balance: bigint): void {
    this.lastPassAt = new Date();
    this.balanceWei = balance;
  }

  snapshot(): KeeperSnapshot {
    let givenUp = 0;
    for (const a of this.attempts.values()) if (a.failures >= MAX_ATTEMPTS) givenUp += 1;
    const lastFundedInterval: Record<string, string> = {};
    for (const [vault, k] of this.fundedInterval) lastFundedInterval[vault] = k.toString();
    const epochCount: Record<string, string> = {};
    for (const [vault, n] of this.openedEpochs) epochCount[vault] = n.toString();
    return {
      address: this.address,
      balanceWei: this.balanceWei?.toString() ?? null,
      graduated: this.graduatedCount,
      funded: this.fundedCount,
      lastFundedInterval,
      epochsOpened: this.epochsOpenedCount,
      epochCount,
      payouts: this.payoutCount,
      payoutEpochs: this.payoutEpochCount,
      payoutsPreempted: this.preemptedCount,
      lastPayoutTx: this.lastPayoutTx,
      burns: this.burnCount,
      lastBurnTx: this.lastBurnTx,
      failed: this.failedCount,
      heldByReserve: this.skippedReserve,
      givenUp,
      lastTx: this.lastTx,
      lastError: this.lastError,
      lastPassAt: this.lastPassAt?.toISOString() ?? null,
    };
  }
}

/**
 * The markets the database believes are filled and poolless, in the generation this deployment
 * serves.
 *
 * `generation = 2` is the pairs-style curve — the only one with a swallowed auto-graduation, and
 * the only one whose graduator is `DOKU_GRADUATION2`. The block cut is the same one every read
 * makes (`served.ts`): a retired generation's market may well be stranded too, and it is not this
 * keeper's to touch — its graduator is a different contract this process is not pointed at.
 */
export async function findStranded(db: Db): Promise<`0x${string}`[]> {
  const { rows } = await db.query<{ market_address: string }>(
    `SELECT m.market_address
       FROM markets m
       JOIN market_state s USING (market_address)
      WHERE m.generation = 2
        AND m.block_number >= $1
        AND s.ready_to_graduate
        AND s.pool_address IS NULL
      ORDER BY m.block_number ASC`,
    [servedFrom().toString()],
  );
  return rows.map((r) => r.market_address as `0x${string}`);
}

/**
 * The headroom every limit this file signs carries: a quarter.
 *
 * On Monad the limit is the price, so headroom is not free — it is the difference between a
 * transaction that costs what it used and one that costs what it asked for. A quarter is what the
 * graduation has always used and what the funding writes now use, so there is one number to change
 * and one number to reason about.
 */
export function withHeadroom(gas: bigint): bigint {
  return gas + gas / 4n;
}

/** The limit a graduation is sent with: the protocol's own hint, plus a quarter. */
export function graduationGasLimit(hint: bigint): bigint {
  return withHeadroom(hint);
}

export interface PassResult {
  candidates: number;
  graduated: `0x${string}`[];
  skipped: `0x${string}`[];
  failed: `0x${string}`[];
}

/**
 * One pass: find, check, act, remember.
 *
 * Sequential over the candidates, deliberately. There is at most a handful of stranded markets at
 * any moment, each attempt is a transaction from one account whose nonce has to be serial anyway,
 * and a pass that fires several at once is a pass that can spend the reserve twice over before the
 * first receipt lands.
 */
export async function runKeeperPass(
  db: Db,
  chain: KeeperChain,
  state: KeeperState,
  now: () => number = Date.now,
): Promise<PassResult> {
  const result: PassResult = { candidates: 0, graduated: [], skipped: [], failed: [] };
  const candidates = await findStranded(db);
  result.candidates = candidates.length;

  let balance = await chain.balance();
  state.passed(balance);
  if (candidates.length === 0) return result;

  for (const curve of candidates) {
    if (!state.due(curve, now())) {
      result.skipped.push(curve);
      continue;
    }

    try {
      // The database lags the chain by the confirmation window. A filling buy that DID graduate
      // reads as stranded here until its `Graduated` is ingested, and sending a second graduation
      // at it would only buy an `AlreadyGraduated` revert at the full limit.
      if (await chain.graduated(curve)) {
        result.skipped.push(curve);
        continue;
      }
      // The other direction of the same lag: a `ReadyToGraduate` the chain has since reorged away.
      if (!(await chain.ready(curve))) {
        result.skipped.push(curve);
        continue;
      }

      const gas = graduationGasLimit(await chain.gasHint(curve));
      const fee = await chain.feePerGas();
      const cost = gas * fee;
      if (balance - cost < MONAD_RESERVE_WEI) {
        state.heldByReserve();
        log.error("keeper cannot graduate: balance would fall below the reserve", {
          curve,
          balanceWei: balance.toString(),
          costWei: cost.toString(),
          reserveWei: MONAD_RESERVE_WEI.toString(),
          keeper: chain.address,
        });
        result.skipped.push(curve);
        continue;
      }

      const hash = await chain.graduate(curve, gas, fee);
      state.succeeded(curve, hash);
      result.graduated.push(curve);
      log.info("graduated a stranded market", { curve, hash, gas: gas.toString() });
      balance = await chain.balance();
      state.passed(balance);
    } catch (error) {
      const a = state.failed(curve, error, now());
      result.failed.push(curve);
      const fields = {
        curve,
        error,
        failures: a.failures,
        retryInMs: a.failures >= MAX_ATTEMPTS ? null : a.notBefore - now(),
      };
      if (a.failures >= MAX_ATTEMPTS) log.error("giving up on a market until restart", fields);
      else log.warn("graduation attempt failed", fields);
    }
  }
  return result;
}

/** One graduated REWARDS market, with everything the funding pass needs to act on it. */
export interface RewardsMarket {
  /** The curve, which is what every other table keys by. */
  market: `0x${string}`;
  /** The `RewardVault` this market's levy is owed to — `graduations.sink` on a REWARDS row. */
  vault: `0x${string}`;
  /** The v4 `PoolId`, which is how the hook's two sink ledgers are keyed. */
  poolId: `0x${string}`;
  /** The seed position, which `SeedLocker.collect` takes as its only argument. */
  tokenId: bigint;
  /** The highest block this market has traded at ON THE POOL. Zero if it never has. */
  lastSwapBlock: bigint;
}

/**
 * Every graduated REWARDS market this deployment serves.
 *
 * Read from `graduations` rather than from `markets.routing`, and the difference is not
 * cosmetic. `routing` is on the market from its launch event, so it names markets that have not
 * graduated and therefore have no vault to fund and no pool to sweep; a row in `graduations` IS
 * the graduation, and it carries the two addresses this pass cannot work without — `sink`, which
 * for `sink_kind = 1` is the market's `RewardVault`, and `pool_id`, which is the only thing that
 * scopes anything to a v4 pool. `gen2/collections.ts` makes the same choice in the other direction
 * for the same reason and says so.
 *
 * The `sink <> ''` and `pool_id <> ''` guards are not paranoia: both columns were added with a
 * `DEFAULT ''` (see `schema.sql`), so a graduation row written before the deferred
 * `PoolRegistered` arrived carries the empty string, and sending `sweep('')` would be a full gas
 * limit spent on a pool id no pool is at.
 *
 * The block cut is `servedFrom()`, the same one every read makes and the same one `findStranded`
 * makes: a retired generation's vault is not this process's to fund.
 */
export async function findRewardsMarkets(db: Db): Promise<RewardsMarket[]> {
  const { rows } = await db.query<{
    market_address: string;
    sink: string;
    pool_id: string;
    token_id: string;
    last_swap_block: string | number | null;
  }>(
    `SELECT m.market_address, g.sink, g.pool_id, g.token_id,
            COALESCE((SELECT MAX(s.block_number) FROM swaps s
                       WHERE s.market_address = m.market_address AND s.venue = 'pool'), 0)
              AS last_swap_block
       FROM markets m
       JOIN graduations g USING (market_address)
      WHERE m.generation = 2
        AND m.block_number >= $1
        AND g.sink_kind = $2
        AND g.sink <> ''
        AND g.pool_id <> ''
      ORDER BY m.block_number ASC`,
    [servedFrom().toString(), SINK_REWARDS],
  );
  return rows.map((r) => ({
    market: r.market_address as `0x${string}`,
    vault: r.sink as `0x${string}`,
    poolId: r.pool_id as `0x${string}`,
    tokenId: BigInt(String(r.token_id ?? 0)),
    lastSwapBlock: BigInt(String(r.last_swap_block ?? 0)),
  }));
}

export interface FundResult {
  candidates: number;
  /** Vaults that took a `fund()` this pass. */
  funded: `0x${string}`[];
  /** Vaults left alone: already funded this interval, nothing owed, backed off, or reserve-held. */
  skipped: `0x${string}`[];
  failed: `0x${string}`[];
}

/** A balance that is spent down across several writes inside one market's turn. */
export interface Purse {
  wei: bigint;
}

/**
 * Sign one write, or refuse it for the reserve.
 *
 * Resolves with the hash, or with `null` when the reserve held it — a refusal, not a failure, so
 * it does not count against the market's backoff. Anything else throws to the caller's `catch`,
 * which is where the backoff lives.
 *
 * `ceilingWei`, when given, is the most this one transaction may cost at its limit. Over it the
 * write is refused the same way — `null`, no backoff — because a gas spike passes and an inflated
 * estimate is not the market's fault; but it is NOT counted as a reserve hold, since topping the
 * wallet up would not change it. The reserve protects the last 10 MON; the ceiling protects all
 * the MON above it from a single call that has been made expensive.
 */
export async function spend(
  chain: Pick<FundingChain, "address" | "balance" | "feePerGas">,
  state: KeeperState,
  purse: Purse,
  what: string,
  context: Record<string, unknown>,
  estimate: () => Promise<bigint>,
  send: (gas: bigint, feePerGas: bigint) => Promise<`0x${string}`>,
  ceilingWei?: bigint,
): Promise<`0x${string}` | null> {
  const gas = withHeadroom(await estimate());
  // ONE fee read. The guards below price the transaction with it and `send` is handed the same
  // number to sign with, so `gas * fee` is what the transaction can cost and not an estimate of it.
  const fee = await chain.feePerGas();
  const cost = gas * fee;
  if (ceilingWei !== undefined && cost > ceilingWei) {
    log.warn(`keeper will not ${what}: the transaction would cost more than its ceiling`, {
      ...context,
      gas: gas.toString(),
      costWei: cost.toString(),
      ceilingWei: ceilingWei.toString(),
      keeper: chain.address,
    });
    return null;
  }
  if (purse.wei - cost < MONAD_RESERVE_WEI) {
    state.heldByReserve();
    log.error(`keeper cannot ${what}: balance would fall below the reserve`, {
      ...context,
      balanceWei: purse.wei.toString(),
      costWei: cost.toString(),
      reserveWei: MONAD_RESERVE_WEI.toString(),
      keeper: chain.address,
    });
    return null;
  }
  const hash = await send(gas, fee);
  try {
    purse.wei = await chain.balance();
    state.passed(purse.wei);
  } catch (error) {
    // The transaction LANDED; failing to read the balance afterwards must not turn it into a
    // failure the caller would retry. Assume the whole reserved cost was spent, which is the
    // most it can have been, so the reserve guard stays on the safe side until the next read.
    purse.wei -= cost;
    log.warn("sent, but the balance could not be read afterwards; assuming the full cost", {
      ...context,
      hash,
      error,
    });
  }
  return hash;
}

/**
 * Open every epoch of `m.vault` that has matured, in one `createEpochs`, or send nothing.
 *
 * Reads `epochCount` and the close block of each of the next `MAX_EPOCHS_PER_OPEN` epochs, and
 * sends only for the consecutive run the head has already passed, so the call can never hit
 * `TooEarly`. A reserve refusal is a skip, not a failure. Throws otherwise, into the market's
 * own backoff.
 */
async function openMaturedEpochs(
  chain: FundingChain,
  state: KeeperState,
  purse: Purse,
  m: RewardsMarket,
): Promise<void> {
  const [head, count] = await Promise.all([chain.blockNumber(), chain.epochCount(m.vault)]);
  const closes: bigint[] = [];
  for (let k = count; k < count + MAX_EPOCHS_PER_OPEN; k += 1n) {
    const close = await chain.snapshotBlockFor(m.vault, k + 1n);
    closes.push(close);
    if (head <= close) break;
  }
  const n = maturedEpochs(head, closes);
  if (n === 0n) return;
  const hash = await spend(
    chain,
    state,
    purse,
    "open matured epochs",
    { market: m.market, vault: m.vault, epochs: n.toString() },
    () => chain.estimateCreateEpochs(m.vault, n),
    (gas, fee) => chain.createEpochs(m.vault, n, gas, fee),
  );
  if (hash === null) return;
  state.epochsOpened(m.vault, n, count + n, hash);
  log.info("opened matured reward epochs so holders can claim", {
    market: m.market,
    vault: m.vault,
    opened: n.toString(),
    epochCount: (count + n).toString(),
    hash,
  });
}

/**
 * One funding pass: for every graduated REWARDS market, make sure this interval has been funded.
 *
 * Per market, in this order and no other:
 *
 *  1. **Which interval is it?** Read from the vault, because `intervalAt` is a function of that
 *     vault's own `genesisBlock` and nothing here may guess at it. If this process has already
 *     funded that interval, the market is done until the next one — one `fund()` per vault per
 *     interval, never more.
 *  2. **A restart does NOT ask the chain whether the interval was already funded.** Generation 4's
 *     keeper read `pending(k) != 0` on first sight as "somebody funded this interval" and left the
 *     vault alone until `k + 1`. Generation 5's `fund()` spreads every pull FORWARD over up to
 *     seven buckets, so after the first funding in a vault's life `pending(k)` is non-zero for
 *     every interval that follows, and that test would have read EVERY restart as "already
 *     funded" — one skipped interval per vault per redeploy, on the job that is M-01's whole
 *     mitigation. The two errors are not symmetric: funding an interval twice costs one
 *     transaction's gas and credits the second pull to the same forward buckets (the vault's
 *     accounting is idempotent about who calls and how often); skipping an interval hands its
 *     late funder the concentrated take the keeper exists to prevent. So a fresh process trusts
 *     only its own memory, and step 5 makes the extra transaction conditional on there being
 *     something to pull.
 *  2b. **Release what the CURVE is still holding for holders.** On a dividends market the 0.7% of
 *     every curve trade accrues in `BondingCurve.pendingFees`, where `collectFees()` refuses to
 *     move it before graduation and nothing moves it after: `release()` leaves the fee buckets
 *     behind on purpose, and a closed curve takes no more trades. On a production market that is
 *     0.7% of at least the whole raise — the largest dividend the market will ever pay — and until
 *     this step it waited for somebody to call `collectFees()` by hand (TR1's was). The call
 *     credits `owedSink`, so step 5 funds it in this same pass. Read once: an empty graduated
 *     curve can never fill again. An attempt is stamped before it is sent and not repeated for a
 *     day, so a collect that is billed and fails is bought once.
 *  3. **Collect the seed position, if collecting could move anything.** `seedFees()` is asked
 *     first; when it answers `null` — which it does on Monad today, because v4 has no fee getter —
 *     the fallback is the swap height, which cannot say how much is there but can prove that
 *     nothing new is. After the hook change that credits the LP share straight to `pendingSink`
 *     this branch simply stops firing, because the seed position stops earning.
 *  4. **Sweep, if the hook is holding something that `fund()` cannot reach.** `fund()` pulls
 *     `owedSink` alone; `pendingSink` needs `sweep(id)` to become `owedSink`. Gated on
 *     `pendingSink != 0` so the call can never hit `NothingToSweep`.
 *  5. **Fund, if there is now something to pull.** `fund()` with nothing owed succeeds and costs
 *     the full limit, so a zero `owedSink` ends the market's turn without a transaction — and
 *     WITHOUT marking the interval funded, so the next pass looks again.
 *  6. **Open matured epochs**, done first in code because it is independent of the rest: the vault
 *     materialises an epoch only when somebody calls `createEpochs`, and nobody can claim until it
 *     has. One call per pass per vault, for exactly the epochs whose close block the head has
 *     passed, capped at the vault's forward spread of seven.
 *
 * Sequential over the markets for the same reason the graduation pass is: one account, one nonce,
 * and a pass that fires everything at once can spend the reserve several times over before the
 * first receipt lands.
 */
export async function runFundPass(
  db: Db,
  chain: FundingChain,
  state: KeeperState,
  now: () => number = Date.now,
): Promise<FundResult> {
  const result: FundResult = { candidates: 0, funded: [], skipped: [], failed: [] };
  const markets = await findRewardsMarkets(db);
  result.candidates = markets.length;

  const purse: Purse = { wei: await chain.balance() };
  state.passed(purse.wei);
  if (markets.length === 0) return result;

  for (const m of markets) {
    if (!state.due(m.vault, now())) {
      result.skipped.push(m.vault);
      continue;
    }

    try {
      // Matured epochs first, whatever the funding decision below: a vault only materialises an
      // epoch when somebody calls `createEpochs`, and until then nobody can claim. The call is
      // permissionless; this process is simply the somebody who is always there. Isolated so a
      // failure here backs off like any other and never blocks the funding steps.
      await openMaturedEpochs(chain, state, purse, m);

      const interval = await chain.currentInterval(m.vault);
      if (state.lastFundedInterval(m.vault) === interval) {
        result.skipped.push(m.vault);
        continue;
      }
      if (state.curveFeesDue(m.market, now())) {
        const pot = await chain.curveFees(m.market);
        if (pot === 0n) {
          state.curveIsDrained(m.market);
        } else {
          const hash = await spend(
            chain,
            state,
            purse,
            "release the curve's holder fees",
            { market: m.market, vault: m.vault, potWei: pot.toString() },
            () => chain.estimateCollectFees(m.market),
            (gas, fee) => {
              state.curveFeesAttempted(m.market, now());
              return chain.collectFees(m.market, gas, fee);
            },
          );
          if (hash === null) {
            result.skipped.push(m.vault);
            continue;
          }
          state.curveIsDrained(m.market);
          log.info("released the holders' share a graduated curve was still holding", {
            market: m.market,
            vault: m.vault,
            potWei: pot.toString(),
            hash,
          });
        }
      }

      // What the chain can say about the seed position, and what this process can say when it
      // cannot. `seedCollectDue` seeds its own watermark on first sight, so it is called every pass
      // whichever branch is taken.
      const fees = await chain.seedFees(m.tokenId);
      const traded = state.seedCollectDue(m.market, m.lastSwapBlock);
      if (fees === null ? traded : fees > 0n) {
        // Measured across the call, not assumed from it. `collect` succeeds and costs a full limit
        // whether the position had anything or not, and the delta on the hook's owed ledger is the
        // only thing that says which happened.
        const before = await chain.owedSink(m.poolId);
        const hash = await spend(
          chain,
          state,
          purse,
          "collect the seed position",
          { market: m.market, tokenId: m.tokenId.toString() },
          () => chain.estimateCollect(m.tokenId),
          (gas, fee) => chain.collect(m.tokenId, gas, fee),
        );
        if (hash === null) {
          result.skipped.push(m.vault);
          continue;
        }
        state.collected(m.market, m.lastSwapBlock);
        const forwarded = (await chain.owedSink(m.poolId)) - before;
        if (forwarded <= 0n) {
          state.seedForwardedNothing(m.market);
          log.info("seed position forwarded nothing; not collecting this market again", {
            market: m.market,
            tokenId: m.tokenId.toString(),
            hash,
          });
        } else {
          log.info("forwarded a seed position's fees", {
            market: m.market,
            hash,
            amountWei: forwarded.toString(),
          });
        }
      }

      if ((await chain.pendingSink(m.poolId)) !== 0n) {
        const hash = await spend(
          chain,
          state,
          purse,
          "sweep the hook",
          { market: m.market, poolId: m.poolId },
          () => chain.estimateSweep(m.poolId),
          (gas, fee) => chain.sweep(m.poolId, gas, fee),
        );
        if (hash === null) {
          result.skipped.push(m.vault);
          continue;
        }
        log.info("swept a market's accrued levy into its owed ledger", { market: m.market, hash });
      }

      const owed = await chain.owedSink(m.poolId);
      if (owed === 0n) {
        // Nothing to fund, and nothing to remember: the interval is NOT marked funded, so the next
        // pass asks again rather than waiting a whole day for money that arrives this afternoon.
        result.skipped.push(m.vault);
        continue;
      }

      const hash = await spend(
        chain,
        state,
        purse,
        "fund the vault",
        { market: m.market, vault: m.vault, owedWei: owed.toString() },
        () => chain.estimateFund(m.vault),
        (gas, fee) => chain.fund(m.vault, gas, fee),
      );
      if (hash === null) {
        result.skipped.push(m.vault);
        continue;
      }
      state.funded(m.vault, interval, hash);
      result.funded.push(m.vault);
      log.info("funded a reward vault for this interval", {
        market: m.market,
        vault: m.vault,
        interval: interval.toString(),
        owedWei: owed.toString(),
        hash,
      });
    } catch (error) {
      const a = state.failed(m.vault, error, now());
      result.failed.push(m.vault);
      const fields = {
        market: m.market,
        vault: m.vault,
        error,
        failures: a.failures,
        retryInMs: a.failures >= MAX_ATTEMPTS ? null : a.notBefore - now(),
      };
      if (a.failures >= MAX_ATTEMPTS) log.error("giving up on a vault until restart", fields);
      else log.warn("funding attempt failed", fields);
    }
  }
  return result;
}

export function startKeeperJob(
  db: Db,
  chain: KeeperChain,
  state: KeeperState,
  onError: (e: unknown) => void,
  intervalMs = KEEPER_INTERVAL_MS,
): Job {
  return startJob({
    name: "graduation-keeper",
    intervalMs,
    run: async () => {
      await runKeeperPass(db, chain, state);
    },
    onError,
  });
}

/**
 * The funding pass, on its own clock.
 *
 * A second job rather than a branch inside the first, because the two cadences are three orders of
 * magnitude apart and folding them would mean either graduating stranded markets every five
 * minutes or reading every vault's interval every ten seconds. They share `KeeperState`, so they
 * share the balance, the backoff, the reserve counter and `/status`.
 */
export function startFundingJob(
  db: Db,
  chain: FundingChain,
  state: KeeperState,
  onError: (e: unknown) => void,
  intervalMs = FUND_INTERVAL_MS,
): Job {
  return startJob({
    name: "reward-vault-funding",
    intervalMs,
    run: async () => {
      await runFundPass(db, chain, state);
    },
    onError,
  });
}
