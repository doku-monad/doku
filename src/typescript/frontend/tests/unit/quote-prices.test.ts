/**
 * @jest-environment node
 */
import {
  buildPriceDocument,
  COIN_IDS,
  NATIVE_ADDRESS,
  PRICED_QUOTES,
  pricedCount,
} from "../../src/lib/prices/quote-prices";

const upstream = {
  monad: { usd: 0.0254 },
  ethereum: { usd: 2470.77 },
  bitcoin: { usd: 78343 },
  "tether-gold": { usd: 4386.87 },
};

describe("buildPriceDocument", () => {
  it("keys every listed asset by address, id and symbol", () => {
    const prices = buildPriceDocument(upstream);
    for (const quote of PRICED_QUOTES) {
      expect({ symbol: quote.symbol, usd: prices[quote.address] }).toEqual({
        symbol: quote.symbol,
        usd: expect.any(Number),
      });
      expect(prices[quote.id]).toBe(prices[quote.address]);
      expect(prices[quote.symbol]).toBe(prices[quote.address]);
    }
  });

  it("prices the native asset under the zero address the registry uses", () => {
    expect(buildPriceDocument(upstream)[NATIVE_ADDRESS]).toBe(0.0254);
  });

  it("gives both bitcoin rails the same price", () => {
    const prices = buildPriceDocument(upstream);
    expect(prices.wbtc).toBe(78343);
    expect(prices.cbbtc).toBe(78343);
  });

  it("omits an asset the upstream did not price rather than defaulting it", () => {
    const prices = buildPriceDocument({ ...upstream, "tether-gold": undefined });
    expect(prices.xaut0).toBeUndefined();
    // A zero would be accepted as a price and rank gold last while looking like a working feed.
    expect(Object.values(prices).every((v) => v > 0)).toBe(true);
  });

  it("omits a zero, a negative and a non-numeric price", () => {
    for (const bad of [0, -1, "n/a", null, {}]) {
      const prices = buildPriceDocument({ ...upstream, monad: { usd: bad } });
      expect({ bad, usd: prices[NATIVE_ADDRESS] }).toEqual({ bad, usd: undefined });
    }
  });

  it("accepts a numeric string, which is how some feeds answer", () => {
    expect(buildPriceDocument({ monad: { usd: "0.0254" } })[NATIVE_ADDRESS]).toBe(0.0254);
  });

  it("survives a malformed document instead of throwing", () => {
    for (const bad of [null, undefined, "", 7, []]) {
      expect(buildPriceDocument(bad)).toEqual({});
    }
  });

  it("counts only the assets that were actually priced", () => {
    expect(pricedCount(buildPriceDocument(upstream))).toBe(PRICED_QUOTES.length);
    expect(pricedCount(buildPriceDocument({ monad: { usd: 1 } }))).toBe(1);
    expect(pricedCount({})).toBe(0);
  });

  it("requests each upstream id once even though two assets share one", () => {
    expect(COIN_IDS).toHaveLength(new Set(COIN_IDS).size);
    expect(COIN_IDS).toContain("bitcoin");
  });
});
