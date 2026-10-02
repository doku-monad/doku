/* `@/sdk/utils/misc`, not the `@/sdk/utils` barrel: the barrel re-exports `./validation`, which
   imports zod (~59 kB minified). This module backs `FormattedNumber`, so that barrel put zod on
   every route in the product to borrow one bigint-to-number helper. */
import { toNominal } from "@/sdk/utils/misc";
import type { AnyNumberString, Flatten } from "@/sdk-types";

/**
 * Sliding precision will show `decimals` decimals when Math.abs(number) is
 * above 1 and `decimals` significant digits when the number is below 1.
 *
 * Fixed will always show `decimals` digits.
 */
type FormattedNumberStyle = "sliding-precision" | "fixed";

// Must be an independent type for `Flatten<...>` to work properly.
type MaybeNominalizeProps =
  | {
      value: bigint;
      nominalize: true;
    }
  | {
      value: AnyNumberString;
      nominalize?: undefined | false;
    };

export type FormatNumberStringProps = Flatten<
  MaybeNominalizeProps & {
    decimals?: number;
    style?: FormattedNumberStyle;
  }
>;

/**
 * Formats a number, bigint, or string into a decimalized string with a fixed or sliding precision format.
 *
 * @param value the bigint or number passed in
 * @param nominalize whether or not it should call @see toNominal on the value
 * @param decimals the number of decimals or significant figures to show, depending on the `style`
 * @param style @see {@link FormattedNumberStyle}
 */
export const formatNumberString = ({
  value,
  decimals,
  nominalize = false,
  style = "sliding-precision",
}: FormatNumberStringProps) => {
  if (nominalize && typeof value !== "bigint") {
    throw new Error("Input value needs to be a bigint.");
  }
  const num = nominalize ? toNominal(value as bigint) : Number(value);
  /*
   * `decimals: 0` takes the fraction branch even under sliding precision.
   *
   * `Intl.NumberFormat` accepts 1 through 21 for `maximumSignificantDigits` and throws a
   * `RangeError` on 0 rather than rounding — and `decimals={0}` is simply how a caller asks for a
   * whole number. The board's market count does exactly that, so the moment that count was zero,
   * sliding precision sent it down the significant-digits branch and the constructor threw. The
   * throw happens inside `FormattedNumber`'s `useMemo`, i.e. during render, so it escaped to the
   * route's error boundary: searching the board for a string that matched nothing replaced the
   * whole page with "This page didn't load" instead of the empty state written for it, and so did
   * every zero-count pair chip, an indexer outage, and a deployment with no markets in it yet.
   *
   * Zero significant digits has no useful reading in any case. Somebody asking for none is asking
   * for a whole number, which is what the fraction branch prints.
   */
  const format =
    style === "fixed" || Math.abs(num) >= 1 || decimals === 0
      ? {
          maximumFractionDigits: decimals,
          minimumFractionDigits: style === "fixed" ? decimals : undefined,
        }
      : { maximumSignificantDigits: decimals };
  const formatter = new Intl.NumberFormat("en-US", format);
  return formatter.format(num);
};
