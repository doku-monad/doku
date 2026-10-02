/**
 * @jest-environment node
 */
import type { ApiClient } from "../../src/lib/api/client";
import {
  fetchCandlesticks,
  fetchHolders,
  fetchMarket,
  fetchMarkets,
  fetchSwaps,
  pageThrough,
} from "../../src/lib/api/markets";

const stubClient = (impl: (path: string, query?: Record<string, unknown>) => unknown): ApiClient =>
  ({ get: jest.fn(async (path, query) => impl(path, query)) }) as unknown as ApiClient;

describe("markets api", () => {
  /**
   * The cursor key is what selects the mode, and it has to be SENT.
   *
   * The service reads `q.cursor !== undefined`: `?cursor=` with an empty value asks for the
   * address-ordered `{items, nextCursor}` list, and omitting the key entirely asks for the board's
   * page — `{items, total, page, limit, pairCounts}`, with no cursor to follow. This function used
   * to pass `cursor: undefined`, which `ApiClient` drops, so it was quietly getting the OTHER
   * contract and reading `nextCursor` off a response that has none. `fetchMarketsPage` is the one
   * that wants page mode, and it sends no cursor key at all.
   */
  it("always sends a cursor key, because its absence selects the other contract", async () => {
    const get = jest.fn().mockResolvedValue({ items: [], nextCursor: null });
    await fetchMarkets({ get } as unknown as ApiClient, { limit: 25 });
    expect(get).toHaveBeenCalledWith("/markets", { limit: 25, cursor: "" });
  });

  /// Addresses arrive from routes, from the chain and from user input in three different cases.
  /// The API stores them lowercased, so anything else silently returns nothing found.
  it("lowercases the address before asking for a market", async () => {
    const get = jest.fn().mockResolvedValue({});
    await fetchMarket({ get } as unknown as ApiClient, "0xAbCdEf0123456789");
    expect(get).toHaveBeenCalledWith("/markets/0xabcdef0123456789");
  });

  it("passes the candlestick period through", async () => {
    const get = jest.fn().mockResolvedValue({ items: [] });
    await fetchCandlesticks({ get } as unknown as ApiClient, "0xA", 3600);
    expect(get).toHaveBeenCalledWith("/markets/0xa/candlesticks", {
      period: 3600,
      limit: undefined,
    });
  });

  it("reads swaps and holders from their own endpoints", async () => {
    const seen: string[] = [];
    const client = stubClient((path) => {
      seen.push(path);
      return { items: [], nextCursor: null };
    });
    await fetchSwaps(client, "0xA");
    await fetchHolders(client, "0xA");
    expect(seen).toEqual(["/markets/0xa/swaps", "/markets/0xa/holders"]);
  });

  /**
   * Paging is where a live feed goes wrong quietly. Two failures matter and neither throws: a
   * cursor that never advances loops forever, and a page boundary that repeats rows shows the same
   * trade twice.
   */
  it("walks every page exactly once and stops", async () => {
    const pages = [
      { items: [1, 2], nextCursor: "a" },
      { items: [3, 4], nextCursor: "b" },
      { items: [], nextCursor: null },
    ];
    let call = 0;
    const client = stubClient(() => pages[call++]);

    const all = await pageThrough<number>(client, "/markets/0xa/swaps");
    expect(all).toEqual([1, 2, 3, 4]);
    expect(call).toBe(3);
  });

  /// An indexer that keeps returning the same cursor would spin here forever, taking the browser
  /// tab with it. Bounded, so a broken server degrades to a short list rather than a hang.
  it("gives up rather than looping when the cursor stops advancing", async () => {
    const client = stubClient(() => ({ items: [1], nextCursor: "same" }));
    const all = await pageThrough<number>(client, "/markets/0xa/swaps", { maxPages: 5 });
    expect(all).toHaveLength(5);
  });
});
