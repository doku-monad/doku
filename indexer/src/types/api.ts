/**
 * The shapes this service puts on the wire.
 *
 * Every amount is a `string`, never a number: these are 18-decimal fixed-point values that exceed
 * what a float64 holds exactly, and the client parses them with `BigInt`. Counts are numbers
 * because they are small by construction. See `repositories/columns.ts` for how that is enforced.
 */

import type { RoutingName } from "../indexer/generations.js";

export type { RoutingName };

export interface MarketRow {
  market_address: string;
  token_address: string;
  symbol: string;
  name: string;
  symbol_key: string;
  creator: string;
  quote_target: string;
  total_supply: string;
  block_number: string;
  tx_hash: string;
  created_at: Date;
  quote_raised: string;
  last_price: string;
  volume_quote: string;
  trade_count: number;
  holders: number;
  ready_to_graduate: boolean;
  pool_address: string | null;
  market_cap: string;
  ath_market_cap: string;
  volume_24h: string;
  /** When this market last traded, or null if it never has. Bump order sorts on it. */
  last_swap_at: Date | string | null;
  /**
   * The graduated pool's own key. Null while bonding.
   *
   * Carried per market rather than assumed from configuration because more than one hook is
   * deployed: markets graduated before the LP-paying hook use the old one.
   */
  pool_id?: string | null;
  currency0?: string | null;
  currency1?: string | null;
  fee?: number | null;
  tick_spacing?: number | null;
  hooks?: string | null;

  // ------------------------------------------------------------------ generation 2 (pairs)
  /** 1 = the emoji launchpad, 2 = the pairs launchpad. Also says which scale the prices carry. */
  generation: number;
  /** The asset this market is priced in. `address(0)` is native MON, which is every gen-1 market. */
  quote_asset: string;
  quote_decimals: number;
  /** From the quote catalogue, null for a quote the catalogue has never heard of. */
  quote_symbol: string | null;
  quote_id: string | null;
  /** Where the routed fee share goes, in the interface's words. Null until it is known. */
  routing: RoutingName | null;
  routed_recipient: string | null;
  creator_tax_bps: number;
  tax_recipient: string | null;
  ticker: string | null;
  logo_uri: string | null;
  banner_uri: string | null;
  description: string | null;
  website: string | null;
  x: string | null;
  telegram: string | null;
  metadata_hash: string | null;

  // ------------------------------------------------------------- the fifteen-second rollup
  market_cap_quote: string;
  /** Null while the quote asset has no USD price; never 0, which would mean "worth nothing". */
  market_cap_usd: string | null;
  volume_24h_quote: string;
  volume_24h_usd: string | null;
  /** Percent. Null when there is no trade at least 24 h old to compare against. */
  change_24h: number | null;
  trades_24h: number;
  last_trade_at: Date | string | null;
  /**
   * The best price this market ever traded at, AT ITS OWN GENERATION'S SCALE — like `last_price`
   * and the candles, and unlike the caps. Comparing it against another market's is only valid when
   * both are the same generation; `ath_market_cap` is the figure that is comparable across them.
   */
  ath_quote: string;
  ath_at: Date | string | null;
}

/**
 * A market row as the repository selects it: the routing SINK number, before the service names it.
 *
 * Split from `MarketRow` rather than widened into it so the wire type cannot accidentally carry
 * both spellings, and so a handler that forgets the translation fails to compile.
 */
export type MarketRowDb = Omit<MarketRow, "routing"> & { routing_sink: number | null };

export interface MarketDetailRow extends MarketRow {
  /**
   * The PoolManager, and therefore the SAME value on every graduated market.
   *
   * Kept because a non-null value is the cheapest "has it graduated" test a client can make, and
   * useless for anything else — under v4 there is no pool contract, so this identifies nothing.
   * `pool_id` is what does.
   */
  graduated_pool: string | null;
  /**
   * `PoolId = keccak256(PoolKey)`, which is the only thing that identifies a v4 pool.
   *
   * It was written to the database and surfaced nowhere, which is the "stored but never read"
   * shape — a column that looks like coverage and is not. A client routing a swap needs this and
   * the key below, and reconstructing either from constants is what silently hashes to a pool that
   * does not exist.
   */
  pool_id: string | null;
  currency0: string | null;
  currency1: string | null;
  fee: number | null;
  tick_spacing: number | null;
  hooks: string | null;
  liquidity: string | null;
}

export type MarketDetailRowDb = Omit<MarketDetailRow, "routing"> & { routing_sink: number | null };

/**
 * The board's page-mode response.
 *
 * `total` is the size of the filtered set, not of the page, so a pager can be drawn without a
 * second request. `pairCounts` is counted over the same filters MINUS the pair predicate — the
 * chips have to say how many markets each pair holds *within the current search*, and a count that
 * respected the pair filter would read 0 for every chip but the selected one.
 */
export interface MarketListPage {
  items: MarketRow[];
  total: number;
  page: number;
  limit: number;
  pairCounts: Record<string, number>;
}

/**
 * A market's fee ledger as the repository selects it. The service names the sink and camel-cases
 * the rest; nothing else reads this shape.
 */
export interface RewardsRow {
  market_address: string;
  routing_sink: number | null;
  quote_asset: string;
  quote_decimals: number;
  routed_generated: string;
  routed_collected: string;
  pending: string;
  tax_generated: string;
  tax_collected: string;
  pending_tax: string;
  protocol_generated: string;
  protocol_collected: string;
  dividends_funded: string;
  dividends_paid: string;
  burned_tokens: string;
  minted_supply: string;
  total_supply: string;
  updated_at: Date | string | null;
}

/**
 * What the rewards module reads.
 *
 * Every figure is a raw-unit string: the fee amounts in the market's quote asset (so
 * `quoteDecimals` is what scales them), the supplies and `burnedTokens` in the token's own base
 * units. `pending` is what is claimable now, and it is 0 on a buyback market by construction rather
 * than by subtraction — see the repository.
 */
export interface MarketRewards {
  routing: RoutingName | null;
  quoteAsset: string;
  quoteDecimals: number;
  routedGenerated: string;
  routedCollected: string;
  pending: string;
  taxGenerated: string;
  taxCollected: string;
  pendingTax: string;
  protocolGenerated: string;
  protocolCollected: string;
  dividendsFunded: string;
  dividendsPaid: string;
  burnedTokens: string;
  totalSupply: string;
  mintedSupply: string;
  updatedAt: Date | string | null;
}

/**
 * One of a creator's launches, as the repository selects it.
 *
 * The fee figures come from `market_rewards`, which sums what the fee events actually recorded —
 * not from `volume × 1%`, which the wallet tab did until now. That guess is right only while every
 * market charges the same fee, none of it is a creator tax, and no market has graduated onto a hook
 * with a different levy; all three are false on generation 2.
 */
export interface LaunchRowDb {
  market_address: string;
  token_address: string;
  symbol: string;
  name: string;
  ticker: string | null;
  logo_uri: string | null;
  created_at: Date;
  graduated: boolean;
  progress: number;
  holders: number;
  trade_count: number;
  volume_quote: string;
  market_cap: string;
  quote_asset: string;
  quote_decimals: number;
  quote_symbol: string | null;
  routing_sink: number | null;
  creator_tax_bps: number;
  routed_recipient: string | null;
  tax_recipient: string | null;
  fees_generated: string;
  pending: string;
  pending_tax: string;
}

/**
 * The same launch on the wire.
 *
 * The first thirteen keys are exactly what `app/api/accounts/[address]/launches/route.ts` builds
 * today by walking five hundred markets, so that route becomes a proxy rather than a rewrite. The
 * rest is what the wallet tab currently reads off the chain a market at a time.
 *
 * Every fee amount is a raw-unit string in the market's quote asset; `quoteDecimals` scales them.
 */
export interface LaunchRow {
  marketAddress: string;
  tokenAddress: string;
  symbol: string;
  name: string;
  ticker: string | null;
  logoUri: string | null;
  launchedAt: string;
  graduated: boolean;
  /** 0-1 along the bonding curve. Meaningless once graduated, and 0 where no target was set. */
  progress: number;
  holders: number;
  tradeCount: number;
  volumeQuote: string;
  marketCap: string;
  quoteAsset: string;
  quoteDecimals: number;
  quoteSymbol: string | null;
  routing: RoutingName | null;
  creatorTaxBps: number;
  /** Routed fees this market has GENERATED, all recipients, from the ledger. */
  feesGenerated: string;
  /** Of that, what has not been collected yet. Always "0" on a buyback market — see the repository. */
  pending: string;
  /** Who the routed share pays. Null where the market never named one. */
  feeRecipient: string | null;
  taxRecipient: string | null;
  pendingTax: string;
}

/** One quote asset's worth of a creator's balance. `amount` is raw units of that asset. */
export interface CreatorBalance {
  quoteAsset: string;
  quoteSymbol: string | null;
  quoteDecimals: number;
  amount: string;
}

/**
 * A market that pays this address, and in which capacity.
 *
 * The two roles are different money: `routed` is the market's share of the protocol fee, `tax` is
 * the creator tax charged on top of it. One address can hold both, and collapsing them would hide
 * that one of the two can be reassigned without the other.
 */
export interface CreatorMarket {
  marketAddress: string;
  ticker: string | null;
  name: string;
  quoteAsset: string;
  role: "routed" | "tax" | "both";
}

export interface CreatorBalanceRowDb {
  quote_asset: string;
  quote_symbol: string | null;
  quote_decimals: number | null;
  claimable: string;
  earned_lifetime: string;
}

export interface CreatorMarketRowDb {
  market_address: string;
  ticker: string | null;
  name: string;
  quote_asset: string;
  role: CreatorMarket["role"];
}

/**
 * What one creator is owed and by whom.
 *
 * Balances are per quote asset and never summed across them: a creator paid in USDC and in MON has
 * two balances, and adding them would be adding dollars to a token count.
 */
export interface CreatorSummary {
  claimable: CreatorBalance[];
  earnedLifetime: CreatorBalance[];
  markets: CreatorMarket[];
}

/**
 * A quote-asset registry row as the repository selects it: presentational columns and on-chain
 * state side by side.
 */
export interface QuoteAssetRowDb {
  id: string;
  address: string | null;
  symbol: string | null;
  name: string | null;
  kind: string | null;
  decimals: number | null;
  blurb: string | null;
  underlying: string | null;
  icon_domain: string | null;
  quote_target: string | null;
  registered: boolean;
  enabled: boolean;
  usd_price: number | null;
  usd_price_at: Date | string | null;
  market_count: number;
}

/** The catalogue's five kinds, as `src/lib/assets/quote-assets.ts` declares them. */
export type QuoteAssetKind = "native" | "stablecoin" | "crypto" | "stock" | "rwa";

/**
 * How far along an asset is, DERIVED from the two on-chain booleans and never stored.
 *
 * `live` means a market can be launched and traded against it today; `listed` means the launchpad
 * knows the asset but has not enabled it; `soon` means neither. Three states rather than a boolean
 * because "not tradable" otherwise collapses two situations a launcher cares about telling apart.
 */
export type QuoteAssetStatus = "live" | "listed" | "soon";

/**
 * A quote asset on the wire: the frontend's `QuoteAsset` shape, plus the four things only the
 * index knows — the on-chain target, the USD price and when it was taken, and how many markets
 * are quoted in it.
 *
 * `quoteTarget` is a raw-unit string like every other amount here. `usdPrice` is a NUMBER, and the
 * one exception to that rule: it is a price in dollars, not a token amount, and never approaches
 * the range where a float64 stops being exact.
 */
export interface QuoteAssetWire {
  id: string;
  symbol: string;
  name: string;
  kind: QuoteAssetKind;
  status: QuoteAssetStatus;
  decimals: number;
  /**
   * The ERC-20 on Monad, or null where there is not one yet.
   *
   * Native MON is `address(0)` and NOT null: that is what a PoolKey carries and what the launch
   * form must send. The frontend catalogue's `null` for MON meant "not on the launchpad yet",
   * which is a different statement and is no longer true.
   */
  address: string | null;
  blurb: string;
  underlying: string | null;
  iconDomain: string | null;
  quoteTarget: string | null;
  usdPrice: number | null;
  usdPriceAt: string | null;
  marketCount: number;
}

/**
 * A market as the leaderboard and the search select it. The service camel-cases it into
 * `SlimMarketRow`; nothing else reads this shape.
 *
 * The last three are per-query extras: only `movers` computes a windowed change, only `topVolume` a
 * windowed volume, only `recentlyGraduated` a graduation time.
 */
export interface SlimRowDb {
  market_address: string;
  token_address: string;
  name: string;
  ticker: string | null;
  symbol: string;
  logo_uri: string | null;
  quote_asset: string;
  quote_symbol: string | null;
  quote_decimals: number;
  graduated: boolean;
  last_price: string;
  market_cap_quote: string;
  market_cap_usd: string | null;
  volume_24h_quote: string;
  volume_24h_usd: string | null;
  change_24h: number | null;
  last_trade_at: Date | string | null;
  change_window?: number;
  volume_window_quote?: string;
  graduated_at?: Date | string;
}

/**
 * The card the hero rail, the mover list and the command palette all render.
 *
 * `lastPrice` is at its OWN market's generation scale, like every price on this service — it is
 * shown beside that market's name and nothing compares it against another's. The comparable
 * figures are the caps.
 */
export interface SlimMarketRow {
  marketAddress: string;
  tokenAddress: string;
  name: string;
  ticker: string | null;
  symbol: string;
  logoUri: string | null;
  quoteAsset: string;
  quoteSymbol: string | null;
  quoteDecimals: number;
  graduated: boolean;
  lastPrice: string;
  marketCapQuote: string;
  marketCapUsd: string | null;
  volume24hQuote: string;
  volume24hUsd: string | null;
  change24h: number | null;
  lastTradeAt: Date | string | null;
  /** Percent over the requested window. Movers only. */
  changeWindow?: number;
  /** Quote raw units traded in the requested window. Volume list only. */
  volumeWindowQuote?: string;
  /** Recently-graduated list only. */
  graduatedAt?: Date | string;
}

/** The four lists the hero draws, over one window. */
export interface Leaderboard {
  window: "1h" | "24h" | "7d";
  movers: SlimMarketRow[];
  volume: SlimMarketRow[];
  graduated: SlimMarketRow[];
  rail: SlimMarketRow[];
}

export interface SwapRow {
  id: string;
  market_address: string;
  trader: string;
  is_buy: boolean;
  venue: string;
  quote_amount: string;
  base_amount: string;
  fee: string;
  tax: string;
  quote_raised: string;
  price: string;
  block_number: string;
  block_hash: string;
  log_index: number;
  tx_hash: string;
  ts: Date;
}

/** The per-account feed joins the market on, so a portfolio is one request rather than N+1. */
export interface AccountSwapRow extends SwapRow {
  symbol: string;
  token_address: string;
}

export interface HolderRow {
  holder: string;
  balance: string;
  /**
   * This holder's fraction of CIRCULATING supply, as a fixed six decimal places ("0.123456").
   *
   * Circulating is `markets.total_supply` (already net of burns) minus what the curve, the
   * PoolManager and the dead address hold, because none of that is in anybody's hands. A string
   * rather than a float so the value the database computed is the value that renders.
   */
  share: string;
  /**
   * What this address IS, where it is not simply a holder.
   *
   * `curve` and `pool` are in the union for a caller that widens the query later; the market
   * holder list never emits them, because both hold enormous balances by construction and listing
   * them makes the real distribution unreadable.
   */
  label: "curve" | "pool" | "dead" | "creator" | "sink" | "hook" | null;
}

export interface BalanceRow {
  token_address: string;
  balance: string;
  market_address: string;
  symbol: string;
  last_price: string;
  pool_address: string | null;
}

/** A liquidity position in a graduated pool, joined to the market it is in. */
export interface PositionRow {
  token_id: string;
  pool_id: string;
  market_address: string;
  owner: string;
  tick_lower: number;
  tick_upper: number;
  liquidity: string;
  token_address: string;
  symbol: string;
}

export interface CandlestickRow {
  market_address: string;
  period_secs: number;
  bucket_start: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume_quote: string;
  trade_count: number;
}

export interface StatusRow {
  last_block: string;
  chain_head: string;
  updated_at: Date;
  lag_blocks: number;
  lag_seconds: number;
  markets: number;
  swaps: number;
  /**
   * Registered, enabled quote assets with no USD price.
   *
   * Non-zero means part of the board is being ordered on whole quote units rather than on dollars,
   * because that is the only honest fallback — see `columns.ts`. It is a data problem with a name,
   * not a market cap of zero, so it is counted here where a dashboard can see it.
   */
  unpriced_quotes: number;
}

/** A cursor-paginated response. `nextCursor` is null when the last page has been reached. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * One row of the upload reference ledger, as the database answers it.
 *
 * `orphaned` is DERIVED in SQL rather than stored: it is a statement about the current time, and a
 * stored copy would be wrong the moment the clock moved past it. `bytes`/`width`/`height` are cast
 * because everything numeric that leaves the database is cast in SQL.
 */
export interface UploadRowDb {
  cid: string;
  sha256: string;
  bytes: number;
  mime: string;
  width: number | null;
  height: number | null;
  uploaded_at: Date;
  referenced_by: string | null;
  referenced_at: Date | null;
  pinned: boolean;
  orphaned: boolean;
}

/** The same row on the wire: camelCase, timestamps as ISO strings. */
export interface UploadWire {
  cid: string;
  sha256: string;
  bytes: number;
  mime: string;
  width: number | null;
  height: number | null;
  uploadedAt: string;
  referencedBy: string | null;
  referencedAt: string | null;
  pinned: boolean;
  orphaned: boolean;
}
