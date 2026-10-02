import type { ApiClient, QueryValue } from "./client";
import type {
  AccountSwapRow,
  BalanceRow,
  CandlestickRow,
  CreatorSummary,
  HolderRow,
  LaunchRow,
  Leaderboard,
  LeaderboardWindow,
  MarketDetailRow,
  MarketListPage,
  MarketRewards,
  MarketRow,
  Page,
  PositionRow,
  QuoteAssetWire,
  RoutingName,
  SlimMarketRow,
  StatusRow,
  SwapRow,
  UploadWire,
} from "./types";

/**
 * Typed reads against the DOKU indexer.
 *
 * These return **rows**, not models. Numeric columns arrive as strings because Postgres serialises
 * `NUMERIC` that way and because an 18-decimal token amount does not survive a round trip through
 * a JavaScript number. Turning rows into models — and strings into `bigint` — belongs to
 * `lib/models`, which is the one place that already knows the model shape.
 *
 * The shapes live in `./types`, mirroring the service's `src/types/api.ts` field for field. They
 * are re-exported from here because every existing consumer imports them from this module, and a
 * rename across forty files is a diff nobody can review.
 */

export type {
  AccountSwapRow,
  BalanceRow,
  CandlestickRow,
  CreatorBalance,
  CreatorMarket,
  CreatorSummary,
  HolderRow,
  LaunchRow,
  Leaderboard,
  LeaderboardWindow,
  MarketDetailRow,
  MarketListPage,
  MarketRewards,
  MarketRow,
  Page,
  PositionRow,
  QuoteAssetKind,
  QuoteAssetStatus,
  QuoteAssetWire,
  RoutingName,
  SlimMarketRow,
  StatusRow,
  SwapRow,
  UploadWire,
} from "./types";

/**
 * The indexer's health row, under the name the app has always used for it.
 *
 * `StatusRow` is the service's name; `IndexerStatus` is what the live badge imports. Aliased
 * rather than renamed, because the alias costs one line and the rename costs a sweep.
 */
export type IndexerStatus = StatusRow;

/** One position in an account's portfolio, already joined to the market it belongs to. */
export type PortfolioRow = BalanceRow;

/** Addresses are stored lowercased; anything else quietly matches nothing. */
const normalize = (address: string) => address.toLowerCase();

// ---------------------------------------------------------------------------- markets

/**
 * The market list in **cursor** mode: address-ordered, `{items, nextCursor}`.
 *
 * The mode is chosen by the mere PRESENCE of the `cursor` key — the service tests
 * `q.cursor !== undefined`, so `?cursor=` with an empty value selects this and omitting the key
 * entirely selects the board's page. That is why this function always sends the key and
 * `fetchMarketsPage` never does.
 */
export const fetchMarkets = (
  api: ApiClient,
  opts: { limit?: number; cursor?: string } = {},
): Promise<Page<MarketRow>> => api.get("/markets", { limit: opts.limit, cursor: opts.cursor ?? "" });

export interface MarketsPageQuery {
  sort?: string;
  order?: "asc" | "desc";
  /** A catalogue id or a quote address. The service decides which; an id matching nothing is not an error. */
  pair?: string;
  status?: "all" | "curve" | "graduated";
  routing?: RoutingName;
  /** The search needle. Lower-cased and matched in SQL, not by filtering a page in the browser. */
  q?: string;
  page?: number;
  limit?: number;
}

/**
 * The board's page: sorted, filtered and counted by the database.
 *
 * **No `cursor` key is sent, ever.** Not an empty one, not an undefined one — the service selects
 * its other contract on the key being present at all, and a `cursor: undefined` left in the query
 * object would be dropped by `ApiClient` but is one refactor away from not being. The object is
 * built by hand for that reason rather than spread from the caller's.
 */
export const fetchMarketsPage = (
  api: ApiClient,
  q: MarketsPageQuery = {},
): Promise<MarketListPage> => {
  const query: Record<string, QueryValue> = {};
  if (q.sort !== undefined) query.sort = q.sort;
  if (q.order !== undefined) query.order = q.order;
  if (q.pair !== undefined) query.pair = q.pair;
  if (q.status !== undefined) query.status = q.status;
  if (q.routing !== undefined) query.routing = q.routing;
  if (q.q !== undefined) query.q = q.q;
  if (q.page !== undefined) query.page = q.page;
  if (q.limit !== undefined) query.limit = q.limit;
  return api.get("/markets", query);
};

/** One market, with its v4 pool key. `MarketDetailRow`, not `MarketRow` — the key is the extra. */
export const fetchMarket = (api: ApiClient, address: string): Promise<MarketDetailRow> =>
  api.get(`/markets/${normalize(address)}`);

/**
 * A market's fee ledger.
 *
 * Answers for a generation-1 market too, with zeros: "this market has earned nothing to route" is
 * a fact about it, not a missing resource.
 */
export const fetchMarketRewards = (api: ApiClient, address: string): Promise<MarketRewards> =>
  api.get(`/markets/${normalize(address)}/rewards`);

export const fetchSwaps = (
  api: ApiClient,
  address: string,
  opts: { limit?: number; cursor?: string; trader?: string } = {},
): Promise<Page<SwapRow>> =>
  api.get(`/markets/${normalize(address)}/swaps`, {
    limit: opts.limit,
    cursor: opts.cursor,
    // Filtered in SQL. Narrowing one page in the browser gives a list that looks complete and is
    // not, which reads as "my trade did not happen".
    trader: opts.trader ? normalize(opts.trader) : undefined,
  });

export const fetchHolders = (
  api: ApiClient,
  address: string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<Page<HolderRow>> =>
  api.get(`/markets/${normalize(address)}/holders`, { limit: opts.limit, cursor: opts.cursor });

export const fetchCandlesticks = (
  api: ApiClient,
  address: string,
  period: number,
  limit?: number,
): Promise<{ items: CandlestickRow[] }> =>
  api.get(`/markets/${normalize(address)}/candlesticks`, { period, limit });

// ------------------------------------------------------------------------ whole-site reads

/**
 * The hero's four lists — movers, volume, recently graduated, and the rail — over one window.
 *
 * One request rather than four, and rather than a fan-out per market: they are drawn as one
 * component, and four calls would give it four independent loading states over the same data.
 */
export const fetchLeaderboard = (
  api: ApiClient,
  window: LeaderboardWindow = "24h",
): Promise<Leaderboard> => api.get("/leaderboard", { window });

/**
 * The command palette, searched in SQL.
 *
 * An empty needle answers an empty list rather than the whole table — a palette that has just been
 * opened has typed nothing.
 */
export const searchMarkets = (
  api: ApiClient,
  q: string,
  limit?: number,
): Promise<{ items: SlimMarketRow[] }> => api.get("/search", { q, limit });

/** The quote-asset registry. See `lib/assets/quote-assets` for the app's own shape of a row. */
export const fetchQuotes = (api: ApiClient): Promise<{ items: QuoteAssetWire[] }> =>
  api.get("/quotes");

export const fetchStatus = (api: ApiClient): Promise<IndexerStatus> => api.get("/status");

// ---------------------------------------------------------------------------- accounts

export const fetchPortfolio = (
  api: ApiClient,
  address: string,
  limit?: number,
): Promise<{ items: PortfolioRow[] }> =>
  api.get(`/accounts/${normalize(address)}/balances`, { limit });

/** An account's trades across every market; carries the symbol so rows need no second lookup. */
export const fetchAccountSwaps = (
  api: ApiClient,
  address: string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<Page<AccountSwapRow>> =>
  api.get(`/accounts/${normalize(address)}/swaps`, { limit: opts.limit, cursor: opts.cursor });

/**
 * What an address launched, newest first.
 *
 * `truncated` is in the shape and is always false: this asks the database for exactly the matching
 * rows. The Next.js route it replaces walked five hundred markets and filtered them in the
 * browser, and had to be able to say when it gave up.
 */
export const fetchLaunches = (
  api: ApiClient,
  address: string,
): Promise<{ items: LaunchRow[]; truncated: boolean }> =>
  api.get(`/accounts/${normalize(address)}/launches`);

/** Liquidity positions an account holds in graduated pools. */
export const fetchPositions = (
  api: ApiClient,
  address: string,
  limit?: number,
): Promise<{ items: PositionRow[] }> =>
  api.get(`/accounts/${normalize(address)}/positions`, { limit });

/** Liquidity positions in one market's pool. */
export const fetchMarketPositions = (
  api: ApiClient,
  address: string,
  limit?: number,
): Promise<{ items: PositionRow[] }> =>
  api.get(`/markets/${normalize(address)}/positions`, { limit });

/**
 * What one creator is owed, per quote asset.
 *
 * **Never sum `claimable` across its entries.** They are different money — a creator paid in USDC
 * and in MON has two balances, and adding them is adding dollars to a token count.
 */
export const fetchCreator = (api: ApiClient, address: string): Promise<CreatorSummary> =>
  api.get(`/creators/${normalize(address)}`);

// ---------------------------------------------------------------------------- uploads

/** One row of the image reference ledger. The write side needs a token — see `POST /uploads`. */
export const fetchUpload = (api: ApiClient, cid: string): Promise<UploadWire> =>
  api.get(`/uploads/${cid}`);

/**
 * Follows a cursor to the end.
 *
 * `maxPages` is not paranoia. An indexer that returns the same cursor twice — a bug, a cache, a
 * proxy replaying a response — turns this into an infinite loop that takes the browser tab with
 * it. Bounded, the same bug degrades to a short list, which is visible and survivable.
 */
export async function pageThrough<T>(
  api: ApiClient,
  path: string,
  opts: { limit?: number; maxPages?: number } = {},
): Promise<T[]> {
  const maxPages = opts.maxPages ?? 20;
  const out: T[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const result = await api.get<Page<T>>(path, { limit: opts.limit, cursor: cursor ?? "" });
    if (result.items.length === 0) break;
    out.push(...result.items);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }

  return out;
}
