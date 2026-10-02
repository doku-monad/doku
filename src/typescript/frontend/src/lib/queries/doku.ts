import "server-only";

import {
  fetchAccountSwaps,
  fetchCandlesticks,
  fetchHolders,
  fetchLeaderboard,
  fetchMarket,
  fetchMarkets,
  fetchMarketsPage,
  fetchPortfolio,
  fetchStatus,
  fetchSwaps,
  type Leaderboard,
  type LeaderboardWindow,
  type MarketsPageQuery,
  type PortfolioRow,
  searchMarkets,
} from "@/lib/api/markets";
import { indexer } from "@/lib/api/server";
import {
  type QuoteAsset,
  quoteAssetFromWire,
  type QuoteAssetWire,
} from "@/lib/assets/quote-assets";
import {
  isTickerSlug,
  resolveFromRows,
  type SlugResolution,
} from "@/lib/chain/market-slug";
import {
  quotePerWholeTokenNumber,
  type QuoteScale,
  UNKNOWN_SCALE,
} from "@/lib/chain/quote-scale";
import {
  type CandlestickModel,
  type HolderModel,
  type MarketModel,
  type SwapModel,
  toCandlestickModel,
  toHolderModel,
  toMarketModel,
  toSwapModel,
} from "@/lib/models";

import { toMarketModelsSkippingBad } from "./market-list";

/**
 * Server-side reads, already mapped to models.
 *
 * This is the whole data layer the pages see. It replaces the PostgREST query helpers, which
 * spoke Aptos row shapes and needed a `TableName` union to keep `from()` honest — machinery that
 * a handful of REST endpoints does not need.
 *
 * Every function here returns models rather than rows, so no page ever handles a raw string
 * amount and no page has to remember to convert one.
 */

export async function getMarkets(opts: { limit?: number; cursor?: string } = {}): Promise<{
  markets: MarketModel[];
  nextCursor: string | null;
}> {
  const page = await fetchMarkets(indexer, opts);
  return { markets: toMarketModelsSkippingBad(page.items), nextCursor: page.nextCursor };
}

export async function getMarket(address: string): Promise<MarketModel> {
  return toMarketModel(await fetchMarket(indexer, address));
}

/** One page of the board, exactly as the database ordered, filtered and counted it. */
export interface MarketsPage {
  markets: MarketModel[];
  /** The size of the FILTERED set, not of the table. What the pager divides. */
  total: number;
  page: number;
  /** What the service actually served, which is not necessarily what was asked for: it clamps. */
  limit: number;
  /**
   * How many markets each quote asset has over the current search, keyed by catalogue id (or by
   * quote address for an asset the catalogue has never been told about).
   *
   * Counted by the service over the searched set MINUS the pair predicate, so a chip says what
   * clicking it would find rather than reading 0 for every pair but the selected one.
   */
  pairCounts: Record<string, number>;
}

/**
 * The board's page: sorted, filtered, searched and counted in SQL.
 *
 * `fetchMarketsPage` sends no `cursor` key at all — the service picks its contract on the mere
 * presence of that key, so `cursor: undefined` would select the OTHER one and this would be
 * reading `total` off a response that has no such field. See that function's own note.
 */
export async function getMarketsPage(q: MarketsPageQuery = {}): Promise<MarketsPage> {
  const page = await fetchMarketsPage(indexer, q);
  return {
    markets: toMarketModelsSkippingBad(page.items),
    total: page.total,
    page: page.page,
    limit: page.limit,
    pairCounts: page.pairCounts,
  };
}

/**
 * The hero's four lists, over one window, in one request.
 *
 * Returned as the wire rows rather than as models on purpose: the service already flattened them
 * — every figure on a `SlimMarketRow` is a decimal string or a JSON number, none is a `bigint` —
 * and there is no richer shape to build. What a consumer must NOT do is read `lastPrice` off one
 * of these: `SlimMarketRow` carries a price and no generation, which is the exact separation that
 * produced four defects on this service. `marketCapQuote` and `volume24hQuote` are already
 * normalised and take `quoteDecimals` alone — use `quoteAmountNumber`.
 */
export async function getLeaderboard(window: LeaderboardWindow = "24h"): Promise<Leaderboard> {
  return fetchLeaderboard(indexer, window);
}

/**
 * What scale one market's prices are stored at.
 *
 * A swap row and a candlestick row carry a price and no generation, so a route that serves either
 * has to ask the market. That is one extra request, and it is the price of not guessing: the same
 * guess, made in the service, produced a market cap a quintillion times too large in three places
 * and a price that collapsed at graduation in a fourth.
 */
/**
 * Resolve a `/market/<slug>` path segment that is not an address.
 *
 * Searches the service and demands an exact ticker match. Generation 1 derived this address from
 * the emoji, because its factory salted on the symbol; generation 2 salts on the creator and a
 * nonce, so a ticker determines nothing and the answer has to be looked up. See `market-slug.ts`
 * for why a prefix match and a first-row pick are both wrong.
 */
export async function resolveMarketSlug(slug: string): Promise<SlugResolution> {
  if (!isTickerSlug(slug)) return { kind: "not-found" };
  // Wide enough that every same-ticker market comes back, so ambiguity is DETECTED rather than
  // hidden by a limit that happened to cut the second one off.
  const { items } = await searchMarkets(indexer, slug, 50);
  return resolveFromRows(slug, items);
}

export async function getMarketScale(address: string): Promise<QuoteScale> {
  const row = await fetchMarket(indexer, address);
  return { generation: row.generation ?? 1, quoteDecimals: row.quote_decimals ?? 18 };
}

/** The scale a market model was built from, for handing to a swap or candle feed of that market. */
export const scaleOf = (market: MarketModel): QuoteScale => ({
  generation: market.market.generation,
  quoteDecimals: market.market.quote.decimals,
});

/**
 * A market's scale, and the asset its figures are denominated in.
 *
 * The symbol travels with the numbers because the two are useless apart. A portfolio spans markets
 * priced in MON, in USDC and in troy ounces of gold, and a column of figures with one currency
 * printed at the top of it is an invitation to add them up.
 */
export interface MarketMoney extends QuoteScale {
  quoteAsset: string;
  quoteSymbol: string | null;
}

/**
 * Resolved once per market, for the life of the process.
 *
 * `generation` and `quote_decimals` are IMMUTABLE for a market — the generation is the contract
 * that deployed it and the decimals are what the quote token reported at registration, and neither
 * has a setter anywhere. So this is not a staleness risk, and without it the P&L walk would ask
 * the indexer for the same handful of market rows on every one of its six pages.
 */
const moneyCache = new Map<string, MarketMoney>();

/**
 * The scale and the denomination of every market in a cross-market feed.
 *
 * `BalanceRow` and `AccountSwapRow` each carry a price and no generation, which is the whole
 * hazard — a price and its scale arrive by different routes and something has to put them back
 * together. Both feeds used to pass `UNKNOWN_SCALE` and render nothing, which was honest and
 * useless. This asks the market rows, which are the shapes that do carry a generation.
 *
 * A market that cannot be fetched falls back to `UNKNOWN_SCALE` for that ROW ALONE. One unreachable
 * market renders one dash; it does not take the price off the rest of the portfolio, and it never
 * substitutes a neighbouring market's scale for the missing one.
 */
async function moneyForMarkets(addresses: string[]): Promise<Map<string, MarketMoney>> {
  const wanted = [...new Set(addresses.map((a) => a.toLowerCase()))];
  const missing = wanted.filter((a) => !moneyCache.has(a));

  await Promise.all(
    missing.map(async (address) => {
      try {
        const row = await fetchMarket(indexer, address);
        moneyCache.set(address, {
          generation: row.generation ?? 1,
          quoteDecimals: row.quote_decimals ?? 18,
          quoteAsset: row.quote_asset ?? "0x0000000000000000000000000000000000000000",
          quoteSymbol: row.quote_symbol ?? null,
        });
      } catch (error) {
        // Logged, not swallowed into a default. A default here is the assumption that produced
        // every one of the generation-scale defects on this service.
        console.error(`Could not resolve the quote scale for market ${address}`, error);
      }
    }),
  );

  return new Map(
    wanted.map((address) => [
      address,
      moneyCache.get(address) ?? { ...UNKNOWN_SCALE, quoteAsset: "", quoteSymbol: null },
    ]),
  );
}

/**
 * A market's trades.
 *
 * @param scale from the market row — `scaleOf(market)` where the caller already has the model, or
 *        `getMarketScale(address)` where it does not. Required rather than defaulted so that no
 *        caller can hand a generation-2 price to a renderer that will treat it as generation 1.
 */
export async function getSwaps(
  address: string,
  scale: QuoteScale,
  opts: { limit?: number; cursor?: string; trader?: string } = {},
): Promise<{ swaps: SwapModel[]; nextCursor: string | null }> {
  const page = await fetchSwaps(indexer, address, opts);
  return {
    swaps: page.items.map((row) => toSwapModel(row, scale.generation)),
    nextCursor: page.nextCursor,
  };
}

export async function getHolders(
  address: string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<{ holders: HolderModel[]; nextCursor: string | null }> {
  const page = await fetchHolders(indexer, address, opts);
  return { holders: page.items.map(toHolderModel), nextCursor: page.nextCursor };
}

export async function getCandlesticks(
  address: string,
  scale: QuoteScale,
  periodSecs: number,
  limit?: number,
): Promise<CandlestickModel[]> {
  const { items } = await fetchCandlesticks(indexer, address, periodSecs, limit);
  return items.map((row) => toCandlestickModel(row, scale.generation, scale.quoteDecimals));
}

export interface PortfolioPosition {
  tokenAddress: string;
  marketAddress: string;
  symbol: string;
  balance: bigint;
  /**
   * Whole quote units per whole token — of THIS ROW'S quote asset, named beside it.
   *
   * `BalanceRow` carries a price and neither a generation nor a quote asset, and a portfolio spans
   * markets that need not share either. It divided every row by a hard-coded 1e18, which is right
   * for a generation-1 MON market and wrong by a quintillion for a generation-2 one sitting in the
   * same list; then it passed `UNKNOWN_SCALE` and rendered a dash for every row, which was honest
   * and useless. Each row now carries its own market's generation.
   *
   * `null` only where that market could not be reached. A dash on one row.
   */
  lastPrice: number | null;
  /**
   * Balance times price, in whole units of `quoteSymbol`. Null for the same reason.
   *
   * **Not addable across rows.** Two positions priced in different assets are two different
   * currencies, and the sum of them is a number with no unit. The field kept its old name only
   * because renaming it would touch every consumer at once; `quoteSymbol` beside it is what says
   * what it is.
   */
  valueMon: number | null;
  /** What this position's figures are denominated in. */
  quoteAsset: string;
  quoteSymbol: string | null;
  quoteDecimals: number;
  graduated: boolean;
}

/** @param money this row's own market's scale and denomination, from `moneyForMarkets`. */
const toPosition = (row: PortfolioRow, money: MarketMoney): PortfolioPosition => {
  const balance = BigInt(row.balance);
  // Both divisions in one step. Scaling the integer first and dividing by the decimals second
  // floors any token worth less than one raw unit of its quote to zero — which on six-decimal gold
  // is most of a young market's supply.
  const lastPrice = quotePerWholeTokenNumber(row.last_price, money.generation, money.quoteDecimals);
  return {
    tokenAddress: row.token_address,
    marketAddress: row.market_address,
    symbol: row.symbol,
    balance,
    lastPrice,
    quoteAsset: money.quoteAsset,
    quoteSymbol: money.quoteSymbol,
    quoteDecimals: money.quoteDecimals,
    // Converted to a number only at the end, after both operands are in nominal units — the
    // product of two base-unit integers would be 1e36 and meaningless as a value.
    valueMon: lastPrice === null ? null : (Number(balance / 1_000_000_000_000n) / 1e6) * lastPrice,
    graduated: row.pool_address !== null,
  };
};

/**
 * The generation and denomination of a set of markets, named by address.
 *
 * The public face of `moneyForMarkets`, for any caller holding a feed whose rows carry a price and
 * no generation — `SlimMarketRow` off the leaderboard is one, and the hero draws a candle series
 * for each row it shows. Resolved once per market for the life of the process, because a market's
 * generation and its quote's decimals are both immutable.
 */
export async function getMarketMoney(addresses: string[]): Promise<Map<string, MarketMoney>> {
  return moneyForMarkets(addresses);
}

export async function getPortfolio(
  address: string,
  limit = 100,
): Promise<PortfolioPosition[]> {
  const { items } = await fetchPortfolio(indexer, address, limit);
  const money = await moneyForMarkets(items.map((row) => row.market_address));
  return items.map((row) =>
    toPosition(row, money.get(row.market_address.toLowerCase())!),
  );
}

/**
 * An account's trades across every market it has touched.
 *
 * Each row is resolved against ITS OWN market's generation, not against one scale for the page.
 * `AccountSwapRow` carries a price and no generation, and this feed spans markets by definition —
 * so it passed `UNKNOWN_SCALE` and every `priceQuote` came back null. That was honest; it was also
 * the last place on the client where a price and its scale had been separated and not put back.
 *
 * The quote symbol and decimals ride along for the same reason a price needs its generation: the
 * amounts on these rows are money, in an asset that differs from row to row, and a consumer that
 * adds them up without asking is adding dollars to troy ounces.
 */
export async function getAccountSwaps(
  address: string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<{
  swaps: (SwapModel & { symbol: string; quoteSymbol: string | null; quoteDecimals: number })[];
  nextCursor: string | null;
}> {
  const page = await fetchAccountSwaps(indexer, address, opts);
  const money = await moneyForMarkets(page.items.map((row) => row.market_address));
  return {
    swaps: page.items.map((row) => {
      const m = money.get(row.market_address.toLowerCase())!;
      return {
        ...toSwapModel(row, m.generation),
        symbol: row.symbol,
        quoteSymbol: m.quoteSymbol,
        quoteDecimals: m.quoteDecimals,
      };
    }),
    nextCursor: page.nextCursor,
  };
}

/** Indexer lag, for a health badge. Deliberately never throws — staleness is not an outage. */
export async function getIndexerStatus() {
  try {
    const status = await fetchStatus(indexer);
    return {
      lastBlock: BigInt(status.last_block),
      chainHead: BigInt(status.chain_head),
      lagBlocks: status.lag_blocks,
      lagSeconds: status.lag_seconds,
      reachable: true as const,
    };
  } catch {
    return { reachable: false as const };
  }
}

/**
 * The quote-asset registry, as the indexer holds it.
 *
 * Two readers, and they want different things. `fetchQuotes` returns the **wire** rows, because
 * `app/api/quotes/route.ts` is a proxy and re-shaping a payload it is only forwarding is a place
 * for a rename to hide a bug. `getQuoteAssets` returns the app's own shape, for a server component
 * that renders the registry itself.
 *
 * Neither swallows a failure. A page that shows an empty registry because the indexer was down is
 * telling a visitor there is nothing to pair against.
 */
export async function fetchQuotes(): Promise<QuoteAssetWire[]> {
  const { items } = await indexer.get<{ items: QuoteAssetWire[] }>("/quotes");
  return items;
}

export async function getQuoteAssets(): Promise<QuoteAsset[]> {
  return (await fetchQuotes()).map(quoteAssetFromWire);
}
