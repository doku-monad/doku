/**
 * @jest-environment node
 */
import {
  FULL_RANGE_LOWER,
  FULL_RANGE_UPPER,
  isFullRange,
  monPerTokenToTick,
  presetRange,
  PRESETS,
  rangeAsMonPerToken,
  rangeFromMonPerToken,
  TICK_SPACING,
  tickToMonPerToken,
} from "../../src/lib/chain/range";

/**
 * Saying a range in the direction people read it.
 *
 * A pool prices token1 per token0, and which of those is MON depends on which address sorts first
 * — so on half of all markets the ticks run opposite to the price the rest of the app shows. Get
 * that wrong and the panel presents a range that looks correct and sits on the wrong side of the
 * market: the position is one-sided when it should straddle, or funded in the token it does not
 * need.
 */
describe("range presets", () => {
  it("centres a preset on the current price", () => {
    const r = presetRange(PRESETS.find((p) => p.id === "mid")!, 0);
    expect(r.tickLower).toBeLessThan(0);
    expect(r.tickUpper).toBeGreaterThan(0);
    expect(Math.abs(r.tickLower)).toBeCloseTo(Math.abs(r.tickUpper), -2);
  });

  it("gives narrower ticks for a narrower preset", () => {
    const wide = presetRange(PRESETS.find((p) => p.id === "wide")!, 0);
    const tight = presetRange(PRESETS.find((p) => p.id === "tight")!, 0);
    expect(tight.tickUpper - tight.tickLower).toBeLessThan(wide.tickUpper - wide.tickLower);
  });

  it("gives the widest usable bounds for the full preset", () => {
    const r = presetRange(PRESETS.find((p) => p.id === "full")!, 0);
    expect(isFullRange(r)).toBe(true);
    expect(Math.abs(r.tickLower % TICK_SPACING)).toBe(0);
    expect(Math.abs(r.tickUpper % TICK_SPACING)).toBe(0);
  });

  /// A preset around a price far from tick zero has to move with it, or every market but one gets
  /// a range sitting somewhere else entirely.
  it("follows the market's current tick", () => {
    const here = presetRange(PRESETS.find((p) => p.id === "mid")!, -138_000);
    expect(here.tickLower).toBeLessThan(-138_000);
    expect(here.tickUpper).toBeGreaterThan(-138_000);
  });

  it("snaps every preset to the pool's spacing", () => {
    for (const preset of PRESETS) {
      const r = presetRange(preset, 12_345);
      expect(Math.abs(r.tickLower % TICK_SPACING)).toBe(0);
      expect(Math.abs(r.tickUpper % TICK_SPACING)).toBe(0);
    }
  });
});

describe("prices in MON per token", () => {
  /// When the market's token is token0, the pool's price already is MON per token.
  it("reads a tick straight through when the token sorts first", () => {
    expect(tickToMonPerToken(0, true)).toBeCloseTo(1, 9);
    expect(tickToMonPerToken(10_000, true)).toBeGreaterThan(1);
  });

  /// When MON is token0, the pool prices tokens per MON, so it has to be turned over.
  it("inverts a tick when MON sorts first", () => {
    expect(tickToMonPerToken(10_000, false)).toBeLessThan(1);
    expect(tickToMonPerToken(10_000, false)).toBeCloseTo(1 / tickToMonPerToken(10_000, true), 9);
  });

  it("round-trips a price through a tick and back", () => {
    for (const marketTokenIsToken0 of [true, false]) {
      for (const price of [1e-7, 1e-3, 1, 1e3]) {
        const back = tickToMonPerToken(
          monPerTokenToTick(price, marketTokenIsToken0),
          marketTokenIsToken0
        );
        expect(Math.abs(back - price) / price).toBeLessThan(0.02);
      }
    }
  });

  /**
   * The direction flip, which is the part that silently breaks. On a market where MON sorts first
   * the *lower* price is the *upper* tick, so a range built from two prices has to come back
   * ordered by tick rather than by the order they were typed.
   */
  it("orders a range by tick, whichever way the prices map", () => {
    for (const marketTokenIsToken0 of [true, false]) {
      const r = rangeFromMonPerToken(0.5, 2, marketTokenIsToken0);
      expect(r.tickLower).toBeLessThan(r.tickUpper);
    }
  });

  it("reports a range's bounds low price first, whichever way it maps", () => {
    for (const marketTokenIsToken0 of [true, false]) {
      const { low, high } = rangeAsMonPerToken(
        { tickLower: -5000, tickUpper: 5000 },
        marketTokenIsToken0
      );
      expect(low).toBeLessThan(high);
    }
  });

  it("round-trips a range through prices and back", () => {
    for (const marketTokenIsToken0 of [true, false]) {
      /*
       * Expressed in multiples of the pool's spacing rather than as literals.
       *
       * A round trip through prices snaps back to a usable tick, so only an already-usable tick can
       * survive it. These were -4000 and 6000 — both multiples of 200, which was the spacing this
       * file was written against and is not the spacing the pool uses.
       */
      const original = { tickLower: -67 * TICK_SPACING, tickUpper: 100 * TICK_SPACING };
      const { low, high } = rangeAsMonPerToken(original, marketTokenIsToken0);
      const back = rangeFromMonPerToken(low, high, marketTokenIsToken0);
      expect(back.tickLower).toBe(original.tickLower);
      expect(back.tickUpper).toBe(original.tickUpper);
    }
  });

  it("clamps a price beyond what any pool can hold", () => {
    expect(monPerTokenToTick(1e60, true)).toBeLessThanOrEqual(FULL_RANGE_UPPER);
    expect(monPerTokenToTick(1e-60, true)).toBeGreaterThanOrEqual(FULL_RANGE_LOWER);
  });
});
