import { formatUnits, parseUnits } from "viem";

/**
 * The two conversions an amount field makes: raw units to the text somebody sees, and back.
 *
 * The inverse of `amount-display`, which formats an amount for READING. These are for a control
 * somebody types into, where the string has to round-trip back to the same `bigint` it was drawn
 * from — a different job, and the reason they are their own pair rather than a `formatAssetAmount`
 * call with different arguments.
 *
 * ## The crash they were extracted for
 *
 * `SyntaxError: Cannot convert 1418629511979.7036 to a BigInt`, thrown during render, which took
 * the market page down. It lived inside `InputNumeric` and needed two faults at once:
 *
 *   1. **The outbound conversion went through `Number`.** `Number(value) / 10 ** decimals` loses
 *      precision above 2^53 — an 18-decimal balance is comfortably past it — so the text in the box
 *      was already a slightly different number from the amount it was drawn from, carrying a tail
 *      of digits that were rounding noise rather than money.
 *   2. **The inbound conversion handed a fraction to `BigInt`.** `Big(str).mul(10 ** decimals)` is
 *      fractional whenever `str` carries more decimal places than `decimals` allows, and `BigInt()`
 *      throws on a fraction rather than rounding it. `1418629.5119797036` at six decimals is
 *      exactly that: ten places where six fit.
 *
 * The trade panel changes an amount field's scale in ordinary use — the swap widget's
 * `inputDecimals` follows the trade direction and the pay-with choice, so flipping Buy/Sell on a
 * USDC market moves it between 18 and 6 — which is how a string written at one scale came to be
 * re-read at another, and why this was reachable by pressing a button.
 *
 * `formatUnits` and `parseUnits` are exact in both directions, reach for no float, and never emit
 * exponential notation — which `Big.toString()` does above 1e21, and which `BigInt()` also refuses.
 * They are what the rest of this codebase converts amounts with; the field predated that.
 */

/** Raw units as text for the box. Exact at any size, and never in exponential notation. */
export const amountToField = (value: bigint, decimals?: number): string =>
  formatUnits(value, decimals ?? 0);

/**
 * The box's text as raw units. Never throws — a field cannot take the page down.
 *
 * Three things reach this that are not numbers, and none of them is an error worth propagating: the
 * half-typed states `isNumberInConstruction` deliberately allows (`""`, `"."`, `"-"`), a string
 * left over from before the scale changed, and anything a paste put there. All of them mean the
 * field is holding zero right now.
 *
 * Excess decimal places are ROUNDED rather than refused. At most one raw unit moves, only on a
 * string that is already being restated, and the alternative — the behaviour this replaces — is the
 * page not rendering at all.
 */
export const fieldToAmount = (value: string, decimals?: number): bigint => {
  if (isNaN(parseFloat(value))) return 0n;
  try {
    return parseUnits(value, decimals ?? 0);
  } catch {
    return 0n;
  }
};
