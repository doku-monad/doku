import { createDatabase, type Database, withTransaction } from "../src/db/index.js";
import { txDb } from "../src/db/tx-db.js";
import type { Db } from "../src/db/legacy.js";

/**
 * An in-process PostgreSQL for tests.
 *
 * PGlite is the real engine compiled to wasm, not a mock, so the tests exercise the actual SQL —
 * NUMERIC(78,0) arithmetic that would lose precision as a float, ON CONFLICT, GREATEST/LEAST.
 * A stub would happily accept queries Postgres rejects, which is exactly the class of bug that
 * then only appears in production.
 *
 * This is the service's own constructor rather than a copy of it. The copy had drifted: it applied
 * the schema with `exec` while the service applied it with `migrate`, so `migrate` was the one
 * function every test avoided and nothing ran it until a deployment did.
 */
export async function memoryDatabase(): Promise<Database> {
  const database = createDatabase();
  await database.connect();
  return database;
}

/**
 * The same database through the pre-Prisma seam.
 *
 * Most tests seed with raw SQL, which is still the clearest way to write a fixture. They get the
 * legacy view of the *same* connection, so what they insert is what the Prisma-backed API reads.
 */
export async function memoryDb(): Promise<Db> {
  return (await memoryDatabase()).legacy;
}

export const ZERO = "0x0000000000000000000000000000000000000000";

/** A market row, so tests that care about swaps do not have to construct a launch first. */
export async function seedMarket(
  db: Db,
  market: string,
  token: string,
  block = 100,
): Promise<void> {
  await db.query(
    `INSERT INTO markets (market_address, token_address, symbol, name, symbol_key, creator,
                          quote_target, block_number, block_hash, log_index, tx_hash, created_at)
     VALUES ($1,$2,'x','x',$3,$4,0,$5,'0xaa',0,$6,NOW())`,
    [market, token, `key-${market}`, ZERO, block, `0xtx-${market}`],
  );
  await db.query("INSERT INTO market_state (market_address) VALUES ($1)", [market]);
}

/**
 * The ingest option that makes a pass atomic, built from a managed database.
 *
 * Tests spread this into their `IngestConfig` so they exercise the same transactional path the
 * service uses. Without it `ingestOnce` falls back to writing statement by statement, and the
 * suite would be proving the behaviour of a code path production does not take.
 */
export function transactional(database: Database): {
  transaction: <T>(work: (db: Db) => Promise<T>) => Promise<T>;
} {
  return {
    transaction: (work) => withTransaction(database.prisma, (tx) => work(txDb(tx))),
  };
}
