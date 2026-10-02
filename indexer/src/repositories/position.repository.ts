import type { Queryable } from "../db/transaction.js";
import type { PositionRow } from "../types/api.js";
import { servedMarkets } from "./served.js";

/**
 * Liquidity positions in graduated pools.
 *
 * This repository exists because the chain cannot answer the question. Uniswap v4's PositionManager
 * is ERC-721 but not ERC-721Enumerable, so there is no `tokenOfOwnerByIndex` — and on Monad it is
 * the CANONICAL manager shared by every v4 protocol, holding hundreds of thousands of positions, so
 * walking the ids to find an owner's holdings is not merely slow but infeasible.
 *
 * The rows come from the PoolManager’s `ModifyLiquidity`, whose pool id and sender are both indexed.
 */
export class PositionRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * One account's positions, newest first.
   *
   * Emptied positions are excluded. A fully withdrawn position settles at exactly zero liquidity
   * rather than disappearing — the table accumulates a signed delta — and listing one beside a real
   * position invites withdrawing from the wrong row.
   *
   * `owner` here is the transaction SIGNER, recorded because the event’s own `sender` is the
   * PositionManager for every position minted through the periphery. It is
   * a DISCOVERY hint rather than the authority: a position minted to a different address, or
   * transferred as an NFT afterwards, leaves it stale. Callers confirm against `ownerOf`, which is
   * cheap over the handful of ids this returns and impossible over every id in the manager.
   */
  async listForAccount(owner: string, limit: number): Promise<PositionRow[]> {
    return this.db.$queryRaw<PositionRow[]>`
      SELECT p.token_id::text     AS token_id,
             p.pool_id            AS pool_id,
             p.market_address     AS market_address,
             p.owner              AS owner,
             p.tick_lower         AS tick_lower,
             p.tick_upper         AS tick_upper,
             p.liquidity::text    AS liquidity,
             m.token_address      AS token_address,
             m.symbol             AS symbol
        FROM positions p
        JOIN ${servedMarkets()} m ON m.market_address = p.market_address
       WHERE p.owner = ${owner}
         AND p.liquidity > 0
       ORDER BY p.block_number DESC, p.token_id DESC
       LIMIT ${limit}`;
  }

  /** Every live position in one market, for the pool page's depth and provider count. */
  async listForMarket(market: string, limit: number): Promise<PositionRow[]> {
    return this.db.$queryRaw<PositionRow[]>`
      SELECT p.token_id::text     AS token_id,
             p.pool_id            AS pool_id,
             p.market_address     AS market_address,
             p.owner              AS owner,
             p.tick_lower         AS tick_lower,
             p.tick_upper         AS tick_upper,
             p.liquidity::text    AS liquidity,
             m.token_address      AS token_address,
             m.symbol             AS symbol
        FROM positions p
        JOIN ${servedMarkets()} m ON m.market_address = p.market_address
       WHERE p.market_address = ${market}
         AND p.liquidity > 0
       ORDER BY p.liquidity DESC, p.token_id DESC
       LIMIT ${limit}`;
  }
}
