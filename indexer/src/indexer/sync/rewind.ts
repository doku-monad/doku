import type { Db } from "../../db/legacy.js";
import { forgetBlocksFrom } from "../blocks.js";
import { PERIODS, bucketOf } from "../processing/derive.js";
import { rebuildFeeProjections } from "../processing/fees.js";
import { recountHolders } from "../processing/holders.js";

/**
 * Drop everything at or above `fromBlock`, then rebuild every figure derived from what is left.
 *
 * Deleting the event rows is the easy half and the half that looks finished. The half that
 * actually matters is the derived data — running volume, trade counts, candlesticks, holder
 * balances, the graduation flag. None of those are re-derivable from the events that remain unless
 * something explicitly re-derives them, and every one of them fails silently: a volume figure that
 * still contains a trade the chain no longer has is a plausible-looking number that nothing
 * checks.
 *
 * So this function is deliberately blunt. Rewinds are rare — a confirmation lag keeps them off the
 * common path entirely — and being obviously correct is worth more here than being quick.
 *
 * TWO THINGS IT DELIBERATELY DOES NOT TOUCH. There is no longer a third — `routed_recipient` and
 * `tax_recipient` were mutated in place with no event behind them and are now restored from
 * `recipient_updates`, exactly as the metadata columns are from `metadata_updates`.
 *
 * `quote_assets` keeps its registry columns. A registry event orphaned by a reorg is replayed by
 * the next pass and the row converges; a stale `enabled` for a couple of seconds is harmless,
 * while deleting the row would break every market joined to it.
 *
 * `market_stats` is a periodic rollup and simply recomputes on its next tick.
 */
export async function rewindTo(
  db: Db,
  fromBlock: bigint,
  graduationAddress?: string,
): Promise<void> {
  const b = fromBlock.toString();

  await db.query("DELETE FROM swaps WHERE block_number >= $1", [b]);
  await db.query("DELETE FROM graduations WHERE block_number >= $1", [b]);
  await db.query("DELETE FROM transfers WHERE block_number >= $1", [b]);
  // The generation-2 event tables. Every one of them is a log, one row per log, and every figure
  // read off them is a projection recomputed below -- which is the whole reason a rewind here is
  // "delete above the fork and recompute" rather than a set of compensating adjustments nobody
  // could write correctly.
  await db.query("DELETE FROM fee_events WHERE block_number >= $1", [b]);
  await db.query("DELETE FROM creator_ledger WHERE block_number >= $1", [b]);
  await db.query("DELETE FROM metadata_updates WHERE block_number >= $1", [b]);
  await db.query("DELETE FROM recipient_updates WHERE block_number >= $1", [b]);
  // Markets last: swaps, state and candles cascade from it, so dropping it first would delete
  // rows this function still needs to read.
  await db.query("DELETE FROM markets WHERE block_number >= $1", [b]);

  // The ledger goes with them. A block record left above the fork would be offered to the next
  // reorg walk as a height the indexer believes it has verified — which is exactly the row that
  // would let the walk stop too high.
  await forgetBlocksFrom(db, fromBlock);

  await rebuildMarketState(db, fromBlock);
  await rebuildCandles(db);
  await rebuildBalances(db, graduationAddress);
  await rebuildFeeProjections(db);
  await restoreMetadata(db);
  await restoreRecipients(db);
}

/**
 * Put each market's payee columns back to its newest surviving `recipient_updates` row.
 *
 * Same cache-restoring job as `restoreMetadata`, and the same failure if it is skipped: the row
 * that justified the address is gone while the address stays, so every FUTURE routed collection
 * and creator tax is credited to whoever an orphaned transfer named. Money already earned is not
 * at risk -- the ledger rows themselves rewind -- but the payee for everything after the fork
 * would be wrong until the chain happened to re-emit a transfer, which it may never do.
 *
 * A gen-2 launch writes the first row itself, so a market that survives a rewind always has one to
 * restore from. Markets launched before that table existed have none, and are left as they stand:
 * there is nothing to reconstruct them FROM, and inventing a value would be worse than keeping the
 * one the chain last announced.
 */
async function restoreRecipients(db: Db): Promise<void> {
  await db.query(
    `UPDATE markets m
        SET routed_recipient = u.routed_recipient, tax_recipient = u.tax_recipient
       FROM (SELECT DISTINCT ON (market_address) *
               FROM recipient_updates ORDER BY market_address, block_number DESC, log_index DESC) u
      WHERE u.market_address = m.market_address AND m.generation = 2`,
  );
}

/**
 * Put each market's CURRENT metadata back to its newest surviving `MetadataSet`.
 *
 * The columns on `markets` are a cache of the newest row in `metadata_updates`, and a cache is
 * exactly the thing a delete leaves stale. Deleting the orphaned update alone would leave the
 * market displaying a name, a description and a logo that the chain no longer says anything about,
 * with the row that justified them gone -- the failure is invisible, because a market with a name
 * looks like a market with a name.
 *
 * A gen-2 launch always emits a `MetadataSet` in its own transaction, so a market that survives a
 * rewind keeps at least one update. The second statement is for the case that cannot happen but
 * would be silent if it did.
 */
async function restoreMetadata(db: Db): Promise<void> {
  await db.query(
    `UPDATE markets m
        SET symbol = u.ticker, name = u.name, ticker = u.ticker, logo_uri = u.logo_uri,
            banner_uri = u.banner_uri, description = u.description, website = u.website,
            x = u.x, telegram = u.telegram, metadata_hash = u.metadata_hash
       FROM (SELECT DISTINCT ON (market_address) *
               FROM metadata_updates ORDER BY market_address, block_number DESC, log_index DESC) u
      WHERE u.market_address = m.market_address AND m.generation = 2`,
  );
  // Gen-2 rows with no surviving update go back to the launch placeholder.
  await db.query(
    `UPDATE markets SET symbol = '', name = '', ticker = NULL, logo_uri = NULL, banner_uri = NULL,
            description = NULL, website = NULL, x = NULL, telegram = NULL, metadata_hash = NULL
      WHERE generation = 2 AND market_address NOT IN (SELECT market_address FROM metadata_updates)`,
  );
}

/** Recompute per-market aggregates from the swaps that survived. */
async function rebuildMarketState(db: Db, fromBlock: bigint): Promise<void> {
  await db.query(
    `UPDATE market_state ms
        SET volume_quote = COALESCE(agg.volume, 0),
            trade_count  = COALESCE(agg.trades, 0),
            quote_raised = COALESCE(agg.quote_raised, 0),
            last_price   = COALESCE(agg.last_price, 0),
            block_number = COALESCE(agg.block_number, 0)
       FROM (SELECT market_address FROM market_state) AS keys
       LEFT JOIN LATERAL (
            SELECT SUM(s.quote_amount) AS volume,
                   COUNT(*)            AS trades,
                   (SELECT quote_raised FROM swaps
                     WHERE market_address = keys.market_address
                     ORDER BY block_number DESC, log_index DESC LIMIT 1) AS quote_raised,
                   (SELECT price FROM swaps
                     WHERE market_address = keys.market_address
                     ORDER BY block_number DESC, log_index DESC LIMIT 1) AS last_price,
                   MAX(s.block_number) AS block_number
              FROM swaps s
             WHERE s.market_address = keys.market_address
       ) AS agg ON TRUE
      WHERE ms.market_address = keys.market_address`,
  );

  // The graduation flag, and the pool it graduated into, only stand if the blocks that announced
  // them still exist.
  await db.query(
    `UPDATE market_state
        SET ready_to_graduate = FALSE, ready_block = NULL
      WHERE ready_block >= $1`,
    [fromBlock.toString()],
  );
  // Both columns, together. `pool_id` is what actually identifies the pool under v4 — restoring
  // `pool_address` alone would leave a market flagged graduated with no way to route to it.
  await db.query(
    `UPDATE market_state ms
        SET pool_address = (SELECT pool_address FROM graduations g
                             WHERE g.market_address = ms.market_address LIMIT 1),
            pool_id      = (SELECT pool_id      FROM graduations g
                             WHERE g.market_address = ms.market_address LIMIT 1)`,
  );
}

/**
 * Rebuild every candle from the surviving trades.
 *
 * One grouped statement per period rather than replaying trades one at a time: a rewind can span
 * thousands of swaps, and this is the same arithmetic the incremental path does, expressed once.
 */
async function rebuildCandles(db: Db): Promise<void> {
  await db.query("DELETE FROM candlesticks");
  for (const period of PERIODS) {
    await db.query(
      `INSERT INTO candlesticks (market_address, period_secs, bucket_start,
                                 open, high, low, close, volume_quote, trade_count)
       SELECT market_address,
              $1::int,
              -- Cast on every use: the same parameter is a column value here and a divisor
              -- below, and Postgres refuses to deduce one type for both.
              TO_TIMESTAMP(FLOOR(EXTRACT(EPOCH FROM ts) / $1::int) * $1::int),
              (ARRAY_AGG(price ORDER BY block_number, log_index))[1],
              MAX(price),
              MIN(price),
              (ARRAY_AGG(price ORDER BY block_number DESC, log_index DESC))[1],
              SUM(quote_amount),
              COUNT(*)
         FROM swaps
        GROUP BY market_address, 3`,
      [period],
    );
  }
}

/** Rebuild holder balances from the transfers that survived, then recount. */
async function rebuildBalances(db: Db, graduationAddress?: string): Promise<void> {
  const ZERO = "0x0000000000000000000000000000000000000000";
  await db.query("DELETE FROM token_balances");
  await db.query(
    `INSERT INTO token_balances (token_address, holder, balance)
     SELECT token_address, holder, SUM(delta)
       FROM (
            SELECT token_address, to_address   AS holder,  value AS delta FROM transfers
             WHERE to_address <> $1
            UNION ALL
            SELECT token_address, from_address AS holder, -value AS delta FROM transfers
             WHERE from_address <> $1
       ) AS moves
      GROUP BY token_address, holder`,
    [ZERO],
  );

  const { rows } = await db.query<{ market_address: string }>(
    "SELECT market_address FROM market_state",
  );
  for (const r of rows) await recountHolders(db, r.market_address, graduationAddress);
}

/** Exported for tests that need the bucket boundary the rebuild above computes in SQL. */
export const bucketFor = bucketOf;
