import { beforeEach, describe, expect, it } from "vitest";
import { createApi } from "../src/app/index.js";
import type { Db } from "../src/db/legacy.js";
import { memoryDatabase, seedMarket } from "./helpers.js";

describe("leaderboard and search", () => {
  let api: ReturnType<typeof createApi>; let db: Db;
  const get = async (p: string) => { const r = await api.request(`http://x${p}`); return { status: r.status, body: (await r.json()) as Record<string, unknown> }; };
  const swap = (m: string, n: number, price: number, quote: number, agoMin: number) => db.query(
    `INSERT INTO swaps (market_address, trader, is_buy, quote_amount, base_amount, fee, tax, quote_raised, price, block_number, block_hash, log_index, tx_hash, ts)
     VALUES ($1,'0xt',TRUE,$2,1,0,0,0,$3,$4,'0xb',0,$5, NOW() - ($6 || ' minutes')::interval)`, [m, quote, price, n, `0xtx${m}${n}`, String(agoMin)]);

  beforeEach(async () => {
    const database = await memoryDatabase(); db = database.legacy; api = createApi(database);
    for (const [i, m] of ["0xa", "0xb", "0xc"].entries()) {
      await seedMarket(db, m, `${m}t`, 100 + i);
      await db.query("UPDATE markets SET name = $2, ticker = $3, symbol = $3 WHERE market_address = $1", [m, `Name ${m}`, m.slice(2).toUpperCase() + "TK"]);
      await db.query("INSERT INTO market_stats (market_address, market_cap_quote, change_24h) VALUES ($1, $2, $3)", [m, (3 - i) * 100, i * 10]);
    }
    await db.query("UPDATE market_state SET last_price = 200 WHERE market_address = '0xa'");
    await db.query("UPDATE market_state SET last_price = 50 WHERE market_address = '0xb'");
    await swap("0xa", 1, 100, 10, 90); await swap("0xa", 2, 200, 30, 10);   // +100% over 1h, 30 volume in 1h
    await swap("0xb", 1, 100, 500, 90); await swap("0xb", 2, 50, 5, 20);    // -50%, 5 volume in 1h
    await swap("0xc", 1, 1, 1, 5);                                            // no 1h-old reference
    await db.query(`INSERT INTO graduations (market_address, pool_address, token_id, quote_amount, base_amount, liquidity, block_number, block_hash, log_index, tx_hash, ts)
                    VALUES ('0xb', '0xpool', 0, 0, 0, 0, 5, '0xb', 0, '0xg', NOW())`);
  });

  it("ranks movers and volume over the window, lists graduations and a rail by cap", async () => {
    const { status, body } = await get("/leaderboard?window=1h");
    expect(status).toBe(200);
    expect(body.window).toBe("1h");
    const movers = body.movers as { marketAddress: string; changeWindow: number }[];
    expect(movers.map((m) => m.marketAddress)).toEqual(["0xa", "0xb"]);
    expect(movers[0]!.changeWindow).toBeCloseTo(100, 5);
    const volume = body.volume as { marketAddress: string; volumeWindowQuote: string }[];
    expect(volume.map((v) => [v.marketAddress, v.volumeWindowQuote])).toEqual([["0xa", "30"], ["0xb", "5"], ["0xc", "1"]]);
    expect((body.graduated as { marketAddress: string }[]).map((g) => g.marketAddress)).toEqual(["0xb"]);
    expect((body.rail as { marketAddress: string }[]).map((r) => r.marketAddress)).toEqual(["0xa", "0xb", "0xc"]);
  });

  it("drops a runner that is more than 70% below its all-time high, and keeps one at exactly 70%", async () => {
    // 0xb last trades at 50. An ATH of 1,000 puts it 95% down: out. An ATH of 166 puts it 69.9%
    // down: still a runner. 0xa and 0xc have no ATH on record and are never judged.
    await db.query("UPDATE market_stats SET ath_quote = 1000 WHERE market_address = '0xb'");
    let volume = (await get("/leaderboard?window=1h")).body.volume as { marketAddress: string }[];
    expect(volume.map((v) => v.marketAddress)).toEqual(["0xa", "0xc"]);

    await db.query("UPDATE market_stats SET ath_quote = 166 WHERE market_address = '0xb'");
    volume = (await get("/leaderboard?window=1h")).body.volume as { marketAddress: string }[];
    expect(volume.map((v) => v.marketAddress)).toEqual(["0xa", "0xb", "0xc"]);

    // The movers list is not a runner board and keeps ranking the same market.
    await db.query("UPDATE market_stats SET ath_quote = 1000 WHERE market_address = '0xb'");
    const movers = (await get("/leaderboard?window=1h")).body.movers as { marketAddress: string }[];
    expect(movers.map((m) => m.marketAddress)).toEqual(["0xa", "0xb"]);
  });

  it("defaults to 24h and rejects an unknown window", async () => {
    expect((await get("/leaderboard")).body.window).toBe("24h");
    expect((await get("/leaderboard?window=1y")).status).toBe(400);
  });

  it("searches slim rows with change24h, capped at 8", async () => {
    const { body } = await get("/search?q=name");
    const items = body.items as { marketAddress: string; change24h: number | null; ticker: string }[];
    expect(items.map((i) => i.marketAddress)).toEqual(["0xa", "0xb", "0xc"]);
    expect(items[1]!.change24h).toBe(10);
    expect((await get("/search?q=btk")).body.items).toHaveLength(1);
    expect((await get("/search?q=0xc")).body.items).toHaveLength(1);
    expect((await get("/search?q=")).body.items).toEqual([]);
    expect((await get("/search?q=name&limit=50")).body.items).toHaveLength(3);
  });
});
