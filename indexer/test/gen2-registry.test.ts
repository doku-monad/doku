import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/legacy.js";
import { quoteRegistryAbi } from "../src/indexer/abi.js";
import { applyLog } from "../src/indexer/ingestion/ingest.js";
import { ensureQuoteCatalog, QUOTE_CATALOG } from "../src/quotes/catalog.js";
import { memoryDb, ZERO } from "./helpers.js";
import { cfg2, fakeLog, REGISTRY, TS, USDC } from "./gen2-logs.js";

const row = (db: Db, address: string) =>
  db.query<Record<string, unknown>>(
    `SELECT id, symbol, decimals, quote_target::text AS quote_target, registered, enabled, kind
     FROM quote_assets WHERE address = $1`,
    [address],
  );

describe("quote registry", () => {
  let db: Db;
  beforeEach(async () => {
    db = await memoryDb();
    await ensureQuoteCatalog(db);
  });

  it("seeds the catalogue with the UI rows, the seven live assets carrying addresses", async () => {
    const { rows } = await db.query<{ id: string; address: string | null; registered: boolean }>(
      "SELECT id, address, registered FROM quote_assets ORDER BY sort_order",
    );
    expect(rows.map((r) => r.id)).toEqual(QUOTE_CATALOG.map((c) => c.id));
    expect(rows.find((r) => r.id === "mon")!.address).toBe(ZERO);
    expect(rows.find((r) => r.id === "usdc")!.address).toBe(USDC);
    expect(rows.filter((r) => r.address !== null)).toHaveLength(7);
    expect(rows.every((r) => r.registered === false)).toBe(true);
  });

  it("QuoteAssetRegistered marks the catalogue row registered and enabled with its target", async () => {
    const { log, decoded } = fakeLog({
      abi: quoteRegistryAbi,
      eventName: "QuoteAssetRegistered",
      address: REGISTRY,
      args: { asset: USDC, decimals: 6, quoteTarget: 8_000_000_000n },
    });
    await applyLog(db, log, decoded, TS, cfg2, () => {});
    expect((await row(db, USDC)).rows[0]).toMatchObject({
      id: "usdc",
      symbol: "USDC",
      decimals: 6,
      quote_target: "8000000000",
      registered: true,
      enabled: true,
      kind: "stablecoin",
    });
  });

  it("registers native MON at address(0)", async () => {
    const { log, decoded } = fakeLog({
      abi: quoteRegistryAbi,
      eventName: "QuoteAssetRegistered",
      address: REGISTRY,
      args: { asset: ZERO, decimals: 18, quoteTarget: 10n ** 18n },
    });
    await applyLog(db, log, decoded, TS, cfg2, () => {});
    expect((await row(db, ZERO)).rows[0]).toMatchObject({ id: "mon", registered: true, decimals: 18 });
  });

  /// The chain wins on `decimals`, because that is what every amount is scaled by. The catalogue's
  /// gold row is presentational and the frontend's is wrong -- XAUt0 is six, not eighteen -- so a
  /// seeded value must never survive a registration that disagrees with it.
  it("takes decimals from the chain even when the catalogue disagrees", async () => {
    const gold = QUOTE_CATALOG.find((c) => c.id === "xaut0")!;
    await db.query("UPDATE quote_assets SET decimals = 18 WHERE id = 'xaut0'");
    const { log, decoded } = fakeLog({
      abi: quoteRegistryAbi,
      eventName: "QuoteAssetRegistered",
      address: REGISTRY,
      args: { asset: gold.address!, decimals: 6, quoteTarget: 1n },
    });
    await applyLog(db, log, decoded, TS, cfg2, () => {});
    expect((await row(db, gold.address!)).rows[0]).toMatchObject({ id: "xaut0", decimals: 6 });
  });

  it("inserts an unknown asset keyed by its address, to be named by an admin", async () => {
    const other = "0x00000000efe302beaa2b3e6e1b18d08d69a9012a";
    const { log, decoded } = fakeLog({
      abi: quoteRegistryAbi,
      eventName: "QuoteAssetRegistered",
      address: REGISTRY,
      args: { asset: other, decimals: 6, quoteTarget: 1n },
    });
    await applyLog(db, log, decoded, TS, cfg2, () => {});
    expect((await row(db, other)).rows[0]).toMatchObject({
      id: other,
      symbol: null,
      decimals: 6,
      registered: true,
    });
  });

  it("QuoteTargetChanged and QuoteAssetEnabled update their columns only", async () => {
    const r = fakeLog({
      abi: quoteRegistryAbi,
      eventName: "QuoteAssetRegistered",
      address: REGISTRY,
      args: { asset: USDC, decimals: 6, quoteTarget: 1n },
    });
    await applyLog(db, r.log, r.decoded, TS, cfg2, () => {});
    const t = fakeLog({
      abi: quoteRegistryAbi,
      eventName: "QuoteTargetChanged",
      address: REGISTRY,
      args: { asset: USDC, previous: 1n, current: 2n },
    });
    await applyLog(db, t.log, t.decoded, TS, cfg2, () => {});
    const e = fakeLog({
      abi: quoteRegistryAbi,
      eventName: "QuoteAssetEnabled",
      address: REGISTRY,
      args: { asset: USDC, enabled: false },
    });
    await applyLog(db, e.log, e.decoded, TS, cfg2, () => {});
    expect((await row(db, USDC)).rows[0]).toMatchObject({
      quote_target: "2",
      enabled: false,
      registered: true,
      symbol: "USDC",
    });
  });

  it("ignores registry events from any other address", async () => {
    const { log, decoded } = fakeLog({
      abi: quoteRegistryAbi,
      eventName: "QuoteAssetRegistered",
      address: "0x9999999999999999999999999999999999999999",
      args: { asset: USDC, decimals: 6, quoteTarget: 1n },
    });
    await applyLog(db, log, decoded, TS, cfg2, () => {});
    expect((await row(db, USDC)).rows[0]!.registered).toBe(false);
  });

  it("re-seeding never overwrites an admin edit", async () => {
    await db.query("UPDATE quote_assets SET blurb = 'edited' WHERE id = 'usdc'");
    await ensureQuoteCatalog(db);
    const { rows } = await db.query<{ blurb: string }>(
      "SELECT blurb FROM quote_assets WHERE id = 'usdc'",
    );
    expect(rows[0]!.blurb).toBe("edited");
  });

  /// A boot after a registration must not undo it: the seed fills presentational NULLs and never
  /// touches a column the chain owns.
  it("re-seeding leaves the on-chain columns alone", async () => {
    const r = fakeLog({
      abi: quoteRegistryAbi,
      eventName: "QuoteAssetRegistered",
      address: REGISTRY,
      args: { asset: USDC, decimals: 6, quoteTarget: 8_000_000_000n },
    });
    await applyLog(db, r.log, r.decoded, TS, cfg2, () => {});
    await ensureQuoteCatalog(db);
    expect((await row(db, USDC)).rows[0]).toMatchObject({
      decimals: 6,
      quote_target: "8000000000",
      registered: true,
      enabled: true,
    });
  });
});
