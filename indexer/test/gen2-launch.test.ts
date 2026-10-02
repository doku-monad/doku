import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/legacy.js";
import { factory2Abi } from "../src/indexer/abi.js";
import { applyLog } from "../src/indexer/ingestion/ingest.js";
import type { LiveEvent } from "../src/websocket/live.js";
import { memoryDb, ZERO } from "./helpers.js";
import { ALICE, cfg2, CREATOR, CURVE, FACTORY2, fakeLog, TOKEN, TS, USDC } from "./gen2-logs.js";

const launch = (over: Partial<Record<string, unknown>> = {}, address = FACTORY2) =>
  fakeLog({
    abi: factory2Abi,
    eventName: "MarketLaunched",
    address,
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
      ...over,
    },
  });

const metadata = (over: Partial<Record<string, unknown>> = {}) =>
  fakeLog({
    abi: factory2Abi,
    eventName: "MetadataSet",
    address: FACTORY2,
    args: {
      curve: CURVE,
      name: "Crescent Moon",
      ticker: "MOON",
      logoURI: "ipfs://bafylogo",
      bannerURI: "ipfs://bafybanner",
      description: "to the moon",
      website: "https://moon.xyz",
      x: "https://x.com/moon",
      telegram: "",
      ...over,
    },
  });

describe("gen-2 MarketLaunched", () => {
  let db: Db;
  let events: LiveEvent[];
  const announce = (e: LiveEvent) => events.push(e);

  beforeEach(async () => {
    db = await memoryDb();
    events = [];
    // The registry row the market will be joined to for its decimals.
    await db.query(
      `INSERT INTO quote_assets (id, address, symbol, decimals, registered, enabled)
       VALUES ('usdc', $1, 'USDC', 6, TRUE, TRUE)`,
      [USDC],
    );
  });

  it("records quote, routing, recipients and tax from the event", async () => {
    const { log, decoded } = launch();
    await applyLog(db, log, decoded, TS, cfg2, announce);
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT generation, quote_asset, quote_decimals, quote_target::text AS quote_target, routing,
              routed_recipient, creator_tax_bps, tax_recipient, symbol, name, symbol_key, creator
         FROM markets WHERE market_address = $1`,
      [CURVE],
    );
    expect(rows[0]).toMatchObject({
      generation: 2,
      quote_asset: USDC,
      quote_decimals: 6,
      quote_target: "8000000000",
      routing: 2,
      routed_recipient: CREATOR,
      creator_tax_bps: 250,
      tax_recipient: ALICE,
      creator: CREATOR,
    });
    // symbol/name/symbol_key are NOT NULL and gen 2 has no symbol yet: placeholders until MetadataSet.
    expect(rows[0]!.symbol).toBe("");
    expect(rows[0]!.symbol_key).toBe(CURVE);
    const st = await db.query("SELECT 1 FROM market_state WHERE market_address = $1", [CURVE]);
    expect(st.rows).toHaveLength(1);
    const rw = await db.query("SELECT 1 FROM market_rewards WHERE market_address = $1", [CURVE]);
    expect(rw.rows).toHaveLength(1);
    expect(events).toEqual([{ type: "market", market: CURVE }]);
  });

  it("stores native MON as address(0) at 18 decimals without a registry row", async () => {
    const { log, decoded } = launch({
      quoteAsset: ZERO,
      sink: 1,
      routedRecipient: ZERO,
      creatorTaxBps: 0,
      taxRecipient: CREATOR,
    });
    await applyLog(db, log, decoded, TS, cfg2, announce);
    const { rows } = await db.query<{
      quote_asset: string;
      quote_decimals: number;
      routed_recipient: string | null;
    }>("SELECT quote_asset, quote_decimals, routed_recipient FROM markets WHERE market_address = $1", [
      CURVE,
    ]);
    expect(rows[0]).toEqual({ quote_asset: ZERO, quote_decimals: 18, routed_recipient: null });
  });

  it("ignores a gen-2-shaped log from an address that is not the gen-2 factory", async () => {
    const { log, decoded } = launch({}, "0x9999999999999999999999999999999999999999");
    await applyLog(db, log, decoded, TS, cfg2, announce);
    expect((await db.query("SELECT 1 FROM markets")).rows).toHaveLength(0);
  });

  it("is idempotent on replay", async () => {
    const { log, decoded } = launch();
    await applyLog(db, log, decoded, TS, cfg2, announce);
    await applyLog(db, log, decoded, TS, cfg2, announce);
    expect((await db.query("SELECT 1 FROM markets")).rows).toHaveLength(1);
  });
});

describe("gen-2 MetadataSet", () => {
  let db: Db;
  const events: LiveEvent[] = [];
  beforeEach(async () => {
    db = await memoryDb();
    events.length = 0;
    const { log, decoded } = launch();
    await applyLog(db, log, decoded, TS, cfg2, () => {});
  });

  it("writes the metadata columns, the history row, and the symbol", async () => {
    const { log, decoded } = metadata();
    await applyLog(db, log, decoded, TS, cfg2, (e) => events.push(e));
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT symbol, name, ticker, logo_uri, banner_uri, description, website, x, telegram, metadata_hash
         FROM markets WHERE market_address = $1`,
      [CURVE],
    );
    expect(rows[0]).toMatchObject({
      symbol: "MOON",
      name: "Crescent Moon",
      ticker: "MOON",
      logo_uri: "ipfs://bafylogo",
      banner_uri: "ipfs://bafybanner",
      description: "to the moon",
      website: "https://moon.xyz",
      x: "https://x.com/moon",
      telegram: null,
    });
    expect(String(rows[0]!.metadata_hash)).toMatch(/^0x[0-9a-f]{64}$/);
    const hist = await db.query("SELECT name FROM metadata_updates WHERE market_address = $1", [
      CURVE,
    ]);
    expect(hist.rows).toHaveLength(1);
    expect(events).toEqual([{ type: "metadata", market: CURVE }]);
  });

  it("marks the uploads a MetadataSet references", async () => {
    await db.query(
      `INSERT INTO uploads (cid, sha256, bytes, mime) VALUES ('bafylogo', 'aa', 10, 'image/webp'),
                                                          ('bafybanner', 'bb', 10, 'image/webp'),
                                                          ('bafyorphan', 'cc', 10, 'image/webp')`,
    );
    const { log, decoded } = metadata();
    await applyLog(db, log, decoded, TS, cfg2, () => {});
    const { rows } = await db.query<{ cid: string; referenced_by: string | null }>(
      "SELECT cid, referenced_by FROM uploads ORDER BY cid",
    );
    expect(rows).toEqual([
      { cid: "bafybanner", referenced_by: CURVE },
      { cid: "bafylogo", referenced_by: CURVE },
      { cid: "bafyorphan", referenced_by: null },
    ]);
  });

  /// The factory rejects a changed name/ticker on chain; the indexer still writes what it sees,
  /// because an event that reached the chain is the truth whatever this code expected.
  it("applies a later MetadataSet over an earlier one and keeps both in history", async () => {
    const first = metadata();
    const second = metadata({ description: "still going", logoURI: "ipfs://bafylogo2" });
    await applyLog(db, first.log, first.decoded, TS, cfg2, () => {});
    await applyLog(db, second.log, second.decoded, new Date(TS.getTime() + 1000), cfg2, () => {});
    const { rows } = await db.query<{ description: string; logo_uri: string }>(
      "SELECT description, logo_uri FROM markets WHERE market_address = $1",
      [CURVE],
    );
    expect(rows[0]).toEqual({ description: "still going", logo_uri: "ipfs://bafylogo2" });
    expect((await db.query("SELECT 1 FROM metadata_updates")).rows).toHaveLength(2);
  });

  it("ignores a MetadataSet for a market it has never heard of", async () => {
    const { log, decoded } = metadata({ curve: "0x5555555555555555555555555555555555555555" });
    await applyLog(db, log, decoded, TS, cfg2, () => {});
    expect((await db.query("SELECT 1 FROM metadata_updates")).rows).toHaveLength(0);
  });
});
