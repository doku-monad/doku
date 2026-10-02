import type { Queryable } from "../db/transaction.js";
import type { AccountSwapRow, SwapRow } from "../types/api.js";
import { swapColumns } from "./columns.js";
import { servedMarket, servedMarkets } from "./served.js";

/**
 * Trade feeds, per market and per account.
 *
 * Cursor pagination on `id` descending, never `OFFSET`. A live feed inserts rows while somebody
 * pages through it, and `OFFSET` silently skips or repeats rows when that happens — a bug that
 * looks like a rendering glitch and gets chased in the wrong layer for a week.
 */
export class SwapRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * @param trader optional, and filtered in SQL rather than by the caller. "My trades" filtered
   *        client-side over one page silently means "my trades that happen to be in the last
   *        fifty", which looks like a complete list and is not one.
   */
  async listForMarket(
    market: string,
    limit: number,
    cursor: string | null,
    trader: string | null,
  ): Promise<SwapRow[]> {
    return this.db.$queryRaw<SwapRow[]>`
      SELECT ${swapColumns("swaps")} FROM swaps
       WHERE swaps.market_address = ${market}
         -- A retired market's trades are real and are not served: the feed belongs to a market this
         -- deployment answers 410 for, so rows here would be the one place it still looked alive.
         AND ${servedMarket("swaps.market_address")}
         AND (${cursor}::bigint IS NULL OR swaps.id < ${cursor}::bigint)
         AND (${trader}::text IS NULL OR swaps.trader = ${trader})
       ORDER BY swaps.id DESC
       LIMIT ${limit}`;
  }

  async listForAccount(
    trader: string,
    limit: number,
    cursor: string | null,
  ): Promise<AccountSwapRow[]> {
    return this.db.$queryRaw<AccountSwapRow[]>`
      SELECT ${swapColumns("sw")}, m.symbol, m.token_address
        FROM swaps sw
        JOIN ${servedMarkets()} m USING (market_address)
       WHERE sw.trader = ${trader}
         AND (${cursor}::bigint IS NULL OR sw.id < ${cursor}::bigint)
       ORDER BY sw.id DESC
       LIMIT ${limit}`;
  }
}
