import { describe, expect, it } from "vitest";

import { GEN2_PRICE_SCALE_UP } from "../src/indexer/generations.js";
import { curveSpotPrice, poolSpotPrice, PRICE_SCALE } from "../src/indexer/processing/price.js";

/**
 * What "the price" of a market is.
 *
 * It used to be a trade's average execution price — the MON paid divided by the tokens received.
 * That is a real number and it is not the price: a buy's average sits below the price it leaves
 * behind, and a sell's average sits above it. On a live testnet market a 3 MON buy followed by a
 * 1.3 MON sell printed 1.43e-7 and then 2.02e-7, so the chart rose 41% on a sell and market cap
 * rose with it. Both moved in the direction opposite to what happened.
 *
 * The curve's spot price is a function of what has been raised, and every event carries that
 * figure precisely so it can be derived rather than inferred from amounts.
 */
describe("curve spot price", () => {
  const target = 10n * 10n ** 18n;

  it("rises with what has been raised", () => {
    const at = (raised: bigint) => curveSpotPrice(raised, target);
    expect(at(1n * 10n ** 18n)).toBeGreaterThan(at(0n));
    expect(at(5n * 10n ** 18n)).toBeGreaterThan(at(1n * 10n ** 18n));
    expect(at(target)).toBeGreaterThan(at(5n * 10n ** 18n));
  });

  /**
   * The property the old figure broke. Selling lowers what has been raised, so it must lower the
   * price — whatever the average execution price of the sell happened to be.
   */
  it("falls when a sell reduces what has been raised", () => {
    const afterBuy = curveSpotPrice(2_990_200_000_000_000_000n, target);
    const afterSell = curveSpotPrice(1_713_800_000_000_000_000n, target);
    expect(afterSell).toBeLessThan(afterBuy);
  });

  /// Same raise, same price, regardless of how many trades got there.
  it("depends only on the amount raised", () => {
    expect(curveSpotPrice(3n * 10n ** 18n, target)).toBe(curveSpotPrice(3n * 10n ** 18n, target));
  });

  /// A market with a larger target sells the same supply over more MON, so each token is worth
  /// more at the same fraction of the way along.
  it("scales with the target", () => {
    const small = curveSpotPrice(1n * 10n ** 18n, 10n * 10n ** 18n);
    const large = curveSpotPrice(100n * 10n ** 18n, 1000n * 10n ** 18n);
    expect(large).toBeGreaterThan(small);
  });

  it("is positive at launch, before anything is raised", () => {
    expect(curveSpotPrice(0n, target)).toBeGreaterThan(0n);
  });

  it("treats a negative or absent raise as zero rather than throwing", () => {
    expect(curveSpotPrice(-1n, target)).toBe(curveSpotPrice(0n, target));
  });

  it("has no price without a target", () => {
    expect(curveSpotPrice(1n, 0n)).toBe(0n);
  });
});

/**
 * After graduation the curve is closed and its `quoteRaised` never moves again, so deriving a
 * graduated market's price from it would freeze the chart at the moment it graduated — while the
 * pool beside it keeps trading. V3 reports the exact post-swap price in the event itself.
 */
describe("pool spot price", () => {
  const Q96 = 2n ** 96n;
  /** `sqrtPriceX96` for a given token1-per-token0 ratio. */
  const sqrtFor = (ratio: number) => BigInt(Math.floor(Math.sqrt(ratio) * Number(Q96)));

  /**
   * Direction, which is the half that silently inverts. V3 sorts a pool's tokens by address, so
   * which side is MON is a property of the addresses rather than of the protocol — and getting it
   * backwards yields the reciprocal, a price wrong by orders of magnitude that still renders.
   */
  it("reads token1-per-token0 directly when the market token is token0", () => {
    // 1 token = 5 MON.
    const price = poolSpotPrice(sqrtFor(5), true);
    expect(Number(price) / 1e18).toBeCloseTo(5, 6);
  });

  it("inverts when the market token is token1", () => {
    // 1 MON = 5 tokens, so a token is 0.2 MON.
    const price = poolSpotPrice(sqrtFor(5), false);
    expect(Number(price) / 1e18).toBeCloseTo(0.2, 6);
  });

  it("has no price at zero", () => {
    expect(poolSpotPrice(0n, true)).toBe(0n);
    expect(poolSpotPrice(0n, false)).toBe(0n);
  });

  /**
   * Real markets price a token far below one MON, and the naive `sqrtPriceX96 ** 2 / 2 ** 192`
   * truncates such a ratio to zero in integer arithmetic before the 1e18 scaling is applied.
   */
  it("keeps precision on a token worth a tiny fraction of a MON", () => {
    const price = poolSpotPrice(sqrtFor(0.0000002), true);
    expect(price).toBeGreaterThan(0n);
    expect(Number(price) / 1e18).toBeCloseTo(0.0000002, 12);
  });

  /**
   * Pins the SCALE ARGUMENT: passed all the way into the division, a ratio too coarse for
   * generation 1's 1e18 fixed point survives at generation 2's 1e36.
   *
   * NOT THE REGRESSION GUARD for Task 25's gold bug. That bug was never reachable from a unit
   * test of this function at any scale: it lived in the CALLER, which used to call
   * `poolSpotPrice` at generation 1's scale and multiply generation 2's extra 1e18 onto whatever
   * came back -- by then this function had already floored the coarse ratio to zero, and
   * multiplying zero cannot undo that. The real guard, which exercises the actual call site and
   * goes red if that hunk is reverted, is in `test/gen2-trades.test.ts`.
   */
  it("keeps a gold-shaped ratio nonzero at generation 2's scale, where generation 1's truncates it", () => {
    // One whole market token (1e18 raw base units) worth 0.02 raw units of a six-decimal quote --
    // gold's own shape, and the exact ratio Task 25's fork test found broken.
    const ratio = 2e-20;
    const sqrtPriceX96 = sqrtFor(ratio);

    expect(poolSpotPrice(sqrtPriceX96, true, PRICE_SCALE)).toBe(0n);

    const price = poolSpotPrice(sqrtPriceX96, true, PRICE_SCALE * GEN2_PRICE_SCALE_UP);
    expect(price).toBeGreaterThan(0n);
    expect(Number(price) / 1e36 / ratio).toBeCloseTo(1, 6);
  });
});
