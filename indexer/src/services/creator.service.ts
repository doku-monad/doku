import type { CreatorRepository } from "../repositories/creator.repository.js";
import type { CreatorBalance, CreatorBalanceRowDb, CreatorSummary } from "../types/api.js";
import { normalizeAddress } from "./pagination.js";

/**
 * What a quote asset's decimals are when the registry has never heard of it.
 *
 * Eighteen, because that is what an ERC-20 defaults to and what every asset on this chain but the
 * stablecoins and the gold uses. It is a guess and it is labelled one — the honest fix is to
 * register the asset, which is what `/status`'s unpriced count and the quote admin script are for.
 */
const DEFAULT_DECIMALS = 18;

/** A creator's balances and the markets that pay them. */
export class CreatorService {
  constructor(private readonly creators: CreatorRepository) {}

  async read(address: string): Promise<CreatorSummary> {
    const who = normalizeAddress(address);
    const [balances, markets] = await Promise.all([
      this.creators.balances(who),
      this.creators.markets(who),
    ]);
    // One query, two lists: claimable and lifetime are the same rows read on different columns, and
    // asking the database twice for them would let the two answers disagree by a write in between.
    const shape = (row: CreatorBalanceRowDb, amount: string): CreatorBalance => ({
      quoteAsset: row.quote_asset,
      quoteSymbol: row.quote_symbol,
      quoteDecimals: row.quote_decimals ?? DEFAULT_DECIMALS,
      amount,
    });
    return {
      claimable: balances.map((b) => shape(b, b.claimable)),
      earnedLifetime: balances.map((b) => shape(b, b.earned_lifetime)),
      markets: markets.map((m) => ({
        marketAddress: m.market_address,
        ticker: m.ticker,
        name: m.name,
        quoteAsset: m.quote_asset,
        role: m.role,
      })),
    };
  }
}
