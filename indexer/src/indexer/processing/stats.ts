import type { Db } from "../../db/legacy.js";
import { priceScaleSql } from "../generations.js";
import { type Job, startJob } from "../jobs.js";

export const STATS_INTERVAL_MS = 15_000;

/**
 * Rebuild every market's rollup in one statement. Aggregated in SQL because a list page must never
 * scan the swaps table per row, and rebuilt whole because a stored rolling figure has to DECAY as
 * trades age out — nothing fires when time merely passes, so the only honest stored 24h figure is
 * one recomputed on a clock.
 *
 * The cap divides by `priceScaleSql`, not by a literal 1e18: the two generations store prices at
 * different scales, and the same expression is what `CAP_COLUMNS` uses, so the rollup and the read
 * path cannot disagree about what a market is worth.
 */
export async function rebuildMarketStats(db: Db): Promise<void> {
  await db.query(`
    INSERT INTO market_stats (market_address, market_cap_quote, market_cap_usd, volume_24h_quote,
                              volume_24h_usd, change_24h, trades_24h, last_trade_at, ath_quote, ath_at,
                              holders, updated_at)
    SELECT m.market_address,
           cap.quote,
           CASE WHEN qa.usd_price IS NULL THEN NULL
                ELSE (cap.quote / POWER(10::numeric, m.quote_decimals)) * qa.usd_price END,
           w.volume,
           CASE WHEN qa.usd_price IS NULL THEN NULL
                ELSE (w.volume / POWER(10::numeric, m.quote_decimals)) * qa.usd_price END,
           CASE WHEN p24.price IS NULL OR p24.price = 0 THEN NULL
                ELSE ((s.last_price - p24.price) / p24.price * 100)::double precision END,
           w.trades,
           w.last_at,
           COALESCE(ath.price, 0),
           ath.ts,
           s.holders,
           NOW()
      FROM markets m
      JOIN market_state s USING (market_address)
      LEFT JOIN quote_assets qa ON qa.address = m.quote_asset
      CROSS JOIN LATERAL (
        SELECT ((s.last_price * m.total_supply) / ${priceScaleSql("m")})::numeric(78,0) AS quote
      ) cap
      CROSS JOIN LATERAL (
        SELECT COALESCE(SUM(quote_amount), 0)::numeric(78,0) AS volume, COUNT(*)::int AS trades, MAX(ts) AS last_at
          FROM swaps WHERE market_address = m.market_address AND ts >= NOW() - INTERVAL '24 hours'
      ) w
      LEFT JOIN LATERAL (
        SELECT price FROM swaps WHERE market_address = m.market_address AND ts <= NOW() - INTERVAL '24 hours'
         ORDER BY ts DESC, block_number DESC, log_index DESC LIMIT 1
      ) p24 ON TRUE
      LEFT JOIN LATERAL (
        SELECT price, ts FROM swaps WHERE market_address = m.market_address
         ORDER BY price DESC, ts ASC LIMIT 1
      ) ath ON TRUE
    ON CONFLICT (market_address) DO UPDATE SET
      market_cap_quote = EXCLUDED.market_cap_quote, market_cap_usd = EXCLUDED.market_cap_usd,
      volume_24h_quote = EXCLUDED.volume_24h_quote, volume_24h_usd = EXCLUDED.volume_24h_usd,
      change_24h = EXCLUDED.change_24h, trades_24h = EXCLUDED.trades_24h,
      last_trade_at = EXCLUDED.last_trade_at, ath_quote = EXCLUDED.ath_quote, ath_at = EXCLUDED.ath_at,
      holders = EXCLUDED.holders, updated_at = NOW()`);
}

export function startStatsJob(
  db: Db,
  onError: (e: unknown) => void,
  intervalMs = STATS_INTERVAL_MS,
): Job {
  return startJob({ name: "market-stats", intervalMs, run: () => rebuildMarketStats(db), onError });
}
