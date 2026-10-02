import { beforeEach, describe, expect, it } from "vitest";
import { createApi } from "../src/app/index.js";
import type { Db } from "../src/db/legacy.js";
import { memoryDatabase, seedMarket, ZERO } from "./helpers.js";
import { USDC } from "./gen2-logs.js";

const ME = "0xme"; const OTHER = "0xother";
describe("launches and creators", () => {
  let api: ReturnType<typeof createApi>; let db: Db;
  const get = async (p: string) => (await (await api.request(`http://x${p}`)).json()) as Record<string, unknown>;

  beforeEach(async () => {
    const database = await memoryDatabase(); db = database.legacy; api = createApi(database);
    await seedMarket(db, "0xm1", "0xt1", 100);
    await seedMarket(db, "0xm2", "0xt2", 200);
    await seedMarket(db, "0xm3", "0xt3", 300);
    await db.query(`UPDATE markets SET creator = $1, generation = 2, quote_asset = $2, quote_decimals = 6, routing = 2, routed_recipient = $1, tax_recipient = $3, creator_tax_bps = 100, ticker = 'ONE', name = 'One', quote_target = 1000 WHERE market_address = '0xm1'`, [ME, USDC, OTHER]);
    await db.query(`UPDATE markets SET creator = $1, routing = 1, tax_recipient = $1, created_at = NOW() + INTERVAL '1 hour' WHERE market_address = '0xm2'`, [ME]);
    await db.query(`UPDATE markets SET creator = $1 WHERE market_address = '0xm3'`, [OTHER]);
    await db.query(`UPDATE market_state SET quote_raised = 500, volume_quote = 12345, holders = 3, trade_count = 4 WHERE market_address = '0xm1'`);
    await db.query(`INSERT INTO market_rewards (market_address, routed_generated, routed_collected, tax_generated) VALUES ('0xm1', 700, 200, 90)`);
    await db.query(`INSERT INTO market_stats (market_address, market_cap_quote) VALUES ('0xm1', 4242)`);
    await db.query(`INSERT INTO creator_balances (who, quote_asset, claimable, earned_lifetime) VALUES ($1, $2, 55, 755), ($1, $3, 1, 1)`, [ME, USDC, ZERO]);
    await db.query(`INSERT INTO quote_assets (id, address, symbol, decimals) VALUES ('usdc', $1, 'USDC', 6), ('mon', $2, 'MON', 18)`, [USDC, ZERO]);
  });

  it("lists an account's launches newest first with ledger-derived fee figures", async () => {
    const body = await get(`/accounts/${ME}/launches`);
    const items = body.items as Record<string, unknown>[];
    expect(body.truncated).toBe(false);
    expect(items.map((i) => i.marketAddress)).toEqual(["0xm2", "0xm1"]);
    expect(items[1]).toMatchObject({
      marketAddress: "0xm1", tokenAddress: "0xt1", symbol: "x", name: "One", ticker: "ONE", graduated: false, progress: 0.5,
      holders: 3, tradeCount: 4, volumeQuote: "12345", marketCap: "4242",
      quoteAsset: USDC, quoteDecimals: 6, quoteSymbol: "USDC", routing: "creator", creatorTaxBps: 100,
      feesGenerated: "700", pending: "500", feeRecipient: ME, taxRecipient: OTHER, pendingTax: "90",
    });
    expect(typeof items[1]!.launchedAt).toBe("string");
  });

  it("answers an empty list for an address that launched nothing", async () => {
    expect((await get("/accounts/0xnobody/launches")).items).toEqual([]);
  });

  it("serves a creator's balances per quote and the markets that pay them", async () => {
    const body = await get(`/creators/${ME}`);
    expect(body.claimable).toEqual([
      { quoteAsset: ZERO, quoteSymbol: "MON", quoteDecimals: 18, amount: "1" },
      { quoteAsset: USDC, quoteSymbol: "USDC", quoteDecimals: 6, amount: "55" },
    ]);
    expect((body.earnedLifetime as { amount: string }[]).map((e) => e.amount)).toEqual(["1", "755"]);
    expect(body.markets).toEqual([
      { marketAddress: "0xm1", ticker: "ONE", name: "One", quoteAsset: USDC, role: "routed" },
      { marketAddress: "0xm2", ticker: null, name: "x", quoteAsset: ZERO, role: "tax" },
    ]);
    const other = await get(`/creators/${OTHER}`);
    expect((other.markets as { role: string }[])[0]!.role).toBe("tax");
    expect(other.claimable).toEqual([]);
  });
});
