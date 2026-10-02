import type { Db } from "../db/legacy.js";

/**
 * The record of which blocks the indexer has processed, and how they chain.
 *
 * Reorg detection used to reconstruct candidate hashes by `UNION`-ing `block_hash` out of the four
 * event tables. That meant only blocks which *emitted something* carried a hash worth comparing,
 * so on a quiet chain the walk-back had almost nothing to work with and the first match it found
 * could sit far below the real fork point — leaving orphaned rows above it and a reader convinced
 * the reorg had been handled.
 *
 * This is the fix the brief asks for: a block-level ledger with `parent_hash`, which turns a set
 * of independent samples into a chain that can be checked for continuity.
 */

export interface IndexedBlock {
  number: bigint;
  hash: string;
  parentHash: string;
}

/**
 * Record a processed block.
 *
 * Idempotent, and an existing row is *overwritten* rather than left alone. A replay after a reorg
 * legitimately re-processes the same height with a different hash, and keeping the old one would
 * preserve exactly the record the rewind was meant to remove.
 */
export async function recordBlock(db: Db, block: IndexedBlock): Promise<void> {
  await db.query(
    `INSERT INTO indexed_blocks (block_number, block_hash, parent_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (block_number)
     DO UPDATE SET block_hash = EXCLUDED.block_hash,
                   parent_hash = EXCLUDED.parent_hash,
                   indexed_at = NOW()`,
    [block.number.toString(), block.hash, block.parentHash],
  );
}

/** Record a log as processed, for logs that produce no row of their own. */
export async function recordEvent(
  db: Db,
  blockNumber: bigint,
  txHash: string,
  logIndex: number,
  eventName: string,
): Promise<void> {
  await db.query(
    `INSERT INTO indexed_events (block_number, tx_hash, log_index, event_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tx_hash, log_index) DO NOTHING`,
    [blockNumber.toString(), txHash, logIndex, eventName],
  );
}

/**
 * Recorded blocks at or below `ceiling`, newest first, at most `limit` of them.
 *
 * Used to walk backwards looking for the last height whose hash the chain still agrees with.
 */
export async function recentBlocks(
  db: Db,
  ceiling: bigint,
  floor: bigint,
  limit = 256,
): Promise<IndexedBlock[]> {
  const { rows } = await db.query<{
    block_number: string;
    block_hash: string;
    parent_hash: string;
  }>(
    /*
     * `ORDER BY indexed_blocks.block_number`, qualified.
     *
     * Unqualified, Postgres resolves `ORDER BY block_number` against the *output* column — which
     * here is the `::text` cast — and sorts it lexicographically: 9, then 11, then 10. The reorg
     * walk depends on this being deepest-last so it finds the highest surviving ancestor first;
     * out of order it can stop at the wrong block and leave orphaned rows above it.
     *
     * The same trap is documented on the swap feed's `ORDER BY id`, and this query walked
     * straight into it.
     */
    `SELECT block_number::text AS block_number, block_hash, parent_hash
       FROM indexed_blocks
      WHERE block_number <= $1 AND block_number >= $2
      ORDER BY indexed_blocks.block_number DESC
      LIMIT $3`,
    [ceiling.toString(), floor.toString(), limit],
  );
  return rows.map((r) => ({
    number: BigInt(r.block_number),
    hash: r.block_hash,
    parentHash: r.parent_hash,
  }));
}

/** Drop the record of every block at or above `fromBlock`, as part of a rewind. */
export async function forgetBlocksFrom(db: Db, fromBlock: bigint): Promise<void> {
  await db.query("DELETE FROM indexed_blocks WHERE block_number >= $1", [fromBlock.toString()]);
  await db.query("DELETE FROM indexed_events WHERE block_number >= $1", [fromBlock.toString()]);
}

/**
 * Forget blocks too old to ever be part of a reorg.
 *
 * The ledger is only useful for the recent past — a divergence deeper than the retention window is
 * not a reorg any chain produces — so it is trimmed rather than kept forever. Without this it
 * grows by one row per block indefinitely, which on a sub-second chain is tens of millions of rows
 * a year to support a lookback measured in hundreds.
 */
export async function pruneBlocksBelow(db: Db, floor: bigint): Promise<void> {
  if (floor <= 0n) return;
  await db.query("DELETE FROM indexed_blocks WHERE block_number < $1", [floor.toString()]);
  await db.query("DELETE FROM indexed_events WHERE block_number < $1", [floor.toString()]);
}

/**
 * Whether two consecutive records actually join.
 *
 * `later.parentHash === earlier.hash` is the whole point of storing the parent: two heights whose
 * hashes each still match the chain can still have a reorg between them if the indexer skipped the
 * blocks in the gap. Only meaningful for genuinely adjacent heights — anything else has blocks in
 * between that were never recorded, so there is no link to check.
 */
export function chainsTo(later: IndexedBlock, earlier: IndexedBlock): boolean {
  if (later.number !== earlier.number + 1n) return true;
  return later.parentHash === earlier.hash;
}
