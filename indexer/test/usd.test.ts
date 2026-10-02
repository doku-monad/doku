import { beforeEach, describe, expect, it } from "vitest";
import { createApi } from "../src/app/index.js";
import type { Db } from "../src/db/legacy.js";
import { parsePriceDocument, refreshUsdPrices } from "../src/indexer/processing/usd.js";
import { ensureQuoteCatalog } from "../src/quotes/catalog.js";
import { memoryDatabase, memoryDb, ZERO } from "./helpers.js";

const fetchJson =
  (body: unknown, ok = true) =>
  async () =>
    ({ ok, status: ok ? 200 : 500, json: async () => body }) as unknown as Response;

describe("USD prices", () => {
  let db: Db;
  const price = async (id: string) =>
    (
      await db.query<{ p: string | null; at: Date | null }>(
        "SELECT usd_price::text AS p, usd_price_at AS at FROM quote_assets WHERE id = $1",
        [id],
      )
    ).rows[0]!;
  beforeEach(async () => {
    db = await memoryDb();
    await ensureQuoteCatalog(db);
  });

  it("parses nested and flat documents with number or string values", () => {
    expect(parsePriceDocument({ prices: { MON: 2.5, "0xabc": "0.5" } })).toEqual(
      new Map([
        ["mon", 2.5],
        ["0xabc", 0.5],
      ]),
    );
    expect(parsePriceDocument({ mon: "2" })).toEqual(new Map([["mon", 2]]));
    expect(parsePriceDocument({ mon: "nope", weth: -1 })).toEqual(new Map());
  });

  it("matches a key against address, id or symbol and pins stablecoins to 1", async () => {
    await refreshUsdPrices(db, "https://p", fetchJson({ prices: { [ZERO]: 2.5, WETH: 3000, usdc: 0.97 } }));
    expect(Number((await price("mon")).p)).toBe(2.5);
    expect(Number((await price("weth")).p)).toBe(3000);
    expect(Number((await price("usdc")).p)).toBe(1); // pinned, the document's 0.97 is ignored
    expect(Number((await price("usdt")).p)).toBe(1); // pinned without being mentioned
    expect((await price("wbtc")).p).toBeNull(); // not mentioned, not a stable
    expect((await price("mon")).at).not.toBeNull();
  });

  it("keeps the previous price and timestamp when the source fails", async () => {
    await refreshUsdPrices(db, "https://p", fetchJson({ MON: 2 }));
    const before = await price("mon");
    await refreshUsdPrices(db, "https://p", fetchJson({}, false));
    expect(await price("mon")).toEqual(before);
    // Nothing is registered in this fixture, so the unpriced report is empty — what is being
    // asserted is that a dead source resolves rather than throws.
    await expect(
      refreshUsdPrices(db, "https://p", async () => {
        throw new Error("down");
      }),
    ).resolves.toEqual([]);
    expect(await price("mon")).toEqual(before);
  });

  it("does nothing but pin stables when no url is configured", async () => {
    await refreshUsdPrices(db, undefined, fetchJson({ MON: 9 }));
    expect((await price("mon")).p).toBeNull();
    expect(Number((await price("usdc")).p)).toBe(1);
  });
});

/**
 * A listed quote asset with no USD price is a gap in the data, not a market worth nothing.
 *
 * The board falls back to whole units of the quote where a price is missing, which RANKS a market
 * but does not VALUE it — so the gap has to be visible. It is logged at warn naming the asset, and
 * counted on `/status` so nobody has to read logs to find out that half the board is being ordered
 * on a proxy.
 */
describe("quote assets with no USD price", () => {
  const source =
    (doc: unknown) =>
    async () =>
      ({ ok: true, status: 200, json: async () => doc }) as unknown as Response;

  it("names the listed assets it could not price", async () => {
    const db = await memoryDb();
    await ensureQuoteCatalog(db);
    await db.query(
      "UPDATE quote_assets SET registered = TRUE, enabled = TRUE WHERE id IN ('mon','usdc','xaut0')",
    );
    const unpriced = await refreshUsdPrices(db, "https://p", source({ prices: { [ZERO]: 2.5 } }));
    // MON came from the document, USDC is pinned as a stablecoin, gold has neither.
    expect(unpriced).toEqual(["xaut0"]);
  });

  it("counts them on /status rather than absorbing them as a zero", async () => {
    const database = await memoryDatabase();
    const db = database.legacy;
    await ensureQuoteCatalog(db);
    await db.query(
      "UPDATE quote_assets SET registered = TRUE, enabled = TRUE WHERE id IN ('mon','usdc','xaut0')",
    );
    // A registered asset that is not ENABLED cannot be launched against, so it is not a gap.
    await db.query("UPDATE quote_assets SET registered = TRUE WHERE id = 'weth'");
    await refreshUsdPrices(db, "https://p", source({ prices: { [ZERO]: 2.5 } }));

    const body = (await (await createApi(database).request("http://x/status")).json()) as Record<
      string,
      unknown
    >;
    expect(body.unpriced_quotes).toBe(1);
  });
});
