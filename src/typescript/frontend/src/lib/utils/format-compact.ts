import { formatUnits } from "viem";

/**
 * Abbreviates a number to K / M / B.
 *
 * Market caps run from four figures to eight, and printing them in full made the hero tiles
 * ("252,411.4 $") wider than the circles above them. A compact figure is also easier to compare at
 * a glance across a row, which is the whole point of showing it there.
 *
 * Trailing `.0` is dropped so the row doesn't fill with noise like "5.0K".
 */
/**
 * A number with a unit suffix and a few decimals, for a card or a fact row.
 *
 * Two rules that used to be wrong, both found on a market priced in gold:
 *
 * - **The unit is chosen AFTER rounding.** 999,998,495 at two decimals is "1000.00M", which is not
 *   a number anyone writes and, on a supply that has just been burned down from a billion, reads as
 *   if nothing had been burned. Rounding that lands on 1000 promotes to the next unit ("1.00B").
 * - **Below one, significant digits rather than fixed decimals.** 0.000014 XAUt0 is real money
 *   (an ounce of gold) and two fixed decimals print it as "0.00" — the same as nothing. Three
 *   significant digits print "0.000014", "0.05" stays "0.05", and "0.5" stays "0.5".
 */
export const formatCompact = (value: number, decimals = 1): string => {
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  const units: Array<[number, string]> = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (let i = 0; i < units.length; i += 1) {
    const [divisor, unit] = units[i]!;
    if (abs < divisor) continue;
    let scaled = Number((value / divisor).toFixed(decimals));
    let suffix = unit;
    // Rounded onto the next unit: 999.998M at two decimals is 1.00B, not 1000.00M.
    if (Math.abs(scaled) >= 1000 && i > 0) {
      const [bigger, biggerUnit] = units[i - 1]!;
      scaled = Number((value / bigger).toFixed(decimals));
      suffix = biggerUnit;
    }
    return `${scaled.toFixed(decimals).replace(/\.0+$/, "")}${suffix}`;
  }
  // Below a thousand there's room for the real number. Below one, keep the digits that carry it.
  if (abs >= 1) return value.toFixed(0);
  if (abs === 0) return "0";
  return value.toLocaleString("en-US", { maximumSignificantDigits: 3 });
};

/**
 * A token supply for a fact row. Rounds DOWN, always: a supply that has been burned must never
 * print as more than it is, so 999,998,495 is "999.99M", not "1000.00M" and not "1.00B". Exact
 * multiples print without decimals ("1B").
 */
export const formatSupply = (n: number): string => {
  const floor2 = (x: number) => (Math.floor(x * 100) / 100).toFixed(2);
  if (n >= 1_000_000_000) return `${n % 1_000_000_000 === 0 ? n / 1_000_000_000 : floor2(n / 1_000_000_000)}B`;
  if (n >= 1_000_000) return `${n % 1_000_000 === 0 ? n / 1_000_000 : floor2(n / 1_000_000)}M`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
};

/**
 * A quote amount for the progress line — "raised / target SYMBOL" — from raw units.
 *
 * The target is what a market is judged against, so it has to survive the rounding: a 1.80959
 * XAUt0 target printed as "2" and 0.000014 raised printed as "0" gave a reader "0 / 2", both
 * halves of which were wrong. Thousands and up keep one decimal and a unit; below that, three
 * significant digits ("1.81", "10", "306", "0.000014").
 */
export const compactQuote = (value: bigint, decimals: number): string => {
  const whole = Number(formatUnits(value, decimals));
  if (whole >= 1_000_000) return `${(whole / 1_000_000).toFixed(1)}M`;
  if (whole >= 1_000) return `${(whole / 1_000).toFixed(1)}K`;
  if (whole === 0) return "0";
  return whole.toLocaleString("en-US", { maximumSignificantDigits: 3 });
};

export const formatAge = (from: Date, now: number = Date.now()): string => {
  const seconds = Math.max(0, (now - from.getTime()) / 1000);
  const minutes = seconds / 60;
  const hours = minutes / 60;
  const days = hours / 24;

  if (minutes < 60) return `${Math.floor(minutes)}m`;
  if (hours < 24) return `${Math.floor(hours)}h`;
  if (days < 30) return `${Math.floor(days)}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
};
