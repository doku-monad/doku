import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/legacy.js";
import { applySupplyDelta, applyTransfer } from "../src/indexer/processing/holders.js";
import { memoryDb, seedMarket, ZERO } from "./helpers.js";

const MARKET = "0xcurve";
const TOKEN = "0xtoken";
const ALICE = "0xa11ce";

async function supply(db: Db): Promise<bigint> {
  const { rows } = await db.query<{ total_supply: string }>(
    "SELECT total_supply FROM markets WHERE market_address = $1",
    [MARKET],
  );
  return BigInt(rows[0]!.total_supply);
}

/**
 * Supply moves both ways, and until this branch existed it only moved one.
 *
 * Burns are not an edge case on this protocol: every market's tax buys its own token back and
 * burns it, from the first taxed buy, while the curve is still open. A supply column that only
 * counts mints therefore diverges from the chain on essentially every market, monotonically, and
 * nothing ever re-reads the chain to correct it.
 */
describe("total supply follows burns as well as mints", () => {
  let db: Db;
  beforeEach(async () => {
    db = await memoryDb();
    await seedMarket(db, MARKET, TOKEN);
  });

  it("adds on a mint", async () => {
    await applySupplyDelta(db, MARKET, ZERO, MARKET, 45_000_000n);
    expect(await supply(db)).toBe(45_000_000n);
  });

  it("subtracts on a burn", async () => {
    await applySupplyDelta(db, MARKET, ZERO, MARKET, 45_000_000n);
    await applySupplyDelta(db, MARKET, MARKET, ZERO, 5_000_000n);
    expect(await supply(db)).toBe(40_000_000n);
  });

  it("round-trips a mint and a burn of the same size back to zero", async () => {
    await applySupplyDelta(db, MARKET, ZERO, ALICE, 1_000n);
    await applySupplyDelta(db, MARKET, ALICE, ZERO, 1_000n);
    expect(await supply(db)).toBe(0n);
  });

  /// An ordinary transfer is neither, and counting it either way would make supply track volume.
  it("ignores a transfer between two holders", async () => {
    await applySupplyDelta(db, MARKET, ZERO, ALICE, 1_000n);
    await applySupplyDelta(db, MARKET, ALICE, "0xb0b", 400n);
    expect(await supply(db)).toBe(1_000n);
  });

  /// The balance side was already correct — neither zero address is a holder — so the two halves
  /// of one Transfer log must agree: supply falls, and nobody is credited with the burned tokens.
  it("agrees with the balance side on a burn", async () => {
    await applySupplyDelta(db, MARKET, ZERO, ALICE, 1_000n);
    await applyTransfer(db, TOKEN, ZERO, ALICE, 1_000n);

    await applySupplyDelta(db, MARKET, ALICE, ZERO, 250n);
    await applyTransfer(db, TOKEN, ALICE, ZERO, 250n);

    expect(await supply(db)).toBe(750n);
    const { rows } = await db.query<{ balance: string }>(
      "SELECT balance FROM token_balances WHERE token_address = $1 AND holder = $2",
      [TOKEN, ZERO],
    );
    expect(rows.length).toBe(0);
  });
});
