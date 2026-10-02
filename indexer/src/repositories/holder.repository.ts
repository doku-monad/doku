import type { Queryable } from "../db/transaction.js";
import type { BalanceRow, HolderRow } from "../types/api.js";
import { servedMarkets } from "./served.js";

/**
 * Balances: who holds a market's token, and what one account holds across every market.
 */
export class HolderRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * A market's holders, largest first, each with its share of supply and a label.
   *
   * Paged on `(balance, holder)` rather than balance alone. Balances tie often — every wallet
   * holding a round number does — and a cursor that cannot break the tie either loops on the
   * boundary row or skips past it.
   *
   * Lists exactly what `recountHolders` counts, so the tab and the masthead agree: the curve, the
   * graduated pool, the hook, the sink and the dead address are all left out. None of them is a
   * holder; the pool and the curve hold enormous balances by construction and listing them makes
   * the real distribution unreadable, and a dead-address row read as one more holder while the
   * count did not include it.
   *
   * `share` is the fraction of SUPPLY net of burns — `markets.total_supply` less
   * `market_rewards.burned_tokens` — which is what every explorer and the wallet trackers report
   * and what a reader compares against. It was a fraction of circulating (supply minus the pool
   * and the curve); on a graduated market the pool holds most of the token, so a wallet with 5%
   * of the supply read as 28% and was reported as wrong.
   *
   * `TRUNC(numeric, 6)::text` renders "0.500000": Postgres keeps the scale, so the string is a
   * fixed six places whatever the value, and truncation rather than rounding means no share is ever
   * reported larger than it is.
   */
  async listForMarket(market: string, limit: number, cursor: string | null): Promise<HolderRow[]> {
    return this.db.$queryRaw<HolderRow[]>`
      WITH mk AS (
        SELECT m.market_address, m.token_address, m.creator, m.total_supply,
               g.pool_address, g.sink, g.hooks
          FROM ${servedMarkets()} m LEFT JOIN graduations g USING (market_address)
         WHERE m.market_address = ${market}
      ), circ AS (
        SELECT GREATEST(mk.total_supply - COALESCE((
                 SELECT r.burned_tokens FROM market_rewards r WHERE r.market_address = mk.market_address
               ), 0), 0)::numeric(78,0) AS supply
          FROM mk
      )
      SELECT b.holder, b.balance::text AS balance,
             CASE WHEN circ.supply > 0 THEN TRUNC(b.balance / circ.supply, 6)::text
                  ELSE '0.000000' END AS share,
             CASE WHEN b.holder = mk.creator THEN 'creator' ELSE NULL END AS label
        FROM token_balances b
        CROSS JOIN mk CROSS JOIN circ
       WHERE b.token_address = mk.token_address
         AND b.balance > 0
         AND b.holder <> mk.market_address
         AND b.holder <> '0x000000000000000000000000000000000000dead'
         AND (mk.pool_address IS NULL OR mk.pool_address = '' OR b.holder <> mk.pool_address)
         AND (mk.hooks        IS NULL OR mk.hooks        = '' OR b.holder <> mk.hooks)
         AND (mk.sink         IS NULL OR mk.sink         = '' OR b.holder <> mk.sink)
         AND (${cursor}::text IS NULL OR (b.balance, b.holder) < (SPLIT_PART(${cursor}, ':', 1)::numeric,
                                                                  SPLIT_PART(${cursor}, ':', 2)))
       ORDER BY b.balance DESC, b.holder DESC
       LIMIT ${limit}`;
  }

  /**
   * One account's holdings, across every market.
   *
   * Joined to `markets` here rather than in the browser: the alternative is one request per token
   * to find out what it is, which turns a portfolio of twenty positions into twenty round trips.
   */
  async listForAccount(holder: string, limit: number): Promise<BalanceRow[]> {
    return this.db.$queryRaw<BalanceRow[]>`
      SELECT b.token_address, b.balance::text AS balance,
             m.market_address, m.symbol, s.last_price::text AS last_price, s.pool_address
        FROM token_balances b
        JOIN ${servedMarkets()} m ON m.token_address = b.token_address
        JOIN market_state s USING (market_address)
       WHERE b.holder = ${holder} AND b.balance > 0
       ORDER BY b.balance DESC
       LIMIT ${limit}`;
  }
}
