import { Prisma } from "@prisma/client";
import { priceScaleSql } from "../indexer/generations.js";
import { servedMarkets } from "./served.js";

/**
 * The column lists the read API selects, and the casts that pin their shape on the wire.
 *
 * **Every `NUMERIC` is cast to `text` and every `BIGINT` either to `text` or to `int`.** This is
 * not decoration, and it is the single most important rule in this layer.
 *
 * Prisma returns an uncast `NUMERIC` as a `Decimal` and an uncast `BIGINT` as a `bigint`. A
 * `Decimal` serialises to JSON in exponential form for anything above 1e21 — which is every token
 * amount on this chain — and `JSON.stringify` does not serialise a `bigint` at all, it *throws*.
 * The client parses these with `BigInt(...)`, which accepts neither. So an uncast column here is
 * either a number that arrives wrong or a response that never arrives.
 *
 * Casting in SQL rather than converting in JavaScript keeps one rule in one place: whatever comes
 * out of a repository is already the shape the client reads.
 *
 * `SELECT *` is avoided for a related reason — it publishes whatever the table happens to hold, so
 * a column added for internal bookkeeping becomes part of the public response by accident.
 */

/**
 * The swap columns the client reads.
 *
 * @param alias the table alias to qualify with, so the per-market and per-account feeds share one
 *        list rather than two copies that drift.
 *
 * The `ORDER BY` clauses that use these qualify `id` with the table on purpose. Postgres resolves
 * an unqualified `ORDER BY id` against the *output* column, which here is the `text` cast — so
 * ordering silently became lexicographic and page two of a trade feed started at row 9, then 8,
 * then 10.
 */
export const swapColumns = (alias: string): Prisma.Sql =>
  Prisma.raw(`
  ${alias}.id::text AS id, ${alias}.market_address, ${alias}.trader, ${alias}.is_buy, ${alias}.venue,
  ${alias}.quote_amount::text AS quote_amount, ${alias}.base_amount::text AS base_amount,
  ${alias}.fee::text AS fee, ${alias}.tax::text AS tax,
  ${alias}.quote_raised::text AS quote_raised, ${alias}.price::text AS price,
  ${alias}.block_number::text AS block_number, ${alias}.block_hash, ${alias}.log_index,
  ${alias}.tx_hash, ${alias}.ts
`);

/** Candlesticks. Volume stays a string: it does not fit a JavaScript number. */
export const CANDLESTICK_COLUMNS = Prisma.raw(`
  market_address, period_secs::int AS period_secs, bucket_start,
  open::text AS open, high::text AS high, low::text AS low, close::text AS close,
  volume_quote::text AS volume_quote, trade_count::int AS trade_count
`);

/** Market state, as the market card and the header read it. */
export const STATE_COLUMNS = Prisma.raw(`
  s.quote_raised::text AS quote_raised, s.last_price::text AS last_price,
  s.volume_quote::text AS volume_quote,
  s.trade_count::int AS trade_count, s.holders::int AS holders,
  s.ready_to_graduate, s.pool_address
`);

/**
 * Market cap now, and at the best price the market ever traded at.
 *
 * Both derived from the trades, never stored. Price is fixed point and supply is in base units, so
 * the product carries the price's scale and that has to come back out — miss it and every cap on
 * the site is a billion billion times too large, which is the kind of wrong that renders perfectly.
 *
 * WHICH scale depends on the generation, which is why the divisor is `priceScaleSql` rather than a
 * literal: generation 2's curve emits `quote * 1e36 / base`, an extra 1e18 over generation 1, so a
 * flat `/ 1e18` here made every generation-2 cap a quintillion times too large.
 *
 * The `numeric(78,0)` cast wraps the *whole* expression on both lines, and has to. Dividing by
 * 1e18 leaves a numeric with a fractional scale, so casting only the input renders the result as
 * "0.000000000000000000000000000000000000" — a decimal string, which `BigInt` refuses outright.
 * One market with no trades was enough to throw while parsing the market list and blank a grid
 * that had eleven perfectly good markets to show.
 *
 * The high is over both venues: a market that peaked on its pool after graduating has its all-time
 * high there, not on the curve it left.
 */
export const CAP_COLUMNS = Prisma.raw(`
  ((s.last_price * m.total_supply) / ${priceScaleSql("m")})::numeric(78,0)::text AS market_cap,
  ((COALESCE((
    SELECT MAX(price) FROM swaps WHERE market_address = m.market_address
  ), 0) * m.total_supply) / ${priceScaleSql("m")})::numeric(78,0)::text AS ath_market_cap
`);

/**
 * Rolling 24-hour volume, computed on read.
 *
 * Never stored: a stored rolling total has to decay as trades age out of the window, and nothing
 * fires when time merely passes. A stalled sweeper would leave a figure that silently overstates
 * volume forever.
 */
export const VOLUME_24H = Prisma.raw(`
  COALESCE((
    SELECT SUM(quote_amount) FROM swaps
     WHERE market_address = m.market_address
       AND ts >= NOW() - INTERVAL '24 hours'
  ), 0)::text AS volume_24h
`);

/**
 * When this market last traded.
 *
 * Bump order means "most recently traded", and without this column it could only ever mean "most
 * recently launched" — so a market that had just taken a buy stayed exactly where it was and the
 * sort looked broken to anyone watching a trade land.
 *
 * Computed on read like the other two, and for the same reason: a stored value would need writing
 * on every swap and would drift the moment one write was missed. NULL for a market with no trades,
 * which the client falls back on the launch time for.
 */
export const LAST_SWAP_AT = Prisma.raw(`
  (SELECT MAX(ts) FROM swaps WHERE market_address = m.market_address) AS last_swap_at
`);

/**
 * The market identity columns, shared by the list and the detail read.
 *
 * `routing` comes out as the raw `Sinks` NUMBER under the name `routing_sink`, and the service
 * names it (`buyback`/`holders`/`creator`). The number is what the database stores and what a
 * filter binds against; the word is what the interface reads, and one translation in one place
 * beats the same switch written twice.
 *
 * The `qa.*` columns require `LEFT JOIN quote_assets qa ON qa.address = m.quote_asset` on every
 * query that selects this list. LEFT, not INNER: a market may be quoted in an asset the catalogue
 * has never heard of, and dropping it from the board would be a far worse answer than showing it
 * with no symbol.
 */
export const MARKET_COLUMNS = Prisma.raw(`
  m.market_address, m.token_address, m.symbol, m.name, m.symbol_key, m.creator,
  m.quote_target::text AS quote_target, m.total_supply::text AS total_supply,
  m.block_number::text AS block_number, m.tx_hash, m.created_at,
  m.generation::int AS generation, m.quote_asset, m.quote_decimals::int AS quote_decimals,
  qa.symbol AS quote_symbol, qa.id AS quote_id,
  m.routing::int AS routing_sink, m.routed_recipient, m.creator_tax_bps::int AS creator_tax_bps,
  m.tax_recipient, m.ticker, m.logo_uri, m.banner_uri, m.description, m.website, m.x, m.telegram,
  m.metadata_hash
`);

/**
 * The fifteen-second rollup, as the board reads it.
 *
 * Requires `LEFT JOIN market_stats st USING (market_address)`; a market the rollup has not reached
 * yet reads as zeros rather than nulls, because a null renders as an em-dash where a real zero is
 * the answer. `change_24h` is the exception and stays nullable on purpose: NULL means "no trade old
 * enough to compare against", which is not the same statement as "flat".
 *
 * `ath_quote` is a PRICE, at its own market's generation scale — the same scale as `last_price`,
 * `swaps.price` and the candles, which the row's `generation` column declares. It is therefore not
 * comparable between two markets of different generations and nothing here orders by it. The
 * comparable all-time high is `ath_market_cap` in `CAP_COLUMNS`, which divides the scale back out.
 */
export const STATS_COLUMNS = Prisma.raw(`
  COALESCE(st.market_cap_quote, 0)::text AS market_cap_quote,
  st.market_cap_usd::text AS market_cap_usd,
  COALESCE(st.volume_24h_quote, 0)::text AS volume_24h_quote,
  st.volume_24h_usd::text AS volume_24h_usd,
  st.change_24h::float8 AS change_24h,
  COALESCE(st.trades_24h, 0)::int AS trades_24h,
  st.last_trade_at,
  COALESCE(st.ath_quote, 0)::text AS ath_quote,
  st.ath_at
`);

/**
 * The value orderings the board sorts on, in figures two markets in DIFFERENT quote assets can be
 * ranked against each other.
 *
 * A cap or a volume is stored in RAW units of its own quote asset, and quote assets do not agree on
 * a decimals count: 1e18 raw units is one MON and a trillion dollars of USDC. Ordering the raw
 * columns against each other therefore put a one-MON market above a million-dollar USDC one — an
 * error of exactly twelve orders of magnitude, exact inside a single `?pair=` and meaningless
 * across the default mixed board.
 *
 * And the USD leg cannot be `COALESCE(usd, 0)`. A quote asset with no price yet is a gap in the
 * data, not a market worth nothing, and reading it as zero sent a gold-quoted market holding
 * roughly $10M below a $2,000 one. So each of these is ONE key with a fallback rather than two
 * keys: the USD figure where the quote has a price, the same figure in WHOLE UNITS of the quote
 * where it does not, and 0 only for a market the fifteen-second rollup has never reached — without
 * that last leg a market with no `market_stats` row sorts NULL, which `DESC` puts FIRST.
 *
 * Whole units are not dollars: one MON still does not equal one USDC, and only a price says
 * otherwise. That residual is the ratio of two assets rather than a power of ten, and it is why
 * `refreshUsdPrices` warns about an enabled quote asset it could not price and `/status` counts
 * them — a board that silently reorders is worse than one that admits a number is missing.
 *
 * Strings rather than `Prisma.Sql` because each is spliced into an `ORDER BY` template that picks
 * its own direction; the caller wraps the finished clause in `Prisma.raw` once. Nothing here is
 * caller text.
 */
const wholeUnits = (raw: string): string =>
  `(${raw} / POWER(10::numeric, m.quote_decimals::numeric))`;

/** Market cap. Requires the `m` and `st` aliases. */
export const CAP_ORDER = `COALESCE(st.market_cap_usd, ${wholeUnits("st.market_cap_quote")}, 0)`;

/** Rolling 24-hour volume, same treatment. Requires `m` and `st`. */
export const VOLUME_24H_ORDER = `COALESCE(st.volume_24h_usd, ${wholeUnits("st.volume_24h_quote")}, 0)`;

/**
 * Lifetime volume. No USD leg exists for it and none is invented: nothing stores one, and scaling a
 * lifetime total by today's price would value every historical trade at today's rate. Whole quote
 * units throughout, so it stays coherent with the cap ordering above. Requires `m` and `s`.
 */
export const VOLUME_ALL_ORDER = `COALESCE(${wholeUnits("s.volume_quote")}, 0)`;


/**
 * The slim row the leaderboard and the command palette draw: enough for a card, nothing else.
 *
 * A separate list rather than `MARKET_COLUMNS` because these two reads return up to thirty-eight
 * rows between them on every page load, and the full row carries a description, four social links,
 * a metadata hash and a PoolKey that no card renders. Sending them would be sending the market
 * detail page's payload thirty-eight times to draw a ticker tape.
 *
 * `last_price` is here and is NOT comparable between markets — it is at its own market's generation
 * scale, like every other price on this service. It is rendered next to that market's own name and
 * nothing sorts by it; the sorts run on the caps.
 *
 * Requires the aliases `SLIM_FROM` establishes.
 */
export const SLIM_COLUMNS = Prisma.raw(`
  m.market_address, m.token_address, m.name, m.ticker, m.symbol, m.logo_uri, m.quote_asset,
  qa.symbol AS quote_symbol, m.quote_decimals::int AS quote_decimals,
  (s.pool_address IS NOT NULL) AS graduated, s.last_price::text AS last_price,
  COALESCE(st.market_cap_quote, 0)::text AS market_cap_quote,
  st.market_cap_usd::text AS market_cap_usd,
  COALESCE(st.volume_24h_quote, 0)::text AS volume_24h_quote,
  st.volume_24h_usd::text AS volume_24h_usd,
  st.change_24h::float8 AS change_24h, st.last_trade_at
`);

/**
 * The joins `SLIM_COLUMNS` needs, in one fragment so the five queries that select it cannot drift
 * apart on which joins are LEFT.
 *
 * `market_stats` and `quote_assets` are LEFT: a market the fifteen-second rollup has not reached
 * yet, or one quoted in an asset the catalogue has never heard of, still belongs on the board.
 * Dropping either would be a worse answer than a missing symbol.
 *
 * It is also where the retired generations leave the leaderboard and the command palette, in one
 * place for all five of those reads rather than five predicates that have to agree — `movers` and
 * `topVolume` each carry a LATERAL and `recentlyGraduated` has no WHERE clause at all, so a shared
 * predicate would have had to be threaded through three different query shapes. A function call
 * rather than a constant because the cut is read per query; see `served.ts`.
 */
export const SLIM_FROM = (): Prisma.Sql => Prisma.sql`
  FROM ${servedMarkets()} m
  JOIN market_state s USING (market_address)
  LEFT JOIN market_stats st USING (market_address)
  LEFT JOIN quote_assets qa ON qa.address = m.quote_asset
`;
