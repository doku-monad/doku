import { POOL_TICK_SPACING } from "./config";
import { nearestUsableTick, priceToTick, tickToPrice } from "./tick-math";

/**
 * The band of prices a position covers, and how to say it in a direction people read.
 *
 * The band is still the decision that matters most when providing liquidity, but not for the
 * reason it used to be. It used to be a rate decision — a narrow range earned more per MON
 * deposited while the price stayed inside it, and stopped earning the moment it left — because the
 * hook donated part of every swap's levy to whichever position was in range at the post-swap tick.
 * Generation 4 removes that donation (see `LP_LEVY_BPS`), so nothing here earns at any width any
 * more. The band still decides two things that are real without it: how concentrated the deposit
 * is (a narrow one converts fully to the other side sooner as the price moves through it, which is
 * the impermanent-loss exposure), and whether the position is presently two-sided at all — "idle"
 * past its bounds, in the sense of holding only one currency, not in the sense of having stopped
 * being paid.
 *
 * Bounds are expressed as **MON per token**, which is the direction every other price in the app is
 * shown in. A pool's ticks are token1-per-token0, and which of those MON is depends on the two
 * addresses — so on a market where MON sorts first the ticks run the other way, and both the value
 * and the *direction* have to be inverted: the lower bound in MON terms is the upper bound in
 * ticks. Getting that backwards produces a range that looks right and sits on the wrong side of
 * the market.
 */

/** The 1% tier's tick spacing. A pool rejects bounds that are not multiples of it. */
/**
 * Re-exported rather than defined, so the ranges this file snaps can never disagree with the pool
 * the transaction addresses. See `POOL_TICK_SPACING` for what a disagreement cost.
 */
export const TICK_SPACING = POOL_TICK_SPACING;

export interface Range {
  tickLower: number;
  tickUpper: number;
}

export interface RangePreset {
  id: string;
  label: string;
  /** How far either side of the current price, as a multiple. `null` is the whole range. */
  factor: number | null;
  hint: string;
}

export const PRESETS: RangePreset[] = [
  { id: "full", label: "Full", factor: null, hint: "Every price. Never goes idle." },
  { id: "wide", label: "±50%", factor: 1.5, hint: "Wide enough for an ordinary swing." },
  { id: "mid", label: "±20%", factor: 1.2, hint: "More concentrated. One-sided past ±20%." },
  { id: "tight", label: "±5%", factor: 1.05, hint: "Most concentrated. One-sided soonest." },
];

export const FULL_RANGE_LOWER = nearestUsableTick(-887272, TICK_SPACING);
export const FULL_RANGE_UPPER = nearestUsableTick(887272, TICK_SPACING);

/**
 * The ticks for a preset, around the price the pool is at now.
 *
 * Snapped to the pool's spacing here rather than at mint time, so the panel computes its amounts
 * from the same bounds the transaction will carry. Snapping later would show one ratio and send
 * another.
 */
export function presetRange(preset: RangePreset, tickCurrent: number): Range {
  if (preset.factor === null) {
    return { tickLower: FULL_RANGE_LOWER, tickUpper: FULL_RANGE_UPPER };
  }
  const span = priceToTick(preset.factor);
  return {
    tickLower: nearestUsableTick(tickCurrent - span, TICK_SPACING),
    tickUpper: nearestUsableTick(tickCurrent + span, TICK_SPACING),
  };
}

/** Whether a range is the widest this pool accepts. */
export const isFullRange = (range: Range): boolean =>
  range.tickLower <= FULL_RANGE_LOWER && range.tickUpper >= FULL_RANGE_UPPER;

/** A tick as MON per token. */
export function tickToMonPerToken(tick: number, marketTokenIsToken0: boolean): number {
  const raw = tickToPrice(tick);
  return marketTokenIsToken0 ? raw : 1 / raw;
}

/** A MON-per-token price as the nearest usable tick. */
export function monPerTokenToTick(price: number, marketTokenIsToken0: boolean): number {
  return nearestUsableTick(priceToTick(marketTokenIsToken0 ? price : 1 / price), TICK_SPACING);
}

/** The two bounds of a range as MON per token, low first. */
export function rangeAsMonPerToken(
  range: Range,
  marketTokenIsToken0: boolean,
): { low: number; high: number } {
  const a = tickToMonPerToken(range.tickLower, marketTokenIsToken0);
  const b = tickToMonPerToken(range.tickUpper, marketTokenIsToken0);
  return a <= b ? { low: a, high: b } : { low: b, high: a };
}

/**
 * A range from two MON-per-token bounds.
 *
 * The min/max at the end is not defensive tidying: on a market where MON is token0 the conversion
 * genuinely reverses the order, so the lower price maps to the higher tick.
 */
export function rangeFromMonPerToken(
  low: number,
  high: number,
  marketTokenIsToken0: boolean,
): Range {
  const a = monPerTokenToTick(low, marketTokenIsToken0);
  const b = monPerTokenToTick(high, marketTokenIsToken0);
  return { tickLower: Math.min(a, b), tickUpper: Math.max(a, b) };
}
