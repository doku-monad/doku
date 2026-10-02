/**
 * The slippage tolerance's bounds — one rule, read by everything that touches the number.
 *
 * ## Why it has to be one rule
 *
 * The tolerance is set in a box, kept in `localStorage`, shown back in the box, printed as a
 * "minimum after slippage" row, folded into the zap's two floors, and signed into `minBaseOut` on
 * the direct curve and pool path. Those were five readers of one number with three different ideas
 * of its range: the box clamped to 0.1–5%, the zap clamped to 50%, and the direct path clamped to
 * nothing. So a wallet whose storage still held `10000` from a build that allowed it saw "100" in
 * the box, a 50% floor on a zap, and a floor of ZERO on every ordinary trade — silently, forever,
 * with nothing on screen saying so.
 *
 * Every reader now goes through `clampSlippageBps`, and the ceiling is what the control can
 * actually express. Anything above it is unreachable from the UI, so clamping loses nobody a
 * setting they could have chosen.
 *
 * ## The two ends
 *
 * Below a tenth of a percent an ordinary fill reverts on the curve's own movement between quote
 * and landing. Above five percent the setting has stopped being protection and become a blank
 * cheque for whatever the pool does in the same window. Both ends are lifted or lowered to the
 * bound rather than refused: the trade is still one the trader can have, at the nearest tolerance
 * the app is willing to sign.
 */

/** 0.1%. */
export const MIN_SLIPPAGE_BPS = 10n;

/** 5%. The widest the control offers, and therefore the widest anything downstream will sign. */
export const MAX_UI_SLIPPAGE_BPS = 500n;

/**
 * A setting from anywhere — the box, storage, an older build — brought into range.
 *
 * Fractional basis points are floored: the write path wants a whole number, and rounding down
 * never widens a tolerance. A value that is not a number at all becomes the floor rather than the
 * ceiling, because the one direction this must never fail in is "wider than asked".
 */
export function clampSlippageBps(setting: bigint | number | string | null | undefined): bigint {
  let bps: bigint;
  if (typeof setting === "bigint") {
    bps = setting;
  } else {
    const n = typeof setting === "number" ? setting : Number(setting);
    if (!Number.isFinite(n)) return MIN_SLIPPAGE_BPS;
    bps = BigInt(Math.floor(n));
  }
  if (bps < MIN_SLIPPAGE_BPS) return MIN_SLIPPAGE_BPS;
  if (bps > MAX_UI_SLIPPAGE_BPS) return MAX_UI_SLIPPAGE_BPS;
  return bps;
}
