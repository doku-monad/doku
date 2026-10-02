import { describe, expect, it } from "vitest";
import { createMemoryDb, migrate } from "../src/db/legacy.js";
import { memoryDb, seedMarket, ZERO } from "./helpers.js";

/**
 * The gen-2 columns and tables reach a database that already exists.
 *
 * `CREATE TABLE IF NOT EXISTS` reaches a fresh database and never a running one, so every column
 * needs an `ALTER TABLE … ADD COLUMN IF NOT EXISTS` at the bottom of schema.sql as well. This
 * drops each new column and re-migrates, which is the only way to prove the second half exists.
 */
const NEW_MARKET_COLUMNS = [
  "generation", "quote_asset", "quote_decimals", "routing", "routed_recipient",
  "creator_tax_bps", "tax_recipient", "ticker", "logo_uri", "banner_uri", "description",
  "website", "x", "telegram", "metadata_hash",
];
const NEW_TABLES = [
  "quote_assets", "market_stats", "fee_events", "market_rewards", "creator_ledger",
  "creator_balances", "metadata_updates", "uploads",
];

describe("gen-2 migration", () => {
  it.each(NEW_MARKET_COLUMNS)("re-adds markets.%s to a pre-gen-2 database", async (column) => {
    const db = await createMemoryDb();
    await db.query(`ALTER TABLE markets DROP COLUMN ${column}`);
    await migrate(db);
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'markets' AND column_name = $1`,
      [column],
    );
    expect(rows).toHaveLength(1);
  }, 120_000);

  it("re-adds swaps.creator_tax and graduations.quote_asset", async () => {
    const db = await createMemoryDb();
    await db.query("ALTER TABLE swaps DROP COLUMN creator_tax");
    await db.query("ALTER TABLE graduations DROP COLUMN quote_asset");
    await migrate(db);
    const { rows } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM information_schema.columns
        WHERE (table_name = 'swaps' AND column_name = 'creator_tax')
           OR (table_name = 'graduations' AND column_name = 'quote_asset')`,
    );
    expect(Number(rows[0]!.n)).toBe(2);
  }, 120_000);

  it.each(NEW_TABLES)("creates %s", async (table) => {
    const db = await createMemoryDb();
    const { rows } = await db.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM information_schema.tables WHERE table_name = $1",
      [table],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  }, 120_000);

  /// A gen-1 row written by the existing handler must read as gen 1 quoted in native MON.
  it("defaults an existing market to generation 1 quoted in MON at 18 decimals", async () => {
    const db = await memoryDb();
    await seedMarket(db, "0xcurve", "0xtoken");
    const { rows } = await db.query<{
      generation: number; quote_asset: string; quote_decimals: number; creator_tax_bps: number;
      routing: number | null; ticker: string | null;
    }>("SELECT generation, quote_asset, quote_decimals, creator_tax_bps, routing, ticker FROM markets");
    expect(rows[0]).toMatchObject({
      generation: 1, quote_asset: ZERO, quote_decimals: 18, creator_tax_bps: 0, routing: null, ticker: null,
    });
  });

  /// Search must work with or without pg_trgm; ILIKE is the contract, the GIN index the accelerator.
  it("answers an ILIKE search on name and ticker", async () => {
    const db = await memoryDb();
    await seedMarket(db, "0xcurve", "0xtoken");
    await db.query("UPDATE markets SET name = 'Crescent Moon', ticker = 'MOON' WHERE market_address = '0xcurve'");
    const { rows } = await db.query<{ market_address: string }>(
      "SELECT market_address FROM markets WHERE name ILIKE $1 OR ticker ILIKE $1",
      ["%moo%"],
    );
    expect(rows).toHaveLength(1);
  });

  it("is a no-op the second time", async () => {
    const db = await createMemoryDb();
    await migrate(db);
    await migrate(db);
    const { rows } = await db.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM information_schema.tables WHERE table_name = 'fee_events'",
    );
    expect(Number(rows[0]!.n)).toBe(1);
  }, 120_000);
});
