import { beforeEach, describe, expect, it } from "vitest";

import type { Db } from "../src/db/legacy.js";
import { ensureQuoteCatalog, QUOTE_CATALOG } from "../src/quotes/catalog.js";
import { memoryDatabase } from "./helpers.js";

/**
 * What happens when the chain registers an asset before the catalogue knows its name.
 *
 * `handleRegistryEvent` inserts such an asset with its ADDRESS as the id, symbol null, exactly as
 * its comment says it should. The catalogue then arrives — a release that names the asset, or a
 * restart after the catalogue rows were cleared — and tries to insert the same address under a
 * friendly id. `address` is UNIQUE, and the insert's conflict target is `id`, so nothing catches
 * it: the seed throws, and it throws at BOOT, before the service serves anything.
 *
 * That is the one failure shape a boot-time seed must not have, so the seed adopts the row instead.
 */
const USDC = QUOTE_CATALOG.find((c) => c.id === "usdc")!;

describe("ensureQuoteCatalog adopting a row the chain created first", () => {
  let db: Db;

  beforeEach(async () => {
    db = (await memoryDatabase()).legacy;
    // Precisely what a `QuoteAssetRegistered` writes for an asset the catalogue does not list.
    await db.query(
      `INSERT INTO quote_assets (id, address, decimals, quote_target, registered, enabled, block_number)
       VALUES ($1, $1, 6, 8000000000, TRUE, TRUE, 100)`,
      [USDC.address],
    );
  });

  it("does not throw when the catalogue names an address the chain already registered", async () => {
    await expect(ensureQuoteCatalog(db)).resolves.toBeUndefined();
  });

  it("keeps ONE row for the address, under the catalogue's id", async () => {
    await ensureQuoteCatalog(db);
    const { rows } = await db.query<{ id: string; symbol: string; kind: string }>(
      "SELECT id, symbol, kind FROM quote_assets WHERE address = $1",
      [USDC.address],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "usdc", symbol: USDC.symbol, kind: USDC.kind });
  });

  it("keeps the chain's own columns, which the catalogue must never overwrite", async () => {
    await ensureQuoteCatalog(db);
    const { rows } = await db.query<{
      registered: boolean; enabled: boolean; quote_target: string; decimals: number;
    }>("SELECT registered, enabled, quote_target, decimals FROM quote_assets WHERE address = $1", [
      USDC.address,
    ]);
    expect(rows[0]!.registered).toBe(true);
    expect(rows[0]!.enabled).toBe(true);
    expect(String(rows[0]!.quote_target)).toBe("8000000000");
    // The chain reports what the token itself says; six is right and the catalogue agrees here.
    expect(Number(rows[0]!.decimals)).toBe(6);
  });

  it("leaves an id an operator chose alone rather than renaming it", async () => {
    // Not an auto-created row: its id is not its address, so somebody named it deliberately.
    await db.query("UPDATE quote_assets SET id = 'house-dollar' WHERE address = $1", [
      USDC.address,
    ]);
    await ensureQuoteCatalog(db);
    const { rows } = await db.query<{ id: string }>(
      "SELECT id FROM quote_assets WHERE address = $1",
      [USDC.address],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("house-dollar");
  });

  it("is idempotent, because it runs on every boot", async () => {
    await ensureQuoteCatalog(db);
    await ensureQuoteCatalog(db);
    const { rows } = await db.query<{ n: string }>("SELECT count(*) AS n FROM quote_assets");
    expect(Number(rows[0]!.n)).toBe(QUOTE_CATALOG.length);
  });
});
