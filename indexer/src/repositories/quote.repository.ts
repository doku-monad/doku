import type { Queryable } from "../db/transaction.js";
import type { QuoteAssetRowDb } from "../types/api.js";
import { servedMarkets } from "./served.js";

/**
 * The quote-asset registry, as the launch form and the pair chips read it.
 *
 * One query for the whole table because the table is a dozen rows and will stay that shape: it is a
 * curated list of things a market can be priced in, not a growing collection. Paging it would add a
 * cursor to a response that fits in a single frame.
 *
 * `market_count` is a correlated count rather than a stored column. It changes with every launch,
 * and a stored copy is one missed increment away from a chip that says "3" over a list of four. It
 * counts the SERVED generation for the same reason: the number is what a pair chip puts over the
 * board, and counting markets the board will not show is the same bug by another route.
 */
export class QuoteRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Every quote asset, presentational columns and on-chain state together.
   *
   * Ordered by `sort_order` then `id`: the catalogue's order is the order the chips and the
   * `/assets` sections render in, and an asset registered by an admin transaction the catalogue did
   * not anticipate falls to the end on the default sort_order rather than landing in the middle.
   */
  async list(): Promise<QuoteAssetRowDb[]> {
    return this.db.$queryRaw<QuoteAssetRowDb[]>`
      SELECT q.id, q.address, q.symbol, q.name, q.kind, q.decimals::int AS decimals,
             q.blurb, q.underlying, q.icon_domain,
             q.quote_target::text AS quote_target, q.registered, q.enabled,
             q.usd_price::float8 AS usd_price, q.usd_price_at,
             (SELECT COUNT(*) FROM ${servedMarkets()} m
               WHERE m.quote_asset = q.address)::int AS market_count
        FROM quote_assets q
       ORDER BY q.sort_order, q.id`;
  }
}
