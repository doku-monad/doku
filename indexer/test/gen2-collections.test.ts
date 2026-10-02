import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/legacy.js";
import { curve2Abi, factory2Abi } from "../src/indexer/abi.js";
import { applyLog } from "../src/indexer/ingestion/ingest.js";
import type { LiveEvent } from "../src/websocket/live.js";
import { memoryDb, seedMarket } from "./helpers.js";
import {
  ALICE,
  cfg2,
  CREATOR,
  CURVE,
  FACTORY2,
  fakeLog,
  TOKEN,
  TS,
  USDC,
} from "./gen2-logs.js";

const collect = (
  eventName: "FeesCollected" | "TaxCollected" | "ProtocolFeesCollected",
  recipient: string,
  amount: bigint,
  address = CURVE,
) => fakeLog({ abi: curve2Abi, eventName, address, args: { recipient, amount } });

describe("gen-2 collections", () => {
  let db: Db;
  let events: LiveEvent[];
  beforeEach(async () => {
    db = await memoryDb();
    events = [];
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
        sink: 2,
        routedRecipient: CREATOR,
        creatorTaxBps: 250,
        taxRecipient: ALICE,
      },
    });
    await applyLog(db, log, decoded, TS, cfg2, () => {});
    // Three generated components so pending has something to fall from.
    const trade = fakeLog({
      abi: curve2Abi,
      eventName: "Bought",
      address: CURVE,
      args: {
        buyer: ALICE,
        quoteIn: 1_000_000n,
        baseOut: 1n,
        fee: 10_000n,
        antiSniperTax: 0n,
        creatorTax: 25_000n,
        quoteRaised: 1_000_000n,
        price: 1n,
      },
    });
    await applyLog(db, trade.log, trade.decoded, TS, cfg2, () => {});
  });

  const rewards = async () =>
    (
      await db.query<Record<string, string>>(
        `SELECT routed_generated::text AS rg, routed_collected::text AS rc, tax_generated::text AS tg,
            tax_collected::text AS tc, protocol_collected::text AS pc FROM market_rewards WHERE market_address = $1`,
        [CURVE],
      )
    ).rows[0]!;

  it("FeesCollected lowers pending and credits the recipient as earned, not claimable", async () => {
    const { log, decoded } = collect("FeesCollected", CREATOR, 7_000n);
    await applyLog(db, log, decoded, TS, cfg2, (e) => events.push(e));
    expect(await rewards()).toMatchObject({ rg: "7000", rc: "7000" });
    const { rows } = await db.query<{ claimable: string; earned_lifetime: string }>(
      "SELECT claimable::text AS claimable, earned_lifetime::text AS earned_lifetime FROM creator_balances WHERE who = $1 AND quote_asset = $2",
      [CREATOR, USDC],
    );
    expect(rows[0]).toEqual({ claimable: "0", earned_lifetime: "7000" });
    expect(events).toEqual([{ type: "fees", market: CURVE, recipient: CREATOR }]);
  });

  it("TaxCollected does the same for the tax recipient", async () => {
    const { log, decoded } = collect("TaxCollected", ALICE, 25_000n);
    await applyLog(db, log, decoded, TS, cfg2, (e) => events.push(e));
    expect(await rewards()).toMatchObject({ tg: "25000", tc: "25000" });
    const { rows } = await db.query<{ earned_lifetime: string }>(
      "SELECT earned_lifetime::text AS earned_lifetime FROM creator_balances WHERE who = $1",
      [ALICE],
    );
    expect(rows[0]!.earned_lifetime).toBe("25000");
  });

  it("ProtocolFeesCollected only moves the protocol counter", async () => {
    const { log, decoded } = collect(
      "ProtocolFeesCollected",
      "0x7777777777777777777777777777777777777777",
      3_000n,
    );
    await applyLog(db, log, decoded, TS, cfg2, (e) => events.push(e));
    expect(await rewards()).toMatchObject({ pc: "3000" });
    expect((await db.query("SELECT 1 FROM creator_balances")).rows).toHaveLength(0);
    expect(events).toEqual([]);
  });

  it("ignores FeesCollected from a gen-1 curve", async () => {
    await seedMarket(db, "0xgen1", "0xgen1token");
    const { log, decoded } = collect("FeesCollected", CREATOR, 1n, "0xgen1");
    await applyLog(db, log, decoded, TS, cfg2, () => {});
    expect(
      (await db.query("SELECT 1 FROM fee_events WHERE market_address = '0xgen1'")).rows,
    ).toHaveLength(0);
  });

  it("is idempotent", async () => {
    const { log, decoded } = collect("FeesCollected", CREATOR, 7_000n);
    await applyLog(db, log, decoded, TS, cfg2, () => {});
    await applyLog(db, log, decoded, TS, cfg2, () => {});
    expect(await rewards()).toMatchObject({ rc: "7000" });
  });
});
