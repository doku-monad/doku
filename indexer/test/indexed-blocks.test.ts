import { beforeEach, describe, expect, it } from "vitest";

import type { Db } from "../src/db/legacy.js";
import {
  chainsTo,
  forgetBlocksFrom,
  type IndexedBlock,
  pruneBlocksBelow,
  recentBlocks,
  recordBlock,
  recordEvent,
} from "../src/indexer/blocks.js";
import { memoryDatabase } from "./helpers.js";

const block = (n: number, hash = `0xh${n}`, parent = `0xh${n - 1}`): IndexedBlock => ({
  number: BigInt(n),
  hash,
  parentHash: parent,
});

/**
 * The block ledger the reorg walk searches.
 *
 * Before this existed, candidate hashes were reconstructed by `UNION`-ing `block_hash` out of the
 * four event tables — so only blocks that emitted something were comparable. On a quiet chain that
 * is almost none of them, and a walk that finds its first agreeing hash hundreds of blocks below
 * the real fork leaves every orphaned row above it in place.
 */
describe("indexed blocks", () => {
  let db: Db;

  beforeEach(async () => {
    db = (await memoryDatabase()).legacy;
  }, 120_000);

  it("records a block and reads it back", async () => {
    await recordBlock(db, block(10));
    const [found] = await recentBlocks(db, 10n, 0n);
    expect(found).toEqual(block(10));
  });

  /**
   * A replay after a reorg legitimately re-processes the same height with a different hash.
   * Leaving the old row would preserve exactly the record the rewind was meant to remove.
   */
  it("overwrites a height that is re-processed with a different hash", async () => {
    await recordBlock(db, block(10, "0xold", "0xp"));
    await recordBlock(db, block(10, "0xnew", "0xp"));
    const found = await recentBlocks(db, 10n, 0n);
    expect(found).toHaveLength(1);
    expect(found[0]!.hash).toBe("0xnew");
  });

  it("returns blocks newest first, within the window", async () => {
    for (const n of [8, 9, 10, 11, 12]) await recordBlock(db, block(n));
    const found = await recentBlocks(db, 11n, 9n);
    expect(found.map((b) => Number(b.number))).toEqual([11, 10, 9]);
  });

  it("forgets everything at or above a rewind point", async () => {
    for (const n of [8, 9, 10, 11]) await recordBlock(db, block(n));
    await recordEvent(db, 10n, "0xtx", 0, "Bought");
    await forgetBlocksFrom(db, 10n);

    const found = await recentBlocks(db, 100n, 0n);
    expect(found.map((b) => Number(b.number))).toEqual([9, 8]);
    const { rows } = await db.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM indexed_events WHERE block_number >= 10",
    );
    expect(rows[0]!.n).toBe(0);
  });

  /**
   * The ledger is only useful for the recent past, and grows by a row per block otherwise — on a
   * sub-second chain that is tens of millions a year to support a lookback measured in hundreds.
   */
  it("prunes blocks below the retention floor", async () => {
    for (const n of [1, 2, 3, 4, 5]) await recordBlock(db, block(n));
    await pruneBlocksBelow(db, 3n);
    const found = await recentBlocks(db, 100n, 0n);
    expect(found.map((b) => Number(b.number))).toEqual([5, 4, 3]);
  });

  it("prunes nothing when the floor is zero", async () => {
    await recordBlock(db, block(1));
    await pruneBlocksBelow(db, 0n);
    expect(await recentBlocks(db, 100n, 0n)).toHaveLength(1);
  });

  it("records a log once, however many times it is replayed", async () => {
    await recordEvent(db, 5n, "0xtx", 3, "Bought");
    await recordEvent(db, 5n, "0xtx", 3, "Bought");
    const { rows } = await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM indexed_events");
    expect(rows[0]!.n).toBe(1);
  });
});

/**
 * The continuity check.
 *
 * Two heights whose hashes each still match the chain can still have a reorg between them. The
 * parent link is the only thing that catches that, and it is the reason the ledger stores a parent
 * hash at all rather than just a hash.
 */
describe("chainsTo", () => {
  it("joins when the later block's parent is the earlier block", () => {
    expect(chainsTo(block(11, "0xb", "0xa"), block(10, "0xa", "0x9"))).toBe(true);
  });

  it("does not join when the parent link is broken", () => {
    expect(chainsTo(block(11, "0xb", "0xDIFFERENT"), block(10, "0xa", "0x9"))).toBe(false);
  });

  /**
   * Non-adjacent heights have blocks between them that were never recorded, so there is no link to
   * check. Reporting those as broken would make every gap look like a reorg.
   */
  it("says nothing about heights that are not adjacent", () => {
    expect(chainsTo(block(20, "0xb", "0xunrelated"), block(10, "0xa", "0x9"))).toBe(true);
  });
});
