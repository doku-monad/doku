/**
 * @jest-environment node
 */
import { POOL_TICK_SPACING } from "../../src/lib/chain/config";
import {
  amountsForRange,
  depositSides,
  FULL_RANGE_TICKS,
  positionAmounts,
  positionValueMon,
  withMintFloor,
} from "../../src/lib/chain/liquidity";
import { presetRange, PRESETS } from "../../src/lib/chain/range";
import { MAX_TICK, MIN_TICK } from "../../src/lib/chain/tick-math";

const Q96 = 2n ** 96n;
const sqrtAt = (price: number) => BigInt(Math.floor(Math.sqrt(price) * Number(Q96)));
const ONE = 10n ** 18n;

/**
 * Which tokens a position needs, and how much of each.
 *
 * This is the whole reason a range picker is worth building. A position is only two-sided while
 * the price is *inside* it. Put the range entirely above the price and it holds one token; put it
 * entirely below and it holds the other. So "deposit a single token" is not a separate feature to
 * bolt on — it is what a range that does not straddle the price already means.
 *
 * Prices here are token1-per-token0, which is what a pool's `sqrtPriceX96` encodes.
 */
describe("which sides a range needs", () => {
  const spot = 0;

  it("needs both while the price is inside the range", () => {
    expect(depositSides({ tickLower: -1000, tickUpper: 1000, tickCurrent: spot })).toEqual({
      needsToken0: true,
      needsToken1: true,
    });
  });

  /**
   * A range entirely above the price is waiting to sell token0, so it is funded with token0 alone.
   * The pool will hand back token1 as the price rises through it.
   */
  it("needs only token0 when the whole range is above the price", () => {
    expect(depositSides({ tickLower: 1000, tickUpper: 2000, tickCurrent: spot })).toEqual({
      needsToken0: true,
      needsToken1: false,
    });
  });

  it("needs only token1 when the whole range is below the price", () => {
    expect(depositSides({ tickLower: -2000, tickUpper: -1000, tickCurrent: spot })).toEqual({
      needsToken0: false,
      needsToken1: true,
    });
  });

  /**
   * The boundaries, which are not symmetric and are easy to state backwards.
   *
   * A tick is a span, not a point: `tickCurrent` equal to `tickLower` means the price sits
   * somewhere *within* the lowest tick of the range, so the position is in range and holds a
   * little of token1. Equal to `tickUpper` it is already past the top, because a range excludes
   * its upper tick — which is exactly how the pool accounts for it.
   */
  it("counts a price at the bottom edge as inside the range", () => {
    expect(depositSides({ tickLower: 0, tickUpper: 1000, tickCurrent: 0 })).toEqual({
      needsToken0: true,
      needsToken1: true,
    });
  });

  it("counts a price at the top edge as already past the range", () => {
    expect(depositSides({ tickLower: -1000, tickUpper: 0, tickCurrent: 0 })).toEqual({
      needsToken0: false,
      needsToken1: true,
    });
  });
});

describe("amounts for a range", () => {
  const sqrtPriceX96 = sqrtAt(1);

  it("pairs both sides for a range around the price", () => {
    const r = amountsForRange({
      sqrtPriceX96,
      tickLower: -1000,
      tickUpper: 1000,
      amount0: ONE,
    });
    expect(r.amount0).toBeGreaterThan(0n);
    expect(r.amount1).toBeGreaterThan(0n);
    // Symmetric range at a price of 1, so the two sides come out near equal.
    expect(Number(r.amount1) / Number(r.amount0)).toBeCloseTo(1, 2);
  });

  it("asks for nothing of token1 when the range sits above the price", () => {
    const r = amountsForRange({ sqrtPriceX96, tickLower: 1000, tickUpper: 2000, amount0: ONE });
    expect(r.amount0).toBeGreaterThan(0n);
    expect(r.amount1).toBe(0n);
  });

  it("asks for nothing of token0 when the range sits below the price", () => {
    const r = amountsForRange({ sqrtPriceX96, tickLower: -2000, tickUpper: -1000, amount1: ONE });
    expect(r.amount1).toBeGreaterThan(0n);
    expect(r.amount0).toBe(0n);
  });

  /**
   * A narrower range holds more liquidity for the same money, which is the entire point of
   * choosing one — and the number a panel has to be able to show honestly.
   */
  it("gives more liquidity for the same deposit as the range narrows", () => {
    const wide = amountsForRange({
      sqrtPriceX96,
      tickLower: -20000,
      tickUpper: 20000,
      amount0: ONE,
    });
    const narrow = amountsForRange({
      sqrtPriceX96,
      tickLower: -1000,
      tickUpper: 1000,
      amount0: ONE,
    });
    expect(narrow.liquidity).toBeGreaterThan(wide.liquidity);
  });

  it("round-trips between the two sides of an in-range position", () => {
    const from0 = amountsForRange({
      sqrtPriceX96,
      tickLower: -5000,
      tickUpper: 5000,
      amount0: ONE,
    });
    const from1 = amountsForRange({
      sqrtPriceX96,
      tickLower: -5000,
      tickUpper: 5000,
      amount1: from0.amount1,
    });
    expect(Number(from1.amount0) / Number(from0.amount0)).toBeCloseTo(1, 6);
  });

  /// Supplying the side a one-sided range does not use cannot conjure a position out of nothing.
  it("refuses the side a one-sided range has no use for", () => {
    expect(() =>
      amountsForRange({ sqrtPriceX96, tickLower: 1000, tickUpper: 2000, amount1: ONE })
    ).toThrow(/token0/i);
  });

  it("refuses a range that is inverted or empty", () => {
    expect(() =>
      amountsForRange({ sqrtPriceX96, tickLower: 1000, tickUpper: 1000, amount0: ONE })
    ).toThrow(/range/i);
    expect(() =>
      amountsForRange({ sqrtPriceX96, tickLower: 2000, tickUpper: 1000, amount0: ONE })
    ).toThrow(/range/i);
  });

  /// Still the widest range the pool accepts, and still what graduation itself mints.
  it("keeps working at the full range", () => {
    const r = amountsForRange({
      sqrtPriceX96: sqrtAt(1e-6),
      ...FULL_RANGE_TICKS,
      amount1: ONE,
    });
    expect(r.amount0).toBeGreaterThan(0n);
    expect(r.amount1).toBeGreaterThan(0n);
  });

  /**
   * The bug that made every deposit revert.
   *
   * v4 refuses a position whose bounds are not multiples of the pool's tick spacing. The full range
   * was hardcoded at ±887200 — correct for Uniswap V3's 1% tier, whose spacing is 200 — while these
   * pools use 60, and `887200 % 60` is 40. So the widest range the UI offered was one the pool
   * rejects outright, and `modifyLiquidities` reverted before it did anything.
   *
   * The bounds also have to sit INSIDE the representable range, which is what rounding inward
   * means: `nearestUsableTick` must not round ±887272 further away from zero.
   */
  it("puts the full range on the pool's own tick spacing", () => {
    // `Math.abs`, because `-887220 % 60` is `-0` and `Object.is(-0, 0)` is false.
    expect(Math.abs(FULL_RANGE_TICKS.tickLower % POOL_TICK_SPACING)).toBe(0);
    expect(Math.abs(FULL_RANGE_TICKS.tickUpper % POOL_TICK_SPACING)).toBe(0);
    expect(FULL_RANGE_TICKS.tickLower).toBeGreaterThanOrEqual(MIN_TICK);
    expect(FULL_RANGE_TICKS.tickUpper).toBeLessThanOrEqual(MAX_TICK);
  });

  /** Every preset, not just Full: all four were snapped to the wrong spacing. */
  it("puts every preset on the pool's tick spacing", () => {
    for (const preset of PRESETS) {
      for (const tickCurrent of [-120_000, -600, 0, 149_015, 800_000]) {
        const range = presetRange(preset, tickCurrent);
        expect(Math.abs(range.tickLower % POOL_TICK_SPACING)).toBe(0);
        expect(Math.abs(range.tickUpper % POOL_TICK_SPACING)).toBe(0);
        expect(range.tickLower).toBeLessThan(range.tickUpper);
      }
    }
  });
});

/**
 * What a position is worth, which is the inverse of funding one.
 *
 * Shown before anyone confirms a withdrawal: "remove liquidity" with no numbers beside it is a
 * button people are right not to press. It has to account for the position's *own* range — a
 * position the price has left holds one token, and valuing it against the live price would report
 * a balance it does not have.
 */
describe("what a position is worth", () => {
  const sqrtPriceX96 = sqrtAt(1);

  it("returns both sides for a position the price is inside", () => {
    const funded = amountsForRange({
      sqrtPriceX96,
      tickLower: -5000,
      tickUpper: 5000,
      amount0: ONE,
    });
    const back = positionAmounts(sqrtPriceX96, funded.liquidity, -5000, 5000);
    expect(Number(back.amount0) / Number(funded.amount0)).toBeCloseTo(1, 6);
    expect(Number(back.amount1) / Number(funded.amount1)).toBeCloseTo(1, 6);
  });

  /// The price has risen through the range, so the position has sold its token0 entirely.
  it("returns one side for a position the price has passed above", () => {
    const funded = amountsForRange({
      sqrtPriceX96,
      tickLower: -5000,
      tickUpper: -1000,
      amount1: ONE,
    });
    const back = positionAmounts(sqrtPriceX96, funded.liquidity, -5000, -1000);
    expect(back.amount0).toBe(0n);
    expect(back.amount1).toBeGreaterThan(0n);
  });

  it("returns the other side for a position the price has not reached", () => {
    const funded = amountsForRange({
      sqrtPriceX96,
      tickLower: 1000,
      tickUpper: 5000,
      amount0: ONE,
    });
    const back = positionAmounts(sqrtPriceX96, funded.liquidity, 1000, 5000);
    expect(back.amount1).toBe(0n);
    expect(back.amount0).toBeGreaterThan(0n);
  });

  it("is nothing for a position with no liquidity", () => {
    expect(positionAmounts(sqrtPriceX96, 0n, -100, 100)).toEqual({ amount0: 0n, amount1: 0n });
  });
});

describe("the floor a mint will accept", () => {
  /**
   * `mint` takes minimums for both sides. The price moves between reading it and the transaction
   * landing, and the contract then takes a different ratio than the panel showed — so without a
   * floor a mint can consume far more of one token than the user agreed to.
   */
  it("lowers both sides by the tolerance", () => {
    const floor = withMintFloor({ amount0: 1000n, amount1: 2000n }, 100);
    expect(floor.amount0Min).toBe(990n);
    expect(floor.amount1Min).toBe(1980n);
  });

  it("refuses a tolerance that removes the floor entirely", () => {
    expect(() => withMintFloor({ amount0: 1n, amount1: 1n }, 10_000)).toThrow();
  });
});

/**
 * The one number a provider actually reads.
 *
 * Both sides at the pool's live price, because that is the price the position would be unwound at
 * — not the indexer's last trade, which can be minutes stale and is a different number from the
 * one the withdrawal will use.
 */
describe("positionValueMon", () => {
  const ONE = 10n ** 18n;

  it("values a MON-only position at its MON", () => {
    expect(positionValueMon(10n * ONE, 0n, 0.5)).toBeCloseTo(10, 9);
  });

  it("converts the token side at the given price", () => {
    expect(positionValueMon(0n, 4n * ONE, 0.25)).toBeCloseTo(1, 9);
  });

  it("adds both sides", () => {
    expect(positionValueMon(ONE, 2n * ONE, 1.5)).toBeCloseTo(4, 9);
  });

  /**
   * No price is a real state, not an error: a pool whose `slot0` has not been read yet yields
   * none, and whether that shows as a dash is the caller's decision. Returning the MON side rather
   * than NaN keeps the decision at the call site instead of poisoning every total that sums these.
   */
  it("falls back to the MON side when there is no price", () => {
    expect(positionValueMon(3n * ONE, 5n * ONE, 0)).toBeCloseTo(3, 9);
    expect(positionValueMon(3n * ONE, 5n * ONE, Number.NaN)).toBeCloseTo(3, 9);
  });
});
