/**
 * @jest-environment node
 */
import type { SlimMarketRow } from "../../src/lib/api/types";
import { isTickerSlug, resolveFromRows } from "../../src/lib/chain/market-slug";

const row = (ticker: string, address: string): SlimMarketRow =>
  ({
    marketAddress: address,
    // The token, which is what the page is keyed by: distinct from the curve, same case habit.
    tokenAddress: address.replace(/^0x/, "0x7"),
    ticker,
    symbol: ticker,
    name: ticker,
  }) as SlimMarketRow;

const MONKE = row("MONKE", "0xAAAaaAAaAaAAaaAAaAAAaaaAAAAAaaaaAaAaAAA1");
const MON = row("MON", "0xBbbBBbbbBbbBbbBBBbbbbbBBBbBbbbbBbBbBBbB2");

describe("resolving a market slug", () => {
  it("resolves an exact ticker, whatever its case", () => {
    for (const slug of ["MONKE", "monke", "MoNkE"]) {
      const r = resolveFromRows(slug, [MONKE, MON]);
      expect(r.kind).toBe("ticker");
      expect(r.kind === "ticker" && r.curve).toBe(MONKE.marketAddress.toLowerCase());
    }
  });

  it("never resolves on a prefix, which would send a link to the wrong market", () => {
    // The service returns MONKE for a search of "MON" too. Taking the first row would put anyone
    // who typed one market's name on a different market's page.
    const r = resolveFromRows("MON", [MONKE, MON]);
    expect(r.kind === "ticker" && r.curve).toBe(MON.marketAddress.toLowerCase());
  });

  it("reports ambiguity rather than picking one", () => {
    // Generation 2 salts on the creator, so two people may both launch $MOON.
    const a = row("MOON", "0xcCCcCCCcCCCcCCcCcccCCCCcCCcCCCCCcCcCCcC3");
    const b = row("MOON", "0xDddDdDDDdDdddDDdDDDdddDDdDDdDDDddDDddDd4");
    const r = resolveFromRows("moon", [a, b]);
    expect(r.kind).toBe("ambiguous");
    expect(r.kind === "ambiguous" && r.matches).toHaveLength(2);
  });

  it("is not-found when nothing matches, including on an empty result", () => {
    expect(resolveFromRows("nope", [MONKE]).kind).toBe("not-found");
    expect(resolveFromRows("monke", []).kind).toBe("not-found");
  });

  it("falls back to the symbol when a row carries no ticker", () => {
    const legacy = { ...MONKE, ticker: null } as SlimMarketRow;
    expect(resolveFromRows("monke", [legacy]).kind).toBe("ticker");
  });

  it("lowercases the addresses it returns, so they compare equal to what the API sends", () => {
    const r = resolveFromRows("monke", [MONKE]);
    expect(r.kind === "ticker" && r.curve).toBe(r.kind === "ticker" && r.curve.toLowerCase());
    expect(r.kind === "ticker" && r.token).toBe(r.kind === "ticker" && r.token.toLowerCase());
  });

  it("carries the token as well as the curve, because the page is keyed by the token", () => {
    const r = resolveFromRows("monke", [MONKE]);
    expect(r.kind === "ticker" && r.token).toBe(MONKE.tokenAddress.toLowerCase());
    expect(r.kind === "ticker" && r.curve).toBe(MONKE.marketAddress.toLowerCase());
  });

  it("accepts exactly the tickers the factory does", () => {
    for (const ok of ["ab", "MONKE", "a1", "123456789012"]) expect(isTickerSlug(ok)).toBe(true);
    // One character, thirteen, and anything the contract's character check rejects.
    for (const bad of ["a", "1234567890123", "mon-ke", "mon ke", "", "🫥"]) {
      expect(isTickerSlug(bad)).toBe(false);
    }
  });
});
