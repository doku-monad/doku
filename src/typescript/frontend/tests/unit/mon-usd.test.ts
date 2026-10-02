/**
 * @jest-environment node
 */
import { isFresh, MAX_PRICE_AGE_MS, readPriceAt, toUsd } from "../../src/lib/prices/mon-usd";

describe("price extraction", () => {
  it("reads a nested path, the shape CoinGecko returns", () => {
    expect(readPriceAt({ monad: { usd: 1.23 } }, "monad.usd")).toBe(1.23);
  });

  it("reads a top-level value", () => {
    expect(readPriceAt({ usd: 4.5 }, "usd")).toBe(4.5);
  });

  it("accepts a numeric string, which plenty of APIs return", () => {
    expect(readPriceAt({ price: "2.50" }, "price")).toBe(2.5);
  });

  it("returns null when the path is not there", () => {
    expect(readPriceAt({ monad: {} }, "monad.usd")).toBeNull();
    expect(readPriceAt({}, "a.b.c")).toBeNull();
    expect(readPriceAt(null, "usd")).toBeNull();
  });

  /**
   * Zero is the dangerous one.
   *
   * It is a number, it passes every type check, and it makes every dollar figure on the site read
   * $0.00 — which looks like a market with no value rather than a broken price feed.
   */
  it("rejects zero, negatives and non-finite values", () => {
    expect(readPriceAt({ usd: 0 }, "usd")).toBeNull();
    expect(readPriceAt({ usd: -1 }, "usd")).toBeNull();
    expect(readPriceAt({ usd: "not a number" }, "usd")).toBeNull();
    expect(readPriceAt({ usd: Infinity }, "usd")).toBeNull();
  });
});

describe("staleness", () => {
  const now = 1_800_000_000_000;

  it("accepts a recent quote", () => {
    expect(isFresh({ usd: 1, fetchedAt: now - 1000 }, now)).toBe(true);
  });

  /// A stale price still renders and still looks live. Treating it as absent means the app falls
  /// back to MON, which cannot be out of date.
  it("treats an old quote as no quote at all", () => {
    expect(isFresh({ usd: 1, fetchedAt: now - MAX_PRICE_AGE_MS - 1 }, now)).toBe(false);
    expect(toUsd(100, { usd: 2, fetchedAt: now - MAX_PRICE_AGE_MS - 1 }, now)).toBeNull();
  });

  it("has no USD without a quote", () => {
    expect(isFresh(null, now)).toBe(false);
    expect(toUsd(100, null, now)).toBeNull();
  });

  it("converts against a fresh quote", () => {
    expect(toUsd(100, { usd: 2.5, fetchedAt: now }, now)).toBe(250);
  });
});
