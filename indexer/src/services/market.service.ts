import { routingName, routingSink } from "../indexer/generations.js";
import type { IndexerSnapshot } from "../indexer/state.js";
import type { ListSort } from "../repositories/market.repository.js";
import type { MarketRepository, StatusRepository } from "../repositories/index.js";
import type {
  LaunchRow,
  Leaderboard,
  MarketDetailRow,
  MarketListPage,
  MarketRewards,
  MarketRow,
  Page,
  SlimMarketRow,
  SlimRowDb,
} from "../types/api.js";
import { clampLimit, normalizeAddress } from "./pagination.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Page mode's own defaults. The board shows a grid, not a feed, so its page is much smaller. */
const PAGE_LIMIT = 24;
const PAGE_MAX = 100;

/**
 * Every spelling of a sort the board puts in a URL, mapped onto the seven the repository knows.
 *
 * Aliases rather than one canonical name because the frontend already has its own vocabulary
 * (`lib/queries/sorting/types.ts`), and rewriting a URL scheme the interface already ships is a
 * worse trade than accepting both spellings here.
 *
 * `price`, `apr` and `tvl` appear in that same frontend union and are deliberately absent: they are
 * Aptos-era leftovers with no column behind them here, so they 400 rather than silently sorting by
 * something else. A sort that quietly means a different thing is worse than one that fails.
 */
const SORT_ALIASES: Record<string, ListSort> = {
  marketcap: "marketCap",
  market_cap: "marketCap",
  volume24h: "volume24h",
  daily_vol: "volume24h",
  daily: "volume24h",
  volumeall: "volumeAll",
  all_time_vol: "volumeAll",
  bump: "bump",
  change24h: "change24h",
  progress: "progress",
  newest: "created",
  created: "created",
};

/**
 * The windows the leaderboard offers, and the Postgres intervals behind them.
 *
 * A whitelist because the interval is spliced into SQL rather than bound — `INTERVAL $1` is not
 * something Postgres will plan — so the only safe version is one the caller SELECTS from and never
 * writes. An unknown key is a 400 before any SQL is built.
 */
const WINDOWS = { "1h": "1 hour", "24h": "24 hours", "7d": "7 days" } as const;

/** Eight rows a list, fourteen on the rail: what the hero has room to draw. */
const BOARD_LIMIT = 8;
const RAIL_LIMIT = 14;

/**
 * A slim row, camel-cased.
 *
 * The three window extras are copied only when the query that produced the row computed one, so a
 * rail row does not carry `changeWindow: undefined` — which a client would have to tell apart from
 * a market that genuinely has no change.
 */
function slim(row: SlimRowDb): SlimMarketRow {
  const out: SlimMarketRow = {
    marketAddress: row.market_address,
    tokenAddress: row.token_address,
    name: row.name,
    ticker: row.ticker,
    symbol: row.symbol,
    logoUri: row.logo_uri,
    quoteAsset: row.quote_asset,
    quoteSymbol: row.quote_symbol,
    quoteDecimals: row.quote_decimals,
    graduated: row.graduated,
    lastPrice: row.last_price,
    marketCapQuote: row.market_cap_quote,
    marketCapUsd: row.market_cap_usd,
    volume24hQuote: row.volume_24h_quote,
    volume24hUsd: row.volume_24h_usd,
    change24h: row.change_24h,
    lastTradeAt: row.last_trade_at,
  };
  if (row.change_window !== undefined) out.changeWindow = row.change_window;
  if (row.volume_window_quote !== undefined) out.volumeWindowQuote = row.volume_window_quote;
  if (row.graduated_at !== undefined) out.graduatedAt = row.graduated_at;
  return out;
}

/** A parameter the caller got wrong, which is a 400 and not a 500. */
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

/**
 * A market that exists, is still on chain, and is not served by this deployment.
 *
 * Thrown rather than returned as a row, because the two answers have nothing in common: one is a
 * market and the other is a refusal to hand one over. A flag on the payload would have meant every
 * consumer remembering to look at it, and a consumer that forgot would render a retired market as
 * tradeable — which is the single outcome this whole cut exists to prevent.
 *
 * It carries the generation because that is what makes the answer checkable by the person reading
 * it: "generation 2 was retired" can be verified against the deployment record, where "not
 * available" cannot.
 */
export class RetiredMarketError extends Error {
  constructor(
    readonly market: string,
    readonly generation: number | null,
  ) {
    super(`market ${market} belongs to retired generation ${generation ?? "unknown"}`);
    this.name = "RetiredMarketError";
  }
}

/**
 * The routing sink as the interface says it.
 *
 * Done once, here, on every market row the API returns. The database stores the `Sinks` number
 * because that is what the contracts emit and what a filter binds against; the board renders
 * "creator", "holders" or "buyback". Leaving the number on the wire would put the translation in
 * every consumer, and the day a fourth sink exists they would disagree.
 */
function nameRouting<T extends { routing_sink: number | null }>(
  row: T,
): Omit<T, "routing_sink"> & { routing: ReturnType<typeof routingName> } {
  const { routing_sink, ...rest } = row;
  return { ...rest, routing: routingName(routing_sink) };
}

/**
 * Market reads, with the rules that are not the database's business and not HTTP's either:
 * what a page size may be, what an address looks like, and where a cursor comes from.
 */
export class MarketService {
  constructor(private readonly markets: MarketRepository) {}

  async list(rawLimit?: string, cursor?: string): Promise<Page<MarketRow>> {
    const limit = clampLimit(rawLimit, DEFAULT_LIMIT, MAX_LIMIT);
    const rows = await this.markets.list(limit, cursor ?? null);
    const items: MarketRow[] = rows.map(nameRouting);
    // The cursor is the last row's key, not a page number: a feed that grows underneath the reader
    // must not shift the boundary.
    return { items, nextCursor: items.at(-1)?.market_address ?? null };
  }

  /**
   * The board's page: sorted, filtered and counted by the database.
   *
   * Validation lives here rather than in the controller because "unknown sort" and "limit over a
   * hundred" are rules about this resource, not about HTTP — and because the repository must never
   * be handed a sort key it does not have an expression for.
   */
  async listPaged(q: Record<string, string | undefined>): Promise<MarketListPage> {
    const sort = SORT_ALIASES[(q.sort ?? "marketCap").toLowerCase()];
    if (!sort) throw new BadRequestError(`unknown sort: ${q.sort}`);
    const order = q.order === "asc" ? "asc" : "desc";
    const limit = clampLimit(q.limit, PAGE_LIMIT, PAGE_MAX);
    const page = Math.max(1, Math.trunc(Number(q.page ?? 1)) || 1);
    const status = q.status === "curve" || q.status === "graduated" ? q.status : "all";
    const routing = q.routing ? routingSink(q.routing) : null;
    if (q.routing && routing === null) throw new BadRequestError(`unknown routing: ${q.routing}`);
    // A pair is either a catalogue id or an address, and the database decides which. An id that
    // matches nothing is not an error: the response's `pairCounts` says what does exist.
    const pair = !q.pair || q.pair === "all" ? null : normalizeAddress(q.pair);
    const search = q.q?.trim() || null;
    const { items, total, pairCounts } = await this.markets.listPaged({
      sort,
      order,
      limit,
      offset: (page - 1) * limit,
      pair,
      status,
      routing,
      q: search ? search.toLowerCase() : null,
    });
    const named: MarketRow[] = items.map(nameRouting);
    return { items: named, total, page, limit, pairCounts };
  }

  /**
   * The hero's four lists, over one window.
   *
   * Issued together rather than one endpoint each: they are drawn as one component and four
   * requests would give it four independent loading states over the same data.
   */
  async leaderboard(rawWindow?: string): Promise<Leaderboard> {
    const key = (rawWindow ?? "24h") as keyof typeof WINDOWS;
    if (!(key in WINDOWS)) throw new BadRequestError(`unknown window: ${rawWindow}`);
    const interval = WINDOWS[key];
    const [movers, volume, graduated, rail] = await Promise.all([
      this.markets.movers(interval, BOARD_LIMIT),
      this.markets.topVolume(interval, BOARD_LIMIT),
      this.markets.recentlyGraduated(BOARD_LIMIT),
      this.markets.rail(RAIL_LIMIT),
    ]);
    return {
      window: key,
      movers: movers.map(slim),
      volume: volume.map(slim),
      graduated: graduated.map(slim),
      rail: rail.map(slim),
    };
  }

  /**
   * The command palette.
   *
   * An empty needle answers an empty list rather than the whole table: a palette that has just been
   * opened has typed nothing, and returning every market for that is both a table scan and a wall
   * of results nobody asked for.
   */
  async search(q?: string, rawLimit?: string): Promise<{ items: SlimMarketRow[] }> {
    const needle = q?.trim().toLowerCase();
    if (!needle) return { items: [] };
    const rows = await this.markets.search(needle, clampLimit(rawLimit, BOARD_LIMIT, BOARD_LIMIT));
    return { items: rows.map(slim) };
  }

  /**
   * One market, or a refusal that says which.
   *
   * Undefined still means "no such address" and nothing else, which is what keeps the controller's
   * 404 honest. A market launched before this deployment's `START_BLOCK` gets `RetiredMarketError`
   * instead: it is on chain, it is quoting, it will sell a buyer a token whose raise anyone can
   * freeze, and the one answer it must never get is a 404 that sends the reader looking for it
   * elsewhere.
   *
   * `retired` is destructured off rather than returned, because nothing downstream should have the
   * option of serving the row.
   */
  async find(address: string): Promise<MarketDetailRow | undefined> {
    const row = await this.markets.findByAddress(normalizeAddress(address));
    if (!row) return undefined;
    const { retired, ...detail } = row;
    if (retired) throw new RetiredMarketError(detail.market_address, detail.generation);
    return nameRouting(detail);
  }

  /**
   * What an address launched, newest first.
   *
   * `truncated` is always false and stays in the shape anyway. The Next.js route this replaces
   * capped its walk at two thousand markets and had to say when it gave up; this asks the database
   * for exactly the rows that match, so there is nothing to truncate — but the field is what the
   * client reads, and dropping it would make "we did not look at everything" unrepresentable the
   * day it is true again.
   */
  async launches(address: string): Promise<{ items: LaunchRow[]; truncated: boolean }> {
    const rows = await this.markets.listByCreator(normalizeAddress(address));
    return {
      items: rows.map((r) => ({
        marketAddress: r.market_address,
        tokenAddress: r.token_address,
        symbol: r.symbol,
        name: r.name,
        ticker: r.ticker,
        logoUri: r.logo_uri,
        launchedAt: new Date(r.created_at).toISOString(),
        graduated: r.graduated,
        progress: r.progress,
        holders: r.holders,
        tradeCount: r.trade_count,
        volumeQuote: r.volume_quote,
        marketCap: r.market_cap,
        quoteAsset: r.quote_asset,
        quoteDecimals: r.quote_decimals,
        quoteSymbol: r.quote_symbol,
        routing: routingName(r.routing_sink),
        creatorTaxBps: r.creator_tax_bps,
        feesGenerated: r.fees_generated,
        pending: r.pending,
        // Named for what it DOES, not for the column it comes from: `routed_recipient` is who
        // `collectFees()` would pay, which is the field that decides whether a claim button is
        // this reader's to press.
        feeRecipient: r.routed_recipient,
        taxRecipient: r.tax_recipient,
        pendingTax: r.pending_tax,
      })),
      truncated: false,
    };
  }

  /**
   * One market's fee ledger, camel-cased for the rewards module.
   *
   * Renamed here rather than in SQL because the column names are the database's vocabulary and
   * these are the interface's; a query that aliased its way to `routedGenerated` would have to be
   * read through quotes forever, and the mapping would still exist, just hidden.
   */
  async rewards(address: string): Promise<MarketRewards | undefined> {
    const row = await this.markets.rewards(normalizeAddress(address));
    if (!row) return undefined;
    // The same 410 the market itself answers, because this is a sub-resource of it and an empty
    // ledger would read as "nothing earned yet" about a market that earned for months.
    if (row.retired) throw new RetiredMarketError(row.market_address, row.generation);
    return {
      routing: routingName(row.routing_sink),
      quoteAsset: row.quote_asset,
      quoteDecimals: row.quote_decimals,
      routedGenerated: row.routed_generated,
      routedCollected: row.routed_collected,
      pending: row.pending,
      taxGenerated: row.tax_generated,
      taxCollected: row.tax_collected,
      pendingTax: row.pending_tax,
      protocolGenerated: row.protocol_generated,
      protocolCollected: row.protocol_collected,
      dividendsFunded: row.dividends_funded,
      dividendsPaid: row.dividends_paid,
      burnedTokens: row.burned_tokens,
      totalSupply: row.total_supply,
      mintedSupply: row.minted_supply,
      updatedAt: row.updated_at,
    };
  }
}

/** How long the indexer may go without a successful pass before it is considered stale. */
export const STALE_AFTER_SECONDS = 300;

export interface HealthReport {
  status: "ok" | "stale" | "error";
  lag_seconds: number;
  last_block: string;
  error?: string;
}

/**
 * Liveness and status.
 *
 * The staleness threshold is generously above the one-second ingest loop, because a health check
 * that trips on an ordinary RPC hiccup causes more outage than it reports: the platform kills a
 * process that would have recovered on its next pass.
 */
export class StatusService {
  constructor(
    private readonly status: StatusRepository,
    /**
     * Facts about the process rather than about the data, so they are injected rather than read
     * from the database: which chain this build follows, and what the ingest loop is currently
     * doing. A restart resets the second one, which is correct — it describes this process.
     */
    private readonly context: {
      chainId?: number;
      indexer?: () => IndexerSnapshot;
    } = {},
  ) {}

  async read(): Promise<Record<string, unknown>> {
    const row = await this.status.read();
    return {
      ...(row ?? {}),
      // Named, because "behind by 4,000 blocks" means something entirely different while catching
      // up than it does while live, and a bare number cannot tell those apart.
      chain_id: this.context.chainId ?? null,
      indexer: this.context.indexer?.() ?? null,
    };
  }

  /**
   * The failure this service actually has is that the ingest loop stops while the API keeps
   * serving: every request succeeds and the data quietly ages. So health is about staleness, and
   * a database it cannot reach is reported as unhealthy rather than swallowed — that reassurance
   * is the one thing a health check exists to withhold.
   */
  async health(): Promise<{ report: HealthReport; healthy: boolean }> {
    try {
      const row = await this.status.readLag();
      const lagSeconds = Number(row?.lag_seconds ?? 0);
      const stale = lagSeconds > STALE_AFTER_SECONDS;
      return {
        report: {
          status: stale ? "stale" : "ok",
          lag_seconds: lagSeconds,
          last_block: row?.last_block ?? "0",
        },
        healthy: !stale,
      };
    } catch (err) {
      return {
        report: { status: "error", lag_seconds: 0, last_block: "0", error: String(err) },
        healthy: false,
      };
    }
  }
}
