/**
 * The USD price document the indexer reads, built from one upstream call.
 *
 * The indexer ranks the board in dollars. An asset it cannot price is not ranked at zero — it is
 * ranked on whole quote units instead, which puts a market holding 1.8 ounces of gold below one
 * holding 8,000 USDC even though the gold is worth more. That failure prints a plausible board
 * and reports no error, so every registered quote has to appear here.
 *
 * Keys are lowercase: the Monad token address, the catalogue id, and the symbol. The indexer tries
 * address, then id, then symbol, so any one of the three matching is enough — the redundancy costs
 * nothing and survives a row whose address is null.
 */

/** A quote asset that has a real contract on Monad, and where its dollar price comes from. */
interface PricedQuote {
  /** Lowercase Monad address, or null for the native asset, which the registry keys as zero. */
  address: string;
  id: string;
  symbol: string;
  /** The CoinGecko id whose USD price this asset tracks. */
  coin: string;
}

export const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Only the assets registered on chain. Adding a quote to the registry means adding it here too, or
 * it launches unpriced.
 *
 * The two bitcoin rails share one price and the stablecoins are absent on purpose: the indexer pins
 * anything of kind `stablecoin` to exactly 1 before it ever reads this document, and a dollar rail
 * that drifts is a depeg the price feed should not be papering over.
 */
export const PRICED_QUOTES: PricedQuote[] = [
  { address: NATIVE_ADDRESS, id: "mon", symbol: "mon", coin: "monad" },
  {
    address: "0xee8c0e9f1bffb4eb878d8f15f368a02a35481242",
    id: "weth",
    symbol: "weth",
    coin: "ethereum",
  },
  {
    address: "0x0555e30da8f98308edb960aa94c0db47230d2b9c",
    id: "wbtc",
    symbol: "wbtc",
    coin: "bitcoin",
  },
  {
    address: "0xd18b7ec58cdf4876f6afebd3ed1730e4ce10414b",
    id: "cbbtc",
    symbol: "cbbtc",
    coin: "bitcoin",
  },
  {
    address: "0x01bff41798a0bcf287b996046ca68b395dbc1071",
    id: "xaut0",
    symbol: "xaut0",
    coin: "tether-gold",
  },
];

/** The upstream ids to request, de-duplicated — both bitcoin rails ask for the same one. */
export const COIN_IDS = Array.from(new Set(PRICED_QUOTES.map((q) => q.coin)));

/**
 * Turn CoinGecko's `{ id: { usd: n } }` into the flat document the indexer parses.
 *
 * An id the upstream omitted, or priced at zero, or priced as a string that is not a number, is
 * left out rather than defaulted. A missing key makes the indexer name the asset in
 * `/status.unpriced_quotes`; a zero would be accepted as a price and silently rank the asset last.
 */
export function buildPriceDocument(upstream: unknown): Record<string, number> {
  const prices: Record<string, number> = {};
  if (typeof upstream !== "object" || upstream === null) return prices;
  const table = upstream as Record<string, unknown>;

  for (const quote of PRICED_QUOTES) {
    const entry = table[quote.coin];
    if (typeof entry !== "object" || entry === null) continue;
    const raw = (entry as Record<string, unknown>).usd;
    const usd = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (!Number.isFinite(usd) || usd <= 0) continue;

    prices[quote.address] = usd;
    prices[quote.id] = usd;
    prices[quote.symbol] = usd;
  }

  return prices;
}

/** How many of the listed assets the document actually priced. */
export function pricedCount(prices: Record<string, number>): number {
  return PRICED_QUOTES.filter((q) => prices[q.address] !== undefined).length;
}
