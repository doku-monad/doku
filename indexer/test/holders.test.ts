import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/legacy.js";
import { applyTransfer, recountHolders } from "../src/indexer/processing/holders.js";
import { memoryDb, seedMarket, ZERO } from "./helpers.js";

const MARKET = "0xcurve";
const TOKEN = "0xtoken";
const ALICE = "0xa11ce";
const BOB = "0xb0b";

describe("holder counting", () => {
  let db: Db;
  beforeEach(async () => {
    db = await memoryDb();
    await seedMarket(db, MARKET, TOKEN);
  });

  it("counts an address that receives tokens", async () => {
    await applyTransfer(db, TOKEN, ZERO, ALICE, 100n);
    expect(await recountHolders(db, MARKET)).toBe(1);
  });

  /// Someone who sold everything is not a holder. Counting zero balances is the most common way
  /// this number ends up permanently inflated.
  it("stops counting an address once its balance reaches zero", async () => {
    await applyTransfer(db, TOKEN, ZERO, ALICE, 100n);
    await applyTransfer(db, TOKEN, ALICE, BOB, 100n);
    expect(await recountHolders(db, MARKET)).toBe(1);
  });

  /// The curve holds most of the supply before graduation, and the pool holds it after. Neither is
  /// a person; counting them would put a floor of two on every market.
  it("excludes the curve itself", async () => {
    await applyTransfer(db, TOKEN, ZERO, MARKET, 45_000_000n);
    expect(await recountHolders(db, MARKET)).toBe(0);
  });

  it("excludes the graduated pool", async () => {
    await db.query(
      `INSERT INTO graduations (market_address, pool_address, token_id, quote_amount,
                                base_amount, liquidity, block_number, block_hash, log_index,
                                tx_hash, ts)
       VALUES ($1, '0xpool', 0, 0, 0, 0, 1, '0xbb', 0, '0xtx2', NOW())`,
      [MARKET],
    );
    await applyTransfer(db, TOKEN, ZERO, "0xpool", 10_000_000n);
    await applyTransfer(db, TOKEN, ZERO, ALICE, 5n);
    expect(await recountHolders(db, MARKET)).toBe(1);
  });

  it("handles many holders and partial sells", async () => {
    for (let i = 0; i < 25; i++) {
      await applyTransfer(db, TOKEN, ZERO, `0xh${i}`, 1_000n);
    }
    expect(await recountHolders(db, MARKET)).toBe(25);

    for (let i = 0; i < 10; i++) {
      await applyTransfer(db, TOKEN, `0xh${i}`, BOB, 1_000n);
    }
    // Ten emptied out, Bob joined.
    expect(await recountHolders(db, MARKET)).toBe(16);
  });

  /// Balances must survive amounts a float64 could not hold exactly.
  it("keeps full precision on an 18-decimal balance", async () => {
    const huge = 45_000_000n * 10n ** 18n;
    await applyTransfer(db, TOKEN, ZERO, ALICE, huge);
    const { rows } = await db.query<{ balance: string }>(
      "SELECT balance FROM token_balances WHERE holder = $1",
      [ALICE],
    );
    expect(rows[0]!.balance).toBe(huge.toString());
  });

  it("writes the count onto market_state", async () => {
    await applyTransfer(db, TOKEN, ZERO, ALICE, 1n);
    await recountHolders(db, MARKET);
    const { rows } = await db.query<{ holders: number }>(
      "SELECT holders FROM market_state WHERE market_address = $1",
      [MARKET],
    );
    expect(rows[0]!.holders).toBe(1);
  });

  /**
   * ## Parity with `RewardVault`'s on-chain exclusion set
   *
   * The two lists decide different things and have to agree anyway. On-chain, an address left in
   * `eligibleSupply` that cannot claim dilutes everyone who can, and the difference is stranded
   * forever. Here, it inflates the number on a market card. A header claiming 500 holders while
   * the vault pays 497 is reporting something that means nothing.
   *
   * Written as ADDRESSES rather than as a join, deliberately. `pool_address` is the PoolManager
   * under v4 and is therefore the same value on every market, so a join-shaped test can pass while
   * both sides are wrong in the same way. `contracts/test/v4/GraduationV4.t.sol`'s
   * `test_exclusionSetMatchesTheIndexer` names the same eight members; these two tests are each
   * other's fixture.
   *
   * `PositionManager` is in the on-chain set and absent here on purpose: under v4 it settles
   * straight through to the singleton and never holds a token, so there is nothing to exclude. The
   * vault fills its own slot on-chain and arrives here as `sink`.
   */
  describe("the exclusion set, in parity with RewardVault", () => {
    const POOL_MANAGER = "0xpoolmanager";
    const HOOK = "0xhook";
    const SINK = "0xsink";
    const GRADUATION = "0xgraduation";
    const DEAD = "0x000000000000000000000000000000000000dead";

    beforeEach(async () => {
      await db.query(
        `INSERT INTO graduations (market_address, pool_address, pool_id, currency0, currency1,
                                  fee, tick_spacing, hooks, sink, sink_kind, token_id,
                                  quote_amount, base_amount, liquidity, block_number, block_hash,
                                  log_index, tx_hash, ts)
         VALUES ($1,$2,'0xpid','',$3,0,60,$4,$5,1,0,0,0,0,1,'0xbb',0,'0xtx-grad',NOW())`,
        [MARKET, POOL_MANAGER, TOKEN, HOOK, SINK],
      );
    });

    /// Each one gets a real balance, and none of them may be counted. Table-driven so adding a
    /// member to `RewardVault`'s array and forgetting this list fails here rather than in
    /// production, where it presents only as a holder count that is quietly one too high.
    it.each([
      ["the curve", MARKET],
      ["the token itself", TOKEN],
      ["the PoolManager", POOL_MANAGER],
      ["the hook", HOOK],
      ["the sink", SINK],
      ["the graduation contract", GRADUATION],
      ["the dead address", DEAD],
    ])("does not count %s", async (_label, address) => {
      await applyTransfer(db, TOKEN, ZERO, address, 1_000_000n);
      await applyTransfer(db, TOKEN, ZERO, ALICE, 5n);
      expect(await recountHolders(db, MARKET, GRADUATION)).toBe(1);
    });

    /// All of them at once, which is the state a live graduated market is actually in.
    it("counts only real holders when every excluded address holds a balance", async () => {
      for (const a of [MARKET, TOKEN, POOL_MANAGER, HOOK, SINK, GRADUATION, DEAD]) {
        await applyTransfer(db, TOKEN, ZERO, a, 1_000_000n);
      }
      await applyTransfer(db, TOKEN, ZERO, ALICE, 5n);
      await applyTransfer(db, TOKEN, ZERO, BOB, 5n);
      expect(await recountHolders(db, MARKET, GRADUATION)).toBe(2);
    });

    /// The graduation address comes from chain config rather than a table, so a caller that omits
    /// it must not silently exclude something else — `COALESCE($3,'')` has to match no real holder.
    it("excludes nothing extra when no graduation address is supplied", async () => {
      await applyTransfer(db, TOKEN, ZERO, ALICE, 5n);
      await applyTransfer(db, TOKEN, ZERO, GRADUATION, 5n);
      expect(await recountHolders(db, MARKET)).toBe(2);
      expect(await recountHolders(db, MARKET, GRADUATION)).toBe(1);
    });
  });
});
