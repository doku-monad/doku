import { beforeAll, describe, expect, it } from "vitest";

import { createApi } from "../src/app/index.js";
import type { Db } from "../src/db/legacy.js";
import { memoryDatabase, seedMarket } from "./helpers.js";

/**
 * What the API puts on the wire, asserted as types rather than values.
 *
 * This exists because of a specific hazard in the move to Prisma. The raw driver was configured to
 * return `NUMERIC` and `BIGINT` as strings; Prisma returns them as `Decimal` and `bigint`. A
 * `Decimal` serialises to JSON in exponential form above 1e21 — which is every token amount on
 * this chain — and `JSON.stringify` refuses a `bigint` outright, so the response would not be
 * produced at all.
 *
 * Both failures are invisible to a test that only checks values on small fixtures, because small
 * numbers round-trip fine. So these assert the *type* of every amount, at realistic magnitudes,
 * and one of them parses the response the way the client does.
 */
describe("wire shape", () => {
  let api: ReturnType<typeof createApi>;
  let db: Db;

  // Bigger than 2^53 and past the exponential threshold: the range where the failure lives.
  const SUPPLY = "1000000000000000000000000000";
  const PRICE = "123456789012345678";

  beforeAll(async () => {
    const database = await memoryDatabase();
    db = database.legacy;
    api = createApi(database);

    await seedMarket(db, "0xmarket", "0xtoken");
    await db.query(
      `UPDATE markets SET total_supply = $1 WHERE market_address = '0xmarket'`,
      [SUPPLY],
    );
    await db.query(
      `UPDATE market_state SET last_price = $1, quote_raised = $2, volume_quote = $2
        WHERE market_address = '0xmarket'`,
      [PRICE, SUPPLY],
    );
    await db.query(
      `INSERT INTO swaps (market_address, trader, is_buy, venue, quote_amount, base_amount, fee,
                          tax, quote_raised, price, block_number, block_hash, log_index, tx_hash, ts)
       VALUES ('0xmarket', '0xtrader', true, 'curve', $1, $1, 0, 0, $1, $2, 1, '0xb', 0, '0xtx1', NOW())`,
      [SUPPLY, PRICE],
    );
    await db.query(
      `INSERT INTO token_balances (token_address, holder, balance) VALUES ('0xtoken', '0xtrader', $1)`,
      [SUPPLY],
    );
  }, 120_000);

  const get = async (path: string) => {
    const res = await api.request(`http://x${path}`);
    expect(res.status).toBe(200);
    return res.json() as Promise<Record<string, unknown>>;
  };

  it("sends every market amount as a plain digit string", async () => {
    const body = (await get("/markets")) as { items: Record<string, unknown>[] };
    const market = body.items[0]!;
    for (const key of [
      "quote_target",
      "total_supply",
      "quote_raised",
      "last_price",
      "volume_quote",
      "market_cap",
      "ath_market_cap",
      "volume_24h",
      "block_number",
    ]) {
      expect(typeof market[key], `${key} must be a string`).toBe("string");
      expect(String(market[key]), `${key} must be plain digits, not exponential`).toMatch(/^\d+$/);
    }
    // Counts are numbers: small by construction, and the client uses them as numbers.
    expect(typeof market.trade_count).toBe("number");
    expect(typeof market.holders).toBe("number");
  });

  /** The client's actual parse. `BigInt` rejects both `"1e+27"` and a decimal point. */
  it("sends amounts the client can parse with BigInt", async () => {
    const body = (await get("/markets")) as { items: Record<string, unknown>[] };
    const market = body.items[0]!;
    expect(BigInt(market.total_supply as string)).toBe(BigInt(SUPPLY));
    expect(BigInt(market.last_price as string)).toBe(BigInt(PRICE));
    // 1e27 * 123456789012345678 / 1e18 — exercised because the cast on this one is easy to get
    // half-right, and a half-right cast renders as "0.000000000000000000".
    expect(BigInt(market.market_cap as string)).toBe(
      (BigInt(SUPPLY) * BigInt(PRICE)) / 10n ** 18n,
    );
  });

  it("sends every swap amount as a plain digit string", async () => {
    const body = (await get("/markets/0xmarket/swaps")) as { items: Record<string, unknown>[] };
    const swap = body.items[0]!;
    for (const key of ["id", "quote_amount", "base_amount", "fee", "tax", "quote_raised", "price", "block_number"]) {
      expect(typeof swap[key], `${key} must be a string`).toBe("string");
      expect(String(swap[key]), `${key} must be plain digits`).toMatch(/^\d+$/);
    }
    expect(typeof swap.log_index).toBe("number");
    expect(typeof swap.is_buy).toBe("boolean");
  });

  it("sends balances as plain digit strings", async () => {
    const holders = (await get("/markets/0xmarket/holders")) as { items: Record<string, unknown>[] };
    expect(typeof holders.items[0]!.balance).toBe("string");
    expect(BigInt(holders.items[0]!.balance as string)).toBe(BigInt(SUPPLY));

    const portfolio = (await get("/accounts/0xtrader/balances")) as {
      items: Record<string, unknown>[];
    };
    expect(typeof portfolio.items[0]!.balance).toBe("string");
    expect(typeof portfolio.items[0]!.last_price).toBe("string");
  });

  it("sends status counts as numbers and blocks as strings", async () => {
    const status = await get("/status");
    expect(typeof status.last_block).toBe("string");
    expect(typeof status.chain_head).toBe("string");
    expect(typeof status.markets).toBe("number");
    expect(typeof status.swaps).toBe("number");
    expect(typeof status.lag_blocks).toBe("number");
  });

  /**
   * The whole response has to survive `JSON.stringify`. A single un-cast `BIGINT` anywhere in a
   * payload throws while serialising, which fails the request rather than corrupting one field —
   * so this is worth asserting on the response as a whole, not column by column.
   */
  it("serialises every response without throwing", async () => {
    for (const path of [
      "/markets",
      "/markets/0xmarket",
      "/markets/0xmarket/swaps",
      "/markets/0xmarket/holders",
      "/accounts/0xtrader/balances",
      "/accounts/0xtrader/swaps",
      "/status",
    ]) {
      const res = await api.request(`http://x${path}`);
      expect(res.status, path).toBe(200);
      // The parsed body, not the Response object: stringifying the wrapper proves nothing about
      // what is inside it.
      const body: unknown = await res.json();
      expect(() => JSON.stringify(body), path).not.toThrow();
      expect(JSON.stringify(body), path).not.toMatch(/e\+\d/);
    }
  });
});

/**
 * The versioned surface.
 *
 * Mounted alongside the unprefixed paths rather than replacing them: the frontend already calls
 * the originals, and the brief says to preserve existing routes.
 */
describe("route mounting", () => {
  let api: ReturnType<typeof createApi>;

  beforeAll(async () => {
    const database = await memoryDatabase();
    await seedMarket(database.legacy, "0xm", "0xt");
    api = createApi(database);
  }, 120_000);

  it.each([
    "/markets",
    "/markets/0xm",
    "/markets/0xm/swaps",
    "/markets/0xm/holders",
    "/accounts/0xa/balances",
    "/status",
    "/health",
    "/ready",
  ])("serves %s at both the root and /api/v1", async (path) => {
    const root = await api.request(`http://x${path}`);
    const versioned = await api.request(`http://x/api/v1${path}`);
    expect(versioned.status).toBe(root.status);
    expect(await versioned.text()).toBe(await root.text());
  });
});
