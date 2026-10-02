import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/legacy.js";
import { creatorSinkAbi, curve2Abi, factory2Abi } from "../src/indexer/abi.js";
import { applyLog } from "../src/indexer/ingestion/ingest.js";
import type { LiveEvent } from "../src/websocket/live.js";
import { memoryDb } from "./helpers.js";
import {
  ALICE,
  cfg2,
  CREATOR,
  CREATOR_SINK,
  CURVE,
  FACTORY2,
  fakeLog,
  TOKEN,
  TS,
  USDC,
} from "./gen2-logs.js";

const BOB = "0x6060606060606060606060606060606060606060";
const ID = "0x" + "11".repeat(32);

/**
 * The two events a real `CreatorSink.pull()` emits for one leg, in the order the contract emits
 * them: `Credited` per non-zero leg, then one `Pulled` summarising both.
 *
 * Built as a helper because every pull test needs the pair. A test that fired `Pulled` alone would
 * be describing a transaction the chain cannot produce, and would have hidden the double count
 * this file exists to pin down.
 */
async function pull(
  db: Db,
  legs: { routed?: [string, bigint]; tax?: [string, bigint] },
  announce: (event: LiveEvent) => void = () => {},
  tx = "0xpull",
): Promise<void> {
  let idx = 0;
  for (const [leg, kind] of [
    [legs.routed, 0],
    [legs.tax, 1],
  ] as const) {
    if (!leg || leg[1] === 0n) continue;
    const c = fakeLog({
      abi: creatorSinkAbi,
      eventName: "Credited",
      address: CREATOR_SINK,
      args: { who: leg[0], quote: USDC, amount: leg[1], kind },
      tx,
      logIndex: idx++,
    });
    await applyLog(db, c.log, c.decoded, TS, cfg2, announce);
  }
  const p = fakeLog({
    abi: creatorSinkAbi,
    eventName: "Pulled",
    address: CREATOR_SINK,
    args: {
      market: CURVE,
      routedAmount: legs.routed?.[1] ?? 0n,
      taxAmount: legs.tax?.[1] ?? 0n,
    },
    tx,
    logIndex: idx,
  });
  await applyLog(db, p.log, p.decoded, TS, cfg2, announce);
}

describe("CreatorSink", () => {
  let db: Db;
  let events: LiveEvent[];
  const balance = async (who: string) =>
    (
      await db.query<{ c: string; e: string }>(
        "SELECT claimable::text AS c, earned_lifetime::text AS e FROM creator_balances WHERE who = $1 AND quote_asset = $2",
        [who, USDC],
      )
    ).rows[0];

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
  });

  /// The correction this task was rewritten for. `collectFees` emits `FeesCollected(person, amount)`
  /// and THEN, when the push to that person reverts, calls `credit(who = person, …)` — one payment,
  /// two logs, one transaction. Task 6 booked the earning on the first. If `Credited` booked it
  /// again, every deferred creator's lifetime total would be exactly double.
  it("a deferred push is claimable once and earned once", async () => {
    const collected = fakeLog({
      abi: curve2Abi,
      eventName: "FeesCollected",
      address: CURVE,
      args: { recipient: CREATOR, amount: 500n },
      tx: "0xdeferred",
      logIndex: 0,
    });
    await applyLog(db, collected.log, collected.decoded, TS, cfg2, (e) => events.push(e));
    const credited = fakeLog({
      abi: creatorSinkAbi,
      eventName: "Credited",
      address: CREATOR_SINK,
      args: { who: CREATOR, quote: USDC, amount: 500n, kind: 0 },
      tx: "0xdeferred",
      logIndex: 1,
    });
    await applyLog(db, credited.log, credited.decoded, TS, cfg2, (e) => events.push(e));

    expect(await balance(CREATOR)).toEqual({ c: "500", e: "500" });
    expect(events).toEqual([
      { type: "fees", market: CURVE, recipient: CREATOR },
      { type: "fees", market: CURVE, recipient: CREATOR },
    ]);
  });

  /// `Credited` is the only event that mirrors the contract's `claimable[who][quote]` mapping, so
  /// it moves claimable and nothing else. The earning belongs to whichever event described the
  /// market generating it.
  it("Credited alone moves claimable and never earned", async () => {
    const { log, decoded } = fakeLog({
      abi: creatorSinkAbi,
      eventName: "Credited",
      address: CREATOR_SINK,
      args: { who: CREATOR, quote: USDC, amount: 500n, kind: 0 },
    });
    await applyLog(db, log, decoded, TS, cfg2, (e) => events.push(e));
    expect(await balance(CREATOR)).toEqual({ c: "500", e: "0" });
    expect(events).toEqual([{ type: "fees", market: CURVE, recipient: CREATOR }]);
  });

  it("Pulled credits the routed recipient and the tax recipient separately", async () => {
    await pull(db, { routed: [CREATOR, 700n], tax: [ALICE, 100n] }, (e) => events.push(e));
    expect(await balance(CREATOR)).toEqual({ c: "700", e: "700" });
    expect(await balance(ALICE)).toEqual({ c: "100", e: "100" });
    expect(events.filter((e) => e.type === "fees")).toHaveLength(4);
  });

  /// A pull emits `Credited` for each leg AND a `Pulled` summarising the same amounts. Counting
  /// both into `claimable` would make the projection disagree with the mapping it is supposed to
  /// mirror — the creator would be shown twice what `claim()` will actually pay.
  it("does not count a pull's claimable twice", async () => {
    await pull(db, { routed: [CREATOR, 700n] });
    const { rows } = await db.query<{ kind: string; c: string; e: string }>(
      "SELECT kind, claimable_delta::text AS c, earned_delta::text AS e FROM creator_ledger ORDER BY kind",
    );
    expect(rows).toEqual([
      { kind: "credited", c: "700", e: "0" },
      { kind: "pulled_routed", c: "0", e: "700" },
    ]);
  });

  it("Claimed lowers claimable and leaves earned alone", async () => {
    await pull(db, { routed: [CREATOR, 500n] });
    const { log, decoded } = fakeLog({
      abi: creatorSinkAbi,
      eventName: "Claimed",
      address: CREATOR_SINK,
      args: { who: CREATOR, quote: USDC, amount: 200n },
    });
    await applyLog(db, log, decoded, TS, cfg2, (e) => events.push(e));
    expect(await balance(CREATOR)).toEqual({ c: "300", e: "500" });
  });

  it("RecipientTransferred moves future routed income to the new recipient", async () => {
    const { log, decoded } = fakeLog({
      abi: creatorSinkAbi,
      eventName: "RecipientTransferred",
      address: CREATOR_SINK,
      args: { market: CURVE, from: CREATOR, to: BOB },
    });
    await applyLog(db, log, decoded, TS, cfg2, () => {});
    const { rows } = await db.query<{ r: string }>(
      "SELECT routed_recipient AS r FROM markets WHERE market_address = $1",
      [CURVE],
    );
    expect(rows[0]!.r).toBe(BOB);
    await pull(db, { routed: [BOB, 10n] });
    expect(await balance(BOB)).toEqual({ c: "10", e: "10" });
    expect(await balance(CREATOR)).toBeUndefined();
  });

  it("Registered confirms the recipients the graduator handed the sink", async () => {
    const { log, decoded } = fakeLog({
      abi: creatorSinkAbi,
      eventName: "Registered",
      address: CREATOR_SINK,
      args: { market: CURVE, id: ID, quote: USDC, routed: BOB, tax: ALICE },
    });
    await applyLog(db, log, decoded, TS, cfg2, () => {});
    const { rows } = await db.query<{ r: string; t: string }>(
      "SELECT routed_recipient AS r, tax_recipient AS t FROM markets WHERE market_address = $1",
      [CURVE],
    );
    expect(rows[0]).toEqual({ r: BOB, t: ALICE });
  });

  /// R2: a HOLDERS or BUYBACK market is registered with the CreatorSink too — it has a creator
  /// tax — and its `routed` leg is the market's OWN SINK, a RewardVault or the BurnSink, not a
  /// person. Recording that as `routed_recipient` would put a contract on the /markets row and
  /// make the vault answer `GET /creators/:vault` as though it earned the fees.
  it("does not write a non-CREATOR market's sink address into routed_recipient", async () => {
    const HOLDERS_CURVE = "0x7070707070707070707070707070707070707070";
    const VAULT = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
    const l = fakeLog({
      abi: factory2Abi,
      eventName: "MarketLaunched",
      address: FACTORY2,
      args: {
        curve: HOLDERS_CURVE,
        token: "0x8080808080808080808080808080808080808080",
        creator: CREATOR,
        quoteAsset: USDC,
        quoteTarget: 1n,
        sink: 1,
        routedRecipient: "0x0000000000000000000000000000000000000000",
        creatorTaxBps: 100,
        taxRecipient: ALICE,
      },
    });
    await applyLog(db, l.log, l.decoded, TS, cfg2, () => {});
    const { log, decoded } = fakeLog({
      abi: creatorSinkAbi,
      eventName: "Registered",
      address: CREATOR_SINK,
      args: { market: HOLDERS_CURVE, id: ID, quote: USDC, routed: VAULT, tax: ALICE },
    });
    await applyLog(db, log, decoded, TS, cfg2, () => {});
    const { rows } = await db.query<{ r: string | null; t: string }>(
      "SELECT routed_recipient AS r, tax_recipient AS t FROM markets WHERE market_address = $1",
      [HOLDERS_CURVE],
    );
    // The tax recipient IS a person and is recorded unconditionally; the routed leg stays null.
    expect(rows[0]).toEqual({ r: null, t: ALICE });
    expect((await db.query("SELECT 1 FROM markets WHERE routed_recipient = $1", [VAULT])).rows)
      .toHaveLength(0);
  });

  it("ignores every event from an address that is not DOKU_CREATOR_SINK, and replays", async () => {
    const wrong = fakeLog({
      abi: creatorSinkAbi,
      eventName: "Credited",
      address: "0x9999999999999999999999999999999999999999",
      args: { who: CREATOR, quote: USDC, amount: 5n, kind: 0 },
    });
    await applyLog(db, wrong.log, wrong.decoded, TS, cfg2, () => {});
    expect(await balance(CREATOR)).toBeUndefined();
    const ok = fakeLog({
      abi: creatorSinkAbi,
      eventName: "Credited",
      address: CREATOR_SINK,
      args: { who: CREATOR, quote: USDC, amount: 5n, kind: 0 },
    });
    await applyLog(db, ok.log, ok.decoded, TS, cfg2, () => {});
    await applyLog(db, ok.log, ok.decoded, TS, cfg2, () => {});
    expect(await balance(CREATOR)).toEqual({ c: "5", e: "0" });
  });
});
