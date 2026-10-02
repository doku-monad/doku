/**
 * @jest-environment node
 */
import { capFigure } from "../../src/lib/market-cap";

const MON = { decimals: 18, symbol: "MON" };
const USDC = { decimals: 6, symbol: "USDC" };
const WBTC = { decimals: 8, symbol: "WBTC" };
const GOLD = { decimals: 6, symbol: "XAUt0" };
const WETH = { decimals: 18, symbol: "WETH" };

describe("a market cap and its unit", () => {
  it("prefers dollars, which is the only unit that compares across pairs", () => {
    const f = capFigure(2938775509n, 2938.775509, USDC);
    expect(f).toEqual({ value: 2938.775509, currency: "$", position: "prefix", isUsd: true });
  });

  /**
   * The live figures from the seven opening markets. Every one of these printed as "0 MON" or a
   * wrong unit under the eighteen-decimal conversion the cards used.
   */
  it.each([
    ["USDC", 2938775509n, USDC, 2938.775509],
    ["WBTC", 3735951n, WBTC, 0.03735951],
    ["gold", 664747n, GOLD, 0.664747],
    ["WETH", 1186794243412135318n, WETH, 1.186794243412135],
    ["MON", 112367114066627004934635n, MON, 112367.11406662701],
  ])("falls back to %s in its own decimals, not MON's", (_name, raw, quote, expected) => {
    const f = capFigure(raw as bigint, null, quote as { decimals: number; symbol: string });
    expect(f.value).toBeCloseTo(expected as number, 6);
    expect(f.currency).toBe((quote as { symbol: string }).symbol);
    expect(f.position).toBe("suffix");
    expect(f.isUsd).toBe(false);
  });

  it("does not collapse a real cap to zero, which is how the bug looked", () => {
    // 2,938 USDC read as 0.0000000029 and printed "0"; gold read as exactly 0.
    for (const [raw, quote] of [
      [2938775509n, USDC],
      [3735951n, WBTC],
      [664747n, GOLD],
    ] as const) {
      expect(capFigure(raw, null, quote).value).toBeGreaterThan(0);
    }
  });

  it("never labels a non-MON market MON", () => {
    expect(capFigure(1186794243412135318n, null, WETH).currency).toBe("WETH");
  });

  it("treats a missing dollar figure as a gap, not as zero", () => {
    for (const missing of [null, undefined, Number.NaN]) {
      const f = capFigure(2938775509n, missing, USDC);
      expect(f.isUsd).toBe(false);
      expect(f.value).toBeCloseTo(2938.775509, 6);
    }
  });

  it("prints an honest zero when the market really is worth nothing", () => {
    expect(capFigure(0n, null, USDC).value).toBe(0);
    expect(capFigure(0n, 0, USDC)).toMatchObject({ value: 0, isUsd: true });
  });
});
