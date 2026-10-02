/**
 * @jest-environment node
 */
import { type ApiClient, ApiError, type QueryValue } from "../../src/lib/api/client";
import { HIDDEN_MARKETS, isHiddenAddress, scrubHidden, withHiddenMarkets } from "../../src/lib/markets/hidden-markets";

const DOKU = HIDDEN_MARKETS[0]!;
const OTHER = { market: "0x0adf27c845c1986892039075c5f26e08c1bbc277", token: "0x1111111111111111111111111111111111111111" };

const row = (m: { market: string; token: string }, extra: Record<string, unknown> = {}) => ({
  market_address: m.market,
  token_address: m.token,
  name: "x",
  ticker: "X",
  symbol: "X",
  quote_asset: "0x0000000000000000000000000000000000000000",
  ...extra,
});

/** A client that answers from a table keyed by path, and records what it was asked. */
const fake = (answer: (path: string, query: Record<string, QueryValue>) => unknown) => {
  const calls: { path: string; query: Record<string, QueryValue> }[] = [];
  const api: ApiClient = {
    async get<T>(path: string, query: Record<string, QueryValue> = {}) {
      calls.push({ path, query });
      const a = answer(path, query);
      if (a instanceof Error) throw a;
      return a as T;
    },
  };
  return { api, calls };
};

describe("which addresses are hidden", () => {
  it("is the DOKU market and its token, in any case", () => {
    expect(DOKU.market).toBe("0xc079b2e6d4422f90e505003a955b275eb0c78b75");
    expect(DOKU.token).toBe("0x3247a77c792878aeb8f90acda8fde95b962c7ae9");
    expect(isHiddenAddress(DOKU.market.toUpperCase().replace("0X", "0x"))).toBe(true);
    expect(isHiddenAddress("0x3247a77c792878AEb8F90AcDa8fde95B962c7Ae9")).toBe(true);
    expect(isHiddenAddress(OTHER.market)).toBe(false);
    expect(isHiddenAddress(undefined)).toBe(false);
  });
});

describe("scrubbing a response", () => {
  it("drops rows naming the market or its token under any of the row shapes, however deep", () => {
    const body = {
      items: [row(DOKU), row(OTHER)],
      rail: { entries: [{ marketAddress: DOKU.market }, { marketAddress: OTHER.market }] },
      balances: [{ tokenAddress: DOKU.token, amount: "1" }, { tokenAddress: OTHER.token, amount: "2" }],
      tape: [{ address: DOKU.market }, { market: DOKU.market }, { token: OTHER.token }],
    };
    const out = scrubHidden(body) as typeof body;
    expect(out.items.map((r) => r.market_address)).toEqual([OTHER.market]);
    expect(out.rail.entries).toEqual([{ marketAddress: OTHER.market }]);
    expect(out.balances).toEqual([{ tokenAddress: OTHER.token, amount: "2" }]);
    expect(out.tape).toEqual([{ token: OTHER.token }]);
  });

  it("leaves everything else alone, scalars and all", () => {
    const body = { total: 3, name: "Doku", nested: [1, "a", null, { k: "v" }] };
    expect(scrubHidden(body)).toEqual(body);
  });
});

describe("the wrapped client", () => {
  it("answers a hidden market's own pages with a 404, and never asks the indexer", async () => {
    const { api, calls } = fake(() => ({}));
    const hidden = withHiddenMarkets(api);
    for (const path of [
      `/markets/${DOKU.market}`,
      `/markets/${DOKU.market.toUpperCase().replace("0X", "0x")}/rewards`,
      `/markets/${DOKU.market}/swaps`,
    ]) {
      await expect(hidden.get(path)).rejects.toMatchObject({ status: 404 });
    }
    await expect(hidden.get(`/markets/${DOKU.market}`)).rejects.toBeInstanceOf(ApiError);
    expect(calls).toEqual([]);
  });

  it("passes other markets' pages through untouched", async () => {
    const { api } = fake(() => row(OTHER));
    expect(await withHiddenMarkets(api).get(`/markets/${OTHER.market}`)).toEqual(row(OTHER));
  });

  /** The board: the page the indexer served, and what it says when asked about DOKU alone. */
  const board = (items: unknown[], total: number, pairCounts: Record<string, number>, dokuProbe: unknown) =>
    fake((_path, query) =>
      query.q === DOKU.market ? dokuProbe : { items, total, page: 1, limit: 20, pairCounts }
    );
  const probeHit = { items: [row(DOKU, { name: "Doku", ticker: "DOKU", symbol: "DOKU" })], total: 1, page: 1, limit: 1, pairCounts: { mon: 1 } };
  const probeMiss = { items: [], total: 0, page: 1, limit: 1, pairCounts: {} };

  it("takes DOKU off the board and out of the total and its pair's count", async () => {
    const { api, calls } = board([row(DOKU), row(OTHER)], 2, { mon: 2, usdc: 3 }, probeHit);
    const page = await withHiddenMarkets(api).get<{ items: unknown[]; total: number; pairCounts: Record<string, number> }>(
      "/markets",
      { sort: "market_cap", status: "all", page: 1, limit: 20 }
    );
    expect(page.items).toEqual([row(OTHER)]);
    expect(page.total).toBe(1);
    expect(page.pairCounts).toEqual({ mon: 1, usdc: 3 });
    // The probe carries the board's own status and routing, and swaps the search for DOKU's address.
    const probe = calls.find((c) => c.query.q === DOKU.market)!;
    expect(probe.query).toMatchObject({ status: "all", limit: 1 });
    expect(probe.query).not.toHaveProperty("pair");
  });

  it("corrects the counts even when DOKU sits on another page", async () => {
    const { api } = board([row(OTHER)], 25, { mon: 20, usdc: 5 }, probeHit);
    const page = await withHiddenMarkets(api).get<{ total: number; pairCounts: Record<string, number> }>("/markets", { page: 2 });
    expect(page.total).toBe(24);
    expect(page.pairCounts).toEqual({ mon: 19, usdc: 5 });
  });

  it("does not touch the total when the pair filter already excludes DOKU, but still fixes its chip", async () => {
    const { api } = board([row(OTHER)], 3, { mon: 2, usdc: 3 }, probeHit);
    const page = await withHiddenMarkets(api).get<{ total: number; pairCounts: Record<string, number> }>("/markets", { pair: "usdc" });
    expect(page.total).toBe(3);
    expect(page.pairCounts).toEqual({ mon: 1, usdc: 3 });
  });

  it("does not touch any count when the search would not have found DOKU", async () => {
    const { api } = board([row(OTHER)], 1, { mon: 1 }, probeHit);
    const page = await withHiddenMarkets(api).get<{ total: number; pairCounts: Record<string, number> }>("/markets", { q: "cat" });
    expect(page.total).toBe(1);
    expect(page.pairCounts).toEqual({ mon: 1 });
  });

  it("counts a search that does match DOKU, by name or by address prefix", async () => {
    for (const q of ["dok", "0xc079"]) {
      const { api } = board([row(OTHER)], 2, { mon: 2 }, probeHit);
      const page = await withHiddenMarkets(api).get<{ total: number }>("/markets", { q });
      expect(page.total).toBe(1);
    }
  });

  it("does not touch any count when the status filter excludes DOKU", async () => {
    const { api } = board([row(OTHER)], 1, { mon: 1 }, probeMiss);
    const page = await withHiddenMarkets(api).get<{ total: number; pairCounts: Record<string, number> }>("/markets", { status: "curve" });
    expect(page.total).toBe(1);
    expect(page.pairCounts).toEqual({ mon: 1 });
  });

  it("leaves the cursor form of /markets to the scrub alone, with no probe", async () => {
    const { api, calls } = fake(() => ({ items: [row(DOKU), row(OTHER)], nextCursor: null }));
    const page = await withHiddenMarkets(api).get<{ items: unknown[] }>("/markets", { limit: 500, cursor: "" });
    expect(page.items).toEqual([row(OTHER)]);
    expect(calls).toHaveLength(1);
  });

  it("scrubs every other response it passes through", async () => {
    const { api } = fake(() => ({ items: [{ marketAddress: DOKU.market }, { marketAddress: OTHER.market }] }));
    const out = await withHiddenMarkets(api).get<{ items: unknown[] }>("/search", { q: "d" });
    expect(out.items).toEqual([{ marketAddress: OTHER.market }]);
  });
});
