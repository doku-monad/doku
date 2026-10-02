/**
 * The pulse a market card gives when a trade lands on it — green for a buy, red for a sell.
 *
 * Feedback, not data, which is why it expires on its own. A flash that outlives its trade is worse
 * than no flash: a card glowing green minutes after the buy says something untrue about what is
 * happening right now, and a page left open all afternoon would end up with every card lit.
 */

/** How long a card stays lit. Long enough to notice across a grid, short enough to mean "just". */
export const FLASH_MS = 2_400;

export interface TradeFlash {
  isBuy: boolean;
  at: number;
}

export type TradeFlashes = Record<string, TradeFlash>;

/** Note a trade, replacing anything already showing for that market. */
export function recordFlash(
  flashes: TradeFlashes,
  market: string,
  isBuy: boolean,
  now: number,
): TradeFlashes {
  return { ...flashes, [market]: { isBuy, at: now } };
}

/**
 * Drop the flashes that have run their course.
 *
 * Returns the *same object* when nothing expired. A fresh object every tick would re-render the
 * whole grid several times a second for no visible change, which is exactly the cost this
 * decoration is not worth paying.
 */
export function pruneFlashes(flashes: TradeFlashes, now: number): TradeFlashes {
  const live = Object.entries(flashes).filter(([, f]) => now - f.at < FLASH_MS);
  if (live.length === Object.keys(flashes).length) return flashes;
  return Object.fromEntries(live);
}
