import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import type { Database } from "../src/db/index.js";
import type { Db } from "../src/db/legacy.js";
import { ingestOnce, MAX_REORG_DEPTH } from "../src/indexer/ingestion/ingest.js";
import { memoryDatabase, seedMarket, transactional } from "./helpers.js";

/**
 * AUDIT: an RPC error is read as proof the chain rolled back, and the rewind that follows is never
 * re-ingested.
 *
 * `ingest.ts`'s `hashAt` swallows EVERY failure from `getBlock` and returns null:
 *
 *     async function hashAt(client, height) {
 *       try { return (await client.getBlock({ blockNumber: height })).hash; } catch { return null; }
 *     }
 *
 * The comment above it says a rolled-back node "reports it by throwing" — true, and so does a
 * rate-limited one, a timed-out one, and one behind a load balancer that dropped the connection.
 * `resolveStart` cannot tell those apart, so a transient error at the checkpoint height is treated
 * as a reorg, the walk-back's own `hashAt` calls fail for the same reason, and the fallback fires:
 * `rewindTo(db, lastBlock - MAX_REORG_DEPTH)`.
 *
 * That would merely be wasteful if the rewind also moved the checkpoint. It does not — `rewindTo`
 * writes no `indexer_status` — so once the node answers again, `hashAt(lastBlock)` matches the hash
 * that was stored all along and the pass resumes at `lastBlock + 1`. Every row the rewind deleted
 * below that point is gone for good: trades, graduations, transfers, fee events, and any market
 * launched in the window.
 */

const HEAD = 1_310n;
const CHECKPOINT = 1_200n;
const MARKET = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";

interface Stub {
  client: PublicClient;
  /** Every `fromBlock` the ingester asked the node for logs from. */
  logRanges: { from: bigint; to: bigint }[];
}

/**
 * A node that answers `eth_blockNumber` and refuses everything else, which is what a rate limit
 * looks like: the cheap cached call succeeds and the per-block reads do not.
 */
function rateLimited(): Stub {
  const logRanges: { from: bigint; to: bigint }[] = [];
  const client = {
    getBlockNumber: async () => HEAD,
    getBlock: async () => {
      throw new Error("429 Too Many Requests");
    },
    getLogs: async () => {
      throw new Error("429 Too Many Requests");
    },
    getTransaction: async () => {
      throw new Error("429 Too Many Requests");
    },
  } as unknown as PublicClient;
  return { client, logRanges };
}

/** The same node, healthy. The chain never reorganised: block 1200 still hashes to `0xh1200`. */
function healthy(): Stub {
  const logRanges: { from: bigint; to: bigint }[] = [];
  const client = {
    getBlockNumber: async () => HEAD,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
      hash: `0xh${blockNumber}`,
      parentHash: `0xh${blockNumber - 1n}`,
      timestamp: 1_760_000_000n + blockNumber,
    }),
    getLogs: async (q: { fromBlock: bigint; toBlock: bigint }) => {
      logRanges.push({ from: q.fromBlock, to: q.toBlock });
      return [];
    },
    getTransaction: async () => ({ from: MARKET }),
  } as unknown as PublicClient;
  return { client, logRanges };
}

async function seed(db: Db): Promise<void> {
  // A market launched well below the rewind floor, so it survives and the token filter still works.
  await seedMarket(db, MARKET, TOKEN, 1_000);
  const swap = async (block: number) => {
    await db.query(
      `INSERT INTO swaps (market_address, trader, is_buy, venue, quote_amount, base_amount, fee,
                          tax, quote_raised, price, block_number, block_hash, log_index, tx_hash, ts)
       VALUES ($1,$2,TRUE,'curve',1000,1,10,0,1000,1,$3,$4,0,$5,NOW())`,
      [MARKET, TOKEN, block, `0xh${block}`, `0xswap${block}`],
    );
  };
  // One below the floor, two above it.
  await swap(1_050);
  await swap(1_100);
  await swap(1_150);

  // The block ledger the reorg walk searches, correctly chained.
  for (let n = 1_100n; n <= CHECKPOINT; n++) {
    await db.query(
      "INSERT INTO indexed_blocks (block_number, block_hash, parent_hash) VALUES ($1,$2,$3)",
      [n.toString(), `0xh${n}`, `0xh${n - 1n}`],
    );
  }
  await db.query(
    "UPDATE indexer_status SET last_block = $1, last_block_hash = $2, chain_head = $1 WHERE id = 1",
    [CHECKPOINT.toString(), `0xh${CHECKPOINT}`],
  );
}

const swapBlocks = async (db: Db): Promise<number[]> => {
  const { rows } = await db.query<{ b: string }>(
    "SELECT block_number::text AS b FROM swaps ORDER BY block_number",
  );
  return rows.map((r) => Number(r.b));
};

describe("AUDIT: a rate-limited node rewinds the indexer and the hole is never refilled", () => {
  it("deletes MAX_REORG_DEPTH blocks of history and then resumes above them", async () => {
    const database: Database = await memoryDatabase();
    const db = database.legacy;
    await seed(db);
    expect(await swapBlocks(db)).toEqual([1_050, 1_100, 1_150]);

    const floor = CHECKPOINT - MAX_REORG_DEPTH; // 1072
    const cfg = {
      factory: "0x00000000000000000000000000000000000000f1" as `0x${string}`,
      graduation: "0x00000000000000000000000000000000000000e1" as `0x${string}`,
      startBlock: 1_000n,
      ...transactional(database),
    };

    // ---- Pass one: the node is rate limited. The pass fails, but not before the rewind commits.
    await expect(ingestOnce(rateLimited().client, db, cfg)).rejects.toThrow(/429/);

    // `rewindTo` ran outside the pass's transaction, so its deletes are already durable.
    expect(await swapBlocks(db)).toEqual([1_050]);
    // And the checkpoint was NOT moved back with them.
    const { rows: status } = await db.query<{ b: string }>(
      "SELECT last_block::text AS b FROM indexer_status WHERE id = 1",
    );
    expect(status[0]!.b).toBe(CHECKPOINT.toString());

    // ---- Pass two: the node recovers. The chain never reorganised.
    const ok = healthy();
    const result = await ingestOnce(ok.client, db, cfg);

    // The checkpoint still matched, so the pass resumed ABOVE the rewound window...
    expect(result.from).toBe(CHECKPOINT + 1n);
    // ...and no query was ever issued for the blocks the rewind emptied.
    for (const range of ok.logRanges) expect(range.from).toBeGreaterThan(CHECKPOINT);
    expect(ok.logRanges.some((r) => r.from <= floor)).toBe(false);

    // The two trades are gone permanently. Nothing in the service will ever look there again.
    expect(await swapBlocks(db)).toEqual([1_050]);
    await database.disconnect();
  }, 120_000);
});
