import { beforeEach, describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256 } from "viem";
import type { Db } from "../src/db/legacy.js";
import { factory2Abi, graduation2Abi, hook2Abi, poolManagerAbi } from "../src/indexer/abi.js";
import { applyLog } from "../src/indexer/ingestion/ingest.js";
import { poolIdOf, poolKeyFor } from "../src/indexer/processing/pool-key.js";
import type { LiveEvent } from "../src/websocket/live.js";
import { memoryDb, ZERO } from "./helpers.js";
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
  TOKEN,
  TS,
  USDC,
} from "./gen2-logs.js";

const SINK = "0x5150515051505150515051505150515051505150";

async function launch(db: Db, quote: string, sink = 1): Promise<void> {
  const { log, decoded } = fakeLog({
    abi: factory2Abi,
    eventName: "MarketLaunched",
    address: FACTORY2,
    args: {
      curve: CURVE,
      token: TOKEN,
      creator: CREATOR,
      quoteAsset: quote,
      quoteTarget: 1n,
      sink,
      routedRecipient: ZERO,
      creatorTaxBps: 100,
      taxRecipient: ALICE,
    },
  });
  await applyLog(db, log, decoded, TS, cfg2, () => {});
}

describe("pool-key", () => {
  it("sorts the currencies and hashes the key like v4 does", () => {
    const key = poolKeyFor(USDC, TOKEN, HOOK2);
    // TOKEN (0x2020…) < USDC (0x7547…) so the market's token is currency0 on this pool.
    expect(key.currency0).toBe(TOKEN);
    expect(key.currency1).toBe(USDC);
    expect(key.fee).toBe(0);
    expect(key.tickSpacing).toBe(60);
    const expected = keccak256(
      encodeAbiParameters(
        [
          { type: "address" },
          { type: "address" },
          { type: "uint24" },
          { type: "int24" },
          { type: "address" },
        ],
        [TOKEN, USDC, 0, 60, HOOK2],
      ),
    );
    expect(poolIdOf(key)).toBe(expected);
  });

  it("puts native MON first", () => {
    const key = poolKeyFor(ZERO, TOKEN, HOOK2);
    expect(key.currency0).toBe(ZERO);
    expect(key.currency1).toBe(TOKEN);
  });
});

describe("gen-2 Graduated", () => {
  let db: Db;
  let events: LiveEvent[];
  beforeEach(async () => {
    db = await memoryDb();
    events = [];
  });

  it("records the graduation with the reconstructed key when it hashes to the emitted id", async () => {
    await launch(db, USDC);
    const id = poolIdOf(poolKeyFor(USDC, TOKEN, HOOK2));
    const { log, decoded } = fakeLog({
      abi: graduation2Abi,
      eventName: "Graduated",
      address: GRADUATION2,
      args: {
        curve: CURVE,
        id,
        token: TOKEN,
        quoteAsset: USDC,
        quoteAmount: 8_000_000_000n,
        baseAmount: 222_222_222n * 10n ** 18n,
        tokenId: 77n,
      },
    });
    await applyLog(db, log, decoded, TS, cfg2, (e) => events.push(e));
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT pool_address, pool_id, currency0, currency1, fee, tick_spacing, hooks, quote_asset,
              token_id::text AS token_id, quote_amount::text AS quote_amount, liquidity::text AS liquidity
         FROM graduations WHERE market_address = $1`,
      [CURVE],
    );
    expect(rows[0]).toEqual({
      pool_address: POOL_MANAGER,
      pool_id: id,
      currency0: TOKEN,
      currency1: USDC,
      fee: 0,
      tick_spacing: 60,
      hooks: HOOK2,
      quote_asset: USDC,
      token_id: "77",
      quote_amount: "8000000000",
      liquidity: "0",
    });
    const st = await db.query<{ pool_address: string; pool_id: string }>(
      "SELECT pool_address, pool_id FROM market_state WHERE market_address = $1",
      [CURVE],
    );
    expect(st.rows[0]).toEqual({ pool_address: POOL_MANAGER, pool_id: id });
    expect(events).toEqual([{ type: "graduation", market: CURVE }]);
  });

  /**
   * A key that does not hash to its own id is wrong for EVERY market, not one, so the pass fails
   * loudly and rolls back rather than leaving a row that looks indexed and is not. This repo
   * shipped the other behaviour once — `pool-swaps.test.ts` still carries the comment about key
   * columns that "silently held empty strings for a while".
   */
  it("refuses to record a graduation whose id it cannot reproduce", async () => {
    await launch(db, USDC);
    const wrongId = "0x" + "ab".repeat(32);
    const { log, decoded } = fakeLog({
      abi: graduation2Abi,
      eventName: "Graduated",
      address: GRADUATION2,
      args: {
        curve: CURVE,
        id: wrongId,
        token: TOKEN,
        quoteAsset: USDC,
        quoteAmount: 1n,
        baseAmount: 1n,
        tokenId: 1n,
      },
    });
    await expect(applyLog(db, log, decoded, TS, cfg2, () => {})).rejects.toThrow(
      /does not reproduce/i,
    );
    expect((await db.query("SELECT 1 FROM graduations")).rows).toHaveLength(0);
    const st = await db.query<{ pool_id: string | null }>(
      "SELECT pool_id FROM market_state WHERE market_address = $1",
      [CURVE],
    );
    expect(st.rows[0]!.pool_id).toBeNull();
  });

  it("ignores a Graduated from an address that is not an accepted graduator", async () => {
    await launch(db, USDC);
    const { log, decoded } = fakeLog({
      abi: graduation2Abi,
      eventName: "Graduated",
      address: "0x9999999999999999999999999999999999999999",
      args: {
        curve: CURVE,
        id: "0x" + "00".repeat(32),
        token: TOKEN,
        quoteAsset: USDC,
        quoteAmount: 1n,
        baseAmount: 1n,
        tokenId: 1n,
      },
    });
    await applyLog(db, log, decoded, TS, cfg2, () => {});
    expect((await db.query("SELECT 1 FROM graduations")).rows).toHaveLength(0);
  });

  /// A pool swap on a USDC market: the token is currency0, so amount0 is the token leg. The
  /// existing Swap handler must read that from the stored key rather than assume MON-first.
  it("prices a pool swap correctly when the market's token is currency0", async () => {
    await launch(db, USDC);
    const key = poolKeyFor(USDC, TOKEN, HOOK2);
    const id = poolIdOf(key);
    const g = fakeLog({
      abi: graduation2Abi,
      eventName: "Graduated",
      address: GRADUATION2,
      args: {
        curve: CURVE,
        id,
        token: TOKEN,
        quoteAsset: USDC,
        quoteAmount: 1n,
        baseAmount: 1n,
        tokenId: 1n,
      },
    });
    await applyLog(db, g.log, g.decoded, TS, cfg2, () => {});
    // Buyer receives 1e18 token (amount0 > 0), pays 65 USDC raw (amount1 < 0).
    const s = fakeLog({
      abi: poolManagerAbi,
      eventName: "Swap",
      address: POOL_MANAGER,
      args: {
        id,
        sender: ALICE,
        amount0: 10n ** 18n,
        amount1: -65n,
        sqrtPriceX96: 2n ** 96n,
        liquidity: 1n,
        tick: 0,
        fee: 0,
      },
    });
    await applyLog(
      db,
      s.log,
      s.decoded,
      TS,
      cfg2,
      () => {},
      new Map([[s.log.transactionHash, ALICE]]),
    );
    const { rows } = await db.query<{ is_buy: boolean; quote_amount: string; base_amount: string }>(
      "SELECT is_buy, quote_amount::text AS quote_amount, base_amount::text AS base_amount FROM swaps WHERE venue = 'pool'",
    );
    expect(rows[0]).toEqual({
      is_buy: true,
      quote_amount: "65",
      base_amount: (10n ** 18n).toString(),
    });
  });
});

describe("PoolRegistered", () => {
  let db: Db;
  beforeEach(async () => {
    db = await memoryDb();
    await launch(db, USDC);
    const id = poolIdOf(poolKeyFor(USDC, TOKEN, HOOK2));
    const g = fakeLog({
      abi: graduation2Abi,
      eventName: "Graduated",
      address: GRADUATION2,
      args: {
        curve: CURVE,
        id,
        token: TOKEN,
        quoteAsset: USDC,
        quoteAmount: 1n,
        baseAmount: 1n,
        tokenId: 1n,
      },
    });
    await applyLog(db, g.log, g.decoded, TS, cfg2, () => {});
  });

  it("attaches the sink, sink kind and hook to the graduation row", async () => {
    const id = poolIdOf(poolKeyFor(USDC, TOKEN, HOOK2));
    const { log, decoded } = fakeLog({
      abi: hook2Abi,
      eventName: "PoolRegistered",
      address: HOOK2,
      args: {
        id,
        token: TOKEN,
        sink: 1,
        sinkAddr: SINK,
        protocolBps: 30,
        lpBps: 70,
        creatorTaxBps: 100,
      },
    });
    await applyLog(db, log, decoded, TS, cfg2, () => {});
    const { rows } = await db.query<{ sink: string; sink_kind: number; hooks: string }>(
      "SELECT sink, sink_kind, hooks FROM graduations WHERE market_address = $1",
      [CURVE],
    );
    expect(rows[0]).toEqual({ sink: SINK, sink_kind: 1, hooks: HOOK2 });
  });

  it("ignores a registration from a hook that is not DOKU_HOOK2", async () => {
    const id = poolIdOf(poolKeyFor(USDC, TOKEN, HOOK2));
    const { log, decoded } = fakeLog({
      abi: hook2Abi,
      eventName: "PoolRegistered",
      address: "0x9999999999999999999999999999999999999999",
      args: {
        id,
        token: TOKEN,
        sink: 1,
        sinkAddr: SINK,
        protocolBps: 30,
        lpBps: 70,
        creatorTaxBps: 100,
      },
    });
    await applyLog(db, log, decoded, TS, cfg2, () => {});
    const { rows } = await db.query<{ sink: string }>(
      "SELECT sink FROM graduations WHERE market_address = $1",
      [CURVE],
    );
    expect(rows[0]!.sink).toBe("");
  });
});
