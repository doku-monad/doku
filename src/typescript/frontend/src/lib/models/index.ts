import type { CandlestickRow, HolderRow, MarketRow, RoutingName, SwapRow } from "@/lib/api/markets";
import {
  type Generation,
  quotePerWholeToken,
  quotePerWholeTokenNumber,
} from "@/lib/chain/quote-scale";

import { safeCoinWebsite, safeExternalUrl } from "./safe-url";

/**
 * The shapes components read.
 *
 * These replace the Aptos-era `DatabaseModels`. Fields that had a meaning on Aptos and none here —
 * `marketID`, `marketNonce`, `transaction.version`, `trigger`, `cpammRealReserves` — are gone
 * rather than renamed onto the nearest-looking EVM value. Keeping the names would have been the
 * smaller diff and the larger mistake: `cpammRealReserves` on a concentrated-liquidity position is
 * not merely misleading, it is a number someone will do arithmetic with.
 *
 * A market is identified by its **address**, which is what the chain uses and what the indexer
 * keys on.
 */

export type Address = string;

export interface MarketMetadata {
  marketAddress: Address;
  tokenAddress: Address;
  /**
   * The on-chain symbol.
   *
   * Today this is the emoji sequence, because that is what the factory accepts. It is the chain's
   * identifier, not the coin's display name — read `lib/token-identity` for what to put in front
   * of a person.
   */
  symbol: string;
  /**
   * The name the chain recorded at launch.
   *
   * The factory currently sets it to the joined emoji, so for every market launched so far this
   * is the symbol again. It is carried through anyway rather than dropped: it is the field a
   * general-purpose factory would put a real name in, and `lib/token-identity` already prefers it
   * whenever it holds something other than the symbol.
   */
  name: string;
  /** `keccak256` of the symbol bytes — the registry's uniqueness key. */
  symbolKey: string;
  creator: Address;
  launchedAt: Date;
  /**
   * 1 = the emoji launchpad, 2 = the pairs launchpad.
   *
   * Carried on the model because it is not trivia: it says which fixed-point scale every price on
   * this market is stored at. See `lib/chain/quote-scale`.
   */
  generation: number;
  /** What this market is priced in, from its own row rather than from a global assumption. */
  quote: {
    /** `address(0)` for native MON. */
    asset: Address;
    decimals: number;
    /** From the quote catalogue; null for an asset it has never been told about. */
    symbol: string | null;
    id: string | null;
  };
  /** Where the routed share of the protocol fee goes. Null where the market never recorded one. */
  routing: RoutingName | null;
  routedRecipient: Address | null;
  /** The creator's own tax, in basis points. 0-1000 and a multiple of 10. */
  creatorTaxBps: number;
  taxRecipient: Address | null;
  /** What the launcher supplied off-chain. All null on a generation-1 market. */
  metadata: {
    ticker: string | null;
    logoUri: string | null;
    bannerUri: string | null;
    description: string | null;
    website: string | null;
    x: string | null;
    telegram: string | null;
  };
}

export interface CurveState {
  /** MON committed to the curve so far, in base units. */
  quoteRaised: bigint;
  /** MON required before the market graduates. */
  quoteTarget: bigint;
  /** 0 to 1. Clamped, because a market can overshoot its target within a single trade. */
  progress: number;
  /**
   * The last traded price AS STORED — raw, at this market's generation scale.
   *
   * Not a number anything should render. Generation 1 stores `quote_wei * 1e18 / base_wei` and
   * generation 2 stores `quote * 1e36 / base`, so the same figure differs by 1e18 between two
   * markets sitting in the same table. `lastPriceQuote` beside it is the one to draw.
   */
  lastPrice: bigint;
  /**
   * The same price as quote RAW units per WHOLE token, with the generation scale taken off.
   *
   * `formatUnits(lastPriceQuote, market.quote.decimals)` is the human figure. Never null on a
   * market model, because a market row always says its generation.
   */
  lastPriceQuote: bigint;
  volumeQuote: bigint;
  /** Rolling 24-hour volume in MON. A real zero on a quiet market, never absent. */
  volume24h: bigint;
  /** Token supply in base units, accumulated from the mints the chain reported. */
  totalSupply: bigint;
  /**
   * Last price times token supply, in RAW QUOTE UNITS — already normalised.
   *
   * The service divides the generation scale out of the caps and leaves it on the prices, so this
   * takes `market.quote.decimals` and nothing else. Putting it through `quotePerWholeToken` would
   * divide it by 1e18 a second time, which is three of the four defects that produced this note.
   */
  marketCap: bigint;
  /** The same at the market's best price ever — its all-time high. Also already normalised. */
  athMarketCap: bigint;
  /**
   * Where the cap sits between zero and its peak, 0 to 1.
   *
   * A market at its all-time high reads 1. Computed here so the card and the hero cannot disagree
   * about it, which is what happens when two components each divide the same pair of numbers.
   */
  athProgress: number;
  tradeCount: number;
  holders: number;
  readyToGraduate: boolean;
  /**
   * Set once the indexer has seen the `Graduated` log.
   *
   * Under v4 there is no pool contract, so this identifies nothing — it is the cheapest "has it
   * graduated" test and no more. Do not decide a trading venue from it: see `lib/chain/venue`.
   */
  poolAddress: Address | null;
  /**
   * The pool's **recorded** id and key, as the graduation log wrote them. Null until graduation.
   *
   * Carried on the model rather than rebuilt from the token and the quote, and that is not a
   * convenience. More than one hook is deployed: markets that graduated before the LP-paying hook
   * carry the old one in their key, and a `PoolKey` reassembled from the single configured hook
   * address hashes to a different `PoolId` for every one of them. The symptom is not an error —
   * `StateView` answers for a pool that was never initialised, so the panel reads a zero price and
   * a zero liquidity and shows an empty pool that is in fact full. The indexer selects these six
   * columns on every market row precisely so a client never has to guess.
   *
   * `poolKey` is `null` where the row did not carry the columns, which is what
   * `poolKeyOf(token, quote, recorded)` takes as "fall back to the pair's own key".
   */
  poolId: `0x${string}` | null;
  poolKey: {
    currency0: `0x${string}`;
    currency1: `0x${string}`;
    fee: number;
    tickSpacing: number;
    hooks: `0x${string}`;
  } | null;
  /** When this market last traded, or null if it never has. Bump order sorts on it. */
  lastSwapAt: Date | null;
  /** Percent over 24 hours. Null when there is no trade old enough to compare against. */
  change24h: number | null;
  /** Dollars, where the quote asset has a USD price. Null is a data gap, never "worth nothing". */
  marketCapUsd: number | null;
}

export interface MarketModel {
  market: MarketMetadata;
  state: CurveState;
}

export interface SwapModel {
  id: string;
  market: { marketAddress: Address };
  swap: {
    trader: Address;
    isSell: boolean;
    /**
     * Where the trade happened.
     *
     * Shown because the fee and tax columns mean different things per venue: on the curve they are
     * separate deductions, on the pool the 1% is taken inside the swap. A feed that mixed them
     * silently would report zero fee on half its rows.
     */
    venue: "curve" | "pool" | "sink";
    /** MON in or out, in base units. */
    quoteVolume: bigint;
    /** Tokens out or in, in base units. */
    baseVolume: bigint;
    /**
     * The price AS STORED — raw, at the market's generation scale.
     *
     * `SwapRow` does not carry a generation, which is the whole hazard: a swap feed holds a price
     * and no way of knowing what it means. `priceQuote` is the resolved one and is `null` exactly
     * when the caller could not say which generation this row belongs to.
     */
    price: bigint;
    /**
     * Quote RAW units per whole token, or `null` when the generation was unknown.
     *
     * Null is not an error to swallow — it means "this feed did not carry the market it came
     * from". Render nothing rather than the raw figure: on a generation-2 market the raw figure is
     * a quintillion times too large and still looks like a price.
     */
    priceQuote: bigint | null;
    /** The 1% protocol fee, in MON. */
    fee: bigint;
    /** The time-decaying anti-sniper tax, in MON. Zero on sells and after the window closes. */
    tax: bigint;
    /**
     * The curve's total raised *after* this trade.
     *
     * Carried on the event specifically so a reader never has to ask the chain where the curve
     * stands — the newest swap already says. Dropping it from the model would put that round trip
     * back for a number we were handed.
     */
    quoteRaised: bigint;
  };
  block: { number: bigint; txHash: string; time: Date };
}

export interface CandlestickModel {
  marketAddress: Address;
  periodSecs: number;
  bucketStart: Date;
  /**
   * Whole quote units per whole token, unscaled through `lib/chain/quote-scale`.
   *
   * `null` when the generation was not supplied — a candle carries no generation of its own, and
   * a chart drawn at the wrong scale is indistinguishable from a chart drawn at the right one
   * because the shape is identical. Only the axis is wrong, and only by eighteen orders of
   * magnitude.
   */
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volumeQuote: bigint;
  tradeCount: number;
}

export interface HolderModel {
  holder: Address;
  balance: bigint;
  /**
   * This holder's fraction of CIRCULATING supply, 0 to 1.
   *
   * From the endpoint, not recomputed. Circulating is the total supply minus what the curve, the
   * PoolManager and the dead address hold — none of which is in anybody's hands — and a browser
   * dividing a balance by `total_supply` does not know which addresses to exclude, so it gets a
   * different and smaller number for every holder on the list.
   */
  share: number;
  /**
   * What this address IS, where it is not simply a holder.
   *
   * `null` for an ordinary one. The market list never emits `curve` or `pool`: both hold enormous
   * balances by construction and listing them makes the real distribution unreadable.
   */
  label: HolderRow["label"];
}

/**
 * Curve progress as a fraction.
 *
 * A zero target is a misconfigured market, not a complete one. Returning 1 there would render as
 * "ready to graduate" on a market that has raised nothing.
 */
function progressOf(raised: bigint, target: bigint): number {
  if (target <= 0n) return 0;
  if (raised >= target) return 1;
  // Scaled to an integer before the division so the ratio is computed on exact values; only the
  // final, small number touches floating point.
  return Number((raised * 10_000n) / target) / 10_000;
}

/**
 * A timestamp column that can be absent, null, or an ISO string.
 *
 * `new Date(undefined)` is an Invalid Date, `getTime()` on one is `NaN`, and a `NaN` in a
 * comparator silently scrambles a whole grid rather than failing — so absence has to become
 * `null`, explicitly, at the one place the column is read.
 */
const dateOrNull = (value: string | null | undefined): Date | null =>
  value === null || value === undefined ? null : new Date(value);

/**
 * The generation a row declares.
 *
 * Defaulted to 1 for a row that predates the column, which is the honest reading: every market
 * that existed before generation 2 shipped is a generation-1 market. This is the ONLY place a
 * generation may be defaulted, and it is safe here because the row is the thing that would carry
 * it — unlike a swap or a candle, where absence means "this shape never had it" and guessing is
 * how a price ends up wrong by 1e18.
 */
const generationOf = (row: MarketRow): number => row.generation ?? 1;

export function toMarketModel(row: MarketRow): MarketModel {
  const quoteRaised = BigInt(row.quote_raised);
  const quoteTarget = BigInt(row.quote_target);
  const marketCap = BigInt(row.market_cap ?? "0");
  const athMarketCap = BigInt(row.ath_market_cap ?? "0");
  const generation = generationOf(row);
  const lastPrice = BigInt(row.last_price);

  return {
    market: {
      marketAddress: row.market_address,
      tokenAddress: row.token_address,
      symbol: row.symbol,
      name: row.name ?? row.symbol,
      symbolKey: row.symbol_key,
      creator: row.creator,
      launchedAt: new Date(row.created_at),
      generation,
      quote: {
        // `address(0)` is native MON and is what a generation-1 row means by "no quote column".
        asset: row.quote_asset ?? "0x0000000000000000000000000000000000000000",
        // 18 only where the row does not say — every generation-1 market is MON, which is 18.
        decimals: row.quote_decimals ?? 18,
        symbol: row.quote_symbol ?? null,
        id: row.quote_id ?? null,
      },
      routing: row.routing ?? null,
      routedRecipient: row.routed_recipient ?? null,
      creatorTaxBps: row.creator_tax_bps ?? 0,
      taxRecipient: row.tax_recipient ?? null,
      metadata: {
        ticker: row.ticker ?? null,
        logoUri: row.logo_uri ?? null,
        bannerUri: row.banner_uri ?? null,
        description: row.description ?? null,
        /*
         * Sanitised HERE, at the one place chain metadata enters the model, so every consumer
         * inherits it. `DokuFactory` validates these for byte length only — no scheme, no charset —
         * and they go straight into an `href` on the masthead and the board card. React 18 renders
         * a `javascript:` href after merely warning about it. See `safe-url`.
         */
        website: safeCoinWebsite(row.website),
        x: safeExternalUrl(row.x),
        telegram: safeExternalUrl(row.telegram),
      },
    },
    state: {
      quoteRaised,
      quoteTarget,
      progress: progressOf(quoteRaised, quoteTarget),
      lastPrice,
      // Never null: the row said which generation it is, which is the whole reason the market row
      // is the shape every other price has to be resolved against.
      lastPriceQuote: quotePerWholeToken(lastPrice, generation) ?? 0n,
      volumeQuote: BigInt(row.volume_quote),
      volume24h: BigInt(row.volume_24h ?? "0"),
      totalSupply: BigInt(row.total_supply ?? "0"),
      marketCap,
      athMarketCap,
      athProgress: athMarketCap > 0n ? Number((marketCap * 10_000n) / athMarketCap) / 10_000 : 0,
      tradeCount: row.trade_count,
      holders: row.holders,
      readyToGraduate: row.ready_to_graduate,
      poolAddress: row.pool_address,
      poolId: (row.pool_id ?? null) as `0x${string}` | null,
      /* All six or none. A half-filled key is worse than no key: `poolKeyOf` would take it as
         recorded and hash a `PoolId` from partly-default fields. */
      poolKey:
        row.currency0 && row.currency1 && row.hooks
          ? {
              currency0: row.currency0 as `0x${string}`,
              currency1: row.currency1 as `0x${string}`,
              fee: row.fee ?? 0,
              tickSpacing: row.tick_spacing ?? 0,
              hooks: row.hooks as `0x${string}`,
            }
          : null,
      lastSwapAt: dateOrNull(row.last_swap_at),
      change24h: row.change_24h ?? null,
      /**
       * DOLLARS, in whole units, and not a raw amount to be scaled.
       *
       * `market_stats.market_cap_usd` is `(cap_quote / 10^quote_decimals) * usd_price` — the
       * service has already applied both the quote's decimals and its price, and sends a
       * `NUMERIC(38,8)` such as "2876.86443017". Reading it as an 18-decimal integer threw inside
       * `BigInt`, and the row parser catches and SKIPS a row that throws: `/api/markets` answered
       * with an empty list and a cursor pointing at a real market, so the command palette found
       * nothing at all.
       *
       * It hid because the column is null until `PRICE_SOURCE_URL` is set, and the null branch
       * returns before the conversion. Configuring a price source made every market on the board
       * unparseable in the same moment.
       */
      marketCapUsd: usdOrNull(row.market_cap_usd),
    },
  };
}

/**
 * A dollar figure the service already computed, or null.
 *
 * Null and absent both mean "no price for this quote asset", which is not the same as zero — a
 * market genuinely worth nothing is a number, and a market whose quote nobody can price is not.
 * A value that does not parse is treated as absent rather than thrown on, because one malformed
 * figure should cost a column and not a whole row.
 */
function usdOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * One trade.
 *
 * @param generation the generation of the MARKET this swap belongs to. Required, and required
 *        because `SwapRow` does not carry it: a feed that has the market row passes its
 *        generation, and one that does not — the cross-market account feed — passes
 *        `UNKNOWN_GENERATION` and gets `priceQuote: null`. Making it an argument rather than a
 *        default is the point: a caller has to answer the question rather than inherit an
 *        assumption that is right for one generation and wrong by 1e18 for the other.
 */
export function toSwapModel(row: SwapRow, generation: Generation): SwapModel {
  const price = BigInt(row.price);
  return {
    id: row.id,
    market: { marketAddress: row.market_address },
    swap: {
      // Lowercased so it compares equal to a connected wallet's address, which arrives checksummed.
      trader: row.trader.toLowerCase(),
      isSell: !row.is_buy,
      venue: row.venue ?? "curve",
      quoteVolume: BigInt(row.quote_amount),
      baseVolume: BigInt(row.base_amount),
      price,
      priceQuote: quotePerWholeToken(price, generation),
      fee: BigInt(row.fee),
      tax: BigInt(row.tax),
      quoteRaised: BigInt(row.quote_raised),
    },
    block: {
      number: BigInt(row.block_number),
      txHash: row.tx_hash,
      time: new Date(row.ts),
    },
  };
}

/**
 * One candle.
 *
 * @param generation the market's, for the same reason `toSwapModel` takes one: OHLC is four prices
 *        and `CandlestickRow` carries no generation. This divided by a hard-coded `1e18` before,
 *        which is right for generation 1 and a factor of a quintillion out for generation 2 —
 *        drawing a chart whose shape is perfect and whose axis is meaningless.
 * @param quoteDecimals the QUOTE ASSET's, so a six-decimal gold market and an eighteen-decimal MON
 *        market both come out in whole units of their own asset. There is no global 18 here.
 */
export function toCandlestickModel(
  row: CandlestickRow,
  generation: Generation,
  quoteDecimals: number
): CandlestickModel {
  const price = (raw: string) => quotePerWholeTokenNumber(raw, generation, quoteDecimals);
  return {
    marketAddress: row.market_address,
    periodSecs: row.period_secs,
    bucketStart: new Date(row.bucket_start),
    // Prices become numbers because that is what a chart takes. Volume does not convert: it is a
    // raw-unit amount and would round.
    open: price(row.open),
    high: price(row.high),
    low: price(row.low),
    close: price(row.close),
    volumeQuote: BigInt(row.volume_quote),
    tradeCount: row.trade_count,
  };
}

export function toHolderModel(row: HolderRow): HolderModel {
  return {
    holder: row.holder.toLowerCase(),
    balance: BigInt(row.balance),
    // A fixed six-decimal string on the wire. `Number` is exact for it and the value is a
    // fraction, not an amount, so nothing is at risk in the conversion.
    share: row.share === undefined || row.share === null ? 0 : Number(row.share),
    label: row.label ?? null,
  };
}
