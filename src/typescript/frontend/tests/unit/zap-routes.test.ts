/**
 * @jest-environment node
 */
import {
  candidateRoutes,
  chooseRoute,
  MAX_ZAP_CANDIDATES,
  MAX_ZAP_HOPS,
  MAX_ZAP_IMPACT_BPS,
  nativeTradingAllowed,
  routeImpactBps,
  sellRoutes,
} from "../../src/lib/chain/zap-routes";

const USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603";
const USDT0 = "0xe7cd86e13ac4309349f30b3435a9d337750fc82d";
const WBTC = "0x0555e30da8f98308edb960aa94c0db47230d2b9c";
const CBBTC = "0xd18b7ec58cdf4876f6afebd3ed1730e4ce10414b";
const GOLD = "0x01bff41798a0bcf287b996046ca68b395dbc1071";
const NATIVE = "0x0000000000000000000000000000000000000000";

describe("which paths are worth quoting", () => {
  it("finds every way to reach an asset, not just the obvious one", () => {
    // WBTC is reachable through USDC and through cbBTC, and the cheaper one is not knowable
    // without asking. Enumerating both is what lets the live quote decide.
    const paths = candidateRoutes(WBTC);
    expect(paths.length).toBeGreaterThan(1);
    const ends = paths.map((p) => p.map((h) => h.to).join(">"));
    expect(ends.some((e) => e.includes(USDC))).toBe(true);
    expect(ends.some((e) => e.includes(CBBTC))).toBe(true);
  });

  it("keeps a direct pool as a candidate even when it is known to be thin", () => {
    // The direct MON/cbBTC pool costs 40% on ten MON today. It stays in the list because "today"
    // has a shelf life, and the quote settles it either way.
    expect(candidateRoutes(CBBTC).some((p) => p.length === 1)).toBe(true);
  });

  it("reaches gold, which pairs with only one asset on the whole chain", () => {
    const paths = candidateRoutes(GOLD);
    expect(paths.length).toBeGreaterThan(0);
    // Every route into gold must pass through USDT0; nothing else pairs with it.
    for (const path of paths) expect(path[path.length - 1]!.from).toBe(USDT0);
  });

  it("offers the shortest paths first, because each hop is a fee and gas", () => {
    for (const asset of [USDC, USDT0, CBBTC, WBTC, GOLD]) {
      const lengths = candidateRoutes(asset).map((p) => p.length);
      expect([...lengths].sort((a, b) => a - b)).toEqual(lengths);
    }
  });

  it("every path starts at native MON, ends at the asset, and never revisits a token", () => {
    for (const asset of [USDC, USDT0, CBBTC, WBTC, GOLD]) {
      for (const path of candidateRoutes(asset)) {
        expect(path[0]!.from).toBe(NATIVE);
        expect(path[path.length - 1]!.to).toBe(asset);
        // A cycle would burn two pool fees to arrive where it started.
        const visited = [path[0]!.from, ...path.map((h) => h.to)];
        expect(new Set(visited).size).toBe(visited.length);
        // Each hop must continue from where the last one ended.
        for (let i = 1; i < path.length; i++) expect(path[i]!.from).toBe(path[i - 1]!.to);
      }
    }
  });

  it("bounds both the hops and the number of candidates", () => {
    // Each candidate costs two quotes on every keystroke, and each hop costs gas and a fee.
    for (const asset of [USDC, USDT0, CBBTC, WBTC, GOLD]) {
      const paths = candidateRoutes(asset);
      expect(paths.length).toBeLessThanOrEqual(MAX_ZAP_CANDIDATES);
      for (const path of paths) expect(path.length).toBeLessThanOrEqual(MAX_ZAP_HOPS);
    }
  });

  it("has nothing to offer for an asset with no pools", () => {
    expect(candidateRoutes("0xdead00000000000000000000000000000000dead")).toEqual([]);
  });

  it("never proposes a market already priced in MON", () => {
    expect(candidateRoutes(NATIVE)).toEqual([]);
  });
});

describe("which paths are worth quoting on the way out", () => {
  it("walks from the asset back to MON, not the other way round", () => {
    for (const path of sellRoutes(USDC)) {
      expect(path[0]!.from).toBe(USDC);
      expect(path[path.length - 1]!.to).toBe(NATIVE);
    }
  });

  it("gets gold home through the one asset it pairs with", () => {
    const paths = sellRoutes(GOLD);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]!.map((h) => h.to)).toEqual([USDT0, NATIVE]);
  });

  it("never proposes a market already priced in MON", () => {
    // Symmetry with the buy side: the proceeds are already MON, so there is nothing to swap.
    expect(sellRoutes(NATIVE)).toEqual([]);
  });

  it("has nothing to offer for an asset with no pools", () => {
    expect(sellRoutes("0xdead00000000000000000000000000000000dead")).toEqual([]);
  });

  it("finds the same set of routes as the buy side, reversed", () => {
    // The two directions must agree on WHICH pools connect the asset to MON, even though each is
    // found by its own walk. What they need not agree on is the ORDER — the candidate budget is
    // spent in whatever sequence each walk reaches its own neighbours — so this compares sets.
    const buy = new Set(candidateRoutes(WBTC).map((p) => p.map((h) => h.to).join(">")));
    const sell = new Set(
      sellRoutes(WBTC).map((p) =>
        [...p]
          .reverse()
          .map((h) => h.from)
          .join(">")
      )
    );
    expect(sell).toEqual(buy);
  });
});

describe("measuring what a route costs at size", () => {
  it("is zero when twice the input returns twice the output", () => {
    expect(routeImpactBps({ amountOut: 200n, halfAmountOut: 100n })).toBe(0);
  });

  it("measures the shortfall against linear in basis points", () => {
    // Half of what a flat pool would return is 5000 bps of impact.
    expect(routeImpactBps({ amountOut: 100n, halfAmountOut: 100n })).toBe(5000);
    expect(routeImpactBps({ amountOut: 180n, halfAmountOut: 100n })).toBe(1000);
  });

  it("reports better-than-linear as zero, never as a negative", () => {
    // Rounding on small integers can beat linear by a unit. That is noise, and a negative impact
    // would pass every ceiling.
    expect(routeImpactBps({ amountOut: 201n, halfAmountOut: 100n })).toBe(0);
  });

  it("treats a route that returns nothing as absent rather than shallow", () => {
    expect(routeImpactBps({ amountOut: 0n, halfAmountOut: 100n })).toBe(10_000);
    expect(routeImpactBps({ amountOut: 100n, halfAmountOut: 0n })).toBe(10_000);
  });

  it("survives a destination whose raw units are coarse", () => {
    /*
     * The failure this replaced. Gold is six decimals and worth thousands an ounce, so one raw
     * unit is nearly half a cent: a tenth-of-a-MON reference quote bought zero of it, and a route
     * that priced correctly at every real size was reported as completely dead. Halving the trade
     * keeps the reference within one power of two of a number that already quoted.
     */
    // 400 MON through the gold route quoted 2241 raw; half of it quoted 1119.
    expect(routeImpactBps({ amountOut: 2241n, halfAmountOut: 1119n })).toBeLessThan(100);
  });
});

describe("choosing between quoted routes", () => {
  const path = (n: number) =>
    Array.from({ length: n }, () => ({ from: NATIVE, to: USDC, fee: 500, tickSpacing: 10 }));

  it("takes the route that returns most, whatever its length", () => {
    const chosen = chooseRoute([
      { path: path(1), amountOut: 100n, impactBps: 4000 },
      { path: path(2), amountOut: 900n, impactBps: 10 },
    ]);
    expect(chosen?.amountOut).toBe(900n);
    expect(chosen?.path).toHaveLength(2);
  });

  it("refuses every route when the best one is still too shallow", () => {
    // The owner's rule: a route that is not deep enough is not offered at all, and the trade falls
    // back to asking for the market's own quote asset. A bad price shown confidently is worse than
    // an option that is absent.
    expect(
      chooseRoute([
        { path: path(1), amountOut: 100n, impactBps: MAX_ZAP_IMPACT_BPS + 1 },
        { path: path(2), amountOut: 90n, impactBps: 9000 },
      ])
    ).toBeNull();
  });

  it("accepts a route exactly at the threshold", () => {
    expect(
      chooseRoute([{ path: path(1), amountOut: 100n, impactBps: MAX_ZAP_IMPACT_BPS }])
    ).not.toBeNull();
  });

  it("ignores a route that failed to quote", () => {
    // A pool that does not exist throws; it arrives here as a zero and must not win by default.
    const chosen = chooseRoute([
      { path: path(1), amountOut: 0n, impactBps: 0 },
      { path: path(2), amountOut: 5n, impactBps: 10 },
    ]);
    expect(chosen?.amountOut).toBe(5n);
  });

  it("has no answer when nothing quoted at all", () => {
    expect(chooseRoute([])).toBeNull();
    expect(chooseRoute([{ path: path(1), amountOut: 0n, impactBps: 0 }])).toBeNull();
  });

  it("sets the threshold somewhere a trader would accept", () => {
    // Measured on Monad: the deep routes sit under 100 bps at $50,000. A threshold this side of a
    // few percent keeps those and drops the dust pools that cost 40%.
    expect(MAX_ZAP_IMPACT_BPS).toBeGreaterThanOrEqual(100);
    expect(MAX_ZAP_IMPACT_BPS).toBeLessThanOrEqual(1000);
  });
});

describe("where the trade panel may offer MON", () => {
  it("everywhere a route exists, except gold, in any spelling", () => {
    for (const asset of [USDC, USDT0, CBBTC, WBTC]) expect(nativeTradingAllowed(asset)).toBe(true);
    expect(nativeTradingAllowed(GOLD)).toBe(false);
    expect(nativeTradingAllowed("0x01BFF41798A0BCF287B996046CA68B395DBC1071")).toBe(false);
  });

  it("leaves gold's routes in place for the launch form", () => {
    expect(candidateRoutes(GOLD).length).toBeGreaterThan(0);
    expect(sellRoutes(GOLD).length).toBeGreaterThan(0);
  });
});
