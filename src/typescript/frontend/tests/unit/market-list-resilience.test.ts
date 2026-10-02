/**
 * @jest-environment node
 */
import { toMarketModelsSkippingBad } from "../../src/lib/queries/market-list";
/*
 * A whole row, typed as one.
 *
 * This was a partial literal, which is a poor fixture for a test about MALFORMED rows: the thing
 * being asserted is that one bad column is survived, and a fixture already missing twenty columns
 * cannot tell a deliberate defect from an accidental one.
 */
import { marketRow } from "../fixtures/market-row";

const good = marketRow({
  market_address: "0xaaa",
  token_address: "0xbbb",
  symbol_key: "0xk",
  creator: "0xc",
  block_number: "1",
  tx_hash: "0xt",
  created_at: "2026-08-22T00:00:00.000Z",
  quote_raised: "1000000000000000000",
  last_price: "1000000",
  volume_quote: "1000000000000000000",
  trade_count: 1,
  holders: 1,
  market_cap: "1000000000000000000",
  ath_market_cap: "1000000000000000000",
  volume_24h: "1000000000000000000",
});

/**
 * One unparseable market must not take the rest of the grid with it.
 *
 * `BigInt` rejects any string carrying a decimal point, and a SQL cast in the wrong place rendered
 * a never-traded market's cap as "0.0000…0". Mapping the list with a bare `.map` meant that single
 * row threw and the page fell back to its empty state — eleven perfectly good markets replaced by
 * "no markets yet", which reads as the protocol being empty rather than as a parsing bug.
 */
describe("mapping a market list", () => {
  it("maps every market when they are all well formed", () => {
    expect(toMarketModelsSkippingBad([good, { ...good, market_address: "0xccc" }])).toHaveLength(2);
  });

  it("keeps the good markets when one cannot be parsed", () => {
    const bad = { ...good, market_address: "0xbad", ath_market_cap: "0.000000000000000000" };
    const models = toMarketModelsSkippingBad([good, bad, { ...good, market_address: "0xccc" }]);
    expect(models).toHaveLength(2);
    expect(models.map((m) => m.market.marketAddress)).not.toContain("0xbad");
  });

  /// Dropping a row silently is its own failure. It has to be visible to whoever looks.
  it("reports what it dropped", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    toMarketModelsSkippingBad([{ ...good, market_cap: "not a number" }]);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/market/i);
    warn.mockRestore();
  });

  it("returns nothing for nothing, without complaining", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(toMarketModelsSkippingBad([])).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
