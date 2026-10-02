import { beforeEach, describe, expect, it } from "vitest";

import { createApi } from "../src/app/index.js";
import type { Db } from "../src/db/legacy.js";
import { ensureHiddenCreators } from "../src/repositories/hidden-creators.js";
import { memoryDatabase, seedMarket } from "./helpers.js";

/**
 * A wallet in `hidden_creators` has none of its markets served — on the board, on the
 * leaderboard, by address, or on a per-market feed — while the rest of the site is untouched.
 */
const SPAMMER = "0xf5ba20ae8340b070bba039195f8b286af598c7a7";
const HONEST = "0xhonest";

describe("hidden creators", () => {
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
    await seedMarket(db, "0xspam1", "0xspam1t", 101);
    await seedMarket(db, "0xspam2", "0xspam2t", 102);
    await seedMarket(db, "0xgood", "0xgoodt", 103);
    await db.query("UPDATE markets SET creator = $1 WHERE market_address IN ('0xspam1', '0xspam2')", [SPAMMER]);
    await db.query("UPDATE markets SET creator = $1 WHERE market_address = '0xgood'", [HONEST]);
    for (const m of ["0xspam1", "0xspam2", "0xgood"]) {
      await db.query(
        `INSERT INTO swaps (market_address, trader, is_buy, quote_amount, base_amount, fee, tax, quote_raised, price, block_number, block_hash, log_index, tx_hash, ts)
         VALUES ($1,'0xt',TRUE,10,1,0,0,0,1,1,'0xb',0,$2, NOW() - INTERVAL '10 minutes')`,
        [m, `0xtx${m}`],
      );
    }
  });

  const listed = async (): Promise<string[]> => {
    const body = (await get("/markets")).body;
    const rows = (body.items ?? body) as { market_address: string }[];
    return rows.map((r) => r.market_address).sort();
  };

  it("serves everything until a creator is hidden", async () => {
    expect(await listed()).toEqual(["0xgood", "0xspam1", "0xspam2"]);
  });

  it("leaves a hidden creator's markets off every surface, and keeps the rest", async () => {
    await ensureHiddenCreators(db, SPAMMER);

    expect(await listed()).toEqual(["0xgood"]);

    const lb = (await get("/leaderboard?window=24h")).body;
    for (const key of ["movers", "volume", "graduated", "rail"]) {
      const rows = lb[key] as { marketAddress: string }[];
      expect(rows.map((r) => r.marketAddress)).not.toContain("0xspam1");
      expect(rows.map((r) => r.marketAddress)).not.toContain("0xspam2");
    }

    expect((await get("/markets/0xspam1")).status).toBe(404);
    expect((await get("/markets/0xspam1t")).status).toBe(404);
    expect((await get("/markets/0xgood")).status).toBe(200);

    const swaps = (await get("/markets/0xspam1/swaps")).body;
    expect(((swaps.items ?? swaps) as unknown[]).length).toBe(0);
  });

  it("seeds from the variable additively, idempotently, and ignores junk", async () => {
    await db.query("INSERT INTO hidden_creators (address, reason) VALUES ('0xbyhand', 'operator')");
    const seeded = await ensureHiddenCreators(db, ` ${SPAMMER.toUpperCase()}, not-an-address ,, ${SPAMMER}`);
    expect(seeded).toEqual([SPAMMER, SPAMMER]);
    await ensureHiddenCreators(db, SPAMMER);
    const { rows } = await db.query<{ address: string; reason: string }>(
      "SELECT address, reason FROM hidden_creators ORDER BY address",
    );
    expect(rows).toEqual([
      { address: "0xbyhand", reason: "operator" },
      { address: SPAMMER, reason: "HIDDEN_CREATORS" },
    ]);
  });

  it("hides nothing when the variable is unset or empty", async () => {
    expect(await ensureHiddenCreators(db, undefined)).toEqual([]);
    expect(await ensureHiddenCreators(db, "")).toEqual([]);
    expect(await listed()).toEqual(["0xgood", "0xspam1", "0xspam2"]);
  });
});
