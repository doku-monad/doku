import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `DOKU_RESET_DB=true` must clear EVERY indexed table, and one of them is why this test exists.
 *
 * `positions` was missing from the list. It went unnoticed because the table was empty — the
 * ingester watched an event no deployed contract emits — and because every other table is written
 * by an upsert that REPLACES, so a surviving row is simply overwritten on the re-scan and nothing
 * looks wrong. `positions` is the exception: it accumulates a signed delta
 * (`liquidity = positions.liquidity + EXCLUDED.liquidity`), so a reset that spared it would re-apply
 * every delta on top of the old total and silently double every provider's liquidity.
 *
 * Reading both files rather than asserting a hardcoded list, so adding a table to the schema and
 * forgetting the reset fails here instead of on the day someone reindexes.
 */
const schema = readFileSync(new URL("../src/schema.sql", import.meta.url), "utf8");
const client = readFileSync(new URL("../src/db/client.ts", import.meta.url), "utf8");

const tablesInSchema = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)/g)].map(
  (m) => m[1]!,
);

const truncated = (() => {
  const stmt = client.match(/TRUNCATE([\s\S]*?)RESTART IDENTITY/);
  if (!stmt) throw new Error("no TRUNCATE found in db/client.ts — has the reset moved?");
  return stmt[1]!
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
})();

describe("DOKU_RESET_DB", () => {
  it("finds tables to check", () => {
    expect(tablesInSchema.length).toBeGreaterThan(5);
  });

  it.each(tablesInSchema)("clears %s", (table) => {
    expect(truncated).toContain(table);
  });

  it("clears nothing that is not a table", () => {
    for (const t of truncated) expect(tablesInSchema).toContain(t);
  });
});
