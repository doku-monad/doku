import type { Db } from "../../db/legacy.js";
import { servedFrom } from "../../repositories/served.js";
import { createLogger } from "../../utils/logger.js";
import { GEN2_PRICE_SCALE_UP, SINK_BURN } from "../generations.js";
import { type Job, startJob } from "../jobs.js";
import { type FundingChain, KeeperState, MAX_ATTEMPTS, type Purse, spend } from "./keeper.js";
import { usdOf } from "./payout.js";
import { PRICE_SCALE } from "./price.js";

/**
 * The burn pass: the keeper finishes the buyback on every graduated BURN market.
 *
 * ## The state this exists for
 *
 * On the curve a BURN market burns by itself — the routed share buys the token and destroys it
 * inside the buy. After graduation it does not. `DokuHook` takes the sink's 70 bps of every swap IN
 * THE TOKEN and books it to `pendingSink[id]`; destroying it takes two more transactions that no
 * trade sends: `DokuHook.sweep(id)`, which turns the claim into a balance in `owedSink[id]`, and
 * `BurnSink.burn()`, which pulls that balance and burns it. Both are permissionless and neither
 * had a caller: the only pool-side burn on mainnet before this file was one sent by hand
 * (`docs/doku/deployments.md`, "Sink paths tested on generation 8"), and on 2026-09-19 TB1 held
 * 748,666 tokens in `pendingSink` that nobody had swept.
 *
 * Those tokens are claims held by the hook, so they are already out of circulation and nobody
 * gains by when they burn — there is no timing lever here, unlike `RewardVault.fund()`. What is
 * wrong until the burn lands is what the market SAYS: `totalSupply()`, and so the market cap, read
 * high, and "Burned" reads low. That is why this pass can afford to be slow and cheap, and is.
 *
 * ## What it must never do
 *
 * - **Send more than one sweep and one burn for a market in a day.** A burn is two full gas limits
 *   on a chain that bills the limit — and bills it just the same when the transaction reverts,
 *   runs out of gas, or lands after its receipt timed out. So an attempt is recorded BEFORE it is
 *   sent, and whatever becomes of it, it was the day's. Successes are also counted from the newest
 *   `Burned` the indexer has ingested for the market, because this process's memory dies with
 *   every deploy and the web service redeploys on every push.
 * - **Act on a database that is behind the chain.** That ingested `Burned` is the clock, and during
 *   a backfill, a re-point or the first minute after a deploy it is missing or days old. The pass
 *   reads the ingest loop's own status first and does nothing at all — no reads, no sends — unless
 *   it is within `MAX_INGEST_LAG_BLOCKS` of the head and reported inside `MAX_STATUS_AGE_MS`. It
 *   does not run at boot.
 * - **Spend the wallet other jobs need.** Burning is the least urgent thing this key does. Under
 *   `BURN_MIN_BALANCE_WEI` the pass stands down entirely, which also caps what every failure mode
 *   in this list put together can ever cost: the balance above that floor, and not a wei more.
 * - **Burn at an address the database chose.** `graduations.sink` is what the indexer decoded from
 *   a log; the hook's own `markets(id)` is what the graduator wrote on chain, and `pullSink` pays
 *   that address and no other. The pass reads it before anything else and burns THERE — and only
 *   if the hook says the pool is registered, its sink is BURN, and the database agrees. A
 *   disagreement is a failure with no transaction, loud on `/status`.
 * - **Pay more than `BURN_MAX_TX_COST_WEI` for one transaction.** The reserve guard protects the
 *   last 10 MON and nothing above it. A gas spike, or a call somebody has found a way to make
 *   expensive, is refused before signing and tried again next pass; a burn is never urgent. The
 *   fee the ceiling was priced at is the fee the transaction is SIGNED with (`spend` hands it to
 *   the adapter), so the ceiling bounds the transaction and not an estimate of it.
 * - **Sweep twice in a day.** A burn that keeps failing must not buy a fresh sweep on every retry:
 *   the pass does not sweep when what is already owed clears the floor by itself, and never sweeps
 *   one market twice inside the day.
 * - **Pay gas for dust.** A market is burned only when what the burn would destroy is worth at
 *   least `minUsd`, at the market's last price and the quote's catalogue price. Under the floor
 *   the tokens simply keep accruing; they are no more in circulation in the hook than burned. A
 *   last price is one trade's say-so and can be pushed — which buys the pusher one early burn, at
 *   most once a day, of tokens that were going to be burned anyway.
 * - **Send a transaction that would revert.** `sweep` reverts `NothingToSweep` on an empty pending
 *   ledger and `burn()` reverts `NothingToBurn` on an empty sink, each at the full limit. The sweep
 *   is gated on `pendingSink != 0`, the burn on there being something swept or owed, and the
 *   adapter simulates both before it sends.
 * - **Dip under the reserve, or retry a broken sink for ever.** The same `spend`, the same backoff
 *   and the same counters as the funding pass — except that a pass which reads a market cleanly
 *   and finds nothing to do clears its failures, so six unrelated RPC hiccups over a month are not
 *   six strikes against a sink that was never broken.
 *
 * ## What is NOT bounded here, said plainly
 *
 * The attempt stamps live in memory. A NEW process has forgotten them, so a transaction that is
 * billed and fails can be bought once more per market per restart — never six times, which is what
 * it was before the stamps. What makes that tolerable rather than a leak: a billed failure needs the
 * chain to disagree with a simulation made a moment earlier, which means somebody front-ran the
 * keeper and paid at least as much to do its work for it (the ledger is then empty and the next
 * pass sends nothing), or gas grew past `SWEEP_GAS_PAD` between estimate and inclusion. And the
 * balance floor above bounds the total whatever the cause.
 * - **Collect the seed position.** `SeedLocker.collect` does forward a BURN market's token-side
 *   fees to its sink, but a graduated pool's LP fee is zero and the seed position earns nothing, so
 *   a collect would be a full gas limit to move nothing, every time.
 *
 * ## Rollback
 *
 * `KEEPER_BURN=off`. The job never starts and nothing else changes: the tokens accrue in the hook
 * exactly as they did before this file existed, and `sweep` + `burn()` stay permissionless.
 */

const log = createLogger().child({ component: "burn-sink" });

/** How often the pass looks. A market burns once a day; a half hour is prompt without being noisy. */
export const BURN_INTERVAL_MS = 30 * 60_000;

/** The least time between two burns of one market. The bound on what this pass can spend. */
export const BURN_MIN_GAP_MS = 24 * 60 * 60_000;

/**
 * The most one transaction of this pass may cost at its gas LIMIT, which on Monad is its price.
 *
 * A quarter of a MON. Measured on a fork of mainnet a sweep is sent with ~190k gas and a burn with
 * ~115k (Monad's own estimator quotes the sweep nearer 260k), so at the usual ~100 gwei each costs
 * 0.01–0.035 MON and this is seven times the dearer of the two. With the day between burns it makes
 * the worst case for one market half a MON a day, whatever gas does and whatever a call is made to
 * consume.
 */
export const BURN_MAX_TX_COST_WEI = 10n ** 18n / 4n;

/**
 * Gas added to a sweep's estimate before the usual quarter of headroom.
 *
 * What `sweep(id)` costs depends on state a stranger can change between the estimate and
 * inclusion: whether `owedTreasury[quote]` and `owedSink[id]` are zero (a fresh storage write each,
 * ~17k), and whether a maker leg has made `pendingProtocolToken[id]` non-zero (a third burn/take).
 * Measured on a fork of mainnet, an estimate of 153,250 needed 208,074 afterwards — 1.36x, past the
 * quarter — and out of gas on Monad is billed at the full limit with the ledgers untouched. 60k
 * covers the measured worst case with room; at ~100 gwei it costs under 0.01 MON a sweep, and the
 * ceiling above still bounds the total. `burn()` is not padded: nothing a stranger does changes
 * what it costs, only whether it has anything to burn.
 */
export const SWEEP_GAS_PAD = 60_000n;

/**
 * The keeper balance under which the burn pass does not run.
 *
 * Three times Monad's 10 MON reserve. Graduating a stranded market and funding a vault before a
 * newcomer can are worth the wallet's last MON; destroying tokens that are already out of
 * circulation is not. It is also the pass's stop-loss: whatever goes wrong — a lying node, a price
 * that is not real, a bug in this file — the most it can take is what is above this line.
 */
export const BURN_MIN_BALANCE_WEI = 30n * 10n ** 18n;

/** The most blocks the ingest loop may be behind the head for the database to count as a clock. */
export const MAX_INGEST_LAG_BLOCKS = 150n;
/** The longest the ingest loop may have gone without reporting. Five minutes. */
export const MAX_STATUS_AGE_MS = 5 * 60_000;

/** The scale generation 2 stores prices at: `quote_raw * 1e36 / token_raw` (see `price.ts`). */
const GEN2_SCALE = PRICE_SCALE * GEN2_PRICE_SCALE_UP;

/** Everything the burn pass needs from the chain: the funding pass's hook half, and the sink. */
export interface BurnChain
  extends Pick<FundingChain, "address" | "balance" | "feePerGas" | "pendingSink" | "owedSink" | "estimateSweep" | "sweep"> {
  /** `DokuHook.markets(id)`: whether the hook knows the pool, its sink kind, and the sink it pays. */
  sinkOf(poolId: `0x${string}`): Promise<{ registered: boolean; kind: number; sinkAddr: `0x${string}` }>;
  estimateBurn(sink: `0x${string}`): Promise<bigint>;
  /** `BurnSink.burn()`. Permissionless; pulls the hook's `owedSink` and destroys it. */
  burn(sink: `0x${string}`, gas: bigint, feePerGas?: bigint): Promise<`0x${string}`>;
}

/** One graduated BURN market, with what the pass needs to value, time and burn it. */
export interface BurnMarket {
  market: `0x${string}`;
  /** The market's `BurnSink` — `graduations.sink` on a BURN row. One per market, never shared. */
  sink: `0x${string}`;
  /** The v4 `PoolId`, which is how the hook's two sink ledgers are keyed. */
  poolId: `0x${string}`;
  /** `market_state.last_price`: quote per token at generation 2's scale. */
  lastPrice: bigint;
  quoteDecimals: number;
  /** The quote's dollar price from the catalogue, or `null` when it has none. */
  usdPrice: number | null;
  /** The newest `Burned` the indexer has ingested for this market, or `null` if it never has. */
  lastBurnAt: Date | null;
}

/**
 * Every graduated BURN market this deployment serves.
 *
 * The same shape as `findRewardsMarkets` and for the same reasons (see there): read from
 * `graduations` because only a graduated market has a sink and a pool, guarded against the empty
 * `sink` and `pool_id` a half-written graduation carries, and cut at `servedFrom()` because a
 * retired generation's levy sits in a different hook this process is not pointed at.
 *
 * `kind = 'burn'` is written by `gen2/sinks.ts` for `BurnSink`'s `Burned` and by nothing else, so
 * its newest row is the market's last pool-side burn whoever sent it.
 */
export async function findBurnMarkets(db: Db): Promise<BurnMarket[]> {
  const { rows } = await db.query<{
    market_address: string;
    sink: string;
    pool_id: string;
    last_price: string | null;
    quote_decimals: number | string | null;
    usd_price: number | string | null;
    last_burn_at: Date | string | null;
  }>(
    `SELECT m.market_address, g.sink, g.pool_id, s.last_price::text AS last_price,
            m.quote_decimals, q.usd_price::float8 AS usd_price,
            (SELECT MAX(f.ts) FROM fee_events f
              WHERE f.market_address = m.market_address AND f.kind = 'burn') AS last_burn_at
       FROM markets m
       JOIN graduations g USING (market_address)
       JOIN market_state s USING (market_address)
       LEFT JOIN quote_assets q ON LOWER(q.address) = LOWER(m.quote_asset)
      WHERE m.generation = 2
        AND m.block_number >= $1
        AND g.sink_kind = $2
        AND g.sink <> ''
        AND g.pool_id <> ''
      ORDER BY m.block_number ASC`,
    [servedFrom().toString(), SINK_BURN],
  );
  return rows.map((r) => {
    const price = r.usd_price === null ? null : Number(r.usd_price);
    return {
      market: r.market_address as `0x${string}`,
      sink: r.sink as `0x${string}`,
      poolId: r.pool_id as `0x${string}`,
      lastPrice: BigInt(r.last_price ?? "0"),
      quoteDecimals: Number(r.quote_decimals ?? 18),
      usdPrice: price !== null && Number.isFinite(price) && price > 0 ? price : null,
      lastBurnAt: r.last_burn_at === null ? null : new Date(r.last_burn_at),
    };
  });
}

/** What `tokens` raw units of the token are worth, in raw units of the quote, at `lastPrice`. */
export function burnWorth(tokens: bigint, lastPrice: bigint): bigint {
  return (tokens * lastPrice) / GEN2_SCALE;
}

/**
 * Whether a burn is worth its two transactions: at least `minUsd` of tokens.
 *
 * A floor of zero is no floor, and is decided on the token amount alone — a few wei of a cheap
 * token is worth zero raw units of its quote, and an operator who asked for no floor did not ask
 * for that rounding to become one. With a floor set, a quote with no price cannot be valued and
 * is not burned.
 */
export function worthBurning(
  tokens: bigint,
  m: Pick<BurnMarket, "lastPrice" | "quoteDecimals" | "usdPrice">,
  minUsd: number,
): boolean {
  if (tokens === 0n) return false;
  if (minUsd <= 0) return true;
  const usd = usdOf(burnWorth(tokens, m.lastPrice), m.quoteDecimals, m.usdPrice);
  return usd !== null && usd >= minUsd;
}

/**
 * Whether something happened inside the last day, from the database's record and this process's.
 *
 * Fails CLOSED. A time that cannot be read is treated as recent, and so is one in the future: the
 * wrong answer in that direction is a burn that waits, and in the other it is a transaction.
 */
export function burnedRecently(recorded: Date | null, remembered: number | null, now: number): boolean {
  const times: number[] = [];
  if (recorded !== null) times.push(recorded.getTime());
  if (remembered !== null) times.push(remembered);
  if (times.length === 0) return false;
  if (times.some((t) => Number.isNaN(t))) return true;
  return now - Math.max(...times) < BURN_MIN_GAP_MS;
}

/** Where the ingest loop says it is: `indexer_status`, its single row. */
export interface IngestStatus {
  lastBlock: bigint;
  chainHead: bigint;
  updatedAt: Date;
}

/**
 * Whether the database is close enough to the chain to be used as a clock.
 *
 * Fails CLOSED: no row, a head of zero (a loop that has never completed a pass), an unreadable
 * time, a lag past `MAX_INGEST_LAG_BLOCKS` or a report older than `MAX_STATUS_AGE_MS` all answer
 * no, and the pass does nothing.
 */
export function ingestIsCurrent(s: IngestStatus | null, now: number): boolean {
  if (s === null || s.chainHead <= 0n) return false;
  const age = now - s.updatedAt.getTime();
  if (Number.isNaN(age) || age > MAX_STATUS_AGE_MS) return false;
  return s.chainHead - s.lastBlock <= MAX_INGEST_LAG_BLOCKS;
}

export async function readIngestStatus(db: Db): Promise<IngestStatus | null> {
  const { rows } = await db.query<{ last_block: string | number; chain_head: string | number; updated_at: Date | string }>(
    "SELECT last_block, chain_head, updated_at FROM indexer_status WHERE id = 1",
  );
  const r = rows[0];
  if (!r) return null;
  return {
    lastBlock: BigInt(String(r.last_block)),
    chainHead: BigInt(String(r.chain_head)),
    updatedAt: new Date(r.updated_at),
  };
}

export interface BurnResult {
  /** The pass stood down because the database is behind the chain: nothing was read or sent. */
  behind: boolean;
  /** The pass stood down because the keeper is under `BURN_MIN_BALANCE_WEI`. */
  low: boolean;
  candidates: number;
  /** Sinks whose market a `sweep` was SENT for this pass, whatever became of the burn after it. */
  swept: `0x${string}`[];
  /** Sinks that took a `burn()` this pass. */
  burned: `0x${string}`[];
  /** Sinks no burn landed for: burned within the day, under the floor, backed off, or refused. */
  skipped: `0x${string}`[];
  failed: `0x${string}`[];
}

export interface BurnOptions {
  /** The least a burn must destroy, in dollars. Zero burns any amount. */
  minUsd: number;
}

/**
 * One burn pass: for every graduated BURN market, destroy what has accrued if it is time and
 * worth it.
 *
 * Per market, in this order:
 *
 *  1. **Has it burned within the day?** Asked of the database and of this process's memory, and
 *     answered before the chain is read at all — a market that burned this morning costs nothing
 *     until tomorrow.
 *  2. **Where does the hook say this market burns?** `markets(id)`, checked against the database
 *     row. Everything after this step uses the hook's address.
 *  3. **What would a burn destroy?** `pendingSink + owedSink`: a sweep moves the first into the
 *     second and `burn()` pulls the second, so the sum is the burn whichever ledger it sits in.
 *     Tokens sent straight to the sink are burned along with it and are not worth a pass of their
 *     own.
 *  4. **Sweep, only if it is needed and has not been done today.** Needed means `pendingSink != 0`
 *     AND what is already owed does not clear the floor by itself — so a retry after a failed burn
 *     is a burn and nothing else, and somebody else's sweep is not repeated.
 *  5. **Burn, if what will actually burn still clears the floor.** Without a sweep that is
 *     `owedSink` alone. A pass that sweeps and then fails, or is refused for the reserve or the
 *     ceiling, leaves the tokens in `owedSink` for the next pass that is due.
 *
 * Sequential for the reason every pass here is: one account, one nonce, one reserve.
 */
export async function runBurnPass(
  db: Db,
  chain: BurnChain,
  state: KeeperState,
  opts: BurnOptions,
  now: () => number = Date.now,
): Promise<BurnResult> {
  const result: BurnResult = { behind: false, low: false, candidates: 0, swept: [], burned: [], skipped: [], failed: [] };

  const status = await readIngestStatus(db);
  if (!ingestIsCurrent(status, now())) {
    result.behind = true;
    log.warn("burn pass standing down: the database is behind the chain, so it cannot say when a market last burned", {
      lastBlock: status?.lastBlock.toString() ?? null,
      chainHead: status?.chainHead.toString() ?? null,
      updatedAt: status?.updatedAt.toISOString?.() ?? null,
    });
    return result;
  }

  const markets = await findBurnMarkets(db);
  result.candidates = markets.length;

  const purse: Purse = { wei: await chain.balance() };
  state.passed(purse.wei);
  if (purse.wei < BURN_MIN_BALANCE_WEI) {
    result.low = true;
    state.burnsHeldForBalance(purse.wei, BURN_MIN_BALANCE_WEI);
    log.error("burn pass standing down: keeper balance is under the burn floor", {
      balanceWei: purse.wei.toString(),
      floorWei: BURN_MIN_BALANCE_WEI.toString(),
      keeper: chain.address,
    });
    return result;
  }

  for (const m of markets) {
    if (!state.due(m.sink, now())) {
      result.skipped.push(m.sink);
      continue;
    }
    if (burnedRecently(m.lastBurnAt, state.lastBurnAt(m.sink), now())) {
      result.skipped.push(m.sink);
      continue;
    }

    try {
      const named = await chain.sinkOf(m.poolId);
      if (!named.registered || named.kind !== SINK_BURN || named.sinkAddr.toLowerCase() !== m.sink.toLowerCase()) {
        throw new Error(
          `hook names ${named.registered ? `${named.sinkAddr} (sink kind ${named.kind})` : "no registered pool"} ` +
            `for pool ${m.poolId}, the database says BURN sink ${m.sink}: not burning`,
        );
      }
      const sink = named.sinkAddr;

      const pending = await chain.pendingSink(m.poolId);
      const owed = await chain.owedSink(m.poolId);
      const burnable = pending + owed;
      if (!worthBurning(burnable, m, opts.minUsd)) {
        state.cleared(m.sink);
        result.skipped.push(m.sink);
        continue;
      }

      const sweep =
        pending !== 0n &&
        !worthBurning(owed, m, opts.minUsd) &&
        !burnedRecently(null, state.lastSweepAt(m.sink), now());
      if (sweep) {
        const swept = await spend(
          chain,
          state,
          purse,
          "sweep the hook",
          { market: m.market, poolId: m.poolId },
          async () => (await chain.estimateSweep(m.poolId)) + SWEEP_GAS_PAD,
          (gas, fee) => {
            // Stamped at the last moment before the send and not after it: see `KeeperState.swept`.
            state.swept(m.sink, now());
            result.swept.push(m.sink);
            return chain.sweep(m.poolId, gas, fee);
          },
          BURN_MAX_TX_COST_WEI,
        );
        if (swept === null) {
          result.skipped.push(m.sink);
          continue;
        }
        state.sweepLanded(swept);
        log.info("swept a market's accrued levy into its owed ledger", { market: m.market, hash: swept });
      }

      // What this burn will destroy: everything if it was just swept, otherwise only what was
      // already owed — which, after a sweep earlier today and a fall in price, may no longer be
      // worth a transaction.
      const toBurn = sweep ? burnable : owed;
      if (!worthBurning(toBurn, m, opts.minUsd)) {
        state.cleared(m.sink);
        result.skipped.push(m.sink);
        continue;
      }

      const hash = await spend(
        chain,
        state,
        purse,
        "burn the sink",
        { market: m.market, sink, tokensWei: toBurn.toString() },
        () => chain.estimateBurn(sink),
        (gas, fee) => {
          state.burnAttempted(m.sink, now());
          return chain.burn(sink, gas, fee);
        },
        BURN_MAX_TX_COST_WEI,
      );
      if (hash === null) {
        result.skipped.push(m.sink);
        continue;
      }
      state.burned(m.sink, now(), hash);
      result.burned.push(m.sink);
      log.info("burned a buyback market's accrued levy", {
        market: m.market,
        sink,
        // Read before the sweep; a swap between the two adds to it. `Burned` carries the exact figure.
        tokensWei: toBurn.toString(),
        hash,
      });
    } catch (error) {
      const a = state.failed(m.sink, error, now());
      result.failed.push(m.sink);
      const fields = {
        market: m.market,
        sink: m.sink,
        error,
        failures: a.failures,
        retryInMs: a.failures >= MAX_ATTEMPTS ? null : a.notBefore - now(),
      };
      if (a.failures >= MAX_ATTEMPTS) log.error("giving up on a burn sink until restart", fields);
      else log.warn("burn attempt failed", fields);
    }
  }
  return result;
}

/**
 * The burn pass, on its own clock, sharing the keeper's state with the other three jobs.
 *
 * NOT run at boot, unlike them. The first minutes of a process are when the ingest loop is
 * furthest behind and this process remembers nothing; `ingestIsCurrent` would refuse most of those
 * passes anyway, and waiting one interval costs a burn nothing.
 */
export function startBurnJob(
  db: Db,
  chain: BurnChain,
  state: KeeperState,
  opts: BurnOptions,
  onError: (e: unknown) => void,
  intervalMs = BURN_INTERVAL_MS,
): Job {
  return startJob({
    name: "burn-sink",
    intervalMs,
    immediate: false,
    run: async () => {
      await runBurnPass(db, chain, state, opts);
    },
    onError,
  });
}
