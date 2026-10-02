/**
 * @jest-environment node
 */
import {
  MAX_TICK,
  MIN_TICK,
  nearestUsableTick,
  priceToTick,
  sqrtRatioAtTick,
  tickToPrice,
} from "../../src/lib/chain/tick-math";

/**
 * Converting between ticks and prices.
 *
 * A range picker needs this and cannot approximate it. The sqrt ratio at a tick decides how much
 * of each token a position takes, so a value that is close but not equal produces amounts the pool
 * disagrees with — the mint reverts, or worse, takes a different ratio than the panel showed.
 *
 * The expected values below come from the vendored `TickMath` itself, printed by a throwaway forge
 * test. Uniswap's algorithm is a chain of twenty fixed-point multiplications and there is no way
 * to be confident a port of it is right except by comparing against the original.
 */
describe("sqrtRatioAtTick", () => {
  const FROM_SOLIDITY: [number, bigint][] = [
    [-887200, 4310618292n],
    [-600000, 7425001144658883n],
    [-300000, 24254261426760301279129n],
    [-138160, 79236137702167542579810491n],
    [-100000, 533968626430936354154228408n],
    [-46080, 7912525539738091750091588668n],
    [-10000, 48055510970269007215549348797n],
    [-200, 78439868342809377387252074393n],
    [0, 79228162514264337593543950336n],
    [200, 80024378775772204256025656563n],
    [10000, 130621891405341611593710811006n],
    [46080, 793312034679948183834879042901n],
    [100000, 11755562826496067164730007768450n],
    [138160, 79220188129070905394287418468253n],
    [600000, 845400776793423922697130608897531771147615n],
    [887200, 1456195216270955103206513029158776779468408838535n],
  ];

  it.each(FROM_SOLIDITY)("matches the vendored library at tick %i", (tick, expected) => {
    expect(sqrtRatioAtTick(tick)).toBe(expected);
  });

  /// Tick 0 is a price of exactly 1, which in Q64.96 is 2^96.
  it("is 2^96 at tick zero", () => {
    expect(sqrtRatioAtTick(0)).toBe(2n ** 96n);
  });

  it("rises with the tick", () => {
    for (let t = -1000; t < 1000; t += 137) {
      expect(sqrtRatioAtTick(t + 1)).toBeGreaterThan(sqrtRatioAtTick(t));
    }
  });

  it("refuses a tick outside the range the pool accepts", () => {
    expect(() => sqrtRatioAtTick(MAX_TICK + 1)).toThrow(/tick/i);
    expect(() => sqrtRatioAtTick(MIN_TICK - 1)).toThrow(/tick/i);
  });
});

describe("prices and ticks", () => {
  /// Each tick is 1.0001x the last, by definition.
  it("moves one tick per 1.0001 of price", () => {
    expect(tickToPrice(0)).toBeCloseTo(1, 12);
    expect(tickToPrice(1)).toBeCloseTo(1.0001, 12);
    expect(tickToPrice(-1)).toBeCloseTo(1 / 1.0001, 12);
  });

  /**
   * Within half a tick, which is the most a round trip can preserve: a tick is a 0.01% step, so a
   * price of a million comes back within about fifty. Asserting absolute closeness would be
   * asserting that ticks are finer than they are.
   */
  it("round-trips a price through a tick, to within half a tick", () => {
    for (const price of [1e-9, 1e-6, 0.01, 1, 100, 1e6]) {
      const back = tickToPrice(priceToTick(price));
      expect(Math.abs(back - price) / price).toBeLessThan(0.00005);
    }
  });

  /**
   * A pool only accepts bounds that are multiples of its tick spacing, so a price the user typed
   * has to be snapped before it can be used. Snapping after computing the sqrt ratio would be too
   * late — the ratio has to be the one at the tick actually passed to `mint`.
   */
  it("snaps a tick to the pool's spacing", () => {
    expect(nearestUsableTick(0, 200)).toBe(0);
    expect(nearestUsableTick(99, 200)).toBe(0);
    expect(nearestUsableTick(101, 200)).toBe(200);
    expect(nearestUsableTick(-101, 200)).toBe(-200);
    expect(nearestUsableTick(-99, 200)).toBe(0);
  });

  /// And never past the ends, where the pool would reject it.
  it("never snaps outside the usable range", () => {
    expect(nearestUsableTick(MAX_TICK, 200)).toBeLessThanOrEqual(887200);
    expect(nearestUsableTick(MIN_TICK, 200)).toBeGreaterThanOrEqual(-887200);
    expect(nearestUsableTick(1e9, 200)).toBe(887200);
    expect(nearestUsableTick(-1e9, 200)).toBe(-887200);
  });

  it("refuses a price that has no tick", () => {
    expect(() => priceToTick(0)).toThrow(/positive/i);
    expect(() => priceToTick(-1)).toThrow(/positive/i);
  });
});
