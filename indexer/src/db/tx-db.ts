import type { Db } from "./legacy.js";
import type { Tx } from "./transaction.js";

/**
 * The pre-Prisma `Db` seam, backed by an open Prisma transaction.
 *
 * The indexer's write path is a few hundred lines of hand-tuned SQL — upserts with `ON CONFLICT`,
 * `GREATEST`/`LEAST` on running aggregates, `NUMERIC(78,0)` arithmetic. All of it is correct and
 * all of it is tested. What it lacked was a transaction around it.
 *
 * Rewriting every statement to reach atomicity would put the riskiest change (rewriting working
 * SQL) and the most valuable one (making it atomic) in the same commit, where a failure in either
 * is indistinguishable from the other. This adapter separates them: the SQL runs verbatim, inside
 * a transaction, through the managed client.
 *
 * `$queryRawUnsafe` is the right call despite the name. "Unsafe" describes the *statement* being a
 * string rather than a tagged template; the parameters are still bound and sent separately, never
 * interpolated. Every caller here passes a constant SQL string with `$1`-style placeholders.
 */

/**
 * Which Prisma call a statement needs.
 *
 * Prisma splits these where `pg` does not: `$queryRaw` expects a result set and `$executeRaw`
 * returns an affected-row count. Sending an `INSERT` through the former, or a `SELECT` through the
 * latter, fails outright — so the seam has to route each statement to the right one.
 */
function returnsRows(sql: string): boolean {
  const head = sql.trimStart().slice(0, 8).toUpperCase();
  if (head.startsWith("SELECT") || head.startsWith("WITH")) return true;
  // A mutation with RETURNING produces rows as well.
  return /\bRETURNING\b/i.test(sql);
}

export function txDb(tx: Tx): Db {
  return {
    query: async <R extends object>(sql: string, params: unknown[] = []) => {
      if (returnsRows(sql)) {
        const rows = await tx.$queryRawUnsafe<R[]>(sql, ...params);
        return { rows, rowCount: rows.length };
      }

      /**
       * The affected-row count has to be exact, not approximated.
       *
       * The ingester writes each event with `ON CONFLICT (tx_hash, log_index) DO NOTHING` and then
       * reads `rowCount === 0` to decide whether to fold the event into the running aggregates.
       * That check is the entire reason re-ingesting a range is a no-op. An adapter that reported
       * a row as inserted when the conflict clause had skipped it would add the same trade's
       * volume again on every replay — a number that stays plausible and is never right again.
       */
      const affected = await tx.$executeRawUnsafe(sql, ...params);
      return { rows: [] as R[], rowCount: affected };
    },
    exec: async (sql: string) => {
      await tx.$executeRawUnsafe(sql);
    },
  };
}
