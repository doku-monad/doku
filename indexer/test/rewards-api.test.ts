import { beforeEach, describe, expect, it } from "vitest";

import { createApi } from "../src/app/index.js";
import type { Db } from "../src/db/legacy.js";
import { USDC } from "./gen2-logs.js";
import { memoryDatabase, seedMarket, ZERO } from "./helpers.js";

describe("GET /markets/:a/rewards", () => {
  let api: ReturnType<typeof createApi>;
  let db: Db;
  const get = async (p: string) => {
    const r = await api.request(`http://x${p}`);
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };

  beforeEach(async () => {
    const database = await memoryDatabase();
    db = database.legacy;
    api = createApi(database);
    await seedMarket(db, "0xm", "0xt");
    await db.query(
      `UPDATE markets SET generation = 2, quote_asset = $1, quote_decimals = 6, routing = 1, total_supply = $2 WHERE market_address = '0xm'`,
      [USDC, (999n * 10n ** 18n).toString()],
    );
    await db.query(
      `INSERT INTO transfers (token_address, from_address, to_address, value, block_number, block_hash, log_index, tx_hash, ts)
                    VALUES ('0xt', $1, '0xm', $2, 1, '0xb', 0, '0xmint', NOW())`,
      [ZERO, (1000n * 10n ** 18n).toString()],
    );
    await db.query(`INSERT INTO market_rewards (market_address, routed_generated, routed_collected, tax_generated, tax_collected,
                      protocol_generated, protocol_collected, dividends_funded, dividends_paid, burned_tokens)
                    VALUES ('0xm', 700, 300, 100, 0, 300, 300, 250, 100, 0)`);
  });

  it("serves the ledger totals with pending figures derived", async () => {
    const { status, body } = await get("/markets/0xm/rewards");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      routing: "holders",
      quoteAsset: USDC,
      quoteDecimals: 6,
      routedGenerated: "700",
      routedCollected: "300",
      // A holders market: pending is what the vault has not been FUNDED with (700 - 250), not
      // what the curve has not collected. The pool-side sweep funds the vault with no
      // FeesCollected on the curve, so 700 - 300 printed money as pending that the vault held.
      pending: "450",
      taxGenerated: "100",
      taxCollected: "0",
      pendingTax: "100",
      protocolGenerated: "300",
      protocolCollected: "300",
      dividendsFunded: "250",
      dividendsPaid: "100",
      // No sink burn recorded, but the supply fell by 1e18 since the mint.
      burnedTokens: (10n ** 18n).toString(),
      mintedSupply: (1000n * 10n ** 18n).toString(),
      totalSupply: (999n * 10n ** 18n).toString(),
    });
  });

  it("takes the larger of the ledger's burns and the supply drop", async () => {
    await db.query("UPDATE market_rewards SET burned_tokens = $1 WHERE market_address = '0xm'", [
      (5n * 10n ** 18n).toString(),
    ]);
    expect((await get("/markets/0xm/rewards")).body.burnedTokens).toBe((5n * 10n ** 18n).toString());
  });

  /// R10: a BURN market's routed share is spent on the curve and burned as it accrues, so
  /// `BondingCurve.pendingFees()` is 0 there and nothing ever writes `routed_collected`.
  /// Reporting generated − collected would grow forever and offer a claim nobody can make.
  it("derives a creator market's pending from what the curve has collected", async () => {
    await db.query("UPDATE markets SET routing = 2 WHERE market_address = '0xm'");
    const { body } = await get("/markets/0xm/rewards");
    expect(body).toMatchObject({ routing: "creator", pending: "400" });
  });

  it("reports zero pending on a buyback market however much it has generated", async () => {
    await db.query("UPDATE markets SET routing = 0 WHERE market_address = '0xm'");
    const { body } = await get("/markets/0xm/rewards");
    expect(body).toMatchObject({ routing: "buyback", routedGenerated: "700", pending: "0" });
    // The creator tax is charged and owed on every market whatever the routing, so it is untouched.
    expect(body.pendingTax).toBe("100");
  });

  it("answers zeros and a null routing for a gen-1 market with no ledger", async () => {
    await seedMarket(db, "0xold", "0xoldt", 101);
    const { status, body } = await get("/markets/0xold/rewards");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      routing: null,
      routedGenerated: "0",
      pending: "0",
      burnedTokens: "0",
      quoteAsset: ZERO,
      quoteDecimals: 18,
    });
  });

  it("404s for an unknown market", async () => {
    expect((await get("/markets/0xnope/rewards")).status).toBe(404);
  });

  it("puts routing, quote and stats on the detail row", async () => {
    const { body } = await get("/markets/0xm");
    expect(body.routing).toBe("holders");
    expect(body.quote_asset).toBe(USDC);
    expect(body).toHaveProperty("change_24h");
    expect(body).toHaveProperty("market_cap_usd");
  });
});
