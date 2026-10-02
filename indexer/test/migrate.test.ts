import { describe, expect, it } from "vitest";

import { createMemoryDb, migrate } from "../src/db/legacy.js";

/**
 * Migrating a database that already exists.
 *
 * The schema is written as `CREATE TABLE IF NOT EXISTS`, which is exactly the right thing for a
 * fresh database and does nothing at all for one that is already deployed. A column added to a
 * `CREATE TABLE` therefore reaches development and never reaches production, where the service
 * boots cleanly and then fails every query that names it — a deploy that reports success while
 * serving errors.
 *
 * These tests run the schema against a database in the *old* shape, which is the only way to find
 * that out before a deployment does.
 */
describe("migrations", () => {
  it("adds columns to a table that already exists", async () => {
    const db = await createMemoryDb();

    // Put the table back in its pre-`total_supply` shape, which is what a running deployment has.
    await db.query("ALTER TABLE markets DROP COLUMN total_supply");
    await migrate(db);

    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'markets' AND column_name = 'total_supply'`,
    );
    expect(rows.length).toBe(1);
  }, 120_000);

  it("is a no-op against a database already at the current shape", async () => {
    const db = await createMemoryDb();
    // Running twice has to be safe: every boot runs it, not only the boot after a change.
    await migrate(db);
    await migrate(db);

    const { rows } = await db.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM information_schema.columns WHERE table_name = 'markets'",
    );
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  }, 120_000);
});
