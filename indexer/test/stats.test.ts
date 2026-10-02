import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/legacy.js";
import { startJob } from "../src/indexer/jobs.js";
import { rebuildMarketStats } from "../src/indexer/processing/stats.js";
import { MarketRepository } from "../src/repositories/market.repository.js";
import { memoryDatabase, memoryDb, seedMarket, ZERO } from "./helpers.js";

const M = "0xcurve";
const T = "0xtoken";
const swap = (db: Db, n: number, price: string, quote: string, agoHours: number) =>
  db.query(
    `INSERT INTO swaps (market_address, trader, is_buy, quote_amount, base_amount, fee, tax, quote_raised, price,
                        block_number, block_hash, log_index, tx_hash, ts)
     VALUES ($1,'0xt',TRUE,$2,1,0,0,0,$3,$4,'0xb',0,$5, NOW() - ($6 || ' hours')::interval)`,
    [M, quote, price, n, `0xtx${n}`, String(agoHours)],
  );

describe("market_stats rollup", () => {
  let db: Db;
  beforeEach(async () => {
    db = await memoryDb();
    await seedMarket(db, M, T);
    await db.query("UPDATE markets SET total_supply = $1 WHERE market_address = $2", [
      (10n ** 27n).toString(),
      M,
    ]);
    await db.query("UPDATE market_state SET last_price = 200, holders = 7 WHERE market_address = $1", [
      M,
    ]);
  });

  it("computes cap, 24h volume/trades, change, ATH and last trade", async () => {
    await swap(db, 1, "100", "1000", 30); // outside the window: sets p24
    await swap(db, 2, "300", "500", 2); // ATH
    await swap(db, 3, "200", "700", 1);
    await rebuildMarketStats(db);
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT market_cap_quote::text AS cap, volume_24h_quote::text AS v24, trades_24h, change_24h,
              ath_quote::text AS ath, holders, market_cap_usd, last_trade_at
         FROM market_stats WHERE market_address = $1`,
      [M],
    );
    expect(rows[0]).toMatchObject({
      cap: ((200n * 10n ** 27n) / 10n ** 18n).toString(),
      v24: "1200",
      trades_24h: 2,
      ath: "300",
      holders: 7,
      market_cap_usd: null,
    });
    expect(rows[0]!.change_24h).toBeCloseTo(100, 5); // 100 → 200
    expect(rows[0]!.last_trade_at).not.toBeNull();
  });

  it("leaves change_24h null when nothing is 24 h old", async () => {
    await swap(db, 1, "100", "10", 1);
    await rebuildMarketStats(db);
    const { rows } = await db.query<{ change_24h: number | null; v24: string }>(
      "SELECT change_24h, volume_24h_quote::text AS v24 FROM market_stats",
    );
    expect(rows[0]).toEqual({ change_24h: null, v24: "10" });
  });

  it("prices cap and volume in USD when the quote has a price", async () => {
    await db.query(
      `INSERT INTO quote_assets (id, address, decimals, usd_price, usd_price_at) VALUES ('mon', $1, 18, 2.5, NOW())`,
      [ZERO],
    );
    // A price that puts 200 whole MON of cap on this supply, rather than the fixture's 200 WEI:
    // 2e11 per whole token x 1e9 tokens = 2e20 raw = 200 MON, which at $2.50 is the $500 below.
    // The suite's default price of 200 makes the cap 2e-7 MON, and a dollar figure of 5e-7.
    await db.query("UPDATE market_state SET last_price = $1 WHERE market_address = $2", [
      (200n * 10n ** 9n).toString(),
      M,
    ]);
    await swap(db, 1, "200", (4n * 10n ** 18n).toString(), 1);
    await rebuildMarketStats(db);
    const { rows } = await db.query<{ cap: string; v: string }>(
      "SELECT market_cap_usd::text AS cap, volume_24h_usd::text AS v FROM market_stats",
    );
    // cap = 2e11 x 1e27 / 1e18 = 2e20 raw = 200 MON → $500; volume 4 MON → $10
    expect(Number(rows[0]!.cap)).toBeCloseTo(500, 6);
    expect(Number(rows[0]!.v)).toBeCloseTo(10, 6);
  });

  it("writes a row for a market with no trades", async () => {
    await rebuildMarketStats(db);
    const { rows } = await db.query<{ v24: string; ath: string; last_trade_at: null }>(
      "SELECT volume_24h_quote::text AS v24, ath_quote::text AS ath, last_trade_at FROM market_stats",
    );
    expect(rows[0]).toEqual({ v24: "0", ath: "0", last_trade_at: null });
  });
});

/**
 * The scale a stored price carries is a property of the GENERATION that emitted it.
 *
 * Generation 1's curve returns `quote_wei * 1e18 / base_wei`; generation 2's returns
 * `quote * 1e36 / base` (`BondingCurve._price`), the same quantity scaled by a further 1e18 so a
 * six-decimal quote does not truncate to a couple of raw units. Multiply either by a supply in base
 * units and the extra scale has to come back out — the RIGHT one, or the answer is off by a
 * quintillion and still renders as an ordinary number.
 *
 * One whole token worth 3 MON, a billion tokens outstanding: three billion MON of market cap,
 * whichever generation the market runs on.
 */
const WHOLE = 10n ** 18n;
const SUPPLY = 1_000_000_000n * WHOLE; // 1e27 base units = 1e9 whole tokens
const PRICE_PER_TOKEN = 3n * WHOLE; // 3 MON per whole token, in quote wei
const EXPECTED_CAP = 3_000_000_000n * WHOLE; // 3e27 quote wei

describe("market cap is generation-aware", () => {
  it("gives two markets at the same real price the same cap, on both read paths", async () => {
    const database = await memoryDatabase();
    const db = database.legacy;
    const G1 = "0xgen1curve";
    const G2 = "0xgen2curve";
    await seedMarket(db, G1, "0xgen1token");
    await seedMarket(db, G2, "0xgen2token");
    await db.query("UPDATE markets SET total_supply = $1", [SUPPLY.toString()]);
    await db.query("UPDATE markets SET generation = 2 WHERE market_address = $1", [G2]);

    // The same real price, in each generation's own units.
    const gen1Price = PRICE_PER_TOKEN; // quote wei per whole token
    const gen2Price = PRICE_PER_TOKEN * WHOLE; // the same, scaled a further 1e18
    for (const [market, price] of [
      [G1, gen1Price],
      [G2, gen2Price],
    ] as const) {
      await db.query("UPDATE market_state SET last_price = $2 WHERE market_address = $1", [
        market,
        price.toString(),
      ]);
      // One trade at that price, so the all-time-high cap is computed from something too.
      await db.query(
        `INSERT INTO swaps (market_address, trader, is_buy, quote_amount, base_amount, fee, tax,
                            quote_raised, price, block_number, block_hash, log_index, tx_hash, ts)
         VALUES ($1,'0xt',TRUE,1,1,0,0,0,$2,1,'0xb',0,$3,NOW())`,
        [market, price.toString(), `0xtx-${market}`],
      );
    }

    // The rollup this task adds.
    await rebuildMarketStats(db);
    const { rows: stats } = await db.query<{ market_address: string; cap: string }>(
      "SELECT market_address, market_cap_quote::text AS cap FROM market_stats ORDER BY market_address",
    );
    expect(stats.map((r) => r.cap)).toEqual([EXPECTED_CAP.toString(), EXPECTED_CAP.toString()]);

    // And the read path the market list and the detail page use.
    const repo = new MarketRepository(database.prisma);
    for (const market of [G1, G2]) {
      const row = await repo.findByAddress(market);
      expect(BigInt(row!.market_cap), `${market} cap`).toBe(EXPECTED_CAP);
      expect(BigInt(row!.ath_market_cap), `${market} ath cap`).toBe(EXPECTED_CAP);
    }
  });
});

describe("startJob", () => {
  it("runs on an interval, never overlaps, and keeps going after a failure", async () => {
    vi.useFakeTimers();
    let running = 0;
    let calls = 0;
    let overlapped = false;
    const errors: unknown[] = [];
    const job = startJob({
      name: "t",
      intervalMs: 100,
      run: async () => {
        calls++;
        if (running++ > 0) overlapped = true;
        await new Promise((r) => setTimeout(r, 150));
        running--;
        if (calls === 2) throw new Error("boom");
      },
      onError: (e) => errors.push(e),
    });
    await vi.advanceTimersByTimeAsync(1000);
    job.stop();
    vi.useRealTimers();
    expect(overlapped).toBe(false);
    expect(errors).toHaveLength(1);
    expect(calls).toBeGreaterThanOrEqual(4);
  });
});
