import type { Queryable } from "../db/transaction.js";
import type { CreatorBalanceRowDb, CreatorMarketRowDb } from "../types/api.js";
import { servedMarkets } from "./served.js";

/**
 * What one creator is owed, and which markets owe it.
 *
 * Two queries rather than one join, deliberately: a creator's balance exists per QUOTE ASSET and a
 * market exists per market, and joining them would multiply one against the other — a creator with
 * two balances and three markets would read six of each. They are different lists about the same
 * address, and the service returns them as such.
 *
 * `creator_balances` is maintained by the creator-sink ledger, so this reads a total rather than
 * summing a ledger on every request.
 */
export class CreatorRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Claimable and lifetime, per quote asset, in raw units of that asset.
   *
   * Never summed across assets — a creator paid in USDC and in MON has two balances, and adding
   * them adds dollars to a token count. The registry join is LEFT because a balance can exist in an
   * asset the catalogue has not been told about, and dropping the row would be worse than showing
   * it without a symbol.
   *
   * Ordered by address so the list is stable between requests; the service does not reorder it.
   */
  async balances(who: string): Promise<CreatorBalanceRowDb[]> {
    return this.db.$queryRaw<CreatorBalanceRowDb[]>`
      SELECT b.quote_asset, qa.symbol AS quote_symbol, qa.decimals::int AS quote_decimals,
             b.claimable::text AS claimable, b.earned_lifetime::text AS earned_lifetime
        FROM creator_balances b
        LEFT JOIN quote_assets qa ON qa.address = b.quote_asset
       WHERE b.who = ${who}
       ORDER BY b.quote_asset`;
  }

  /**
   * Every market that names this address as a recipient, and in which capacity.
   *
   * Keyed on the RECIPIENT columns rather than on `creator`: the two come apart the moment a
   * creator transfers a recipient, and it is the recipient who gets paid. A page that listed
   * markets by `creator` would show a creator money they can no longer claim.
   *
   * A retired market is off this list even though its balance is not. `creator_balances` is keyed by
   * recipient and quote asset, never by market, so what a retired generation earned stays claimable
   * and stays counted — the market row is what would have linked somebody to a launch they must not
   * be sent back to.
   */
  async markets(who: string): Promise<CreatorMarketRowDb[]> {
    return this.db.$queryRaw<CreatorMarketRowDb[]>`
      SELECT market_address, ticker, name, quote_asset,
             CASE WHEN routed_recipient = ${who} AND tax_recipient = ${who} THEN 'both'
                  WHEN routed_recipient = ${who} THEN 'routed'
                  ELSE 'tax' END AS role
        FROM ${servedMarkets()} m
       WHERE routed_recipient = ${who} OR tax_recipient = ${who}
       ORDER BY block_number, market_address`;
  }
}
