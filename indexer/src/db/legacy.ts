import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The pre-Prisma seam, kept for the write path and the tests that seed with raw SQL.
 *
 * The pooled constructor that used to live here is gone: `db/client.ts` owns the pool now, and two
 * ways to build one is exactly what "a single managed client" rules out. What remains is the
 * interface, the in-process engine the migration test uses, and the checkpoint accessors.
 */

/**
 * The one thing this service needs from a database.
 *
 * Narrowed to a single method so the ingester can run against production Postgres and against an
 * in-process PGlite in tests without a branch anywhere in the logic. The tests therefore exercise
 * the real SQL — NUMERIC(78,0) arithmetic, ON CONFLICT, GREATEST/LEAST — rather than a mock that
 * would happily accept queries Postgres would reject.
 */
export interface Db {
  query<R extends object = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;

  /**
   * Run a script of several statements, taking no parameters.
   *
   * Separate from `query` because a prepared statement holds exactly one command, and the schema
   * is many. `pg` happens to accept both through the same call and PGlite does not, which is the
   * kind of difference that makes a migration work in production and fail in tests, or the
   * reverse.
   */
  exec(sql: string): Promise<void>;
}

/**
 * An in-process Postgres, for local development.
 *
 * PGlite is the real engine compiled to wasm, not an emulation — the same SQL, the same
 * `NUMERIC(78,0)` arithmetic, the same `ON CONFLICT`. It exists so running the stack locally does
 * not require standing up a database first; production passes `DATABASE_URL` and gets the pooled
 * client below.
 *
 * Imported lazily so the dependency is never loaded in a deployment that does not use it.
 */
export async function createMemoryDb(): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  // Same as `db/client.ts`: pg_trgm ships with PGlite but has to be handed to the constructor.
  const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
  const pg = await PGlite.create({ extensions: { pg_trgm } });
  const db: Db = {
    query: async (sql, params) => {
      const r = await pg.query(sql, params as never[]);
      return { rows: r.rows as never[], rowCount: r.affectedRows ?? r.rows.length };
    },
    exec: async (sql) => {
      await pg.exec(sql);
    },
  };
  await migrate(db);
  return db;
}

export async function migrate(db: Db): Promise<void> {
  await db.exec(readFileSync(join(here, "..", "schema.sql"), "utf8"));
}

export async function getStatus(db: Db): Promise<{ lastBlock: bigint; lastBlockHash: string | null }> {
  const { rows } = await db.query<{ last_block: string; last_block_hash: string | null }>(
    "SELECT last_block, last_block_hash FROM indexer_status WHERE id = 1",
  );
  const row = rows[0];
  return {
    lastBlock: BigInt(row?.last_block ?? "0"),
    lastBlockHash: row?.last_block_hash ?? null,
  };
}

export async function setStatus(
  db: Db,
  lastBlock: bigint,
  lastBlockHash: string,
  chainHead: bigint,
): Promise<void> {
  await db.query(
    `UPDATE indexer_status
        SET last_block = $1, last_block_hash = $2, chain_head = $3, updated_at = NOW()
      WHERE id = 1`,
    [lastBlock.toString(), lastBlockHash, chainHead.toString()],
  );
}
