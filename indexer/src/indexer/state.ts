import { redactUrls } from "../utils/redact.js";
/**
 * What the indexer is doing, and what has been going wrong.
 *
 * Held in memory rather than in the database, on purpose: this is the health of *this process*,
 * and a restart should reset it. Lag and the checkpoint live in Postgres because they are facts
 * about the data; error counts and the current phase are facts about the process.
 *
 * The brief asks for a named indexer state, and the naming is the useful part. "Behind by 4,000
 * blocks" means something completely different during `catching-up` than during `live`, and
 * without the distinction a dashboard cannot tell a service that started two minutes ago from one
 * that has been failing for an hour.
 */

export type IndexerPhase =
  /** Constructed, not yet started. */
  | "starting"
  /** Working through a backlog: behind head, and expected to be. */
  | "catching-up"
  /** At the head, doing incremental passes. */
  | "live"
  /** A pass failed; retrying with backoff. Still running. */
  | "degraded"
  /** Shutting down. */
  | "stopping";

export interface ErrorCounts {
  rpc: number;
  database: number;
  websocket: number;
}

/**
 * What the keeper has done since the process started, across both of its jobs.
 *
 * Present only when `KEEPER_PRIVATE_KEY` is set; `null` on `/status` otherwise, which is the
 * documented "keeper off" reading. Counters rather than a log, because the question an operator
 * has is "is it working and is it funded", and both are one number each: `heldByReserve` rising
 * means the account needs topping up, `givenUp` rising means a market is failing for a reason
 * gas cannot fix.
 *
 * `heldByReserve` counts both jobs, on purpose. One wallet pays for both, so an operator who had
 * to ask which of them ran out of gas would be asking the wrong question.
 */
export interface KeeperSnapshot {
  address: string;
  balanceWei: string | null;
  graduated: number;
  /** Successful `RewardVault.fund()` calls. */
  funded: number;
  /**
   * vault address → the interval its last `fund()` credited.
   *
   * The audit's answer to "is the timing lever closed": an interval that is behind the vault's
   * `currentInterval()` means this market's holders are exposed to a late funder. Empty at
   * startup and filled as each vault is seen, so an absent vault means "not looked at yet", never
   * "not funded".
   */
  lastFundedInterval: Record<string, string>;
  /** Successful `RewardVault.createEpochs()` calls, counted in epochs opened. */
  epochsOpened: number;
  /** vault address → epochs materialised after this process last opened some. */
  epochCount: Record<string, string>;
  /** Successful `RewardVault.claim()` calls sent on holders' behalf, and the epochs they covered. */
  payouts: number;
  payoutEpochs: number;
  /** Claims that reverted because somebody had claimed the same epochs first. */
  payoutsPreempted: number;
  lastPayoutTx: string | null;
  /** Successful `BurnSink.burn()` calls on graduated buyback markets, and the last one's hash. */
  burns: number;
  lastBurnTx: string | null;
  failed: number;
  heldByReserve: number;
  givenUp: number;
  lastTx: string | null;
  lastError: string | null;
  lastPassAt: string | null;
}

export interface IndexerSnapshot {
  phase: IndexerPhase;
  /** The graduation keeper, or `null` when no key is configured. */
  keeper: KeeperSnapshot | null;
  /** Consecutive failed passes. Zero after any success. */
  consecutiveFailures: number;
  errors: ErrorCounts;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  /** How far the last successful pass reached. */
  lastBlock: string | null;
  /** The head as of the last pass. */
  chainHead: string | null;
}

/** How far behind a pass may fall before "catching up" is a better description than "live". */
const LIVE_WITHIN_BLOCKS = 25n;

export class IndexerState {
  private phase: IndexerPhase = "starting";
  private consecutiveFailures = 0;
  private readonly errors: ErrorCounts = { rpc: 0, database: 0, websocket: 0 };
  private lastSuccessAt: Date | null = null;
  private lastErrorAt: Date | null = null;
  private lastError: string | null = null;
  private lastBlock: bigint | null = null;
  private chainHead: bigint | null = null;
  private keeper: (() => KeeperSnapshot) | null = null;

  /** Wire the keeper's own state in, so `/status` reports it beside the ingest loop's. */
  attachKeeper(read: () => KeeperSnapshot): void {
    this.keeper = read;
  }

  /**
   * A pass finished.
   *
   * The phase is derived from the gap rather than set by the caller, so "live" always means the
   * same thing and cannot be asserted by a code path that has not checked.
   */
  passSucceeded(lastBlock: bigint, chainHead: bigint): void {
    this.consecutiveFailures = 0;
    this.lastSuccessAt = new Date();
    this.lastBlock = lastBlock;
    this.chainHead = chainHead;
    if (this.phase === "stopping") return;
    const behind = chainHead > lastBlock ? chainHead - lastBlock : 0n;
    this.phase = behind > LIVE_WITHIN_BLOCKS ? "catching-up" : "live";
  }

  passFailed(error: unknown, kind: keyof ErrorCounts = "rpc"): void {
    this.consecutiveFailures += 1;
    this.errors[kind] += 1;
    this.lastErrorAt = new Date();
    this.lastError = redactUrls(error instanceof Error ? error.message : String(error));
    if (this.phase !== "stopping") this.phase = "degraded";
  }

  /** An error that did not fail a pass — a dropped socket, a retried query. */
  recordError(kind: keyof ErrorCounts, error: unknown): void {
    this.errors[kind] += 1;
    this.lastErrorAt = new Date();
    this.lastError = redactUrls(error instanceof Error ? error.message : String(error));
  }

  stopping(): void {
    this.phase = "stopping";
  }

  snapshot(): IndexerSnapshot {
    return {
      phase: this.phase,
      keeper: this.keeper?.() ?? null,
      consecutiveFailures: this.consecutiveFailures,
      errors: { ...this.errors },
      lastSuccessAt: this.lastSuccessAt?.toISOString() ?? null,
      lastErrorAt: this.lastErrorAt?.toISOString() ?? null,
      lastError: this.lastError,
      lastBlock: this.lastBlock?.toString() ?? null,
      chainHead: this.chainHead?.toString() ?? null,
    };
  }
}
