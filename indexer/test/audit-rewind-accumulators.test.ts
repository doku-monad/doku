import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/legacy.js";
import { erc20Abi, poolManagerAbi } from "../src/indexer/abi.js";
import { applyLog } from "../src/indexer/ingestion/ingest.js";
import { rewindTo } from "../src/indexer/sync/rewind.js";
import { memoryDb, seedMarket, ZERO } from "./helpers.js";
import { ALICE, cfg2, CURVE, fakeLog, POOL_MANAGER, TOKEN, TS } from "./gen2-logs.js";

/**
 * AUDIT: the two accumulators `rewindTo` does not touch.
 *
 * `sync/rewind.ts` is built on one rule — delete the event rows above the fork, then RECOMPUTE
 * every figure derived from them — and `test/gen2-rewind.test.ts` proves that rule holds for
 * swaps, fees, the creator ledger, metadata, recipients, candles and `market_state`.
 *
 * Two accumulators are missing from it, and both are driven by events the gen-2 rewind fixture
 * never replays, so its "reconstructs exactly the database that never saw the orphaned blocks"
 * assertion passes over them vacuously:
 *
 *   `markets.total_supply`  — `processing/holders.ts:32` `applySupplyDelta`, `+=` on a mint and
 *                             `-=` on a burn. Nothing recomputes it from `transfers`.
 *   `positions.liquidity`   — `ingestion/ingest.ts:1149`, `liquidity + EXCLUDED.liquidity`.
 *                             `rewindTo` issues no statement against `positions` at all.
 *
 * Both are money figures. `total_supply` is the multiplier in every market cap on the site
 * (`repositories/columns.ts:81`, `processing/stats.ts:41`); `positions.liquidity` is what the
 * pools page reports a provider owns.
 */

const POOL_ID = "0xaaaa0000000000000000000000000000000000000000000000000000000000aa";
const SUPPLY = 1_000_000_000n * 10n ** 18n;
const BURNED = 400_000_000n * 10n ** 18n;

const salt = (id: bigint): `0x${string}` =>
  `0x${id.toString(16).padStart(64, "0")}`;

const transfer = (block: number, tx: string, from: string, to: string, value: bigint) =>
  fakeLog({
    abi: erc20Abi,
    eventName: "Transfer",
    address: TOKEN,
    block,
    tx,
    logIndex: 0,
    args: { from, to, value },
  });

const modifyLiquidity = (block: number, tx: string, delta: bigint) =>
  fakeLog({
    abi: poolManagerAbi,
    eventName: "ModifyLiquidity",
    address: POOL_MANAGER,
    block,
    tx,
    logIndex: 0,
    args: {
      id: POOL_ID,
      sender: ALICE,
      tickLower: -600,
      tickUpper: 600,
      liquidityDelta: delta,
      salt: salt(7n),
    },
  });

async function apply(db: Db, entry: ReturnType<typeof fakeLog>): Promise<void> {
  await applyLog(db, entry.log, entry.decoded, TS, cfg2, () => {});
}

/** `markets.total_supply`, as the read layer reads it. */
async function totalSupply(db: Db): Promise<string> {
  const { rows } = await db.query<{ t: string }>(
    "SELECT total_supply::text AS t FROM markets WHERE market_address = $1",
    [CURVE],
  );
  return rows[0]!.t;
}

/** The sum of every live balance, which is what the supply figure has to agree with. */
async function heldByHolders(db: Db): Promise<string> {
  const { rows } = await db.query<{ t: string }>(
    "SELECT COALESCE(SUM(balance), 0)::text AS t FROM token_balances WHERE token_address = $1",
    [TOKEN],
  );
  return rows[0]!.t;
}

describe("AUDIT: markets.total_supply survives a rewind it should not", () => {
  let db: Db;

  beforeEach(async () => {
    db = await memoryDb();
    await seedMarket(db, CURVE, TOKEN, 100);
    // Block 105: the launch mint, BELOW the fork. Survives.
    await apply(db, transfer(105, "0xmint", ZERO, ALICE, SUPPLY));
    // Block 120: a tax burn, ABOVE the fork. Must not survive.
    await apply(db, transfer(120, "0xburn", ALICE, ZERO, BURNED));
  });

  it("keeps the orphaned burn in total_supply while dropping the transfer that justified it", async () => {
    expect(await totalSupply(db)).toBe((SUPPLY - BURNED).toString());

    await rewindTo(db, 115n);

    // The transfer row is gone and the balance side was rebuilt from what survived...
    expect((await db.query("SELECT 1 FROM transfers WHERE block_number >= 115")).rows).toHaveLength(0);
    expect(await heldByHolders(db)).toBe(SUPPLY.toString());

    // ...but the supply column still carries the orphaned burn. A database that never saw block
    // 120 would read 1e27 here.
    expect(await totalSupply(db)).toBe((SUPPLY - BURNED).toString());
    expect(await totalSupply(db)).not.toBe(SUPPLY.toString());
  });

  it("subtracts the same burn a second time when the range is replayed", async () => {
    await rewindTo(db, 115n);
    // The replay the rewind exists to enable. The transfer row was deleted, so the INSERT is new
    // and `applySupplyDelta` runs again.
    await apply(db, transfer(120, "0xburn", ALICE, ZERO, BURNED));

    expect(await totalSupply(db)).toBe((SUPPLY - 2n * BURNED).toString());
    // Every holder balance now adds up to MORE than the total supply, which cannot be true.
    expect(BigInt(await heldByHolders(db))).toBeGreaterThan(BigInt(await totalSupply(db)));
  });

  it("moves every market cap with it, by the same factor", async () => {
    // The expression `repositories/columns.ts:81` and `processing/stats.ts:41` both use.
    const cap = async (): Promise<bigint> => {
      const { rows } = await db.query<{ c: string }>(
        `SELECT ((s.last_price * m.total_supply) / 1e18)::numeric(78,0)::text AS c
           FROM markets m JOIN market_state s USING (market_address)
          WHERE m.market_address = $1`,
        [CURVE],
      );
      return BigInt(rows[0]!.c);
    };
    // A price of exactly 1e18 makes the cap equal the supply, so the assertions below read as the
    // supply figure itself. Re-applied after the rewind, which legitimately recomputes
    // `last_price` from the surviving swaps (there are none here).
    const price = async (): Promise<void> => {
      await db.query("UPDATE market_state SET last_price = $2 WHERE market_address = $1", [
        CURVE,
        (10n ** 18n).toString(),
      ]);
    };

    const truthful = SUPPLY; // what a database that never saw block 120 would report
    await rewindTo(db, 115n);
    await price();
    expect(await cap()).toBe(SUPPLY - BURNED);

    await apply(db, transfer(120, "0xburn", ALICE, ZERO, BURNED));
    const afterReplay = await cap();
    expect(afterReplay).toBe(SUPPLY - 2n * BURNED);
    // 20% of the real cap, reported as the real cap.
    expect(afterReplay).toBeLessThan(truthful / 4n);
  });
});

describe("AUDIT: positions.liquidity is never rewound", () => {
  let db: Db;

  beforeEach(async () => {
    db = await memoryDb();
    await seedMarket(db, CURVE, TOKEN, 100);
    await db.query(
      `INSERT INTO graduations (market_address, pool_address, pool_id, token_id, quote_amount,
                                base_amount, liquidity, block_number, block_hash, log_index,
                                tx_hash, ts)
       VALUES ($1,$2,$3,1,0,0,0,110,'0xblock110',0,'0xgraduate',NOW())`,
      [CURVE, POOL_MANAGER, POOL_ID],
    );
  });

  const liquidity = async (): Promise<string> => {
    const { rows } = await db.query<{ l: string }>(
      "SELECT liquidity::text AS l FROM positions WHERE token_id = 7",
    );
    return rows[0]?.l ?? "absent";
  };

  it("leaves the orphaned position standing at its full liquidity", async () => {
    await apply(db, modifyLiquidity(120, "0xmint", 1_000_000n));
    expect(await liquidity()).toBe("1000000");

    await rewindTo(db, 115n);

    // Every other event table dropped its rows above 115. `positions` has no statement in
    // `rewindTo` at all, so the row and its block number are untouched.
    const { rows } = await db.query<{ b: string }>(
      "SELECT block_number::text AS b FROM positions WHERE token_id = 7",
    );
    expect(rows[0]!.b).toBe("120");
    expect(await liquidity()).toBe("1000000");
  });

  it("doubles a provider's liquidity when the range is replayed", async () => {
    await apply(db, modifyLiquidity(120, "0xmint", 1_000_000n));
    await rewindTo(db, 115n);
    await apply(db, modifyLiquidity(120, "0xmint", 1_000_000n));

    // `ON CONFLICT (token_id) DO UPDATE SET liquidity = positions.liquidity + EXCLUDED.liquidity`,
    // with nothing to make the replay a no-op: the table carries no (tx_hash, log_index) unique
    // and `indexed_events` is never consulted before applying a log.
    expect(await liquidity()).toBe("2000000");
  });

  it("drives a closed position negative, so it reappears as live", async () => {
    await apply(db, modifyLiquidity(120, "0xmint", 1_000_000n));
    await apply(db, modifyLiquidity(121, "0xburn", -1_000_000n));
    expect(await liquidity()).toBe("0");

    // The withdrawal is orphaned and replayed; the mint below it is not re-applied because the
    // rewind fork sits between them.
    await rewindTo(db, 121n);
    await apply(db, modifyLiquidity(121, "0xburn", -1_000_000n));

    expect(await liquidity()).toBe("-1000000");
    // `listForAccount` filters on `liquidity > 0`, so the row is invisible rather than wrong --
    // but a subsequent deposit of 1,000,000 would net to zero and hide a real position.
    await apply(db, modifyLiquidity(130, "0xmint2", 1_000_000n));
    expect(await liquidity()).toBe("0");
  });
});
