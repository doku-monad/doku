import type { Queryable } from "../db/transaction.js";
import type { CandlestickRow } from "../types/api.js";
import { CANDLESTICK_COLUMNS } from "./columns.js";
import { servedMarket } from "./served.js";

/**
 * Chart data.
 *
 * Written on ingest rather than aggregated on read: a chart query should not scan the whole trade
 * history every time somebody opens a market page.
 */
export class CandlestickRepository {
  constructor(private readonly db: Queryable) {}

  /** The most recent `limit` buckets. Newest-first from the database, reversed by the service. */
  async listForMarket(market: string, periodSecs: number, limit: number): Promise<CandlestickRow[]> {
    return this.db.$queryRaw<CandlestickRow[]>`
      SELECT ${CANDLESTICK_COLUMNS} FROM candlesticks
       WHERE market_address = ${market} AND period_secs = ${periodSecs}
         -- A chart for a retired market draws nothing, which is the same answer the rest of the
         -- service gives for it. The market page itself is what says why, with a 410.
         AND ${servedMarket("candlesticks.market_address")}
       ORDER BY bucket_start DESC
       LIMIT ${limit}`;
  }
}
