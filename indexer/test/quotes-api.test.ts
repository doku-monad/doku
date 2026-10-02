import { beforeEach, describe, expect, it } from "vitest";
import { createApi } from "../src/app/index.js";
import type { Db } from "../src/db/legacy.js";
import { ensureQuoteCatalog } from "../src/quotes/catalog.js";
import { memoryDatabase, seedMarket, ZERO } from "./helpers.js";
import { USDC } from "./gen2-logs.js";

/** The catalogue's own WETH row. Real, live on Monad, and not registered with the launchpad yet. */
const WETH = "0xee8c0e9f1bffb4eb878d8f15f368a02a35481242";

describe("GET /quotes", () => {
  let api: ReturnType<typeof createApi>; let db: Db;
  beforeEach(async () => {
    const database = await memoryDatabase(); db = database.legacy; api = createApi(database);
    await ensureQuoteCatalog(db);
    await db.query("UPDATE quote_assets SET registered = TRUE, enabled = TRUE, quote_target = 1000000000000000000, usd_price = 2.5, usd_price_at = NOW() WHERE id = 'mon'");
    await db.query("UPDATE quote_assets SET registered = TRUE, enabled = FALSE, quote_target = 8000000000 WHERE id = 'usdc'");
    await db.query(`INSERT INTO quote_assets (id, address, decimals, registered, enabled, quote_target) VALUES ('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', 6, TRUE, TRUE, 1)`);
    await seedMarket(db, "0xm", "0xt");
    await db.query("UPDATE markets SET quote_asset = $1 WHERE market_address = '0xm'", [ZERO]);
  });

  it("returns the catalogue in the frontend's QuoteAsset shape plus target, price and counts", async () => {
    const res = await api.request("http://x/quotes");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Record<string, unknown>[] };
    const mon = body.items.find((i) => i.id === "mon")!;
    expect(mon).toEqual({
      id: "mon", symbol: "MON", name: "Monad", kind: "native", status: "live", decimals: 18, address: ZERO,
      blurb: "The chain's native asset — the default quote on DOKU", underlying: null, iconDomain: "monad.xyz",
      quoteTarget: "1000000000000000000", usdPrice: 2.5, usdPriceAt: expect.any(String), marketCount: 1,
    });
    const usdc = body.items.find((i) => i.id === "usdc")!;
    expect(usdc).toMatchObject({ status: "listed", address: USDC, quoteTarget: "8000000000", usdPrice: null, marketCount: 0 });
    // `soon` is about REGISTRATION, not about whether the token exists. WETH is deployed on Monad
    // and the catalogue carries its address; nothing has registered it with the launchpad, so it is
    // `soon` WITH an address. The tokenized equities are the rows that genuinely have none.
    expect(body.items.find((i) => i.id === "weth")).toMatchObject({ status: "soon", address: WETH, quoteTarget: null });
    expect(body.items.find((i) => i.id === "nvdax")).toMatchObject({ status: "soon", address: null, quoteTarget: null });
  });

  it("names an unlisted registered asset by its address until an admin edits it", async () => {
    const body = (await (await api.request("http://x/quotes")).json()) as { items: Record<string, unknown>[] };
    const raw = body.items.find((i) => i.id === "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd")!;
    expect(raw).toMatchObject({ symbol: "0xabcd…abcd", name: "0xabcd…abcd", kind: "crypto", status: "live", decimals: 6, blurb: "" });
  });

  it("keeps the catalogue order", async () => {
    const body = (await (await api.request("http://x/quotes")).json()) as { items: { id: string }[] };
    expect(body.items.slice(0, 3).map((i) => i.id)).toEqual(["mon", "usdc", "usdt"]);
  });
});
