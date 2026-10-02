import { Prisma } from "@prisma/client";

import type { Queryable } from "../db/transaction.js";
import { priceScaleSql } from "../indexer/generations.js";
import type {
  LaunchRowDb,
  MarketDetailRowDb,
  MarketRowDb,
  RewardsRow,
  SlimRowDb,
  StatusRow,
} from "../types/api.js";
import {
  CAP_COLUMNS,
  CAP_ORDER,
  LAST_SWAP_AT,
  MARKET_COLUMNS,
  STATE_COLUMNS,
  SLIM_COLUMNS,
  SLIM_FROM,
  STATS_COLUMNS,
  VOLUME_24H,
  VOLUME_24H_ORDER,
  VOLUME_ALL_ORDER,
} from "./columns.js";
import { EVERY_MARKET, notHidden, retiredFlag, servedMarkets } from "./served.js";

/** The orderings the board offers. The service maps the URL's spellings onto these. */
export type ListSort = "marketCap" | "volume24h" | "volumeAll" | "bump" | "change24h" | "progress" | "created";

export interface ListFilter {
  sort: ListSort;
  order: "asc" | "desc";
  limit: number;
  offset: number;
  /** A `quote_assets.id` or a quote address, already lowercased. Null means every pair. */
  pair: string | null;
  status: "all" | "curve" | "graduated";
  /** A `Sinks` number, not the interface's word for it. */
  routing: number | null;
  q: string | null;
}

/**
 * The ORDER BY for each sort, as a template with `%o` where the direction goes.
 *
 * A whitelist rather than caller text: this is the one fragment of these queries that cannot be a
 * bound parameter, so the only safe version is one the caller selects from and never writes.
 *
 * **Every expression here is generation-safe, and that is not an accident.** A stored price carries
 * its own market's scale — generation 1's curve returns `quote_wei * 1e18 / base_wei`, generation
 * 2's returns `quote * 1e36 / base` — so `last_price`, `swaps.price` and `market_stats.ath_quote`
 * sit a quintillion apart for two markets at the same real price. This is the first read that
 * orders both generations against each other, and ordering by any of those columns would park every
 * generation-2 market at one end of the board regardless of what it is worth.
 *
 * So the value sorts run on CAPS and VOLUMES, never on prices. `market_cap_quote` is written by the
 * rollup as `last_price * total_supply / priceScaleSql`, which is the scale coming back out;
 * volumes and `quote_raised` are quote amounts and never carried a price scale to begin with.
 *
 * Generation is not the only scale in play, though: a quote AMOUNT carries its quote asset's
 * decimals, and the three value sorts therefore delegate to `CAP_ORDER`, `VOLUME_24H_ORDER` and
 * `VOLUME_ALL_ORDER`, which put every market on one axis — dollars where the quote has a price,
 * whole units of the quote where it does not. See `columns.ts` for why that is one key with a
 * fallback rather than a USD key with a raw one behind it.
 */
const SORT_EXPR: Record<ListSort, string> = {
  marketCap: `${CAP_ORDER} %o`,
  volume24h: `${VOLUME_24H_ORDER} %o`,
  volumeAll: `${VOLUME_ALL_ORDER} %o`,
  bump: "COALESCE((SELECT MAX(ts) FROM swaps WHERE market_address = m.market_address), m.created_at) %o",
  change24h: "st.change_24h %o NULLS LAST",
  progress: "(CASE WHEN m.quote_target > 0 THEN s.quote_raised / m.quote_target ELSE 0 END) %o",
  // Launch order: the block the market was created in, then its log within that block. Not
  // `created_at`, which is the block's timestamp and ties for two launches in one block.
  created: "m.block_number %o, m.log_index %o",
};

/**
 * Where a mint comes from.
 *
 * Every token's whole supply arrives as one `Transfer` from `address(0)`, so summing those is the
 * only record of what was ever minted — `markets.total_supply` follows burns down and cannot say
 * what it started at.
 */
const MINT_FROM = "0x0000000000000000000000000000000000000000";

/**
 * A free-text query as an ILIKE pattern.
 *
 * `%` and `_` are wildcards to ILIKE; a person who types them means the characters. Unescaped, a
 * search for "%" matches every market on the site, which reads as a broken filter rather than as a
 * literal-versus-wildcard misunderstanding. The backslash is escaped by the same pass, so the
 * ESCAPE clause the queries carry cannot be turned against the pattern.
 */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Market reads.
 *
 * These stay as SQL rather than moving to Prisma's query builder, and deliberately. The list query
 * alone needs a computed market cap, an all-time high from a correlated `MAX` over a second table,
 * a rolling 24-hour window, and explicit casts on every column to pin the wire shape. Expressed
 * through the builder that becomes several round trips and a JavaScript reduction over rows the
 * database could have aggregated — slower, and no clearer.
 *
 * What the repository boundary buys is that the SQL lives in one place with a name, is reusable by
 * the indexer as well as the API, and can be handed a transaction. A controller never sees it.
 *
 * Every method takes a `Queryable`, so the same call works against the client or inside an open
 * transaction.
 */
/**
 * The most a market may be down from its all-time high and still be a "top runner": 70%. Kept as
 * the ratio the SQL compares against (`last_price >= ath_quote * RUNNER_KEEP_RATIO`).
 */
export const RUNNER_MAX_DRAWDOWN = 0.7;
const RUNNER_KEEP_RATIO = 1 - RUNNER_MAX_DRAWDOWN;

export class MarketRepository {
  constructor(private readonly db: Queryable) {}

  /** One page of markets, ordered by address so the cursor is stable under concurrent inserts. */
  async list(limit: number, cursor: string | null): Promise<MarketRowDb[]> {
    return this.db.$queryRaw<MarketRowDb[]>`
      SELECT ${MARKET_COLUMNS}, ${STATE_COLUMNS}, ${CAP_COLUMNS}, ${VOLUME_24H}, ${LAST_SWAP_AT},
             ${STATS_COLUMNS},
             -- The pool's OWN key, per market. There is more than one hook deployed now: markets
             -- that graduated before the LP-paying hook use the old one, and a client that rebuilds
             -- a PoolKey from a single configured hook address computes the wrong PoolId for half
             -- of them — which reads as "this pool has never been initialised" rather than as a
             -- mistake. Null for a market that has not graduated.
             g.pool_id AS pool_id, g.currency0 AS currency0, g.currency1 AS currency1,
             g.fee AS fee, g.tick_spacing AS tick_spacing, g.hooks AS hooks
        FROM ${servedMarkets()} m
        JOIN market_state s USING (market_address)
        LEFT JOIN graduations g USING (market_address)
        LEFT JOIN market_stats st USING (market_address)
        LEFT JOIN quote_assets qa ON qa.address = m.quote_asset
       WHERE (${cursor}::text IS NULL OR m.market_address > ${cursor})
       ORDER BY m.market_address
       LIMIT ${limit}`;
  }

  /**
   * One page of the board: sorted, filtered, searched and counted in SQL.
   *
   * All of it in the database because the alternative is what the interface did until now — fetch
   * five hundred markets and sort them in the browser, which is right only while the site is small
   * enough for the truncation not to show, and silently wrong the day it is not.
   */
  async listPaged(
    f: ListFilter,
  ): Promise<{ items: MarketRowDb[]; total: number; pairCounts: Record<string, number> }> {
    const order = Prisma.raw(SORT_EXPR[f.sort].replaceAll("%o", f.order === "asc" ? "ASC" : "DESC"));
    const rows = await this.db.$queryRaw<(MarketRowDb & { total: number })[]>`
      SELECT ${MARKET_COLUMNS}, ${STATE_COLUMNS}, ${CAP_COLUMNS}, ${VOLUME_24H}, ${LAST_SWAP_AT},
             ${STATS_COLUMNS},
             g.pool_id AS pool_id, g.currency0 AS currency0, g.currency1 AS currency1,
             g.fee AS fee, g.tick_spacing AS tick_spacing, g.hooks AS hooks,
             -- The size of the filtered set, carried on every row of the page, so drawing a pager
             -- costs no second round trip.
             COUNT(*) OVER ()::int AS total
        FROM ${servedMarkets()} m
        JOIN market_state s USING (market_address)
        LEFT JOIN graduations g USING (market_address)
        LEFT JOIN market_stats st USING (market_address)
        LEFT JOIN quote_assets qa ON qa.address = m.quote_asset
        ${this.where(f, true)}
       ORDER BY ${order}, m.market_address
       LIMIT ${f.limit} OFFSET ${f.offset}`;
    const counts = await this.db.$queryRaw<{ key: string; n: number }[]>`
      SELECT COALESCE(qa.id, m.quote_asset) AS key, COUNT(*)::int AS n
        FROM ${servedMarkets()} m
        JOIN market_state s USING (market_address)
        LEFT JOIN quote_assets qa ON qa.address = m.quote_asset
        ${this.where(f, false)}
       GROUP BY 1`;
    const pairCounts: Record<string, number> = {};
    for (const c of counts) pairCounts[c.key] = c.n;
    // The window function returns nothing at all for a page past the end, and "no rows" is not the
    // same answer as "no markets" — a pager that read it that way would erase itself on the last
    // page plus one.
    const total = rows[0]?.total ?? (await this.countOnly(f));
    return { items: rows.map(({ total: _t, ...r }) => r as MarketRowDb), total, pairCounts };
  }

  /**
   * Everything the two queries above filter on.
   *
   * @param withPair false for the `pairCounts` query, which counts over the searched set MINUS the
   *        pair predicate: the chips have to say what else the current search would find, and a
   *        count that respected the pair filter would read 0 for every chip but the selected one.
   *
   * Every value is a bound parameter with an explicit cast, including the ones that only decide
   * whether a predicate applies at all. A `Prisma.raw` here would be an injection shape even where
   * the value happens to be safe today.
   */
  private where(
    f: Omit<ListFilter, "sort" | "order" | "limit" | "offset">,
    withPair: boolean,
  ): Prisma.Sql {
    const pair = withPair ? f.pair : null;
    const pattern = f.q ? likePattern(f.q) : null;
    // An address search is a prefix match, not a substring one: someone pasting an address wants
    // the market it names, and `%0x…%` across two address columns is a scan that answers the same
    // question more slowly.
    const prefix = f.q && f.q.startsWith("0x") ? `${f.q}%` : null;
    return Prisma.sql`
      WHERE (${pair}::text IS NULL OR m.quote_asset = ${pair}::text OR qa.id = ${pair}::text)
        AND (${f.status}::text = 'all'
             OR (${f.status}::text = 'graduated' AND s.pool_address IS NOT NULL)
             OR (${f.status}::text = 'curve' AND s.pool_address IS NULL))
        AND (${f.routing}::int IS NULL OR m.routing = ${f.routing}::int)
        AND (${pattern}::text IS NULL
             OR m.name ILIKE ${pattern}::text ESCAPE '\\'
             OR m.ticker ILIKE ${pattern}::text ESCAPE '\\'
             OR m.symbol ILIKE ${pattern}::text ESCAPE '\\'
             OR (${prefix}::text IS NOT NULL
                 AND (m.market_address LIKE ${prefix}::text OR m.token_address LIKE ${prefix}::text)))`;
  }

  /** The count on its own, for a page past the end where the window function returns no rows. */
  private async countOnly(f: ListFilter): Promise<number> {
    const rows = await this.db.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
        FROM ${servedMarkets()} m
        JOIN market_state s USING (market_address)
        LEFT JOIN quote_assets qa ON qa.address = m.quote_asset
        ${this.where(f, true)}`;
    return rows[0]?.n ?? 0;
  }

  /**
   * One market by address — the RETIRED ones included, carrying `retired` to say so.
   *
   * The only read in this class that sees past the cut, and the reason is that a lookup is the one
   * surface where silence is a lie. A retired market is not absent: it exists, it holds somebody's
   * raise, and it will still sell a buyer a token that can be frozen under them. A 404 says "no
   * such market", which sends the reader to look for it somewhere that will happily serve one.
   *
   * The service turns the flag into 410 Gone rather than suppressing the row here, because only it
   * knows how to say the sentence; `generation` travels with the row so the answer can name what it
   * was. Nothing else about a retired market is published — the flag is stripped before the row
   * reaches the wire.
   *
   * Answers to EITHER address a market has: the curve's (the row's key, what every internal
   * reference carries) or the token's (what a wallet, a scanner and every `/market/<token>` link
   * carry — "CA" means the token everywhere else on the internet). Both are stored lowercase
   * and the caller lowercases the lookup, so no case-folding happens in SQL.
   */
  async findByAddress(
    address: string,
  ): Promise<(MarketDetailRowDb & { retired: boolean }) | undefined> {
    const rows = await this.db.$queryRaw<(MarketDetailRowDb & { retired: boolean })[]>`
      SELECT ${MARKET_COLUMNS}, ${STATE_COLUMNS}, ${CAP_COLUMNS}, ${VOLUME_24H}, ${LAST_SWAP_AT},
             ${STATS_COLUMNS},
             g.pool_address AS graduated_pool, g.pool_id AS pool_id,
             g.currency0 AS currency0, g.currency1 AS currency1,
             g.fee AS fee, g.tick_spacing AS tick_spacing, g.hooks AS hooks,
             g.liquidity::text AS liquidity,
             ${retiredFlag("m")}
        FROM ${EVERY_MARKET} m
        JOIN market_state s USING (market_address)
        LEFT JOIN graduations g USING (market_address)
        LEFT JOIN market_stats st USING (market_address)
        LEFT JOIN quote_assets qa ON qa.address = m.quote_asset
       WHERE (m.market_address = ${address} OR m.token_address = ${address}) AND ${notHidden("m")}`;
    return rows[0];
  }

  /**
   * Everything the rewards module reports about one market, from the ledger rather than the chain.
   *
   * `pending` and `pendingTax` are derived here rather than stored, because "generated minus
   * collected" is only true while both sides are written by the same events; a stored balance would
   * drift the first time one of them was missed.
   *
   * Returns a row for ANY market that exists, generation 1 included — those have no ledger at all
   * and read as zeros, which is the honest answer. Undefined means the market does not exist, and
   * only that, so the controller's 404 says what it means.
   *
   * A RETIRED market comes back too, flagged, for the same reason `findByAddress` does: this is a
   * sub-resource of one market rather than a list, so the truthful answer is the one the service
   * builds from the flag — 410 with the generation named — and not an empty ledger that reads as
   * "this market has earned nothing yet".
   */
  async rewards(
    address: string,
  ): Promise<(RewardsRow & { retired: boolean; generation: number }) | undefined> {
    const rows = await this.db.$queryRaw<
      (RewardsRow & { retired: boolean; generation: number })[]
    >`
      SELECT m.market_address, m.routing::int AS routing_sink, m.quote_asset,
             m.generation::int AS generation,
             m.quote_decimals::int AS quote_decimals,
             COALESCE(r.routed_generated, 0)::text AS routed_generated,
             COALESCE(r.routed_collected, 0)::text AS routed_collected,
             -- R10: a BURN market's routed share is spent on the curve and burned as it accrues,
             -- and BondingCurve.pendingFees() is always 0 there. Subtracting a routed_collected
             -- that is never written would report a forever-growing uncollectable balance.
             -- A REWARDS market's share is pending until it is FUNDED into the vault: the
             -- pool-side sweep funds the vault without a FeesCollected on the curve, so
             -- routed_collected under-counts and printed money as pending that the vault held.
             CASE WHEN m.routing = 0 THEN '0'
                  WHEN m.routing = 1 THEN GREATEST(COALESCE(r.routed_generated, 0) - COALESCE(r.dividends_funded, 0), 0)::text
                  ELSE (COALESCE(r.routed_generated, 0) - COALESCE(r.routed_collected, 0))::text
             END AS pending,
             COALESCE(r.tax_generated, 0)::text AS tax_generated,
             COALESCE(r.tax_collected, 0)::text AS tax_collected,
             -- The creator tax is charged and owed whatever the routing, so it has no such case.
             (COALESCE(r.tax_generated, 0) - COALESCE(r.tax_collected, 0))::text AS pending_tax,
             COALESCE(r.protocol_generated, 0)::text AS protocol_generated,
             COALESCE(r.protocol_collected, 0)::text AS protocol_collected,
             COALESCE(r.dividends_funded, 0)::text AS dividends_funded,
             COALESCE(r.dividends_paid, 0)::text AS dividends_paid,
             -- Two ways of counting the same thing, and the larger wins. The ledger only sees burns
             -- a sink announced; the supply drop sees every burn there has ever been, including a
             -- generation-1 market's, where there is no ledger at all.
             GREATEST(COALESCE(r.burned_tokens, 0), GREATEST(minted.total - m.total_supply, 0))::text
               AS burned_tokens,
             minted.total::text AS minted_supply, m.total_supply::text AS total_supply,
             r.updated_at, ${retiredFlag("m")}
        FROM ${EVERY_MARKET} m
        LEFT JOIN market_rewards r USING (market_address)
        CROSS JOIN LATERAL (
          SELECT COALESCE(SUM(value), 0)::numeric(78,0) AS total FROM transfers
           WHERE token_address = m.token_address AND from_address = ${MINT_FROM}
        ) minted
       WHERE m.market_address = ${address} AND ${notHidden("m")}`;
    return rows[0];
  }

  /**
   * What one address launched, newest first, with its fee figures read from the ledger.
   *
   * This replaces a walk: the Next.js route it answers for pages through five hundred markets at a
   * time looking for the two a creator owns, and reports `truncated` when it gives up. A `WHERE
   * creator = …` costs one index lookup and cannot be truncated.
   *
   * `fees_generated` is `market_rewards.routed_generated` — what the fee events actually recorded —
   * and not `volume × 1%`, which is what the wallet tab computed. The guess is right only while
   * every market charges the same rate and none of the take is a creator tax.
   */
  async listByCreator(creator: string): Promise<LaunchRowDb[]> {
    return this.db.$queryRaw<LaunchRowDb[]>`
      SELECT m.market_address, m.token_address, m.symbol, m.name, m.ticker, m.logo_uri, m.created_at,
             (s.pool_address IS NOT NULL) AS graduated,
             CASE WHEN m.quote_target > 0
                  THEN LEAST(s.quote_raised / m.quote_target, 1)::float8
                  ELSE 0 END AS progress,
             s.holders::int AS holders, s.trade_count::int AS trade_count,
             s.volume_quote::text AS volume_quote,
             -- The rollup's cap where there is one, and the same arithmetic CAP_COLUMNS does where
             -- there is not -- INCLUDING priceScaleSql. A flat 1e18 divisor here would report every
             -- generation-2 market as a quintillion times more valuable than it is, on the one
             -- screen its creator looks at.
             COALESCE(
               st.market_cap_quote,
               ((s.last_price * m.total_supply) / ${Prisma.raw(priceScaleSql("m"))})::numeric(78,0)
             )::text AS market_cap,
             m.quote_asset, m.quote_decimals::int AS quote_decimals, qa.symbol AS quote_symbol,
             m.routing::int AS routing_sink, m.creator_tax_bps::int AS creator_tax_bps,
             m.routed_recipient, m.tax_recipient,
             COALESCE(r.routed_generated, 0)::text AS fees_generated,
             -- R10: a BURN market's routed share is spent on the curve and burned as it accrues,
             -- and BondingCurve.pendingFees() is always 0 there. Subtracting a routed_collected
             -- that is never written would report a forever-growing uncollectable balance.
             -- A REWARDS market's share is pending until it is FUNDED into the vault: the
             -- pool-side sweep funds the vault without a FeesCollected on the curve, so
             -- routed_collected under-counts and printed money as pending that the vault held.
             CASE WHEN m.routing = 0 THEN '0'
                  WHEN m.routing = 1 THEN GREATEST(COALESCE(r.routed_generated, 0) - COALESCE(r.dividends_funded, 0), 0)::text
                  ELSE (COALESCE(r.routed_generated, 0) - COALESCE(r.routed_collected, 0))::text
             END AS pending,
             -- The creator tax is charged and owed whatever the routing, so it has no such case.
             (COALESCE(r.tax_generated, 0) - COALESCE(r.tax_collected, 0))::text AS pending_tax
        FROM ${servedMarkets()} m
        JOIN market_state s USING (market_address)
        LEFT JOIN market_stats st USING (market_address)
        LEFT JOIN market_rewards r USING (market_address)
        LEFT JOIN quote_assets qa ON qa.address = m.quote_asset
       WHERE m.creator = ${creator}
       ORDER BY m.created_at DESC, m.market_address`;
  }

  /**
   * The biggest movers over a window.
   *
   * The change is computed against the newest swap at or BEFORE the window's start, not against the
   * oldest swap inside it — those are different numbers on a market that has not traded for a
   * while, and only the first one means "what has this done over the last hour". A market with no
   * such swap is excluded rather than shown at 0%: it has no reference price, which is not the same
   * statement as "it has not moved", and a launch minutes old would otherwise pad the list.
   *
   * Both prices are the SAME market's, so the ratio carries no generation scale and needs no
   * normalising. That is the only reason a price appears in a comparison anywhere in this file.
   *
   * @param interval a Postgres interval literal. It is spliced into the SQL and can therefore only
   *        come from the service's whitelist — never from a request.
   */
  async movers(interval: string, limit: number): Promise<SlimRowDb[]> {
    const iv = Prisma.raw(`INTERVAL '${interval}'`);
    return this.db.$queryRaw<SlimRowDb[]>`
      SELECT ${SLIM_COLUMNS}, ((s.last_price - p.price) / p.price * 100)::float8 AS change_window
      ${SLIM_FROM()}
      JOIN LATERAL (
        SELECT price FROM swaps
         WHERE market_address = m.market_address AND ts <= NOW() - ${iv}
         ORDER BY ts DESC, block_number DESC, log_index DESC LIMIT 1
      ) p ON p.price > 0
      ORDER BY change_window DESC NULLS LAST, m.market_address
      LIMIT ${limit}`;
  }

  /**
   * The most traded over a window.
   *
   * Ranked in dollars where the quote asset has a price and in WHOLE UNITS of the quote where it
   * does not — the same one-key-with-a-fallback the board's sorts use, and for the same reason:
   * comparing raw amounts across quote assets is comparing 1e-18ths of a MON against 1e-6ths of a
   * dollar. The raw sum is the tiebreak and is also what the row reports, because that is the
   * figure the market actually traded.
   *
   * A market that has fallen more than `RUNNER_MAX_DRAWDOWN` from its all-time high is left out.
   * The board this feeds is the front page's "top runners", and a coin that was bid to a peak and
   * dumped still trades heavily on the way down — volume alone would keep listing it as a runner
   * for a day. Both prices are the SAME market's (`st.ath_quote` and `s.last_price` share its
   * generation scale), so the ratio needs no normalising; a market with no ATH on record yet is
   * kept, because there is nothing to be down from.
   */
  async topVolume(interval: string, limit: number): Promise<SlimRowDb[]> {
    const iv = Prisma.raw(`INTERVAL '${interval}'`);
    return this.db.$queryRaw<SlimRowDb[]>`
      SELECT ${SLIM_COLUMNS}, w.volume::text AS volume_window_quote
      ${SLIM_FROM()}
      JOIN LATERAL (
        SELECT SUM(quote_amount) AS volume FROM swaps
         WHERE market_address = m.market_address AND ts >= NOW() - ${iv}
      ) w ON w.volume > 0
      WHERE COALESCE(st.ath_quote, 0) = 0
         OR s.last_price >= st.ath_quote * ${RUNNER_KEEP_RATIO}
      ORDER BY (w.volume / POWER(10::numeric, m.quote_decimals::numeric))
                 * COALESCE(qa.usd_price, 1) DESC,
               w.volume DESC, m.market_address
      LIMIT ${limit}`;
  }

  /** The last graduations, newest first. */
  async recentlyGraduated(limit: number): Promise<SlimRowDb[]> {
    return this.db.$queryRaw<SlimRowDb[]>`
      SELECT ${SLIM_COLUMNS}, g.ts AS graduated_at
      ${SLIM_FROM()}
      JOIN graduations g USING (market_address)
      ORDER BY g.ts DESC, g.log_index DESC
      LIMIT ${limit}`;
  }

  /** The biggest markets, for the hero rail. Same value ordering as the board's default sort. */
  async rail(limit: number): Promise<SlimRowDb[]> {
    return this.db.$queryRaw<SlimRowDb[]>`
      SELECT ${SLIM_COLUMNS}
      ${SLIM_FROM()}
      ORDER BY ${Prisma.raw(CAP_ORDER)} DESC, m.market_address
      LIMIT ${limit}`;
  }

  /**
   * The command palette's search: the SAME predicate the board's `?q=` uses, so a query that finds
   * a market in one finds it in the other. Ordered by cap, because when a needle matches several
   * markets the one worth the most is almost always the one meant.
   */
  async search(q: string, limit: number): Promise<SlimRowDb[]> {
    const pattern = likePattern(q);
    // An address is a PREFIX match, not a substring one: someone pasting an address wants the
    // market it names.
    const prefix = q.startsWith("0x") ? `${q}%` : null;
    return this.db.$queryRaw<SlimRowDb[]>`
      SELECT ${SLIM_COLUMNS}
      ${SLIM_FROM()}
      WHERE m.name ILIKE ${pattern}::text ESCAPE '\\'
         OR m.ticker ILIKE ${pattern}::text ESCAPE '\\'
         OR m.symbol ILIKE ${pattern}::text ESCAPE '\\'
         OR (${prefix}::text IS NOT NULL
             AND (m.market_address LIKE ${prefix}::text OR m.token_address LIKE ${prefix}::text))
      ORDER BY ${Prisma.raw(CAP_ORDER)} DESC, m.market_address
      LIMIT ${limit}`;
  }

  /**
   * The token addresses and pool addresses the ingester filters logs by.
   *
   * `Transfer` and V3's `Swap` share their signatures with every token and every pool on the
   * chain, so those queries are narrowed by address instead of by topic.
   *
   * Retired markets stay in this filter, and that is what keeps the cutover reversible: the cut is
   * a read cut, so flipping `START_BLOCK` back has to serve a CURRENT picture rather than one that
   * stopped moving on the day of the repointing. An ingester narrowed to the live generation would
   * leave a hole nothing but a full re-scan could fill — and a re-scan is the expensive, risky
   * operation this whole approach exists to avoid. Indexing rows nobody serves costs filter width.
   */
  async knownAddresses(): Promise<{ tokens: string[]; pools: string[] }> {
    const [tokens, pools] = await Promise.all([
      this.db.$queryRaw<{ token_address: string }[]>`SELECT token_address FROM ${EVERY_MARKET}`,
      this.db.$queryRaw<{ pool_address: string }[]>`SELECT pool_address FROM graduations`,
    ]);
    return {
      tokens: tokens.map((r) => r.token_address),
      pools: pools.map((r) => r.pool_address),
    };
  }
}

/**
 * The indexer's own position, and how far behind it is.
 *
 * Lag is stored and reported rather than inferred. A dashboard that only shows "last block 1234"
 * cannot tell a healthy indexer from one that stopped an hour ago, and staleness is the failure
 * this service actually has.
 */
export class StatusRepository {
  constructor(private readonly db: Queryable) {}

  async read(): Promise<StatusRow | undefined> {
    const rows = await this.db.$queryRaw<StatusRow[]>`
      SELECT last_block::text AS last_block, chain_head::text AS chain_head, updated_at,
             GREATEST(chain_head - last_block, 0)::int AS lag_blocks,
             FLOOR(EXTRACT(EPOCH FROM (NOW() - updated_at)))::int AS lag_seconds,
             -- COUNT is BIGINT. Without the cast these arrive as a bigint that JSON.stringify
             -- refuses; neither count comes near overflowing an int.
             --
             -- Both counts are of the SERVED generation, because this is the figure a dashboard
             -- compares against the board: a count that read the retired markets back in would
             -- disagree with every list on the site, which looks like the API dropping rows rather
             -- than like the one thing it is deliberately doing.
             (SELECT COUNT(*) FROM ${servedMarkets()} m)::int AS markets,
             (SELECT COUNT(*) FROM swaps sw
               JOIN ${servedMarkets()} m USING (market_address))::int AS swaps,
             -- Quote assets a launch can be made against that the price refresher could not price.
             -- Every market quoted in one of them is ordered on whole quote units instead of on
             -- dollars, which ranks but does not value — so the gap is reported rather than
             -- absorbed. A board that silently reorders is worse than one that says a number is
             -- missing.
             (SELECT COUNT(*) FROM quote_assets
               WHERE registered AND enabled AND usd_price IS NULL)::int AS unpriced_quotes
        FROM indexer_status WHERE id = 1`;
    return rows[0];
  }

  /** Just the staleness figures, for the probes. Cheaper than the full status read. */
  async readLag(): Promise<{ lag_seconds: number; last_block: string } | undefined> {
    const rows = await this.db.$queryRaw<{ lag_seconds: number; last_block: string }[]>`
      SELECT FLOOR(EXTRACT(EPOCH FROM (NOW() - updated_at)))::int AS lag_seconds,
             last_block::text AS last_block
        FROM indexer_status WHERE id = 1`;
    return rows[0];
  }

  /** The checkpoint the ingester resumes from. */
  async readCheckpoint(): Promise<{ lastBlock: bigint; lastBlockHash: string | null }> {
    const rows = await this.db.$queryRaw<{ last_block: string; last_block_hash: string | null }[]>`
      SELECT last_block::text AS last_block, last_block_hash
        FROM indexer_status WHERE id = 1`;
    const row = rows[0];
    return {
      lastBlock: BigInt(row?.last_block ?? "0"),
      lastBlockHash: row?.last_block_hash ?? null,
    };
  }

  async writeCheckpoint(lastBlock: bigint, lastBlockHash: string, chainHead: bigint): Promise<void> {
    // Bound as parameters, not interpolated. `Prisma.raw` on a value is an injection shape even
    // when the value happens to be a bigint, and it invites the next person to do it with a string.
    await this.db.$executeRaw`
      UPDATE indexer_status
         SET last_block = ${lastBlock},
             last_block_hash = ${lastBlockHash},
             chain_head = ${chainHead},
             updated_at = NOW()
       WHERE id = 1`;
  }
}
