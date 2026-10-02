import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app/index.js";
import type { Db } from "../src/db/legacy.js";
import { ingestOnce } from "../src/indexer/ingestion/ingest.js";
import { startScenario, type Scenario } from "./anvil.js";
import { memoryDatabase, transactional } from "./helpers.js";

/**
 * The response shape the frontend compiles against.
 *
 * The frontend declares row types by hand; nothing makes them agree with what this service
 * actually sends. A renamed column would type-check on both sides and arrive as `undefined` —
 * which renders as a blank cell, not an error. These pin the keys against a real ingested market.
 */
/**
 * The generation-1 factory, which this chain does not have.
 *
 * `IngestConfig.factory` is required, and its only job is to attribute a `MarketLaunched` to a
 * generation. On a generation-2-only chain it therefore names an address no contract is at.
 * Pointing it at `s.factory` alongside `factory2` would also work — `factoryAbis` writes the
 * generation-2 entry second and it would win — but it would work by insertion order, and the day
 * that order changed every launch here would silently decode as generation 1.
 */
const NO_GEN1_FACTORY = "0x0000000000000000000000000000000000000f01" as const;

describe("API response shape", () => {
  let s: Scenario;
  let api: ReturnType<typeof createApi>;
  let db: Db;

  beforeAll(async () => {
    s = await startScenario(8557);
    const database = await memoryDatabase();
    db = database.legacy;
    const tx = transactional(database);
    await ingestOnce(s.client, db, {
      ...tx,
      // Generation 2 is what this chain runs. The addresses come from the scenario, and the
      // generation of a log is decided by the address that emitted it, never by its name.
      factory: NO_GEN1_FACTORY,
      factory2: s.factory,
      // `graduation` is both the default accepted `Graduated` emitter and the address the holder
      // count excludes, so it names the real graduator. `graduation2` and `quoteRegistry` are not
      // read yet; they are set so this cfg describes the chain rather than the current handlers.
      graduation: s.graduation,
      graduation2: s.graduation,
      // Without this the PoolKey rebuilt for every graduation cannot be checked against the
      // emitted id, and `handleGraduated2` throws rather than guess.
      hook2: s.hook,
      creatorSink: s.creatorSink,
      quoteRegistry: s.quoteRegistry,
      poolManager: s.poolManager,
      startBlock: 0n,
    });
    api = createApi(database);
  }, 300_000);

  afterAll(() => s?.stop());

  const get = async (path: string) =>
    (await (await api.request(`http://x${path}`)).json()) as Record<string, unknown>;

  const hasKeys = (obj: Record<string, unknown>, keys: string[]) => {
    for (const key of keys) expect(Object.keys(obj), `missing ${key}`).toContain(key);
  };

  it("serves markets with the columns the market card reads", async () => {
    const body = await get("/markets");
    const row = (body.items as Record<string, unknown>[])[0]!;
    // Specifically checked: a zero target makes every progress bar read 0%, which looks like a
    // quiet market rather than a missing field.
    expect(BigInt(row.quote_target as string)).toBeGreaterThan(0n);
    hasKeys(row, [
      "market_address", "token_address", "symbol", "name", "symbol_key", "creator",
      "quote_target", "total_supply", "block_number", "tx_hash", "created_at", "quote_raised",
      "last_price", "volume_quote", "volume_24h", "market_cap", "ath_market_cap", "trade_count",
      "holders", "ready_to_graduate", "pool_address",
    ]);
  });

  /**
   * Market cap and its all-time high.
   *
   * Both are derived, not stored: cap is the last price times the supply the mint reported, and
   * the high is the best price the market ever traded at. Storing either would mean a second
   * figure that can disagree with the trades it came from.
   */
  /**
   * Every amount on the wire has to survive `BigInt`, which rejects any string with a decimal
   * point. Dividing by 1e18 in SQL leaves a fractional scale unless the whole expression is cast,
   * and a market with no trades rendered as "0.0000…0" — enough to throw while parsing the list
   * and blank a grid of eleven other markets.
   */
  it("serves every amount as a whole number, even for a market that has never traded", async () => {
    await db.query(
      `INSERT INTO markets (market_address, token_address, symbol, name, symbol_key, creator,
                            quote_target, total_supply, block_number, block_hash, log_index,
                            tx_hash, created_at)
       VALUES ('0xquiet','0xquiettoken','QUIET','QUIET','0xquietkey','0xcreator',
               10000000000000000000, 45000000000000000000000000, 1, '0xb', 0, '0xt', NOW())`,
    );
    await db.query("INSERT INTO market_state (market_address) VALUES ('0xquiet')");

    const body = await get("/markets");
    const rows = body.items as Record<string, string>[];
    const quiet = rows.find((r) => r.market_address === "0xquiet");
    expect(quiet).toBeDefined();

    for (const key of ["market_cap", "ath_market_cap", "volume_24h", "quote_raised", "last_price"]) {
      expect(String(quiet![key])).not.toContain(".");
      expect(() => BigInt(quiet![key]!)).not.toThrow();
    }
  });

  it("serves market cap and all-time high", async () => {
    const body = await get("/markets");
    const row = (body.items as Record<string, string>[])[0]!;
    const field = (key: string) => BigInt(row[key] ?? "");

    expect(field("total_supply")).toBeGreaterThan(0n);
    expect(field("market_cap")).toBeGreaterThan(0n);
    expect(field("ath_market_cap")).toBeGreaterThan(0n);

    // A market can only be at or below its own peak.
    expect(field("market_cap")).toBeLessThanOrEqual(field("ath_market_cap"));

    // And the cap is the price times the supply, not an independent number that drifts from it.
    //
    // The scale is 1e36 because this chain is GENERATION 2: its curve emits `quote * 1e36 / base`
    // (`BondingCurve._price`), an extra 1e18 over generation 1's `quote_wei * 1e18 / base_wei`,
    // chosen so a six-decimal quote does not truncate to a couple of raw units. Dividing by 1e18
    // here is what made every generation-2 cap a quintillion times too large: this market's cap
    // read as 1.8e21 MON rather than the ~1786 MON it is.
    //
    // Rounded, not truncated: `CAP_COLUMNS` casts the whole expression to `numeric(78,0)`, and
    // Postgres rounds half away from zero on that cast while integer division floors. Generation
    // 1's prices happened to leave a remainder below a half; generation 2's do not, so the two
    // spellings differ by one and the assertion has to say which it means.
    const scale = 10n ** 36n;
    const product = field("last_price") * field("total_supply");
    const expected = (product + scale / 2n) / scale;
    expect(field("market_cap")).toBe(expected);
  });

  it("serves market cap on the detail endpoint too", async () => {
    const body = await get(`/markets/${s.curve}`);
    expect(BigInt(body.market_cap as string)).toBeGreaterThan(0n);
    expect(BigInt(body.ath_market_cap as string)).toBeGreaterThan(0n);
  });

  it("serves swaps with the columns the trade table reads", async () => {
    const body = await get(`/markets/${s.curve}/swaps`);
    const row = (body.items as Record<string, unknown>[])[0]!;
    hasKeys(row, [
      "id", "market_address", "trader", "is_buy", "quote_amount", "base_amount", "fee", "tax",
      "quote_raised", "price", "block_number", "tx_hash", "ts",
    ]);
  });

  it("serves candlesticks with the columns the chart reads", async () => {
    const body = await get(`/markets/${s.curve}/candlesticks?period=3600`);
    const row = (body.items as Record<string, unknown>[])[0]!;
    hasKeys(row, [
      "market_address", "period_secs", "bucket_start", "open", "high", "low", "close",
      "volume_quote", "trade_count",
    ]);
  });

  it("serves status with the lag fields a health check reads", async () => {
    hasKeys(await get("/status"), [
      "last_block", "chain_head", "lag_blocks", "lag_seconds", "updated_at", "markets", "swaps",
    ]);
  });

  /**
   * Prices are integers, not decimals.
   *
   * They are 18-decimal fixed point, so the column carries scale 0. With scale 18 Postgres appends
   * eighteen more decimal places and the value arrives as "…754.000000000000000000" — which every
   * consumer parses with BigInt, and BigInt throws on a decimal point. The market list simply
   * failed to load.
   */
  it("sends prices as integers a BigInt can parse", async () => {
    const markets = await get("/markets");
    const market = (markets.items as Record<string, unknown>[])[0]!;
    expect(() => BigInt(market.last_price as string)).not.toThrow();

    const swaps = await get(`/markets/${s.curve}/swaps`);
    const swap = (swaps.items as Record<string, unknown>[])[0]!;
    expect(() => BigInt(swap.price as string)).not.toThrow();

    const candles = await get(`/markets/${s.curve}/candlesticks?period=3600`);
    const candle = (candles.items as Record<string, unknown>[])[0]!;
    for (const key of ["open", "high", "low", "close"]) {
      expect(() => BigInt(candle[key] as string), key).not.toThrow();
    }
  });

  /**
   * The wire types, pinned.
   *
   * Postgres drivers disagree about `BIGINT`: `pg` returns a string to avoid losing precision,
   * PGlite a number. Left implicit, the same query answers with a different JSON shape depending
   * on which database is underneath — and the client's arithmetic silently becomes string
   * concatenation, so a total renders as "036" instead of 36. The queries cast explicitly; this
   * says what they cast to.
   */
  it("sends counts as numbers and block numbers as strings", async () => {
    const markets = await get("/markets");
    const market = (markets.items as Record<string, unknown>[])[0]!;
    expect(typeof market.trade_count).toBe("number");
    expect(typeof market.holders).toBe("number");
    // A block number outlives what a JavaScript number holds exactly, so it stays a string and
    // the client parses it with BigInt.
    expect(typeof market.block_number).toBe("string");

    const detail = await get(`/markets/${s.curve}`);
    expect(typeof detail.trade_count).toBe("number");
    expect(typeof detail.block_number).toBe("string");

    const swaps = await get(`/markets/${s.curve}/swaps`);
    const swap = (swaps.items as Record<string, unknown>[])[0]!;
    expect(typeof swap.id).toBe("string");
    expect(typeof swap.block_number).toBe("string");
    expect(typeof swap.log_index).toBe("number");

    const candles = await get(`/markets/${s.curve}/candlesticks?period=3600`);
    const candle = (candles.items as Record<string, unknown>[])[0]!;
    expect(typeof candle.period_secs).toBe("number");
    expect(typeof candle.trade_count).toBe("number");

    const status = await get("/status");
    expect(typeof status.last_block).toBe("string");
    expect(typeof status.lag_blocks).toBe("number");
  });

  /// Amounts must stay strings all the way out. Serialised as numbers they would already have
  /// been rounded by the time the frontend saw them, and the rounding is invisible.
  it("sends 18-decimal amounts as strings, not numbers", async () => {
    const body = await get(`/markets/${s.curve}/swaps`);
    const row = (body.items as Record<string, unknown>[])[0]!;
    expect(typeof row.quote_amount).toBe("string");
    expect(typeof row.base_amount).toBe("string");
  });
});
