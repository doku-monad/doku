import { cacheControlFor } from "@/lib/api/cache-policy";

describe("cacheControlFor — the Cache-Control every /api GET carries", () => {
  it("paces block-driven data at one second shared at the edge, always revalidated by the browser", () => {
    for (const p of [
      "/api/markets",
      "/api/markets/0xabc/swaps",
      "/api/markets/0xabc/holders",
      "/api/markets/0xabc/rewards",
      "/api/candlesticks",
      "/api/leaderboard",
      "/api/search",
      "/api/creators/0xabc",
      "/api/explore",
    ]) {
      expect(cacheControlFor(p, "GET")).toBe("public, max-age=0, s-maxage=1, stale-while-revalidate=2");
    }
  });

  it("gives the admin-paced lists a minute", () => {
    for (const p of ["/api/quotes", "/api/quote-prices", "/api/price", "/api/quotes/"]) {
      expect(cacheControlFor(p, "GET")).toBe("public, max-age=60, s-maxage=60, stale-while-revalidate=600");
    }
  });

  it("keeps the indexer status short and public", () => {
    expect(cacheControlFor("/api/status", "GET")).toBe("public, max-age=5, s-maxage=5, stale-while-revalidate=15");
  });

  it("never lets a shared cache serve one wallet's page to another", () => {
    expect(cacheControlFor("/api/accounts/0xabc/swaps", "GET")).toBe("private, max-age=2");
    expect(cacheControlFor("/api/accounts/0xabc/balances", "GET")).toBe("private, max-age=2");
  });

  it("leaves uploads, images, the allowlist, non-GETs and non-API paths alone", () => {
    expect(cacheControlFor("/api/uploads/image", "GET")).toBeUndefined();
    expect(cacheControlFor("/api/img/key", "GET")).toBeUndefined();
    expect(cacheControlFor("/api/allowlist", "GET")).toBeUndefined();
    expect(cacheControlFor("/api/markets", "POST")).toBeUndefined();
    expect(cacheControlFor("/api/uploads/image", "POST")).toBeUndefined();
    expect(cacheControlFor("/explore", "GET")).toBeUndefined();
    expect(cacheControlFor("/apiary", "GET")).toBeUndefined();
  });
});
