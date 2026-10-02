import type { QuoteRepository } from "../repositories/quote.repository.js";
import type { QuoteAssetWire } from "../types/api.js";

/**
 * An address as a name, for an asset the catalogue has never been told about.
 *
 * Six leading characters and four trailing ones is the convention the interface already uses for
 * every unnamed address, so a registry row nobody has labelled reads like the rest of the site
 * rather than like a bug.
 */
const short = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;

/**
 * The quote-asset registry in the exact shape `src/lib/assets/quote-assets.ts` declares, so that
 * constant file can be deleted rather than kept in step with a table.
 *
 * `status` is DERIVED here and never stored: `registered && enabled` is "live", registered alone is
 * "listed", neither is "soon". Storing it would be storing a conclusion about two booleans that the
 * chain already answers, and the two would disagree the first time a registration was missed.
 */
export class QuoteService {
  constructor(private readonly quotes: QuoteRepository) {}

  async list(): Promise<{ items: QuoteAssetWire[] }> {
    const rows = await this.quotes.list();
    return {
      items: rows.map((r) => {
        // An asset registered by an admin transaction the catalogue did not anticipate has no
        // symbol and no name. Rendering its address is a true statement about it; inventing a
        // ticker would not be.
        const fallback = r.address ? short(r.address) : r.id;
        return {
          id: r.id,
          symbol: r.symbol ?? fallback,
          name: r.name ?? r.symbol ?? fallback,
          kind: (r.kind ?? "crypto") as QuoteAssetWire["kind"],
          status: r.registered ? (r.enabled ? "live" : "listed") : "soon",
          // 18 is the ERC-20 default, and only a guess until a registration reports what the token
          // itself says — which overwrites this column and always wins.
          decimals: r.decimals ?? 18,
          // Native MON is `address(0)` ON CHAIN, and the launch form must send exactly that. The
          // frontend catalogue's `null` for MON meant "not on the launchpad yet", which is a
          // different statement and is no longer true.
          address: r.address,
          blurb: r.blurb ?? "",
          underlying: r.underlying,
          iconDomain: r.icon_domain,
          quoteTarget: r.quote_target,
          usdPrice: r.usd_price,
          usdPriceAt: r.usd_price_at ? new Date(r.usd_price_at).toISOString() : null,
          marketCount: r.market_count,
        };
      }),
    };
  }
}
