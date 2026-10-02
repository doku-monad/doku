/**
 * The shapes the DOKU indexer puts on the wire.
 *
 * A mirror of the service's `src/types/api.ts`, field for field and **case for case**. Two
 * conventions travel on this wire and neither is tidied here:
 *
 *   - **snake_case:** `MarketRow`, `MarketDetailRow`, `SwapRow`, `HolderRow`, `BalanceRow`,
 *     `CandlestickRow`, `PositionRow`, `StatusRow`.
 *   - **camelCase:** `SlimMarketRow`, `LaunchRow`, `MarketRewards`, `CreatorSummary`,
 *     `QuoteAssetWire`, `UploadWire`.
 *
 * Renaming one into the other would read better and would be a place for a bug to hide: a
 * mis-mapped key is `undefined`, `BigInt(undefined)` throws somewhere unrelated, and the field that
 * silently went missing is the one nobody notices until it matters.
 *
 * ## Every large numeric is a decimal string
 *
 * These are fixed-point values that exceed what a float64 holds exactly; the client parses them
 * with `BigInt`. The four exceptions, which really are JSON numbers, are `usdPrice`, `change_24h`,
 * `changeWindow` and `progress` — none of them a token amount.
 *
 * ## Timestamps
 *
 * The service types these `Date | string | null`, because the same interface describes the row
 * before and after serialisation. Over HTTP a `Date` has already been through `JSON.stringify`, so
 * what a client receives is always a string. They are typed as strings here for that reason —
 * `new Date(row.created_at)` on a value the compiler believes could be a `Date` is a mistake the
 * compiler would then not catch.
 *
 * ## Prices carry a generation scale — see `lib/chain/quote-scale`
 *
 * Generation 1 stores `quote_wei * 1e18 / base_wei`; generation 2 stores `quote * 1e36 / base`.
 * The service divides that scale out of the CAPS and leaves it on the PRICES, and `generation` is
 * present on `MarketRow` and `MarketDetailRow` and **on nothing else that carries a price**. Each
 * field below says which side of that line it is on.
 */

/** Where a market's routed fee share goes. The service names the on-chain sink number for us. */
export type RoutingName = "creator" | "holders" | "buyback";

export interface MarketRow {
  market_address: string;
  token_address: string;
  symbol: string;
  name: string;
  symbol_key: string;
  creator: string;
  quote_target: string;
  /** Base units, accumulated from the mints the chain reported. */
  total_supply: string;
  block_number: string;
  tx_hash: string;
  created_at: string;
  quote_raised: string;
  /** RAW, at this market's generation scale. Put it through `quotePerWholeToken`. */
  last_price: string;
  volume_quote: string;
  trade_count: number;
  holders: number;
  ready_to_graduate: boolean;
  pool_address: string | null;
  /** Already normalised: raw quote units, scale it by `quote_decimals` and nothing else. */
  market_cap: string;
  /** The same, at the best price this market ever traded at. Already normalised. */
  ath_market_cap: string;
  volume_24h: string;
  /** When this market last traded, or null if it never has. Bump order sorts on it. */
  last_swap_at: string | null;

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
  /** Already normalised: raw quote units. */
  market_cap_quote: string;
  /** Null while the quote asset has no USD price; never "0", which would mean "worth nothing". */
  market_cap_usd: string | null;
  volume_24h_quote: string;
  volume_24h_usd: string | null;
  /** Percent, a JSON number. Null when there is no trade at least 24 h old to compare against. */
  change_24h: number | null;
  trades_24h: number;
  last_trade_at: string | null;
  /**
   * The best price this market ever traded at, AT ITS OWN GENERATION'S SCALE — like `last_price`
   * and the candles, and unlike the caps. Comparing it against another market's is only valid when
   * both are the same generation; `ath_market_cap` is the figure that is comparable across them.
   */
  ath_quote: string;
  ath_at: string | null;
}

export interface MarketDetailRow extends MarketRow {
  /**
   * The PoolManager, and therefore the SAME value on every graduated market.
   *
   * Kept because a non-null value is the cheapest "has it graduated" test a client can make, and
   * useless for anything else — under v4 there is no pool contract, so this identifies nothing.
   * `pool_id` is what does.
   */
  graduated_pool: string | null;
  /** `PoolId = keccak256(PoolKey)`, the only thing that identifies a v4 pool. */
  pool_id: string | null;
  currency0: string | null;
  currency1: string | null;
  fee: number | null;
  tick_spacing: number | null;
  hooks: string | null;
  liquidity: string | null;
}

/**
 * The board's page-mode response.
 *
 * `total` is the size of the FILTERED set, not of the page, so a pager can be drawn without a
 * second request. `pairCounts` is counted over the same filters MINUS the pair predicate — the
 * chips have to say how many markets each pair holds within the current search, and a count that
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
 * What the rewards module reads.
 *
 * Every figure is a raw-unit string: the fee amounts in the market's quote asset (so
 * `quoteDecimals` scales them), the supplies and `burnedTokens` in the token's own base units.
 * `pending` is what is claimable now, and it is "0" on a buyback market **by construction** rather
 * than by subtraction — do not render a claim button for one.
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
  updatedAt: string | null;
}

/**
 * One of a creator's launches.
 *
 * The fee figures come from the service's `market_rewards`, which sums what the fee events
 * actually recorded — not from `volume × 1%`, which the wallet tab did. That guess is right only
 * while every market charges the same fee, none of it is a creator tax, and no market has
 * graduated onto a hook with a different levy; all three are false on generation 2.
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
  /** 0-1 along the bonding curve, a JSON number. Meaningless once graduated. */
  progress: number;
  holders: number;
  tradeCount: number;
  volumeQuote: string;
  /** Already normalised: raw quote units. */
  marketCap: string;
  quoteAsset: string;
  quoteDecimals: number;
  quoteSymbol: string | null;
  routing: RoutingName | null;
  creatorTaxBps: number;
  /** Routed fees this market has GENERATED, all recipients, from the ledger. */
  feesGenerated: string;
  /** Of that, what has not been collected. Always "0" on a buyback market. */
  pending: string;
  /** Who the routed share pays. Null where the market never named one. */
  feeRecipient: string | null;
  taxRecipient: string | null;
  pendingTax: string;
}

/** One quote asset's worth of a creator's balance. `amount` is raw units OF THAT ASSET. */
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
 * that either can be reassigned without the other.
 */
export interface CreatorMarket {
  marketAddress: string;
  ticker: string | null;
  name: string;
  quoteAsset: string;
  role: "routed" | "tax" | "both";
}

/**
 * What one creator is owed, and by whom.
 *
 * Balances are per quote asset and **never summed across them**: a creator paid in USDC and in MON
 * has two balances, and adding them is adding dollars to a token count.
 */
export interface CreatorSummary {
  claimable: CreatorBalance[];
  earnedLifetime: CreatorBalance[];
  markets: CreatorMarket[];
}

export type QuoteAssetKind = "native" | "stablecoin" | "crypto" | "stock" | "rwa";

/**
 * How far along an asset is, DERIVED from two on-chain booleans and never stored.
 *
 * `registered && enabled` is live, registered alone is listed, neither is soon.
 */
export type QuoteAssetStatus = "live" | "listed" | "soon";

/**
 * A quote asset on the wire.
 *
 * `quoteTarget` is a raw-unit string like every other amount here. `usdPrice` is a NUMBER and one
 * of the four exceptions: it is a price in dollars, not a token amount.
 *
 * Re-declared in `lib/assets/quote-assets` as well, because that module is the app's own shape and
 * must not import the whole wire surface to describe one row.
 */
export interface QuoteAssetWire {
  id: string;
  symbol: string;
  name: string;
  kind: QuoteAssetKind;
  status: QuoteAssetStatus;
  decimals: number;
  /** `address(0)` for native MON — NOT null, which means "there is no token". */
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
 * The card the hero rail, the mover list and the command palette all render.
 *
 * **`lastPrice` is at its own market's generation scale and this shape does not say which.** It is
 * shown beside that market's name and nothing compares it against another's; the comparable
 * figures are the caps. A consumer that wants to scale it must carry the generation from the
 * market row it came from — see `lib/chain/quote-scale`.
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
  lastTradeAt: string | null;
  /** Percent over the requested window, a JSON number. Movers only. */
  changeWindow?: number;
  /** Quote raw units traded in the requested window. Volume list only. */
  volumeWindowQuote?: string;
  /** Recently-graduated list only. */
  graduatedAt?: string;
}

/** The four lists the hero draws, over one window. One request, one loading state. */
export interface Leaderboard {
  window: LeaderboardWindow;
  movers: SlimMarketRow[];
  volume: SlimMarketRow[];
  graduated: SlimMarketRow[];
  rail: SlimMarketRow[];
}

export type LeaderboardWindow = "1h" | "24h" | "7d";

export interface SwapRow {
  id: string;
  market_address: string;
  trader: string;
  is_buy: boolean;
  /**
   * Which venue filled it.
   *
   * `sink` is the third value and the client's union omitted it: a fee routed through
   * `CreatorSink` is recorded against the market like a trade, and a feed that narrowed this to
   * two values would have had a row it could not name. There is no v4 "pool contract" — `pool`
   * means the PoolManager.
   */
  venue: "curve" | "pool" | "sink";
  quote_amount: string;
  base_amount: string;
  fee: string;
  /** The time-decaying anti-sniper tax. Zero on sells and after the window closes. */
  tax: string;
  quote_raised: string;
  /** RAW, at the market's generation scale — and THIS SHAPE DOES NOT CARRY THE GENERATION. */
  price: string;
  block_number: string;
  block_hash: string;
  log_index: number;
  tx_hash: string;
  ts: string;
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
   * Circulating is `total_supply` (already net of burns) minus what the curve, the PoolManager and
   * the dead address hold, because none of that is in anybody's hands. A string rather than a
   * float so the value the database computed is the value that renders — and computing it in the
   * browser from a balance and a supply gets a different answer, because the browser does not know
   * which addresses to exclude.
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
  /** RAW, at that market's generation scale — and this shape does not carry the generation. */
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
  bucket_start: string;
  /** All four are RAW, at the market's generation scale. This shape does not carry it either. */
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
  updated_at: string;
  lag_blocks: number;
  lag_seconds: number;
  markets: number;
  swaps: number;
  /**
   * Registered, enabled quote assets with no USD price.
   *
   * Non-zero means part of the board is ordered on whole quote units rather than on dollars,
   * because that is the only honest fallback. It is a data problem with a name, not a market cap
   * of zero.
   */
  unpriced_quotes: number;
}

/** A cursor-paginated response. `nextCursor` is null when the last page has been reached. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * One row of the upload reference ledger.
 *
 * `orphaned` is DERIVED in SQL rather than stored: it is a statement about the current time, and a
 * stored copy would be wrong the moment the clock moved past it.
 */
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
