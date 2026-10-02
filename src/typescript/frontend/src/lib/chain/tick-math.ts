/**
 * Ticks and the prices at them.
 *
 * A range picker cannot approximate this. The sqrt ratio at a tick decides how much of each token
 * a position takes, so a value that is close but not equal produces amounts the pool disagrees
 * with — the mint reverts, or worse takes a different ratio than the panel showed.
 *
 * `sqrtRatioAtTick` is a port of Uniswap's `TickMath`, which is Solidity 0.7.6 and cannot be
 * imported here. It is a chain of twenty fixed-point multiplications by precomputed constants, and
 * there is no way to be confident a port of it is right except by comparing against the original —
 * so `tests/unit/tick-math.test.ts` pins sixteen ticks against values printed from the vendored
 * library itself.
 *
 * The *inverse* is deliberately not a port. Going from a price to a tick happens only when someone
 * types a bound into the panel, and the result is immediately snapped to the pool's tick spacing —
 * so a logarithm is exact enough, and `sqrtRatioAtTick` is then used to get the ratio that
 * actually matters. Porting `getTickAtSqrtRatio` as well would be two hundred lines of bit-twiddling
 * to make a number more precise than the thing it is rounded into.
 */

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

/** `1.0001`, the ratio between one tick and the next. */
const TICK_BASE = 1.0001;

/**
 * The Q128.128 constants `TickMath` multiplies through, one per bit of the tick.
 *
 * Each is `1.0001^(2^i)` in Q128.128 — so multiplying the ones whose bit is set composes
 * `1.0001^tick` without ever evaluating a power.
 */
const RATIOS: bigint[] = [
  0xfffcb933bd6fad37aa2d162d1a594001n,
  0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n,
  0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n,
  0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
];

const Q128 = 1n << 128n;
const Q32 = 1n << 32n;
const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * The price at a tick, as `sqrt(price) * 2^96`.
 *
 * Exactly Uniswap's algorithm, including the final rounding-up: the pool stores the ratio as a
 * `uint160`, and rounding down would put the boundary a hair inside the range rather than at it.
 */
export function sqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick)) throw new Error(`tick must be a whole number: ${tick}`);
  if (tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error(`tick ${tick} is outside the range a pool accepts`);
  }

  const absTick = BigInt(Math.abs(tick));
  let ratio = (absTick & 1n) !== 0n ? RATIOS[0]! : Q128;
  for (let i = 1; i < RATIOS.length; i++) {
    if ((absTick & (1n << BigInt(i))) !== 0n) {
      ratio = (ratio * RATIOS[i]!) >> 128n;
    }
  }

  // A positive tick is the reciprocal of the negative one, taken in the same fixed point.
  if (tick > 0) ratio = MAX_UINT256 / ratio;

  // Q128.128 down to Q64.96, rounding up.
  return (ratio >> 32n) + (ratio % Q32 === 0n ? 0n : 1n);
}

/** The price at a tick, as an ordinary number. For display and for reading typed input back. */
export function tickToPrice(tick: number): number {
  return TICK_BASE ** tick;
}

/**
 * The tick nearest a price.
 *
 * Rounded, not truncated: a bound typed as a price should land on the closest tick rather than
 * always the lower one, which would bias every range downward by up to a tick.
 */
export function priceToTick(price: number): number {
  if (!(price > 0)) throw new Error(`a price must be positive: ${price}`);
  return Math.round(Math.log(price) / Math.log(TICK_BASE));
}

/**
 * The nearest tick a pool of this spacing will accept, clamped to the usable range.
 *
 * `MIN_TICK` and `MAX_TICK` themselves are usually not multiples of the spacing — -887272 is not a
 * multiple of 200 — so the ends are rounded *inward*. Rounding outward gives a bound `mint`
 * rejects, which is a confusing failure to debug from a panel.
 */
export function nearestUsableTick(tick: number, spacing: number): number {
  if (!Number.isInteger(spacing) || spacing <= 0) {
    throw new Error(`tick spacing must be a positive whole number: ${spacing}`);
  }
  // `|| 0` normalises negative zero, which `Math.round` produces for any small negative tick and
  // which is not `0` to `Object.is` — enough to make an equality check fail for no visible reason.
  const snapped = Math.round(tick / spacing) * spacing || 0;
  const floor = Math.ceil(MIN_TICK / spacing) * spacing;
  const ceiling = Math.floor(MAX_TICK / spacing) * spacing;
  return Math.min(ceiling, Math.max(floor, snapped));
}
