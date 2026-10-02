/**
 * @jest-environment node
 */
import type { ApiClient } from "../../src/lib/api/client";
import {
  fetchCreator,
  fetchLaunches,
  fetchLeaderboard,
  fetchMarketPositions,
  fetchMarketRewards,
  fetchMarketsPage,
  fetchPositions,
  fetchQuotes,
  fetchUpload,
  searchMarkets,
} from "../../src/lib/api/markets";
import type { HolderRow, MarketRow, SwapRow } from "../../src/lib/api/types";

const stub = () => jest.fn().mockResolvedValue({ items: [], nextCursor: null });
const client = (get: jest.Mock): ApiClient => ({ get }) as unknown as ApiClient;

/**
 * The nine endpoints the client had no function for.
 *
 * Asserted on the path and the query rather than on a response body, because what was missing was
 * the call itself — every one of these was either fetched by hand at a call site or not fetched at
 * all, and the board was paging five hundred markets to do in the browser what `?q=` does in SQL.
 */
describe("the endpoints that had no client", () => {
  it("asks for the board's page WITHOUT a cursor key", async () => {
    const get = stub();
    await fetchMarketsPage(client(get), { sort: "marketCap", page: 2, limit: 30, pair: "usdc" });

    const [path, query] = get.mock.calls[0];
    expect(path).toBe("/markets");
    // The presence of the key is the whole contract: `q.cursor !== undefined` on the service picks
    // cursor mode, so a `cursor: undefined` sitting in this object would quietly select the other
    // shape and the page would come back as `{items, nextCursor}` with no total and no pairCounts.
    expect(Object.keys(query)).not.toContain("cursor");
    expect(query).toMatchObject({ sort: "marketCap", page: 2, limit: 30, pair: "usdc" });
  });

  it("reads a market's fee ledger", async () => {
    const get = stub();
    await fetchMarketRewards(client(get), "0xAbC");
    expect(get).toHaveBeenCalledWith("/markets/0xabc/rewards");
  });

  it("reads an account's launches from the endpoint, not from 500 markets", async () => {
    const get = stub();
    await fetchLaunches(client(get), "0xAbC");
    expect(get).toHaveBeenCalledWith("/accounts/0xabc/launches");
  });

  it("reads a creator's balances", async () => {
    const get = stub();
    await fetchCreator(client(get), "0xAbC");
    expect(get).toHaveBeenCalledWith("/creators/0xabc");
  });

  it("reads the quote registry", async () => {
    const get = stub();
    await fetchQuotes(client(get));
    expect(get).toHaveBeenCalledWith("/quotes");
  });

  it("reads the hero's four lists in one call", async () => {
    const get = jest
      .fn()
      .mockResolvedValue({ window: "24h", movers: [], volume: [], graduated: [], rail: [] });
    await fetchLeaderboard(client(get), "7d");
    expect(get).toHaveBeenCalledWith("/leaderboard", { window: "7d" });
  });

  it("searches on the server", async () => {
    const get = stub();
    await searchMarkets(client(get), "gold", 20);
    expect(get).toHaveBeenCalledWith("/search", { q: "gold", limit: 20 });
  });

  it("reads liquidity positions for an account and for a market", async () => {
    const get = stub();
    await fetchPositions(client(get), "0xAbC", 25);
    expect(get).toHaveBeenCalledWith("/accounts/0xabc/positions", { limit: 25 });

    await fetchMarketPositions(client(get), "0xDeF");
    expect(get).toHaveBeenCalledWith("/markets/0xdef/positions", { limit: undefined });
  });

  it("reads one upload from the reference ledger", async () => {
    const get = jest.fn().mockResolvedValue({ cid: "bafy", sha256: "0".repeat(64) });
    await fetchUpload(client(get), "bafy");
    expect(get).toHaveBeenCalledWith("/uploads/bafy");
  });
});

/**
 * The types are the point of this task, so they are asserted at compile time.
 *
 * A row literal that is missing a required field, or spells one in the wrong case, fails to
 * type-check — which is the only kind of test that catches "the client's `MarketRow` is thirty
 * fields behind the service's".
 */
describe("the row shapes", () => {
  it("carries the generation-2 columns on a market row", () => {
    const row: Pick<
      MarketRow,
      | "generation"
      | "quote_asset"
      | "quote_decimals"
      | "quote_symbol"
      | "quote_id"
      | "routing"
      | "routed_recipient"
      | "creator_tax_bps"
      | "tax_recipient"
      | "ticker"
      | "logo_uri"
      | "banner_uri"
      | "description"
      | "website"
      | "x"
      | "telegram"
      | "metadata_hash"
      | "market_cap_quote"
      | "market_cap_usd"
      | "volume_24h_quote"
      | "volume_24h_usd"
      | "change_24h"
      | "trades_24h"
      | "ath_quote"
    > = {
      generation: 2,
      quote_asset: "0x01bff41798a0bcf287b996046ca68b395dbc1071",
      quote_decimals: 6,
      quote_symbol: "XAUt0",
      quote_id: "xaut0",
      routing: "holders",
      routed_recipient: null,
      creator_tax_bps: 250,
      tax_recipient: "0xcreator",
      ticker: "GOLDY",
      logo_uri: "ipfs://bafy",
      banner_uri: null,
      description: null,
      website: null,
      x: null,
      telegram: null,
      metadata_hash: "0xhash",
      market_cap_quote: "1234567",
      market_cap_usd: null,
      volume_24h_quote: "9999",
      volume_24h_usd: null,
      // A JSON number, and one of the four exceptions to everything-is-a-string.
      change_24h: -12.5,
      trades_24h: 4,
      ath_quote: "100000000000000000000",
    };

    expect(row.generation).toBe(2);
    expect(row.quote_decimals).toBe(6);
  });

  it("carries `share` and `label` on a holder row", () => {
    const holder: HolderRow = { holder: "0xa", balance: "1", share: "0.123456", label: "creator" };
    expect(holder.share).toBe("0.123456");
    expect(holder.label).toBe("creator");
  });

  it("admits `sink` as a swap venue", () => {
    const venue: SwapRow["venue"] = "sink";
    expect(venue).toBe("sink");
  });
});
