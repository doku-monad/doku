import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApi } from "../src/app/index.js";
import type { Db } from "../src/db/legacy.js";
import { MarketRepository, PositionRepository } from "../src/repositories/index.js";
import { memoryDatabase, seedMarket } from "./helpers.js";

/**
 * A retired generation must be absent from EVERY surface, not from the market list.
 *
 * Generation 2 was retired after an audit found four ways for anyone to permanently freeze a
 * market's entire raise; its contracts are immutable, so the fix was a new deployment and the old
 * markets stay in this database. The first cut filtered the market list alone, which is the shape
 * this failure always takes — the board looks right, and the market is still reachable by address,
 * still in the leaderboard, still in a portfolio, still counted by a pair chip. Any one of those is
 * a route into buying a token whose raise a stranger can freeze.
 *
 * So this suite is written as a sweep rather than as a list of cases: one retired market and one
 * live one, identical in every other respect, and every read asserted to return exactly the second.
 * `SURFACES` is the sweep, and the guards at the bottom are what make it keep up — one on the source
 * (`FROM markets` must not appear in the read layer) and one on the repositories (a method nobody
 * has decided about fails the build).
 */

/** The repointing. Launched before it is generation 2; after it is generation 3. */
const CUTOVER = "150";

const RETIRED = "0xretired";
const RETIRED_TOKEN = "0xretiredtok";
const LIVE = "0xlive";
const LIVE_TOKEN = "0xlivetok";

const CREATOR = "0xcreator";
const TRADER = "0xtrader";
const HOLDER = "0xholder";
const LP = "0xlp";
const USDC = "0x0000000000000000000000000000000000000abc";

/**
 * Everything a market can own, so that no surface is empty for a reason other than the cut.
 *
 * A test where the retired market has no swaps proves nothing: the swap feed would be empty with or
 * without the filter. Both markets therefore get a trade inside the leaderboard's window, a trade
 * old enough to be its reference price, a candle, a holder, a position, a graduation, a rollup row
 * and a fee ledger.
 */
async function seedEverything(
  db: Db,
  market: string,
  token: string,
  block: number,
  name: string,
): Promise<void> {
  await seedMarket(db, market, token, block);
  await db.query(
    `UPDATE markets SET name=$2, ticker=$3, symbol=$3, creator=$4, routed_recipient=$4,
            tax_recipient=$4, quote_asset=$5, quote_decimals=6, generation=2, routing=2,
            quote_target=1000, total_supply=1000000
      WHERE market_address=$1`,
    [market, name, name.slice(0, 3).toUpperCase(), CREATOR, USDC],
  );
  await db.query(
    `UPDATE market_state SET last_price=2000000000000000000, quote_raised=500, volume_quote=9000,
            trade_count=2, holders=1, pool_address='0xpoolmanager'
      WHERE market_address=$1`,
    [market],
  );
  await db.query(
    `INSERT INTO market_stats (market_address, market_cap_quote, market_cap_usd, volume_24h_quote,
                              volume_24h_usd, change_24h, trades_24h, ath_quote)
     VALUES ($1, 5000, 5000, 4000, 4000, 12.5, 2, 3000000000000000000)`,
    [market],
  );
  await db.query(
    `INSERT INTO market_rewards (market_address, routed_generated, routed_collected, tax_generated)
     VALUES ($1, 700, 100, 50)`,
    [market],
  );
  await db.query(
    `INSERT INTO graduations (market_address, pool_address, pool_id, token_id, quote_amount,
                              base_amount, liquidity, block_number, block_hash, log_index, tx_hash,
                              ts)
     VALUES ($1, '0xpoolmanager', $2, 1, 10, 10, 10, $3, '0xbb', 0, $4, NOW())`,
    [market, `${market}pool`, block, `0xgrad-${market}`],
  );
  // Two trades: one inside the 24h window for `topVolume`, one outside it so `movers` has a
  // reference price. `movers` excludes a market without one, which would hide the retired market
  // from that list for the wrong reason.
  await db.query(
    `INSERT INTO swaps (market_address, trader, is_buy, quote_amount, base_amount, fee, tax,
                        quote_raised, price, block_number, block_hash, log_index, tx_hash, ts)
     VALUES ($1, $2, TRUE, 4000, 4000, 0, 0, 4000, 1000000000000000000, $3, '0xbb', 0, $4,
             NOW() - INTERVAL '2 days'),
            ($1, $2, TRUE, 5000, 5000, 0, 0, 9000, 2000000000000000000, $3, '0xbb', 1, $5, NOW())`,
    [market, TRADER, block, `0xtx-old-${market}`, `0xtx-new-${market}`],
  );
  await db.query(
    `INSERT INTO candlesticks (market_address, period_secs, bucket_start, open, high, low, close,
                               volume_quote, trade_count)
     VALUES ($1, 3600, NOW(), 1, 2, 1, 2, 9000, 2)`,
    [market],
  );
  await db.query(
    `INSERT INTO token_balances (token_address, holder, balance) VALUES ($1, $2, 1000)`,
    [token, HOLDER],
  );
  await db.query(
    `INSERT INTO positions (token_id, pool_id, market_address, owner, tick_lower, tick_upper,
                            liquidity, block_number)
     VALUES ($1, $2, $3, $4, -100, 100, 5000, $5)`,
    [block, `${market}pool`, market, LP, block],
  );
}

/**
 * Every read that can name a market, and how to get the addresses out of its response.
 *
 * Table-driven so that adding a surface is adding a row, and so that the same two assertions run
 * against all of them — "the live market is here" alongside "the retired one is not". The first half
 * matters as much as the second: a cut that filtered everything would pass a test that only checked
 * for absence.
 */
/** The distinct markets a response names. A trade feed returns a row per trade, not per market. */
const named = (addresses: string[]): string[] => [...new Set(addresses)].sort();

type Body = Record<string, unknown>;

/**
 * One list out of a response, by the key it arrives under and the key its rows call the address.
 *
 * Written as a reader rather than as a typed shape per endpoint, because the point of the table is
 * that thirteen unrelated response shapes get the same two assertions.
 */
const from =
  (list: string, key: string) =>
  (body: Body): string[] =>
    (body[list] as Record<string, string>[]).map((row) => row[key]!);

const SURFACES: { name: string; path: string; addresses: (body: Body) => string[] }[] = [
  {
    name: "GET /markets (cursor mode)",
    path: "/markets?cursor=",
    addresses: from("items", "market_address"),
  },
  {
    name: "GET /markets (board page)",
    path: "/markets",
    addresses: from("items", "market_address"),
  },
  {
    name: "GET /markets?q= (board search)",
    path: "/markets?q=moon",
    addresses: from("items", "market_address"),
  },
  {
    name: "GET /search (command palette)",
    path: "/search?q=moon",
    addresses: from("items", "marketAddress"),
  },
  {
    name: "GET /leaderboard movers",
    path: "/leaderboard?window=24h",
    addresses: from("movers", "marketAddress"),
  },
  {
    name: "GET /leaderboard volume",
    path: "/leaderboard?window=24h",
    addresses: from("volume", "marketAddress"),
  },
  {
    name: "GET /leaderboard graduated",
    path: "/leaderboard?window=24h",
    addresses: from("graduated", "marketAddress"),
  },
  {
    name: "GET /leaderboard rail",
    path: "/leaderboard?window=24h",
    addresses: from("rail", "marketAddress"),
  },
  {
    name: "GET /accounts/:a/launches",
    path: `/accounts/${CREATOR}/launches`,
    addresses: from("items", "marketAddress"),
  },
  {
    name: "GET /accounts/:a/balances",
    path: `/accounts/${HOLDER}/balances`,
    addresses: from("items", "market_address"),
  },
  {
    name: "GET /accounts/:a/swaps",
    path: `/accounts/${TRADER}/swaps`,
    addresses: from("items", "market_address"),
  },
  {
    name: "GET /accounts/:a/positions",
    path: `/accounts/${LP}/positions`,
    addresses: from("items", "market_address"),
  },
  {
    name: "GET /creators/:a",
    path: `/creators/${CREATOR}`,
    addresses: from("markets", "marketAddress"),
  },
];

/** The per-market feeds, which answer about one address rather than listing several. */
const FEEDS = [
  { name: "swaps", path: (m: string) => `/markets/${m}/swaps` },
  { name: "holders", path: (m: string) => `/markets/${m}/holders` },
  { name: "candlesticks", path: (m: string) => `/markets/${m}/candlesticks?period=3600` },
];

describe("a retired generation", () => {
  let api: ReturnType<typeof createApi>;
  let markets: MarketRepository;
  let positions: PositionRepository;
  const before = process.env.START_BLOCK;

  const get = async (path: string) => {
    const res = await api.request(`http://x${path}`);
    return { status: res.status, body: (await res.json()) as Body };
  };

  beforeAll(async () => {
    const database = await memoryDatabase();
    const db = database.legacy;
    api = createApi(database);
    markets = new MarketRepository(database.prisma);
    positions = new PositionRepository(database.prisma);

    await db.query(
      `INSERT INTO quote_assets (id, address, symbol, name, decimals, registered, enabled, usd_price)
       VALUES ('usdc', $1, 'USDC', 'USD Coin', 6, TRUE, TRUE, 1)`,
      [USDC],
    );
    await seedEverything(db, RETIRED, RETIRED_TOKEN, 100, "Retired Moon");
    await seedEverything(db, LIVE, LIVE_TOKEN, 200, "Live Moon");
    process.env.START_BLOCK = CUTOVER;
  }, 120_000);

  afterAll(() => {
    if (before === undefined) delete process.env.START_BLOCK;
    else process.env.START_BLOCK = before;
  });

  describe("is absent from every surface that lists markets", () => {
    it.each(SURFACES)("$name", async ({ path, addresses }) => {
      const { status, body } = await get(path);
      expect(status).toBe(200);
      expect(named(addresses(body))).toEqual([LIVE]);
    });
  });

  describe("serves nothing on a per-market feed", () => {
    it.each(FEEDS)("$name", async ({ path }) => {
      const retired = await get(path(RETIRED));
      expect(retired.status).toBe(200);
      expect(retired.body.items).toEqual([]);
      // The live market's feed is the control: these would all be empty if the fixture were wrong.
      const live = await get(path(LIVE));
      expect((live.body.items as unknown[]).length).toBeGreaterThan(0);
    });
  });

  /**
   * The lookup, which is the one read that must answer rather than go quiet.
   *
   * 410 and not 404, because the reader is holding the address of a market that exists and is still
   * quoting: "no such market" reads as a typo and sends them to find it somewhere that will sell
   * them one. The body names the generation so the claim can be checked.
   */
  it("answers 410 Gone, naming the generation, for a market-by-address lookup", async () => {
    const { status, body } = await get(`/markets/${RETIRED}`);
    expect(status).toBe(410);
    expect(body.error).toBe("retired");
    expect(body.market).toBe(RETIRED);
    expect(body.generation).toBe(2);
    expect(body.detail).toMatch(/retired/i);
    // And not a shred of the market itself, which is what a client would render.
    expect(body).not.toHaveProperty("last_price");
    expect(body).not.toHaveProperty("quote_raised");
  });

  it("answers 410 for a retired market's fee ledger rather than an empty one", async () => {
    const { status, body } = await get(`/markets/${RETIRED}/rewards`);
    expect(status).toBe(410);
    expect(body.generation).toBe(2);
  });

  /** 404 has to keep meaning "no such market", or 410 says nothing. */
  it("still 404s for an address that was never a market", async () => {
    expect((await get("/markets/0xnope")).status).toBe(404);
    expect((await get("/markets/0xnope/rewards")).status).toBe(404);
  });

  it("serves the live market and its ledger", async () => {
    const market = await get(`/markets/${LIVE}`);
    expect(market.status).toBe(200);
    expect(market.body.market_address).toBe(LIVE);
    // The flag the repository carries is internal and must not reach a client, which would then
    // have a field it could read as "tradeable".
    expect(market.body).not.toHaveProperty("retired");
    const rewards = await get(`/markets/${LIVE}/rewards`);
    expect(rewards.status).toBe(200);
    expect(rewards.body.routedGenerated).toBe("700");
  });

  it("counts only the served generation in the board's totals and pair chips", async () => {
    const board = await get("/markets");
    expect(board.body.total).toBe(1);
    expect(board.body.pairCounts).toEqual({ usdc: 1 });
    const quotes = await get("/quotes");
    const usdc = (quotes.body.items as { id: string; marketCount: number }[]).find(
      (q) => q.id === "usdc",
    );
    expect(usdc?.marketCount).toBe(1);
  });

  it("counts only the served generation in /status", async () => {
    const { body } = await get("/status");
    expect(body.markets).toBe(1);
    // Two trades per market, and only one market is served.
    expect(body.swaps).toBe(2);
  });

  it("hides a retired market's liquidity providers", async () => {
    expect(await positions.listForMarket(RETIRED, 50)).toEqual([]);
    expect((await positions.listForMarket(LIVE, 50)).length).toBe(1);
  });

  /**
   * The deliberate exception, asserted so that "it still indexes them" is a decision rather than an
   * oversight someone later tidies up.
   *
   * Ingestion keeps following the retired markets' tokens and pools, because that is what makes the
   * cutover reversible: flipping `START_BLOCK` back has to serve a current picture, where an
   * ingester narrowed to the live generation would leave a hole only a full re-scan could fill.
   */
  it("keeps indexing the retired markets, which is what makes the cut reversible", async () => {
    const known = await markets.knownAddresses();
    expect(known.tokens).toContain(RETIRED_TOKEN);
    expect(known.tokens).toContain(LIVE_TOKEN);
  });

  /**
   * `START_BLOCK=0` is the default and means "never repointed".
   *
   * A deployment that has not been moved to a new generation must serve everything it has indexed.
   * Reading the block per query rather than at import is what makes this assertable at all — and is
   * also what makes a repointing take effect on a restart rather than on a redeploy.
   */
  describe("with START_BLOCK=0, the never-repointed default", () => {
    beforeAll(() => {
      process.env.START_BLOCK = "0";
    });
    afterAll(() => {
      process.env.START_BLOCK = CUTOVER;
    });

    it.each(SURFACES)("$name serves both markets", async ({ path, addresses }) => {
      const { body } = await get(path);
      expect(named(addresses(body))).toEqual(named([LIVE, RETIRED]));
    });

    it.each(FEEDS)("$name serves the pre-cutover market's feed", async ({ path }) => {
      const { body } = await get(path(RETIRED));
      expect((body.items as unknown[]).length).toBeGreaterThan(0);
    });

    it("serves the pre-cutover market by address, with no 410", async () => {
      const { status, body } = await get(`/markets/${RETIRED}`);
      expect(status).toBe(200);
      expect(body.market_address).toBe(RETIRED);
    });

    it("counts both markets", async () => {
      expect((await get("/status")).body.markets).toBe(2);
      expect((await get("/markets")).body.total).toBe(2);
    });
  });
});

/**
 * The two guards, which are what keep the sweep above from going quietly out of date.
 *
 * The cut is structural — a read selects from `servedMarkets()` instead of from the table — but
 * structure only holds while nobody writes `FROM markets` out of habit. That is one grep. The other
 * guard is about additions: a repository method written next month is a surface this file has never
 * heard of, and a sweep cannot fail for a query it does not know exists.
 */
describe("the cut cannot be forgotten", () => {
  const dir = new URL("../src/repositories/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "served.ts");

  it("finds the read layer", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  /**
   * `served.ts` is the only file allowed to name the table, so every other read goes through a
   * fragment that carries the cut. `EVERY_MARKET` is how the two deliberate exceptions — the
   * address lookup and the ingester's filter — spell themselves out.
   */
  it.each(files)("%s does not name the markets table directly", (file) => {
    const source = readFileSync(new URL(file, dir), "utf8");
    const sql = source.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    expect(sql).not.toMatch(/\b(FROM|JOIN)\s+markets\b/i);
  });

  /**
   * Every repository method, and the decision made about it.
   *
   * Listed rather than derived, because the point is that somebody looked: a new method fails here
   * until its name is added, and adding it means answering "can this return a retired market?".
   * Private helpers are on the prototype too and are listed for the same reason.
   */
  const DECIDED: Record<string, string[]> = {
    MarketRepository: [
      "list",
      "listPaged",
      "where",
      "countOnly",
      "findByAddress",
      "rewards",
      "listByCreator",
      "movers",
      "topVolume",
      "recentlyGraduated",
      "rail",
      "search",
      "knownAddresses",
    ],
    StatusRepository: ["read", "readLag", "readCheckpoint", "writeCheckpoint"],
    SwapRepository: ["listForMarket", "listForAccount"],
    HolderRepository: ["listForMarket", "listForAccount"],
    PositionRepository: ["listForMarket", "listForAccount"],
    CandlestickRepository: ["listForMarket"],
    CreatorRepository: ["balances", "markets"],
    QuoteRepository: ["list"],
    UploadRepository: ["upsert", "find", "orphans", "remove"],
  };

  it("has a decision recorded for every repository method", async () => {
    const repositories = (await import("../src/repositories/index.js")) as Record<string, unknown>;
    for (const [name, exported] of Object.entries(repositories)) {
      if (typeof exported !== "function" || !name.endsWith("Repository")) continue;
      const methods = Object.getOwnPropertyNames(exported.prototype as object).filter(
        (m) => m !== "constructor",
      );
      expect(DECIDED[name], `${name} is new — decide what it does about retired markets`).toBeDefined();
      for (const method of methods) {
        expect(
          DECIDED[name],
          `${name}.${method} is new — can it return a market launched before START_BLOCK?`,
        ).toContain(method);
      }
      // And nothing stale: a method removed from the class should leave this list too, or the next
      // reader trusts a decision about code that is gone.
      for (const listed of DECIDED[name]!) expect(methods).toContain(listed);
    }
  });
});
