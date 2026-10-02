import type { PGlite } from "@electric-sql/pglite";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { PrismaPGlite } from "pglite-prisma-adapter";

import type { Db } from "./legacy.js";
import { withRetry } from "./retry.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(here, "..", "schema.sql");

/**
 * Drop every indexed row and re-scan from `START_BLOCK`, when `DOKU_RESET_DB=true`.
 *
 * Applied on BOTH connect paths, and that is the whole point of it living here rather than beside
 * one of them. The pooled Postgres path is what production uses and the in-process PGlite path is
 * what development and tests use; putting this next to the schema application means neither can
 * quietly miss it. A first attempt went into `legacy.ts` and did nothing on the deployment that
 * needed it, because production never takes that path.
 *
 * The database outlives the deployment. Repointing a service from one chain to another leaves the
 * previous chain's markets sitting in it, served alongside the new ones by an API that gives no
 * hint two chains are mixed.
 *
 * Safe because nothing here is original: every row is derived from a chain log, so clearing costs
 * a re-scan and nothing else. Opt-in anyway — recoverable and free are not the same thing on a
 * chain fifty million blocks deep.
 */
async function resetIfRequested(db: { exec: (sql: string) => Promise<void> }): Promise<void> {
  if (process.env.DOKU_RESET_DB !== "true") return;
  // `positions` belongs in this list for a reason the other tables do not have. Every one of them
  // is written by an upsert that REPLACES, so re-scanning a block twice is idempotent even if the
  // row survived. `positions` accumulates — `liquidity = positions.liquidity + EXCLUDED.liquidity`,
  // because the event carries a delta — so a reset that left it standing would re-apply every
  // delta on top of the old total and double every provider's position. Harmless while the table
  // was empty, which it was for as long as the ingester watched an event nothing emitted.
  // The generation-2 tables are on the list for the same reason as the rest, with two footnotes:
  // `quote_assets` loses its presentational rows and gets them back from `ensureQuoteCatalog` on
  // the next boot, and `uploads` rows are NOT derived from a chain log — they are the only thing
  // in this database a re-scan cannot reproduce, which is one more reason `DOKU_RESET_DB` is
  // never set on Railway.
  await db.exec(
    `TRUNCATE markets, market_state, swaps, graduations, candlesticks, transfers,
              token_balances, positions, indexed_blocks, indexed_events, indexer_status,
              quote_assets, market_stats, fee_events, market_rewards, creator_ledger,
              creator_balances, metadata_updates, recipient_updates, uploads,
              contract_verifications, hidden_creators
     RESTART IDENTITY CASCADE`,
  );
  await db.exec("INSERT INTO indexer_status (id, last_block) VALUES (1, 0)");
}

/**
 * The one database handle for the process.
 *
 * Constructed once at boot and passed down. Never per request — a `PrismaClient` owns a connection
 * pool, so one per request is one pool per request, which exhausts the server's connection limit
 * under any real load and does it fastest exactly when load is highest.
 *
 * Two engines behind one interface, chosen by whether `DATABASE_URL` is set:
 *
 *   deployment   `@prisma/adapter-pg`      over a `pg.Pool` this module owns
 *   dev / tests  `pglite-prisma-adapter`   over in-process PGlite
 *
 * Both are real Postgres, so `NUMERIC(78,0)` arithmetic, `ON CONFLICT` and partial indexes behave
 * identically in tests and in production. That is the property worth protecting: a test suite that
 * needs no external database, running the same SQL the deployment runs.
 *
 * `legacy` exposes the same pool through the pre-Prisma two-method seam. It exists only while
 * consumers are migrated across, and goes when the last one does.
 */
export interface Database {
  readonly prisma: PrismaClient;
  /** The pre-Prisma seam, over the same connection. Temporary. */
  readonly legacy: Db;
  /** Verify the connection and apply the schema. Throws if the database is unreachable. */
  connect(): Promise<void>;
  /** A cheap liveness probe for `/health` and `/ready`. Never throws. */
  ping(): Promise<boolean>;
  /** Close the pool. Safe to call twice. */
  disconnect(): Promise<void>;
}

export interface DatabaseOptions {
  /** Absent means the in-process engine: development and tests only. */
  url?: string | undefined;
  poolSize?: number;
}

/**
 * Postgres returns `NUMERIC` and `BIGINT` as strings so precision is not lost on the way out, and
 * the legacy seam depends on that. Set once, globally, because `pg` keeps parsers on a module
 * singleton — setting them per pool would silently apply to every pool.
 */
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);

export function createDatabase(options: DatabaseOptions = {}): Database {
  return options.url === undefined
    ? createInProcessDatabase()
    : createPooledDatabase(options.url, options.poolSize ?? 10);
}

function createPooledDatabase(url: string, poolSize: number): Database {
  // One pool, shared by Prisma and the legacy seam. Handing the adapter a pool this module owns —
  // rather than a connection string it would pool for itself — is what keeps that "one" true.
  const pool = new pg.Pool({ connectionString: url, max: poolSize });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  const legacy: Db = {
    query: async <R extends object>(sql: string, params?: unknown[]) => {
      const r = await pool.query<R>(sql, params as never[]);
      return { rows: r.rows, rowCount: r.rowCount };
    },
    exec: async (sql: string) => {
      await pool.query(sql);
    },
  };

  let closed = false;
  return {
    prisma,
    legacy,
    async connect() {
      // Retried, because a deployment routinely starts while its database is still accepting
      // connections. Failing the first attempt and exiting turns an ordinary startup race into a
      // crash loop.
      await withRetry(async () => {
        const client = await pool.connect();
        try {
          await client.query("SELECT 1");
        } finally {
          client.release();
        }
      });
      await legacy.exec(readFileSync(SCHEMA_PATH, "utf8"));
      await resetIfRequested(legacy);
    },
    async ping() {
      try {
        await pool.query("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },
    async disconnect() {
      if (closed) return;
      closed = true;
      // Prisma first: it holds checked-out connections, and ending the pool underneath it makes
      // the disconnect throw on connections it can no longer return.
      await prisma.$disconnect().catch(() => {});
      await pool.end().catch(() => {});
    },
  };
}

/**
 * PGlite: the same Postgres engine compiled to wasm, in this process.
 *
 * Not an emulation and not a mock — the tests exercise the real SQL, which is why they catch the
 * things a mock would happily accept.
 */
function createInProcessDatabase(): Database {
  let pglite: PGlite | undefined;
  let prisma: PrismaClient | undefined;
  let closed = false;

  const ensure = async (): Promise<{ pglite: PGlite; prisma: PrismaClient }> => {
    // Without this, `disconnect()` is undone by the next query: the lazy constructor would simply
    // build a second engine, and a closed database would answer `ping()` by resurrecting itself.
    if (closed) throw new Error("database is closed");
    if (!pglite || !prisma) {
      const { PGlite: Ctor } = await import("@electric-sql/pglite");
      // `pg_trgm` is bundled with PGlite but not loaded unless it is handed to the constructor.
      // Production Postgres gets it from `CREATE EXTENSION` in schema.sql; without this the same
      // statement fails in wasm and the GIN indexes silently never exist, so the one place search
      // is exercised — the tests — would be the one place it is never accelerated.
      const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
      pglite = await Ctor.create({ extensions: { pg_trgm } });
      prisma = new PrismaClient({ adapter: new PrismaPGlite(pglite) });
    }
    return { pglite, prisma };
  };

  const legacy: Db = {
    query: async <R extends object>(sql: string, params?: unknown[]) => {
      const { pglite: p } = await ensure();
      const r = await p.query<R>(sql, params as never[]);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
    exec: async (sql: string) => {
      const { pglite: p } = await ensure();
      await p.exec(sql);
    },
  };

  return {
    // Accessed lazily through a getter: the engine is created on first use, and a `Database` that
    // is constructed but never connected should not have booted a wasm Postgres.
    get prisma(): PrismaClient {
      if (!prisma) throw new Error("database not connected — call connect() first");
      return prisma;
    },
    legacy,
    async connect() {
      closed = false;
      await ensure();
      await legacy.exec(readFileSync(SCHEMA_PATH, "utf8"));
      await resetIfRequested(legacy);
    },
    async ping() {
      try {
        await legacy.query("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },
    async disconnect() {
      if (closed) return;
      closed = true;
      await prisma?.$disconnect().catch(() => {});
      await pglite?.close().catch(() => {});
      prisma = undefined;
      pglite = undefined;
    },
  };
}
