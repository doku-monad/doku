import { beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../src/db/index.js";
import { withTransaction } from "../src/db/index.js";
import { txDb } from "../src/db/tx-db.js";
import { memoryDatabase } from "./helpers.js";

/**
 * The `Db` seam over an open Prisma transaction.
 *
 * The indexer's whole idempotency guarantee runs through this adapter. Each event is written with
 * `ON CONFLICT (tx_hash, log_index) DO NOTHING`, and the ingester then reads `rowCount === 0` to
 * decide whether to fold that event into the running aggregates. If the adapter reported a
 * skipped insert as an inserted one, every replayed range would add its volume again — a figure
 * that stays plausible and is never right again.
 *
 * Prisma also splits row-returning statements from mutations where `pg` did not, so the adapter
 * has to route each statement to the right call. Both properties are asserted here.
 */
describe("txDb", () => {
  let database: Database;

  beforeEach(async () => {
    database = await memoryDatabase();
  }, 120_000);

  const market = (tx: string) =>
    [
      `INSERT INTO markets (market_address, token_address, symbol, name, symbol_key, creator,
                            quote_target, block_number, block_hash, log_index, tx_hash, created_at)
       VALUES ($1,$2,'x','x',$3,'0xc',0,1,'0xb',0,$4,NOW())
       ON CONFLICT (tx_hash, log_index) DO NOTHING`,
      ["0xm-" + tx, "0xt-" + tx, "key-" + tx, tx],
    ] as const;

  /** The guard itself: a genuinely new row reports one, a conflict reports zero. */
  it("reports rows actually inserted, and zero when the conflict clause skips", async () => {
    await withTransaction(database.prisma, async (tx) => {
      const db = txDb(tx);
      const [sql, params] = market("0xtx1");

      const first = await db.query(sql, [...params]);
      expect(first.rowCount, "a new row counts as one").toBe(1);

      const second = await db.query(sql, [...params]);
      expect(second.rowCount, "a conflicting row must count as zero").toBe(0);
    });
  });

  it("counts updated rows", async () => {
    await withTransaction(database.prisma, async (tx) => {
      const db = txDb(tx);
      const [sql, params] = market("0xtx1");
      await db.query(sql, [...params]);

      const updated = await db.query("UPDATE markets SET symbol = $1 WHERE market_address = $2", [
        "🐎",
        "0xm-0xtx1",
      ]);
      expect(updated.rowCount).toBe(1);

      const missed = await db.query("UPDATE markets SET symbol = $1 WHERE market_address = $2", [
        "🐎",
        "0xnope",
      ]);
      expect(missed.rowCount).toBe(0);
    });
  });

  it("returns rows for a select", async () => {
    await withTransaction(database.prisma, async (tx) => {
      const db = txDb(tx);
      const [sql, params] = market("0xtx1");
      await db.query(sql, [...params]);

      const { rows } = await db.query<{ market_address: string }>(
        "SELECT market_address FROM markets WHERE tx_hash = $1",
        ["0xtx1"],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.market_address).toBe("0xm-0xtx1");
    });
  });

  /** A mutation with RETURNING produces rows, so it has to take the query path. */
  it("returns rows for a mutation with RETURNING", async () => {
    await withTransaction(database.prisma, async (tx) => {
      const db = txDb(tx);
      const [sql, params] = market("0xtx1");
      await db.query(sql, [...params]);

      const { rows } = await db.query<{ market_address: string }>(
        "UPDATE markets SET symbol = $1 WHERE tx_hash = $2 RETURNING market_address",
        ["🐎", "0xtx1"],
      );
      expect(rows).toHaveLength(1);
    });
  });

  /**
   * The reason the adapter exists. Everything a pass wrote is discarded together when it fails
   * part-way, rather than leaving aggregates that disagree with the events they came from.
   */
  it("discards every write when the transaction fails part-way", async () => {
    await expect(
      withTransaction(database.prisma, async (tx) => {
        const db = txDb(tx);
        const [sql, params] = market("0xtx1");
        await db.query(sql, [...params]);
        const [sql2, params2] = market("0xtx2");
        await db.query(sql2, [...params2]);
        throw new Error("the pass failed after writing two markets");
      }),
    ).rejects.toThrow("the pass failed after writing two markets");

    const survivors = await database.prisma.markets.count();
    expect(survivors, "a failed pass must leave nothing behind").toBe(0);
  });

  /** Committed work is visible outside the transaction, through the ordinary client. */
  it("commits what succeeded", async () => {
    await withTransaction(database.prisma, async (tx) => {
      const [sql, params] = market("0xtx1");
      await txDb(tx).query(sql, [...params]);
    });
    expect(await database.prisma.markets.count()).toBe(1);
  });
});
