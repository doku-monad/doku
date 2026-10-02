import type { Db } from "../../db/legacy.js";

/** Periods the chart offers. Seconds, so bucketing is integer division and never drifts. */
export const PERIODS = [60, 300, 900, 1800, 3600, 14400, 86400] as const;

/** The bucket a timestamp belongs to. Floor division on epoch seconds — no timezone, no DST. */
export function bucketOf(ts: Date, periodSecs: number): Date {
  const epoch = Math.floor(ts.getTime() / 1000);
  return new Date(Math.floor(epoch / periodSecs) * periodSecs * 1000);
}

/**
 * Fold one trade into every period's candle.
 *
 * Written on ingest rather than aggregated on read: a market page should not scan the whole trade
 * history to draw a chart. `high` and `low` use GREATEST/LEAST so the update is order-independent,
 * which matters because a re-ingested range can arrive in any order.
 */
export async function updateCandles(
  db: Db,
  market: string,
  ts: Date,
  price: string,
  volumeQuote: bigint,
): Promise<void> {
  for (const period of PERIODS) {
    await db.query(
      `INSERT INTO candlesticks (market_address, period_secs, bucket_start,
                                 open, high, low, close, volume_quote, trade_count)
       VALUES ($1, $2, $3, $4, $4, $4, $4, $5, 1)
       ON CONFLICT (market_address, period_secs, bucket_start) DO UPDATE
       SET high = GREATEST(candlesticks.high, EXCLUDED.high),
           low = LEAST(candlesticks.low, EXCLUDED.low),
           close = EXCLUDED.close,
           volume_quote = candlesticks.volume_quote + EXCLUDED.volume_quote,
           trade_count = candlesticks.trade_count + 1`,
      [market, period, bucketOf(ts, period), price, volumeQuote.toString()],
    );
  }
}
