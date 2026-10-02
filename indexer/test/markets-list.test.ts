import { beforeEach, describe, expect, it } from "vitest";

import { createApi } from "../src/app/index.js";
import type { Db } from "../src/db/legacy.js";
import { rebuildMarketStats } from "../src/indexer/processing/stats.js";
import { ensureQuoteCatalog } from "../src/quotes/catalog.js";
import { USDC } from "./gen2-logs.js";
import { memoryDatabase, seedMarket, ZERO } from "./helpers.js";

interface Spec {
  m: string;
  name: string;
  ticker: string;
  quote: string;
  routing: number | null;
  cap: bigint;
  vol24: bigint;
  volAll: bigint;
  graduated?: boolean;
  change?: number | null;
  progress?: number;
}

async function seed(db: Db, s: Spec, i: number): Promise<void> {
  await seedMarket(db, s.m, `${s.m}tok`, 100 + i);
  await db.query(
    `UPDATE markets SET name=$2, ticker=$3, symbol=$3, quote_asset=$4, quote_decimals=$5,
            routing=$6, generation=2, quote_target=1000, total_supply=1
      WHERE market_address=$1`,
    [s.m, s.name, s.ticker, s.quote, s.quote === ZERO ? 18 : 6, s.routing],
  );
  await db.query(
    `UPDATE market_state SET volume_quote=$2, pool_address=$3, quote_raised=$4
      WHERE market_address=$1`,
    [s.m, s.volAll.toString(), s.graduated ? "0xpool" : null, Math.round((s.progress ?? 0) * 1000)],
  );
  await db.query(
    `INSERT INTO market_stats (market_address, market_cap_quote, market_cap_usd, volume_24h_quote,
                               volume_24h_usd, change_24h)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [s.m, s.cap.toString(), Number(s.cap), s.vol24.toString(), Number(s.vol24), s.change ?? null],
  );
}

const SPECS: Spec[] = [
  { m: "0xa1", name: "Alpha Moon", ticker: "ALPHA", quote: ZERO, routing: 2, cap: 500n, vol24: 10n, volAll: 100n, change: 5, progress: 0.5 },
  { m: "0xb2", name: "Beta", ticker: "BETA", quote: USDC, routing: 1, cap: 900n, vol24: 50n, volAll: 60n, graduated: true, change: -3, progress: 1 },
  { m: "0xc3", name: "Gamma Moon", ticker: "GAM", quote: ZERO, routing: 0, cap: 100n, vol24: 90n, volAll: 200n, change: null, progress: 0.1 },
  { m: "0xd4", name: "Delta", ticker: "DELTA", quote: USDC, routing: 2, cap: 700n, vol24: 0n, volAll: 10n, change: 20, progress: 0.9 },
];

describe("GET /markets (page mode)", () => {
  let api: ReturnType<typeof createApi>;
  let db: Db;
  const get = async (qs: string) => {
    const res = await api.request(`http://x/markets${qs}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const addresses = (b: Record<string, unknown>) =>
    (b.items as { market_address: string }[]).map((r) => r.market_address);

  beforeEach(async () => {
    const database = await memoryDatabase();
    db = database.legacy;
    api = createApi(database);
    await ensureQuoteCatalog(db);
    for (const [i, s] of SPECS.entries()) await seed(db, s, i);
  });

  it("keeps the cursor contract when a cursor is given", async () => {
    const { body } = await get("?limit=2&cursor=0xa1");
    expect(body).toHaveProperty("nextCursor");
    expect(addresses(body)).toEqual(["0xb2", "0xc3"]);
  });

  it("defaults to market cap descending with total, page, limit and pairCounts", async () => {
    const { status, body } = await get("");
    expect(status).toBe(200);
    expect(addresses(body)).toEqual(["0xb2", "0xd4", "0xa1", "0xc3"]);
    expect(body.total).toBe(4);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(24);
    expect(body.pairCounts).toEqual({ mon: 2, usdc: 2 });
  });

  const sortCases: [string, string[]][] = [
    ["volume24h", ["0xc3", "0xb2", "0xa1", "0xd4"]],
    ["daily", ["0xc3", "0xb2", "0xa1", "0xd4"]],
    // Whole units of each market's own quote, not raw ones: 60 raw USDC is 0.00006 dollars and
    // 200 raw MON is 2e-16 MON, so the two six-decimal markets lead. Ordering the raw columns
    // instead compares 1e-18ths of a MON against 1e-6ths of a dollar and reverses this.
    ["volumeAll", ["0xb2", "0xd4", "0xc3", "0xa1"]],
    ["all_time_vol", ["0xb2", "0xd4", "0xc3", "0xa1"]],
    ["change24h", ["0xd4", "0xa1", "0xb2", "0xc3"]],
    ["progress", ["0xb2", "0xd4", "0xa1", "0xc3"]],
    ["market_cap", ["0xb2", "0xd4", "0xa1", "0xc3"]],
  ];

  it.each(sortCases)("sorts by %s", async (sort, expected) => {
    expect(addresses((await get(`?sort=${sort}`)).body)).toEqual(expected);
  });

  it("sorts newest by launch order, under either spelling, and oldest first on asc", async () => {
    // Launched in block 100, 101, 102, 103: a1, b2, c3, d4. Newest first is the reverse.
    for (const sort of ["newest", "created"]) {
      expect(addresses((await get(`?sort=${sort}`)).body)).toEqual(["0xd4", "0xc3", "0xb2", "0xa1"]);
    }
    expect(addresses((await get("?sort=newest&order=asc")).body)).toEqual(["0xa1", "0xb2", "0xc3", "0xd4"]);
  });

  it("sorts bump by last trade, falling back to launch time", async () => {
    await db.query(`INSERT INTO swaps (market_address, trader, is_buy, quote_amount, base_amount, fee, tax, quote_raised, price, block_number, block_hash, log_index, tx_hash, ts)
                    VALUES ('0xc3','0xt',TRUE,1,1,0,0,0,1,1,'0xb',0,'0xbump',NOW())`);
    expect(addresses((await get("?sort=bump")).body)[0]).toBe("0xc3");
  });

  it("honours order=asc", async () => {
    expect(addresses((await get("?sort=marketCap&order=asc")).body)).toEqual([
      "0xc3",
      "0xa1",
      "0xd4",
      "0xb2",
    ]);
  });

  it("pages", async () => {
    const p1 = await get("?limit=3&page=1");
    const p2 = await get("?limit=3&page=2");
    expect(addresses(p1.body)).toHaveLength(3);
    expect(addresses(p2.body)).toEqual(["0xc3"]);
    expect(p2.body.total).toBe(4);
  });

  it("filters by pair using either the catalogue id or the address, counting over the unfiltered set", async () => {
    const byId = await get("?pair=usdc");
    expect(addresses(byId.body)).toEqual(["0xb2", "0xd4"]);
    expect(byId.body.pairCounts).toEqual({ mon: 2, usdc: 2 });
    const byAddr = await get(`?pair=${USDC}`);
    expect(addresses(byAddr.body)).toEqual(["0xb2", "0xd4"]);
    expect(addresses((await get("?pair=xaux")).body)).toEqual([]);
  });

  it("filters by status and routing", async () => {
    expect(addresses((await get("?status=graduated")).body)).toEqual(["0xb2"]);
    expect(addresses((await get("?status=curve")).body)).toEqual(["0xd4", "0xa1", "0xc3"]);
    expect(addresses((await get("?routing=creator")).body)).toEqual(["0xd4", "0xa1"]);
    expect(addresses((await get("?routing=buyback")).body)).toEqual(["0xc3"]);
  });

  it("searches name, ticker and address prefix, and counts pairs over the searched set", async () => {
    const { body } = await get("?q=moon");
    expect(addresses(body)).toEqual(["0xa1", "0xc3"]);
    expect(body.pairCounts).toEqual({ mon: 2 });
    expect(addresses((await get("?q=gam")).body)).toEqual(["0xc3"]);
    expect(addresses((await get("?q=0xd")).body)).toEqual(["0xd4"]);
    // Wildcards in the query are literal.
    expect(addresses((await get("?q=%25")).body)).toEqual([]);
  });

  it("clamps limit to 100 and rejects an unknown sort", async () => {
    expect((await get("?limit=1000")).body.limit).toBe(100);
    expect((await get("?sort=nope")).status).toBe(400);
  });

  it("carries the gen-2 columns and the stats on every row", async () => {
    const row = ((await get("?pair=usdc")).body.items as Record<string, unknown>[])[0]!;
    for (const k of [
      "generation", "quote_asset", "quote_decimals", "quote_symbol", "routing", "routed_recipient",
      "creator_tax_bps", "tax_recipient", "ticker", "logo_uri", "banner_uri", "description",
      "website", "x", "telegram", "market_cap_usd", "volume_24h_usd", "change_24h", "trades_24h",
      "ath_quote", "last_trade_at",
    ]) {
      expect(Object.keys(row), k).toContain(k);
    }
    expect(row.routing).toBe("holders");
    expect(row.quote_symbol).toBe("USDC");
    expect(typeof row.market_cap_usd).toBe("string");
  });
});

/**
 * The first read that orders markets of BOTH generations against each other.
 *
 * A stored price carries its own market's scale: generation 1's curve returns
 * `quote_wei * 1e18 / base_wei` — quote raw units per whole token — and generation 2's returns
 * `quote * 1e36 / base`, the same figure scaled a further 1e18 so a six-decimal quote does not
 * truncate to a couple of raw units. So `last_price`, `swaps.price`, the candles and
 * `market_stats.ath_quote` are NOT comparable between two markets of different generations, and an
 * ordering built on any of them ranks every generation-2 market a quintillion places out.
 *
 * The comparable figures are the CAPS — `market_stats.market_cap_quote` and `CAP_COLUMNS`, both of
 * which divide by `priceScaleSql` — and that is what every sort here is built on. This pins it:
 * two markets at the same real price, one of each generation, land next to each other with two
 * other markets straddling them. Order by the raw product instead and the generation-2 market goes
 * to the top of the list while the generation-1 one sits third.
 */
describe("GET /markets across both generations", () => {
  const WHOLE = 10n ** 18n;
  const SUPPLY = 1_000_000_000n * WHOLE; // 1e27 base units = 1e9 whole tokens

  it("ranks a gen-1 and a gen-2 market at the same real price next to each other", async () => {
    const database = await memoryDatabase();
    const db = database.legacy;
    const api = createApi(database);
    await ensureQuoteCatalog(db);

    const seedAt = async (market: string, generation: 1 | 2, quotePerToken: bigint) => {
      await seedMarket(db, market, `${market}tok`);
      await db.query(
        "UPDATE markets SET generation = $2, total_supply = $3 WHERE market_address = $1",
        [market, generation, SUPPLY.toString()],
      );
      const stored = generation === 2 ? quotePerToken * WHOLE : quotePerToken;
      await db.query("UPDATE market_state SET last_price = $2 WHERE market_address = $1", [
        market,
        stored.toString(),
      ]);
      await db.query(
        `INSERT INTO swaps (market_address, trader, is_buy, quote_amount, base_amount, fee, tax,
                            quote_raised, price, block_number, block_hash, log_index, tx_hash, ts)
         VALUES ($1,'0xt',TRUE,1,1,0,0,0,$2,1,'0xb',0,$3,NOW())`,
        [market, stored.toString(), `0xtx-${market}`],
      );
    };

    // Two markets at 3 MON a token, one of each generation, with a dearer and a cheaper market
    // around them. In RAW units the gen-2 market's price is 3e36 while the others are 5e18, 3e18
    // and 1e18 — so a sort that skips the normalisation puts it alone at the top.
    await seedAt("0x1high", 1, 5n * WHOLE);
    await seedAt("0x2gen1", 1, 3n * WHOLE);
    await seedAt("0x3gen2", 2, 3n * WHOLE);
    await seedAt("0x4low", 1, 1n * WHOLE);
    await rebuildMarketStats(db);

    const res = await api.request("http://x/markets?sort=marketCap");
    const body = (await res.json()) as {
      items: Record<string, string>[];
    };
    expect(body.items.map((r) => r.market_address)).toEqual([
      "0x1high",
      "0x2gen1",
      "0x3gen2",
      "0x4low",
    ]);

    const row = (address: string) => body.items.find((r) => r.market_address === address)!;
    const g1 = row("0x2gen1");
    const g2 = row("0x3gen2");
    // Three billion MON of cap, whichever generation the market runs on.
    expect(BigInt(g1.market_cap_quote!)).toBe(3_000_000_000n * WHOLE);
    expect(g2.market_cap_quote).toBe(g1.market_cap_quote);
    expect(g2.market_cap).toBe(g1.market_cap);
    expect(g2.ath_market_cap).toBe(g1.ath_market_cap);

    // And the convention that makes the caps possible, stated: a PRICE on the wire stays at its
    // own market's scale, the way `last_price`, `swaps.price` and the candles already do, and the
    // row's `generation` says which scale that is. Nothing sorts or compares one.
    expect(BigInt(g2.last_price!)).toBe(BigInt(g1.last_price!) * WHOLE);
    expect(BigInt(g2.ath_quote!)).toBe(BigInt(g1.ath_quote!) * WHOLE);
  });
});

/**
 * The board's fallback ordering, where a quote asset has no USD price.
 *
 * Two defects, both measured on the board Task 15 built. `COALESCE(market_cap_usd, 0)` reads a
 * missing price as "worth nothing", which sent a gold-quoted market holding roughly $10M below a
 * $2,000 one; and the raw fallback behind it compared 18-decimal MON units against 6-decimal USDC
 * ones, so a one-MON market outranked a million-dollar one.
 *
 * The fix is one ordering key rather than two: a USD figure where the quote has a price, and the
 * cap in WHOLE UNITS of the quote where it does not. That does not make one MON equal one XAUt0 —
 * nothing but a price does — but it is off by the ratio of two assets rather than by twelve orders
 * of magnitude, and an unpriced market keeps a position on the board instead of being sent to the
 * bottom of it.
 */
describe("GET /markets when a quote asset has no USD price", () => {
  const XAUT0 = "0x01bff41798a0bcf287b996046ca68b395dbc1071";
  const WETH = "0xee8c0e9f1bffb4eb878d8f15f368a02a35481242";

  let api: ReturnType<typeof createApi>;
  let db: Db;

  const addresses = (b: Record<string, unknown>) =>
    (b.items as { market_address: string }[]).map((r) => r.market_address);

  /** One market, with a cap and an all-time volume in raw units of its own quote asset. */
  const place = async (
    market: string,
    quote: string,
    decimals: number,
    capRaw: bigint,
    usd: number | null,
    volAllRaw: bigint,
    i: number,
  ): Promise<void> => {
    await seedMarket(db, market, `${market}tok`, 300 + i);
    await db.query(
      "UPDATE markets SET quote_asset = $2, quote_decimals = $3 WHERE market_address = $1",
      [market, quote, decimals],
    );
    await db.query("UPDATE market_state SET volume_quote = $2 WHERE market_address = $1", [
      market,
      volAllRaw.toString(),
    ]);
    await db.query(
      `INSERT INTO market_stats (market_address, market_cap_quote, market_cap_usd, volume_24h_quote)
       VALUES ($1, $2, $3, 0)`,
      [market, capRaw.toString(), usd],
    );
  };

  beforeEach(async () => {
    const database = await memoryDatabase();
    db = database.legacy;
    api = createApi(database);
    await ensureQuoteCatalog(db);
    // 3,846 troy ounces at ~$2,600 — about $10M, and the registry has no price for gold.
    await place("0xgold", XAUT0, 6, 3_846_000_000n, null, 3_846_000_000n, 0);
    // One whole WETH. Also unpriced, and 18 decimals against gold's 6.
    await place("0xweth", WETH, 18, 10n ** 18n, null, 10n ** 18n, 1);
    // Two thousand dollars, priced.
    await place("0xrich", USDC, 6, 2_000_000_000n, 2000, 2_000_000_000n, 2);
    // A hundred MON at $2.50.
    await place("0xsmall", ZERO, 18, 100n * 10n ** 18n, 250, 100n * 10n ** 18n, 3);
    // No rollup row at all: it must read as zero and sort last, not as NULL and sort first.
    await seedMarket(db, "0xnone", "0xnonetok", 310);
  });

  it("does not read a missing USD price as a market cap of zero", async () => {
    const body = (await (await api.request("http://x/markets?sort=marketCap")).json()) as Record<
      string,
      unknown
    >;
    expect(addresses(body)).toEqual(["0xgold", "0xrich", "0xsmall", "0xweth", "0xnone"]);
    expect(addresses(body).at(-1)).not.toBe("0xgold");
  });

  it("ranks unpriced markets in whole units of their quote, not in raw ones", async () => {
    const body = (await (await api.request("http://x/markets?sort=marketCap")).json()) as Record<
      string,
      unknown
    >;
    // 3,846 ounces beats 1 ether. In raw units it is 3.846e9 against 1e18 and loses by nine
    // orders of magnitude.
    const order = addresses(body);
    expect(order.indexOf("0xgold")).toBeLessThan(order.indexOf("0xweth"));
  });

  it("applies the same whole-unit treatment to all-time volume, which has no USD leg", async () => {
    const body = (await (await api.request("http://x/markets?sort=volumeAll")).json()) as Record<
      string,
      unknown
    >;
    expect(addresses(body)).toEqual(["0xgold", "0xrich", "0xsmall", "0xweth", "0xnone"]);
  });
});
