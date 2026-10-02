import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/legacy.js";
import {
  curve2Abi,
  factory2Abi,
  graduation2Abi,
  poolManagerAbi,
  quoteRegistryAbi,
} from "../src/indexer/abi.js";
import { applyLog } from "../src/indexer/ingestion/ingest.js";
import { poolIdOf, poolKeyFor } from "../src/indexer/processing/pool-key.js";
import type { LiveEvent } from "../src/websocket/live.js";
import { memoryDb } from "./helpers.js";
import {
  ALICE,
  cfg2,
  CREATOR,
  CURVE,
  FACTORY2,
  fakeLog,
  GRADUATION2,
  HOOK2,
  POOL_MANAGER,
  REGISTRY,
  TOKEN,
  TS,
  USDC,
} from "./gen2-logs.js";

async function launched(db: Db, sink = 2, creatorTaxBps = 250): Promise<void> {
  const { log, decoded } = fakeLog({
    abi: factory2Abi,
    eventName: "MarketLaunched",
    address: FACTORY2,
    args: {
      curve: CURVE,
      token: TOKEN,
      creator: CREATOR,
      quoteAsset: USDC,
      quoteTarget: 8_000_000_000n,
      sink,
      routedRecipient: sink === 2 ? CREATOR : "0x0000000000000000000000000000000000000000",
      creatorTaxBps,
      taxRecipient: ALICE,
    },
  });
  await applyLog(db, log, decoded, TS, cfg2, () => {});
}

const bought = (over: Record<string, unknown> = {}) =>
  fakeLog({
    abi: curve2Abi,
    eventName: "Bought",
    address: CURVE,
    args: {
      buyer: ALICE,
      quoteIn: 1_000_000n,
      baseOut: 15_300n * 10n ** 18n,
      fee: 10_000n,
      antiSniperTax: 0n,
      creatorTax: 25_000n,
      quoteRaised: 1_000_000n,
      price: 65_359_477_124n,
      ...over,
    },
  });
const sold = (over: Record<string, unknown> = {}) =>
  fakeLog({
    abi: curve2Abi,
    eventName: "Sold",
    address: CURVE,
    args: {
      seller: ALICE,
      baseIn: 1_000n * 10n ** 18n,
      quoteOut: 65_000n,
      fee: 650n,
      creatorTax: 1_625n,
      quoteRaised: 935_000n,
      price: 65_000_000_000n,
      ...over,
    },
  });

const feeRows = (db: Db) =>
  db.query<{ kind: string; amount: string; recipient: string | null; quote_asset: string }>(
    "SELECT kind, amount::text AS amount, recipient, quote_asset FROM fee_events WHERE market_address = $1 ORDER BY id",
    [CURVE],
  );

describe("gen-2 trades", () => {
  let db: Db;
  let events: LiveEvent[];
  beforeEach(async () => {
    db = await memoryDb();
    events = [];
    await launched(db);
  });

  it("records a buy as a swap with the event's price, anti-sniper tax and creator tax", async () => {
    const { log, decoded } = bought({ antiSniperTax: 400_000n });
    await applyLog(db, log, decoded, TS, cfg2, (e) => events.push(e));
    const { rows } = await db.query<Record<string, string | boolean>>(
      `SELECT is_buy, venue, quote_amount::text AS quote_amount, base_amount::text AS base_amount,
              fee::text AS fee, tax::text AS tax, creator_tax::text AS creator_tax,
              quote_raised::text AS quote_raised, price::text AS price
         FROM swaps WHERE market_address = $1`,
      [CURVE],
    );
    expect(rows[0]).toEqual({
      is_buy: true,
      venue: "curve",
      quote_amount: "1000000",
      base_amount: (15_300n * 10n ** 18n).toString(),
      fee: "10000",
      tax: "400000",
      creator_tax: "25000",
      quote_raised: "1000000",
      price: "65359477124",
    });
    const st = await db.query<{
      last_price: string;
      volume_quote: string;
      trade_count: number;
      quote_raised: string;
    }>(
      "SELECT last_price::text AS last_price, volume_quote::text AS volume_quote, trade_count::int AS trade_count, quote_raised::text AS quote_raised FROM market_state WHERE market_address = $1",
      [CURVE],
    );
    expect(st.rows[0]).toEqual({
      last_price: "65359477124",
      volume_quote: "1000000",
      trade_count: 1,
      quote_raised: "1000000",
    });
    expect(events).toContainEqual({ type: "swap", market: CURVE, isBuy: true });
  });

  it("splits the fee into protocol/routed and records the creator tax, in the quote asset", async () => {
    const { log, decoded } = bought();
    await applyLog(db, log, decoded, TS, cfg2, (e) => events.push(e));
    const { rows } = await feeRows(db);
    expect(rows).toEqual([
      { kind: "protocol", amount: "3000", recipient: null, quote_asset: USDC },
      { kind: "routed", amount: "7000", recipient: CREATOR, quote_asset: USDC },
      { kind: "tax", amount: "25000", recipient: ALICE, quote_asset: USDC },
    ]);
    const { rows: rw } = await db.query<Record<string, string>>(
      `SELECT protocol_generated::text AS p, routed_generated::text AS r, tax_generated::text AS t,
              routed_collected::text AS rc FROM market_rewards WHERE market_address = $1`,
      [CURVE],
    );
    expect(rw[0]).toEqual({ p: "3000", r: "7000", t: "25000", rc: "0" });
    // Two fee frames: one for the routed recipient, one for the tax recipient.
    expect(events).toContainEqual({ type: "fees", market: CURVE, recipient: CREATOR });
    expect(events).toContainEqual({ type: "fees", market: CURVE, recipient: ALICE });
  });

  it("records a sell the same way, with the creator tax and no anti-sniper", async () => {
    const { log, decoded } = sold();
    await applyLog(db, log, decoded, TS, cfg2, (e) => events.push(e));
    const { rows } = await db.query<Record<string, string | boolean>>(
      "SELECT is_buy, tax::text AS tax, creator_tax::text AS creator_tax, price::text AS price FROM swaps WHERE market_address = $1",
      [CURVE],
    );
    expect(rows[0]).toEqual({
      is_buy: false,
      tax: "0",
      creator_tax: "1625",
      price: "65000000000",
    });
    const fees = (await feeRows(db)).rows.map((r) => [r.kind, r.amount]);
    expect(fees).toEqual([
      ["protocol", "195"],
      ["routed", "455"],
      ["tax", "1625"],
    ]);
  });

  /// A HOLDERS or BUYBACK market has no routed recipient yet: the routed row carries null and is
  /// attributed to the sink once graduation registers one.
  it("leaves the routed recipient null on a HOLDERS market and writes no tax row at 0 bps", async () => {
    db = await memoryDb();
    await launched(db, 1, 0);
    const { log, decoded } = bought({ creatorTax: 0n });
    await applyLog(db, log, decoded, TS, cfg2, (e) => events.push(e));
    const { rows } = await feeRows(db);
    expect(rows.map((r) => [r.kind, r.recipient])).toEqual([
      ["protocol", null],
      ["routed", null],
    ]);
    expect(events.filter((e) => e.type === "fees")).toHaveLength(0);
  });

  it("is a no-op on replay: one swap, three fee rows, volume counted once", async () => {
    const { log, decoded } = bought();
    await applyLog(db, log, decoded, TS, cfg2, () => {});
    await applyLog(db, log, decoded, TS, cfg2, () => {});
    expect((await db.query("SELECT 1 FROM swaps")).rows).toHaveLength(1);
    expect((await feeRows(db)).rows).toHaveLength(3);
    const st = await db.query<{ v: string }>("SELECT volume_quote::text AS v FROM market_state");
    expect(st.rows[0]!.v).toBe("1000000");
  });

  it("folds gen-2 trades into candlesticks", async () => {
    const { log, decoded } = bought();
    await applyLog(db, log, decoded, TS, cfg2, () => {});
    const { rows } = await db.query<{ close: string }>(
      "SELECT close::text AS close FROM candlesticks WHERE market_address = $1 AND period_secs = 60",
      [CURVE],
    );
    expect(rows[0]!.close).toBe("65359477124");
  });
});

/**
 * THE REAL GUARD for the bug Task 25's fork test found on real mainnet gold. (See also
 * `test/price.test.ts`, which pins `poolSpotPrice` itself and says in its own comment why that one
 * is NOT this guard.)
 *
 * `poolSpotPrice`'s scale has to reach the division as an ARGUMENT: generation 2 stores
 * `quote * 1e36 / base`, and the caller in `ingest.ts` used to call the function at generation 1's
 * 1e18 scale and multiply generation 2's extra 1e18 onto whatever it returned. On a coarse,
 * six-decimal quote -- gold's shape, a whole token worth about 0.02 raw units of it -- the 1e18
 * intermediate is `0.02`, which floors to zero in bigint arithmetic before that multiplication
 * ever runs, and zero times anything is zero. Price, candles, all-time high and market cap all
 * fell to nothing the instant such a market graduated, and nothing threw.
 *
 * This is offline and synthetic -- no anvil, no fork -- because the only thing that ever caught
 * the real bug was `test/gen2-fork.test.ts` against actual mainnet gold, and that suite `skipIf`s
 * itself whenever `MONAD_RPC_URL` is unset, which is every CI run and most laptops. Revert the
 * fix in `src/indexer/processing/price.ts` (move `scale` back to a factor multiplied onto the
 * result, and call it with `PRICE_SCALE` here) and this test goes red; that is the whole point.
 */
describe("gen-2 pool swap keeps a coarse six-decimal price nonzero (offline regression guard)", () => {
  /** A synthetic six-decimal quote, gold's own decimals, distinct from every address already in
   * this suite. */
  const GOLD = "0x9090909090909090909090909090909090909090";

  it("stores the pool's post-graduation price above zero, at generation 2's scale", async () => {
    const db = await memoryDb();

    // Register GOLD as a six-decimal quote asset -- the way `QuoteAssetRegistered` did for the
    // real XAUt0 -- so the launch below stores `quote_decimals = 6` rather than the 18-decimal
    // default.
    const reg = fakeLog({
      abi: quoteRegistryAbi,
      eventName: "QuoteAssetRegistered",
      address: REGISTRY,
      args: { asset: GOLD, decimals: 6, quoteTarget: 8_000_000_000n },
    });
    await applyLog(db, reg.log, reg.decoded, TS, cfg2, () => {});

    const launch = fakeLog({
      abi: factory2Abi,
      eventName: "MarketLaunched",
      address: FACTORY2,
      args: {
        curve: CURVE,
        token: TOKEN,
        creator: CREATOR,
        quoteAsset: GOLD,
        quoteTarget: 8_000_000_000n,
        sink: 1,
        routedRecipient: "0x0000000000000000000000000000000000000000",
        creatorTaxBps: 0,
        taxRecipient: ALICE,
      },
    });
    await applyLog(db, launch.log, launch.decoded, TS, cfg2, () => {});

    // TOKEN ("0x2020…") sorts below GOLD ("0x9090…"), so the market's token lands on currency0 and
    // `poolSpotPrice` takes the direct-multiply branch -- the one the fix touches.
    const key = poolKeyFor(GOLD, TOKEN, HOOK2);
    expect(key.currency0).toBe(TOKEN);
    const poolId = poolIdOf(key);

    const grad = fakeLog({
      abi: graduation2Abi,
      eventName: "Graduated",
      address: GRADUATION2,
      args: {
        curve: CURVE,
        id: poolId,
        token: TOKEN,
        quoteAsset: GOLD,
        quoteAmount: 1n,
        baseAmount: 1n,
        tokenId: 1n,
      },
    });
    await applyLog(db, grad.log, grad.decoded, TS, cfg2, () => {});

    // sqrtPriceX96 for a raw token1/token0 (GOLD-per-TOKEN) ratio of 2e-20: one whole market token
    // (1e18 raw base units) worth 0.02 raw units of gold. Chosen so generation 1's
    // `(ratio * 1e18)` intermediate is exactly the `0.02` Task 25's fork test found -- floored to
    // zero before any multiplication -- while generation 2's `* 1e36` keeps sixteen significant
    // digits: `floor(sqrt(2e-20) * 2**96) ** 2 * 1e18 / 2**192 == 0`, the same expression at
    // `1e36` == `20000000000000000`.
    const sqrtPriceX96 = 11_204_554_194_957_228_032n;

    const swap = fakeLog({
      abi: poolManagerAbi,
      eventName: "Swap",
      address: POOL_MANAGER,
      args: {
        id: poolId,
        sender: ALICE,
        amount0: 5n * 10n ** 18n,
        amount1: -100_000n,
        sqrtPriceX96,
        liquidity: 1n,
        tick: 0,
        fee: 0,
      },
    });
    await applyLog(db, swap.log, swap.decoded, TS, cfg2, () => {});

    const { rows } = await db.query<{ price: string }>(
      "SELECT price::text AS price FROM swaps WHERE market_address = $1 AND venue = 'pool'",
      [CURVE],
    );
    expect(rows).toHaveLength(1);
    // Not merely "greater than zero" -- a scale off by any power of ten would still clear that
    // bar. This is generation 2's exact figure, `ratioX192 * (1e18 * 1e18) / 2**192` for the
    // `sqrtPriceX96` above.
    expect(rows[0]!.price).toBe("20000000000000000");

    const st = await db.query<{ last_price: string }>(
      "SELECT last_price::text AS last_price FROM market_state WHERE market_address = $1",
      [CURVE],
    );
    expect(st.rows[0]!.last_price).toBe("20000000000000000");
  });
});
