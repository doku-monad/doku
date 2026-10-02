/**
 * @jest-environment node
 */
import { marketPath } from "../../src/lib/market-path";

const TOKEN = "0xB012e737A1c0Ff7c4Bb0aA8E1c9dD3F0e5A67ED8";

describe("the market page's path", () => {
  it("is keyed by the token address, lowercased", () => {
    // The curve address never appears in a link: it is the indexer's key, not the visitor's.
    expect(marketPath(TOKEN)).toBe(`/market/${TOKEN.toLowerCase()}`);
  });

  it("accepts an already-lowercase address unchanged", () => {
    expect(marketPath(TOKEN.toLowerCase())).toBe(`/market/${TOKEN.toLowerCase()}`);
  });
});
