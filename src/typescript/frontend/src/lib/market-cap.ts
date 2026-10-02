import { quoteAmountNumber } from "@/lib/chain/quote-scale";

/**
 * A market cap as a figure and the unit it is in.
 *
 * Every card on the board used to compute this as `toNominal(marketCap)` and label it "MON".
 * `toNominal` is a fixed eighteen-decimal conversion, so on the pairs launchpad it was wrong twice
 * over: a USDC market's cap of 2,938.78 came out as 0.0000000029 and a gold market's as zero,
 * while a WETH market read correctly and was still labelled MON. The wrong figures printed as a
 * flat "0", which reads as a worthless coin rather than as a unit mistake.
 *
 * Dollars are preferred because they are the only unit that COMPARES. A board sorted on caps
 * denominated in five different assets is not a ranking — 1.19 WETH beats 2,938 USDC on the number
 * and loses on the money — and comparing them is the entire point of quoting markets in different
 * assets.
 */

export interface CapFigure {
  /** The number to print. */
  value: number;
  /** "$" or the quote's own ticker. */
  currency: string;
  /** Dollars lead, tickers follow: `$2,938` but `1.19 WETH`. */
  position: "prefix" | "suffix";
  /** True when this is money and not a quantity of some asset. */
  isUsd: boolean;
}

/**
 * @param capQuote the cap in RAW quote units, as the service sends it — already normalised, so it
 *        takes the quote's decimals and nothing else.
 * @param capUsd the service's own dollar figure, or null where that quote has no price. Null is a
 *        data gap and never "worth nothing", so it falls back to the quote rather than printing $0.
 * @param quote the market's quote asset, for the decimals and the ticker.
 */
export function capFigure(
  capQuote: bigint,
  capUsd: number | null | undefined,
  quote: { decimals: number; symbol: string },
): CapFigure {
  if (capUsd !== null && capUsd !== undefined && Number.isFinite(capUsd)) {
    return { value: capUsd, currency: "$", position: "prefix", isUsd: true };
  }
  return {
    value: quoteAmountNumber(capQuote, quote.decimals),
    currency: quote.symbol,
    position: "suffix",
    isUsd: false,
  };
}
