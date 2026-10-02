/**
 * Showing a raw on-chain amount to a person, when the asset's decimals are not the app's decimals.
 *
 * ## The bug this exists to make unrepresentable
 *
 * The trade panel printed the swap leg of a MON-funded buy with `toFixed(6)`. On a WBTC-quoted
 * market that renders the truth as a lie: WBTC has EIGHT decimals, one MON is a few cents, and a
 * few cents of bitcoin is about 26 raw units — `0.00000026`. Six fixed places prints `0.000000`.
 *
 * So the panel said "Swap delivers 0.000000 WBTC" directly above "You receive 8,297.6892 TEST".
 * The trade worked. The receipt said the swap that funded it delivered nothing, which reads either
 * as a broken quote or as a market giving tokens away, and both cost the reader their trust in
 * every other number on the panel.
 *
 * It is the same hazard the protocol already documents on the other side: `BondingCurve.sell`
 * warns that on a coarse quote asset an ORDINARY amount rounds to zero — one troy ounce of gold is
 * 1e6 raw units — and refuses such a sale rather than booking it. A display has the same duty.
 * `formatImpactBps` states the rule for percentages: a route that costs something must never claim
 * it is free. This is that rule for amounts.
 *
 * ## The rule
 *
 * **A non-zero amount never renders as zero.** Precision is not a constant here; it is whatever it
 * takes to show the first significant digit, plus enough after it to be useful, bounded by the
 * decimals the asset actually has. A number with more precision than the asset can carry is as
 * misleading as one with less.
 *
 * ## Why the arithmetic is all `bigint` and `string`
 *
 * `Number(formatUnits(v, 18))` is lossy above 2^53, which is nine ordinary tokens at eighteen
 * decimals — so a balance, a market cap or a whale's sell would be rendered from a float that had
 * already dropped digits. Nothing here converts to `Number`. The integer and fractional halves are
 * sliced out of the decimal string of the `bigint` itself.
 */

/** How many places to show when the amount is big enough not to need thinking about. */
const DEFAULT_MIN_PLACES = 6;

/**
 * How many digits to show once the leading zeros are past.
 *
 * Three. `0.00000026` is two, and a third tells a reader whether the next trade moved it; more is
 * noise on a figure nobody is reconciling to the wei.
 */
const DEFAULT_SIGNIFICANT_DIGITS = 3;

export interface AmountDisplayOptions {
  /** Places to show when the amount has an integer part, or is large enough to read. */
  minPlaces?: number;
  /** Digits to keep after the leading zeros, for an amount smaller than `minPlaces` can show. */
  significantDigits?: number;
}

/**
 * A raw amount, as a decimal string, in the asset's own decimals.
 *
 * @param raw      the on-chain integer
 * @param decimals the ASSET'S decimals — never a global. Six for USDC and gold, eight for the
 *                 bitcoins, eighteen for MON. Passing the wrong one is the whole bug class this
 *                 module exists for.
 */
export function formatAssetAmount(
  raw: bigint,
  decimals: number,
  options: AmountDisplayOptions = {}
): string {
  const minPlaces = options.minPlaces ?? DEFAULT_MIN_PLACES;
  const significantDigits = options.significantDigits ?? DEFAULT_SIGNIFICANT_DIGITS;

  // Zero is the one amount that may render as zero, and it renders as a bare "0" rather than
  // "0.000000": trailing zeros on a figure that is exactly nothing are precision theatre.
  if (raw === 0n) return "0";

  const negative = raw < 0n;
  const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals) || "0";
  const fraction = decimals > 0 ? digits.slice(digits.length - decimals) : "";

  const places = fractionPlaces({ whole, fraction, minPlaces, significantDigits, decimals });
  // Sliced, never rounded. Rounding up could turn an amount into one the chain will not honour,
  // and this string sits beside floors the user is about to sign.
  const shown = trimTrailingZeros(fraction.slice(0, places));

  const sign = negative ? "-" : "";
  return shown.length === 0 ? `${sign}${whole}` : `${sign}${whole}.${shown}`;
}

/**
 * How many fractional digits this particular amount needs.
 *
 * An amount with an integer part is readable at `minPlaces` whatever its decimals. An amount
 * smaller than that gets exactly enough places to clear its leading zeros and show
 * `significantDigits` after them — which is what stops `0.00000026` from printing as `0.000000`.
 * Never more than the asset actually has: inventing a nineteenth decimal on an eighteen-decimal
 * token claims a precision that does not exist.
 */
function fractionPlaces(input: {
  whole: string;
  fraction: string;
  minPlaces: number;
  significantDigits: number;
  decimals: number;
}): number {
  const { whole, fraction, minPlaces, significantDigits, decimals } = input;
  const capped = Math.min(minPlaces, decimals);
  if (whole !== "0") return capped;

  /*
   * At least ONE digit past the leading zeros, always. `significantDigits: 0` would otherwise
   * slice exactly the zeros, `trimTrailingZeros` would empty what is left, and this would return
   * "0" for a non-zero amount — defeating the single rule the module exists to enforce. No caller
   * passes zero today; the point is that the rule cannot be switched off by an option.
   */
  const digits = Math.max(1, significantDigits);

  const firstSignificant = fraction.search(/[1-9]/);
  // No significant digit inside the asset's own precision. Unreachable for a non-zero `raw`, since
  // the fraction then holds every digit there is, but a caller passing too few `decimals` would
  // land here and must not get a silent zero.
  if (firstSignificant === -1) return decimals;

  return Math.min(Math.max(capped, firstSignificant + digits), decimals);
}

function trimTrailingZeros(fraction: string): string {
  let end = fraction.length;
  while (end > 0 && fraction[end - 1] === "0") end -= 1;
  return fraction.slice(0, end);
}
