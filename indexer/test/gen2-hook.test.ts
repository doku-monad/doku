import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/legacy.js";
import { factory2Abi, graduation2Abi, hook2Abi } from "../src/indexer/abi.js";
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
  TOKEN,
  TS,
  USDC,
} from "./gen2-logs.js";

describe("hook levies", () => {
  let db: Db;
  let events: LiveEvent[];
  const id = poolIdOf(poolKeyFor(USDC, TOKEN, HOOK2));

  beforeEach(async () => {
    db = await memoryDb();
    events = [];
    const l = fakeLog({
      abi: factory2Abi,
      eventName: "MarketLaunched",
      address: FACTORY2,
      args: {
        curve: CURVE,
        token: TOKEN,
        creator: CREATOR,
        quoteAsset: USDC,
        quoteTarget: 1n,
        sink: 2,
        routedRecipient: CREATOR,
        creatorTaxBps: 100,
        taxRecipient: ALICE,
      },
    });
    await applyLog(db, l.log, l.decoded, TS, cfg2, () => {});
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

  it("TaxLevied is a pool-venue tax row for the market's tax recipient", async () => {
    const { log, decoded } = fakeLog({
      abi: hook2Abi,
      eventName: "TaxLevied",
      address: HOOK2,
      args: { id, amount: 1_234n },
    });
    await applyLog(db, log, decoded, TS, cfg2, (e) => events.push(e));
    const { rows } = await db.query<Record<string, string>>(
      "SELECT kind, venue, recipient, amount::text AS amount, quote_asset FROM fee_events WHERE market_address = $1",
      [CURVE],
    );
    expect(rows).toEqual([
      { kind: "tax", venue: "pool", recipient: ALICE, amount: "1234", quote_asset: USDC },
    ]);
    expect(events).toEqual([{ type: "fees", market: CURVE, recipient: ALICE }]);
  });

  it("Swept is a protocol row and a routed row", async () => {
    const { log, decoded } = fakeLog({
      abi: hook2Abi,
      eventName: "Swept",
      address: HOOK2,
      args: { id, protocolAmount: 300n, sinkAmount: 700n },
    });
    await applyLog(db, log, decoded, TS, cfg2, (e) => events.push(e));
    const { rows } = await db.query<Record<string, string>>(
      "SELECT kind, recipient, amount::text AS amount FROM fee_events WHERE market_address = $1 ORDER BY kind",
      [CURVE],
    );
    expect(rows).toEqual([
      { kind: "protocol", recipient: null, amount: "300" },
      { kind: "routed", recipient: CREATOR, amount: "700" },
    ]);
    const rw = await db.query<{ r: string }>(
      "SELECT routed_generated::text AS r FROM market_rewards WHERE market_address = $1",
      [CURVE],
    );
    expect(rw.rows[0]!.r).toBe("700");
  });

  it("ignores levies from any other hook, and for unknown pools", async () => {
    const other = fakeLog({
      abi: hook2Abi,
      eventName: "TaxLevied",
      address: "0x9999999999999999999999999999999999999999",
      args: { id, amount: 1n },
    });
    await applyLog(db, other.log, other.decoded, TS, cfg2, () => {});
    const unknown = fakeLog({
      abi: hook2Abi,
      eventName: "TaxLevied",
      address: HOOK2,
      args: { id: "0x" + "cd".repeat(32), amount: 1n },
    });
    await applyLog(db, unknown.log, unknown.decoded, TS, cfg2, () => {});
    expect((await db.query("SELECT 1 FROM fee_events")).rows).toHaveLength(0);
  });

  it("is idempotent", async () => {
    const { log, decoded } = fakeLog({
      abi: hook2Abi,
      eventName: "Swept",
      address: HOOK2,
      args: { id, protocolAmount: 1n, sinkAmount: 1n },
    });
    await applyLog(db, log, decoded, TS, cfg2, () => {});
    await applyLog(db, log, decoded, TS, cfg2, () => {});
    expect((await db.query("SELECT 1 FROM fee_events")).rows).toHaveLength(2);
  });
  void ZERO;
});
