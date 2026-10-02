import { formatUnits } from "viem";

/**
 * The one place a stored price is turned into a real one.
 *
 * ## The two scales
 *
 * A price on this service is quote units per base unit, in fixed point — and the two generations of
 * contract do not use the same fixed point.
 *
 *   - **Generation 1** — `BondingCurve` returns `quote_wei * 1e18 / base_wei`.
 *   - **Generation 2** — `BondingCurve._price` returns `quote * 1e36 / base`: the same quantity
 *     scaled a further 1e18, chosen so a six-decimal quote against a 1e27 reserve does not
 *     truncate to a handful of raw units.
 *
 * Base is 18 decimals in both, so dividing a stored price by its scale and multiplying by 1e18
 * gives **quote RAW units per WHOLE token**, which is the figure everything on screen is built
 * from. That number is then scaled by the QUOTE ASSET's own decimals — six for USDC and for gold,
 * eight for the wrapped bitcoins, eighteen for MON — which is a separate question from the
 * generation and is why a single global `TOKEN_DECIMALS = 18` is wrong twice over.
 *
 * ## Why this exists as a module rather than as a constant
 *
 * The indexer divides the scale out of the CAPS and leaves it on the PRICES:
 *
 * | Already normalised — raw quote units | Still raw at the generation scale |
 * |---|---|
 * | `market_cap`, `ath_market_cap`, `market_cap_quote`, `LaunchRow.marketCap` | `last_price`, `ath_quote`, `SlimMarketRow.lastPrice`, `SwapRow.price`, candlestick OHLC, `BalanceRow.last_price` |
 *
 * And `generation` is carried on `MarketRow` and `MarketDetailRow` and **on none of the other five
 * shapes that hold a price**. So a price and its scale arrive separately, by different routes, and
 * every consumer has to put them back together.
 *
 * Four separate defects of exactly this shape were found and fixed on the service: a market cap a
 * quintillion times too large in three places, and a generation-2 price that fell by the same
 * factor the moment its market graduated. None of them threw, none tripped a consistency check,
 * and all four still rendered as perfectly ordinary numbers. This module is the client's one
 * chance not to add a fifth.
 */

/*
 * WRITTEN OUT RATHER THAN COMPUTED, and it is not a style preference.
 *
 * `10n ** 18n` is the obvious way to say this and it does not survive every build of this app. The
 * exponent operator can be LOWERED to `Math.pow` by a transpile target that predates `**`, and
 * `Math.pow` on a BigInt throws `Cannot convert a BigInt value to a number` — at MODULE LOAD, which
 * takes the whole client render down with it rather than the one figure that needed the constant.
 * It was observed in the dev bundle while this file was server-only; the search palette now
 * resolves prices through it, so it is in the client bundle too, where that failure is a blank
 * page on every route.
 *
 * A literal cannot be lowered into anything.
 */

/** Generation 1: `quote_wei * 1e18 / base_wei`. */
export const PRICE_SCALE_GEN1 = 1_000_000_000_000_000_000n;

/** Generation 2: `quote * 1e36 / base` — the same figure, a further 1e18 up. */
export const PRICE_SCALE_GEN2 = 1_000_000_000_000_000_000_000_000_000_000_000_000n;

/** One whole token in base units. Both generations mint 18-decimal tokens. */
const BASE_UNIT = 1_000_000_000_000_000_000n;

/**
 * The generation of a price whose row did not say.
 *
 * `SwapRow`, `AccountSwapRow`, `BalanceRow`, `CandlestickRow` and `SlimMarketRow` all carry a price
 * and no generation. Defaulting those to 1 is precisely the assumption that produced the four
 * defects above, so there is a value for "the row did not say" and the helpers refuse to scale it.
 * A caller holding this is not stuck — it means go and fetch the market row, or thread the
 * generation down from the one you already have.
 */
export const UNKNOWN_GENERATION = null;
export type Generation = number | typeof UNKNOWN_GENERATION;

/**
 * The fixed-point scale a generation's prices are stored at.
 *
 * Anything that is not 2 is treated as generation 1, deliberately: the column is an integer the
 * service writes, and a future generation 3 that changed the scale again would have to be added
 * here — falling back to the OLD scale means a new market renders wrong, which is visible, rather
 * than the new one silently claiming the new scale for old rows.
 */
export const priceScaleFor = (generation: number): bigint =>
  generation === 2 ? PRICE_SCALE_GEN2 : PRICE_SCALE_GEN1;

/**
 * Quote RAW units per WHOLE token.
 *
 * The figure to hand to `formatUnits(x, quoteDecimals)`, to multiply by a whole-token balance, or
 * to compare against another price in the same asset.
 *
 * ## It truncates, and on a coarse quote that matters
 *
 * Integer division, so a whole token worth LESS than one raw unit of its quote comes back as `0`.
 * Against six-decimal gold — one token, one troy ounce — that is any coin under a millionth of an
 * ounce, which is most of them early on. This is the same shape as the defect that took every gold
 * market's price to zero the moment it graduated.
 *
 * Use it for arithmetic in raw units, where truncating below one unit is correct because there is
 * no such thing as a fraction of one. For anything a person reads, use
 * `quotePerWholeTokenNumber`, which does the whole division at once and keeps the fraction.
 *
 * @param rawPrice as stored — a decimal string off the wire, or the `bigint` it was parsed into
 * @param generation from the market row this price belongs to, or `UNKNOWN_GENERATION`
 * @returns `null` when the generation is unknown. Rendering nothing is survivable; rendering a
 *          number that is off by a factor of 1e18 is not, because it looks exactly like a number.
 */
export function quotePerWholeToken(rawPrice: bigint | string, generation: Generation): bigint | null {
  if (generation === UNKNOWN_GENERATION) return null;
  const raw = typeof rawPrice === "bigint" ? rawPrice : BigInt(rawPrice);
  return (raw * BASE_UNIT) / priceScaleFor(generation);
}

/**
 * Whole quote units per whole token, as a number.
 *
 * For a chart axis or a label — the two places a `bigint` cannot go. It is a float at the end and
 * that is fine: a price is being drawn, not settled.
 *
 * ## Both divisions at once, deliberately
 *
 * This does NOT call `quotePerWholeToken` and then scale the result. That would truncate to a
 * whole raw unit first — and against six-decimal gold, a coin worth less than a millionth of an
 * ounce truncates to zero, so every price, candle and label on the market would read 0.00 while
 * nothing threw. Both divisors are combined into one `formatUnits` exponent instead, so the
 * fraction survives: the generation contributes 18 places on generation 2 and none on generation
 * 1, and the quote asset contributes its own decimals.
 *
 * `formatUnits` rather than `Number(x) / 10 ** d` so the integer part survives values above 2^53
 * exactly, and only the final parse is lossy.
 *
 * @param quoteDecimals the QUOTE ASSET's decimals — six for USDC and gold, eight for cbBTC,
 *        eighteen for MON. Not the token's, and never a global.
 */
export function quotePerWholeTokenNumber(
  rawPrice: bigint | string,
  generation: Generation,
  quoteDecimals: number
): number | null {
  if (generation === UNKNOWN_GENERATION) return null;
  const raw = typeof rawPrice === "bigint" ? rawPrice : BigInt(rawPrice);
  const generationPlaces = generation === 2 ? 18 : 0;
  return Number(formatUnits(raw, quoteDecimals + generationPlaces));
}

/**
 * A quote amount that is ALREADY normalised, as a number.
 *
 * The caps — `market_cap`, `ath_market_cap`, `market_cap_quote`, `LaunchRow.marketCap` — and every
 * fee, balance and volume figure are raw quote units already: the service took the generation
 * scale off them. They take the quote's decimals and nothing else, and putting one through
 * `quotePerWholeToken` would divide it by 1e18 a second time.
 *
 * Here so that the two kinds of figure have two named functions rather than one function and a
 * convention, because "did this one already have the scale removed" is the exact question the four
 * defects got wrong.
 */
export function quoteAmountNumber(rawAmount: bigint | string, quoteDecimals: number): number {
  const raw = typeof rawAmount === "bigint" ? rawAmount : BigInt(rawAmount);
  return Number(formatUnits(raw, quoteDecimals));
}

/**
 * A price and the two things needed to read it: which generation stored it, and which asset it is
 * denominated in.
 *
 * Carried together because they are always needed together and are always found in the same place
 * — the market row — while the prices themselves arrive on five other shapes that carry neither.
 * Passing this rather than two loose numbers is what stops a call site from supplying the decimals
 * and forgetting the generation, which is the failure that reads as "the chart is fine, the axis
 * is odd".
 */
export interface QuoteScale {
  generation: Generation;
  /** The QUOTE ASSET's decimals — 6 for USDC and gold, 8 for cbBTC, 18 for MON. */
  quoteDecimals: number;
}

/**
 * The scale for a feed that does not know which market its rows came from.
 *
 * Every price resolved against it comes back `null`, which is the correct answer and not a
 * degraded one: the alternative is a number that is right for generation 1 and a quintillion times
 * wrong for generation 2, with nothing on screen to tell the two apart.
 */
export const UNKNOWN_SCALE: QuoteScale = {
  generation: UNKNOWN_GENERATION,
  // Never consulted — `quotePerWholeToken` returns null before the decimals are reached — but it
  // has to be a number, and 18 is the least surprising one to see in a debugger.
  quoteDecimals: 18,
};
