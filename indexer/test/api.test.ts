import { beforeEach, describe, expect, it } from "vitest";
import { createApi } from "../src/app/index.js";
import type { Db } from "../src/db/legacy.js";
import { memoryDatabase, seedMarket } from "./helpers.js";

const MARKET = "0xcurve";
const TOKEN = "0xtoken";

/** Insert a swap with an explicit block so ordering is deterministic. */
async function seedSwap(db: Db, n: number): Promise<void> {
  await db.query(
    `INSERT INTO swaps (market_address, trader, is_buy, quote_amount, base_amount, fee, tax,
                        quote_raised, price, block_number, block_hash, log_index, tx_hash, ts)
     VALUES ($1, '0xtrader', TRUE, $2, $2, 0, 0, $2, 1, $3, '0xbb', 0, $4, NOW())`,
    [MARKET, (n * 1_000).toString(), n, `0xtx${n}`],
  );
}

describe("read API", () => {
  let db: Db;
  let api: ReturnType<typeof createApi>;

  const get = async (path: string) => {
    const res = await api.request(`http://x${path}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  beforeEach(async () => {
    const database = await memoryDatabase();
    db = database.legacy;
    api = createApi(database);
    await seedMarket(db, MARKET, TOKEN);
  });

  it("serves a market with its state joined in", async () => {
    const { status, body } = await get(`/markets/${MARKET}`);
    expect(status).toBe(200);
    expect(body.market_address).toBe(MARKET);
    expect(body.token_address).toBe(TOKEN);
    expect(body).toHaveProperty("quote_raised");
  });

  it("serves the same market when asked by its token address", async () => {
    // The route and the CA chip carry the TOKEN; the row is keyed by the curve. One lookup, either key.
    const { status, body } = await get(`/markets/${TOKEN}`);
    expect(status).toBe(200);
    expect(body.market_address).toBe(MARKET);
    expect(body.token_address).toBe(TOKEN);
  });

  it("404s for a market that does not exist", async () => {
    const { status } = await get("/markets/0xnope");
    expect(status).toBe(404);
  });

  it("rejects an unsupported candlestick period instead of returning nothing", async () => {
    const { status, body } = await get(`/markets/${MARKET}/candlesticks?period=7`);
    expect(status).toBe(400);
    expect(body.supported).toBeDefined();
  });

  /**
   * The reason the API uses cursors at all.
   *
   * A trade feed inserts while a user reads it. With OFFSET, rows arriving between pages shift
   * everything down and page two repeats what page one already showed — which looks like a
   * rendering bug and gets chased in the wrong layer. The cursor is anchored to a row, so new
   * rows cannot move it.
   */
  it("does not repeat or skip rows when new trades arrive mid-page", async () => {
    for (let n = 1; n <= 10; n++) await seedSwap(db, n);

    const first = await get(`/markets/${MARKET}/swaps?limit=5`);
    const firstIds = (first.body.items as { id: string }[]).map((r) => r.id);
    expect(firstIds).toHaveLength(5);

    // Five more trades land while the user is looking at page one.
    for (let n = 11; n <= 15; n++) await seedSwap(db, n);

    const second = await get(
      `/markets/${MARKET}/swaps?limit=5&cursor=${first.body.nextCursor}`,
    );
    const secondIds = (second.body.items as { id: string }[]).map((r) => r.id);

    expect(secondIds).toHaveLength(5);
    expect(secondIds.filter((id) => firstIds.includes(id))).toEqual([]);
  });

  it("walks the whole swap list exactly once across pages", async () => {
    for (let n = 1; n <= 23; n++) await seedSwap(db, n);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const q: string = cursor ? `&cursor=${cursor}` : "";
      const { body } = await get(`/markets/${MARKET}/swaps?limit=5${q}`);
      const items = body.items as { id: string }[];
      if (items.length === 0) break;
      seen.push(...items.map((r) => r.id));
      cursor = body.nextCursor as string;
    }

    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);
  });

  /// Balances tie constantly — every wallet that bought a round number holds the same amount — so
  /// a cursor on balance alone either loops on the boundary or steps over it.
  it("pages holders past tied balances", async () => {
    for (let i = 0; i < 9; i++) {
      await db.query(
        "INSERT INTO token_balances (token_address, holder, balance) VALUES ($1, $2, 1000)",
        [TOKEN, `0xholder${i}`],
      );
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const q: string = cursor ? `&cursor=${cursor}` : "";
      const { body } = await get(`/markets/${MARKET}/holders?limit=4${q}`);
      const items = body.items as { holder: string }[];
      if (items.length === 0) break;
      seen.push(...items.map((r) => r.holder));
      cursor = body.nextCursor as string;
    }

    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);
  });

  it("omits the curve from the holder list", async () => {
    await db.query(
      "INSERT INTO token_balances (token_address, holder, balance) VALUES ($1, $2, 999)",
      [TOKEN, MARKET],
    );
    await db.query(
      "INSERT INTO token_balances (token_address, holder, balance) VALUES ($1, $2, 5)",
      [TOKEN, "0xperson"],
    );
    const { body } = await get(`/markets/${MARKET}/holders`);
    expect((body.items as { holder: string }[]).map((r) => r.holder)).toEqual(["0xperson"]);
  });

  /**
   * "My trades" has to mean all of them.
   *
   * Filtering a single page client-side produces a list that looks complete and is not — a trader
   * whose last trade was sixty trades ago sees an empty history and concludes the feature is
   * broken, or worse, that their trade did not happen.
   */
  it("filters swaps by trader across the whole history, not just one page", async () => {
    for (let n = 1; n <= 30; n++) await seedSwap(db, n);
    await db.query(
      `INSERT INTO swaps (market_address, trader, is_buy, quote_amount, base_amount, fee, tax,
                          quote_raised, price, block_number, block_hash, log_index, tx_hash, ts)
       VALUES ($1, '0xmine', TRUE, 5, 5, 0, 0, 5, 1, 0, '0xbb', 0, '0xtx-mine', NOW())`,
      [MARKET],
    );

    // The trader's only swap is the oldest row, well past the first page.
    const { body } = await get(`/markets/${MARKET}/swaps?trader=0xmine&limit=5`);
    const items = body.items as { trader: string }[];
    expect(items).toHaveLength(1);
    expect(items[0]!.trader).toBe("0xmine");
  });

  it("matches a trader regardless of address casing", async () => {
    await db.query(
      `INSERT INTO swaps (market_address, trader, is_buy, quote_amount, base_amount, fee, tax,
                          quote_raised, price, block_number, block_hash, log_index, tx_hash, ts)
       VALUES ($1, '0xabc', TRUE, 5, 5, 0, 0, 5, 1, 1, '0xbb', 0, '0xtx-c', NOW())`,
      [MARKET],
    );
    const { body } = await get(`/markets/${MARKET}/swaps?trader=0xABC`);
    expect((body.items as unknown[]).length).toBe(1);
  });

  it("returns every swap when no trader is given", async () => {
    for (let n = 1; n <= 3; n++) await seedSwap(db, n);
    const { body } = await get(`/markets/${MARKET}/swaps`);
    expect((body.items as unknown[]).length).toBe(3);
  });

  /**
   * A rolling 24-hour figure, computed on read.
   *
   * Deliberately not stored. A stored rolling total has to *decay* — a trade from twenty-five
   * hours ago must leave the window — and nothing fires when time simply passes. That needs a
   * sweeper, and a stalled sweeper leaves a number that silently overstates volume forever. Read
   * from the swaps table it is correct by construction, and the (market_address, ts) index already
   * exists for the trade feed.
   */
  it("counts only the last 24 hours of volume", async () => {
    await db.query(
      `INSERT INTO swaps (market_address, trader, is_buy, quote_amount, base_amount, fee, tax,
                          quote_raised, price, block_number, block_hash, log_index, tx_hash, ts)
       VALUES ($1, '0xt', TRUE, 100, 100, 0, 0, 100, 1, 1, '0xbb', 0, '0xrecent', NOW())`,
      [MARKET],
    );
    await db.query(
      `INSERT INTO swaps (market_address, trader, is_buy, quote_amount, base_amount, fee, tax,
                          quote_raised, price, block_number, block_hash, log_index, tx_hash, ts)
       VALUES ($1, '0xt', TRUE, 900, 900, 0, 0, 900, 1, 2, '0xbb', 1, '0xold',
               NOW() - INTERVAL '25 hours')`,
      [MARKET],
    );

    const { body } = await get(`/markets/${MARKET}`);
    expect(body.volume_24h).toBe("100");
    // All-time volume is a different figure and must not be affected.
    const list = await get("/markets");
    const row = (list.body.items as Record<string, unknown>[]).find(
      (m) => m.market_address === MARKET,
    )!;
    expect(row.volume_24h).toBe("100");
  });

  /// A market with no recent trades reports zero, not null — a null renders as "—" where a real
  /// zero is the answer.
  it("reports zero 24h volume rather than null for a quiet market", async () => {
    const { body } = await get(`/markets/${MARKET}`);
    expect(body.volume_24h).toBe("0");
  });

  /**
   * The cursor contract, which is now opt-in.
   *
   * `GET /markets` answers in page mode unless a `cursor` is sent, so the first request has to send
   * one to be walking the cursor at all. `0x` is the shortest prefix every address sorts after, so
   * it means "from the beginning" without naming a market.
   */
  it("lists markets with a cursor", async () => {
    await seedMarket(db, "0xaaa", "0xtok2", 101);
    const { body } = await get("/markets?limit=1&cursor=0x");
    expect((body.items as unknown[]).length).toBe(1);
    const next = await get(`/markets?limit=5&cursor=${body.nextCursor}`);
    expect((next.body.items as { market_address: string }[])[0]!.market_address).not.toBe(
      (body.items as { market_address: string }[])[0]!.market_address,
    );
  });

  /**
   * A portfolio spans markets, so it is assembled in SQL.
   *
   * The alternative — a balances list plus one lookup per token to find out what it is — turns
   * twenty positions into twenty-one round trips, and the page renders a column of unresolved
   * addresses while they land.
   */
  it("serves an account's holdings joined to their markets", async () => {
    await seedMarket(db, "0xm2", "0xt2", 102);
    await db.query(
      "INSERT INTO token_balances (token_address, holder, balance) VALUES ($1, $2, $3)",
      [TOKEN, "0xowner", "5000"],
    );
    await db.query(
      "INSERT INTO token_balances (token_address, holder, balance) VALUES ($1, $2, $3)",
      ["0xt2", "0xowner", "9000"],
    );

    const { body } = await get("/accounts/0xowner/balances");
    const items = body.items as { symbol: string; balance: string; market_address: string }[];
    expect(items).toHaveLength(2);
    // Largest first, so the position that matters is not below the fold.
    expect(items[0]!.balance).toBe("9000");
    expect(items[0]!.market_address).toBe("0xm2");
    expect(items[0]!.symbol).toBeDefined();
  });

  it("omits emptied positions from a portfolio", async () => {
    await db.query(
      "INSERT INTO token_balances (token_address, holder, balance) VALUES ($1, $2, 0)",
      [TOKEN, "0xsold"],
    );
    const { body } = await get("/accounts/0xsold/balances");
    expect(body.items).toEqual([]);
  });

  it("serves an account's trades across every market", async () => {
    await seedMarket(db, "0xm3", "0xt3", 103);
    for (const market of [MARKET, "0xm3"]) {
      await db.query(
        `INSERT INTO swaps (market_address, trader, is_buy, quote_amount, base_amount, fee, tax,
                            quote_raised, price, block_number, block_hash, log_index, tx_hash, ts)
         VALUES ($1, '0xowner', TRUE, 1, 1, 0, 0, 1, 1, 1, '0xbb', 0, $2, NOW())`,
        [market, `0xtx-${market}`],
      );
    }
    const { body } = await get("/accounts/0xowner/swaps");
    const items = body.items as { market_address: string; symbol: string }[];
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.symbol !== undefined)).toBe(true);
  });

  /// Staleness is this service's real failure mode, and it is invisible unless reported.
  it("reports how far behind the chain it is", async () => {
    await db.query(
      "UPDATE indexer_status SET last_block = 900, chain_head = 1000 WHERE id = 1",
    );
    const { body } = await get("/status");
    expect(Number(body.lag_blocks)).toBe(100);
    expect(Number(body.lag_seconds)).toBeGreaterThanOrEqual(0);
  });

  it("never reports negative lag when the head has not moved", async () => {
    await db.query(
      "UPDATE indexer_status SET last_block = 1000, chain_head = 995 WHERE id = 1",
    );
    const { body } = await get("/status");
    expect(Number(body.lag_blocks)).toBe(0);
  });
});
