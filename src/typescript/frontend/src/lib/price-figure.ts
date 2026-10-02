import { type Generation, quotePerWholeTokenNumber } from "@/lib/chain/quote-scale";

/**
 * A last price as a figure, its unit, and the string to print.
 *
 * The sibling of `lib/market-cap`, and it exists for the same reason: a raw column and the two
 * things needed to read it kept being put back together at the call site, once per surface, and one
 * of them always got it wrong. The palette's was the last: it rendered `lastPrice` through
 * `FormattedNumber`'s `nominalize`, which is a hard-coded eighteen-decimal divide — the
 * GENERATION-1 scale, and by coincidence also MON's decimals. On a generation-2 market, whose
 * prices are stored at `quote * 1e36 / base`, that leaves a factor of 1e18 on the number: MONKE's
 * 0.000112 MON printed as 112,363,479,529,932.33. Nothing threw and nothing looked broken, because
 * a price a quintillion times too large is still a number.
 *
 * `nominalize` could not have been made right in place, either — it only accepts a `bigint`, so
 * there is no way to hand it a price that has already had its scale resolved.
 */

export interface PriceFigure {
  /**
   * Whole quote units per whole token, or null where the row could not say which generation stored
   * it.
   *
   * Null is the honest answer and not a degraded one — see `lib/chain/quote-scale`.
   */
  value: number | null;
  /** The quote asset's ticker. A pairs launchpad has five; none of them is assumed. */
  currency: string;
  /** What to print: the figure and its unit, or an em dash. */
  label: string;
}

/**
 * Four places, sliding.
 *
 * Four fraction digits above one and four SIGNIFICANT digits below it, which is the rule the
 * palette already applied through `formatNumberString`'s "sliding-precision" — kept identical so
 * this fix changes the scale of the number and nothing about how it reads. A fixed four decimals
 * would print every bonding-curve price on the board as `0.0001`, and most of them as `0.0000`.
 */
const DIGITS = 4;

const printable = (value: number): string =>
  new Intl.NumberFormat(
    "en-US",
    Math.abs(value) >= 1 ? { maximumFractionDigits: DIGITS } : { maximumSignificantDigits: DIGITS }
  ).format(value);

/**
 * @param rawPrice as stored — quote units per base unit at the market's own generation scale.
 * @param generation the generation of the MARKET this price belongs to, or `UNKNOWN_GENERATION`.
 *        An argument rather than a default, so a caller has to answer the question: a hard-coded
 *        divisor is right for every market that exists today and wrong for the first row of the
 *        other generation that reaches it, which is how this defect was born the first time.
 * @param quote the market's quote asset, for the decimals and the ticker. Six for USDC and gold,
 *        eight for the wrapped bitcoins, eighteen for MON — a separate question from the
 *        generation, and the reason a single global 18 is wrong twice over.
 */
export function priceFigure(
  rawPrice: bigint | string,
  generation: Generation,
  quote: { decimals: number; symbol: string }
): PriceFigure {
  const value = quotePerWholeTokenNumber(rawPrice, generation, quote.decimals);
  return {
    value,
    currency: quote.symbol,
    // An em dash carries no unit: "— MON" claims a denomination for a figure there isn't one of.
    label: value === null || !Number.isFinite(value) ? "—" : `${printable(value)} ${quote.symbol}`,
  };
}
