import { describe, expect, it } from "vitest";

import { createDatabase } from "../src/db/index.js";
import { toBigInt, toNumeric } from "../src/db/numeric.js";
import { withTransaction } from "../src/db/transaction.js";

/**
 * The managed database.
 *
 * These run against the in-process engine, which is the real Postgres compiled to wasm rather than
 * a mock — so `NUMERIC(78,0)`, `ON CONFLICT` and rollback behave here exactly as they do in a
 * deployment.
 */
describe("managed database", () => {
  const fresh = async () => {
    const database = createDatabase();
    await database.connect();
    return database;
  };

  it("applies the schema on connect", async () => {
    const database = await fresh();
    // The status row the schema seeds is the cheapest proof the whole file ran.
    const status = await database.prisma.indexer_status.findUnique({ where: { id: 1 } });
    expect(status?.last_block).toBe(0n);
    await database.disconnect();
  });

  it("answers a ping while connected, and stops after disconnect", async () => {
    const database = await fresh();
    expect(await database.ping()).toBe(true);
    await database.disconnect();
    expect(await database.ping()).toBe(false);
  });

  it("survives a second disconnect", async () => {
    const database = await fresh();
    await database.disconnect();
    await expect(database.disconnect()).resolves.toBeUndefined();
  });

  /** Prisma and the legacy seam must be the same database, or a half-migrated service is incoherent. */
  it("shows the same data through Prisma and the legacy seam", async () => {
    const database = await fresh();
    await database.prisma.markets.create({
      data: {
        market_address: "0xmarket",
        token_address: "0xtoken",
        symbol: "🐎",
        name: "horse",
        symbol_key: "horse",
        creator: "0xcreator",
        quote_target: toNumeric(1_000_000_000_000_000_000n),
        total_supply: toNumeric(0n),
        block_number: 10n,
        block_hash: "0xblock",
        log_index: 0,
        tx_hash: "0xtx",
        created_at: new Date(),
      },
    });

    const { rows } = await database.legacy.query<{ market_address: string; quote_target: string }>(
      "SELECT market_address, quote_target FROM markets",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.market_address).toBe("0xmarket");
    expect(rows[0]!.quote_target).toBe("1000000000000000000");
    await database.disconnect();
  });

  it("keeps a large amount exact through Prisma", async () => {
    const database = await fresh();
    const supply = 999_999_999_999_999_999_999_999_999_999n;
    await database.prisma.markets.create({
      data: {
        market_address: "0xbig",
        token_address: "0xtoken",
        symbol: "🐘",
        name: "elephant",
        symbol_key: "elephant",
        creator: "0xcreator",
        quote_target: toNumeric(supply),
        total_supply: toNumeric(supply),
        block_number: 1n,
        block_hash: "0xblock",
        log_index: 0,
        tx_hash: "0xtxbig",
        created_at: new Date(),
      },
    });
    const row = await database.prisma.markets.findUniqueOrThrow({
      where: { market_address: "0xbig" },
    });
    expect(toBigInt(row.total_supply)).toBe(supply);
    await database.disconnect();
  });
});

describe("withTransaction", () => {
  const fresh = async () => {
    const database = createDatabase();
    await database.connect();
    return database;
  };

  const market = (address: string, key: string, tx: string) => ({
    market_address: address,
    token_address: "0xtoken",
    symbol: "🐎",
    name: "horse",
    symbol_key: key,
    creator: "0xcreator",
    quote_target: toNumeric(1n),
    total_supply: toNumeric(0n),
    block_number: 1n,
    block_hash: "0xblock",
    log_index: 0,
    tx_hash: tx,
    created_at: new Date(),
  });

  it("commits everything the callback wrote", async () => {
    const database = await fresh();
    await withTransaction(database.prisma, async (tx) => {
      await tx.markets.create({ data: market("0xa", "a", "0xta") });
      await tx.markets.create({ data: market("0xb", "b", "0xtb") });
    });
    expect(await database.prisma.markets.count()).toBe(2);
    await database.disconnect();
  });

  /**
   * The property the whole phase exists for: a failure part-way through leaves *nothing* behind.
   * Before this, events and derived state were written as independent statements, so a crash
   * between them left a volume figure permanently disagreeing with the trades it came from.
   */
  it("rolls back everything when the callback throws", async () => {
    const database = await fresh();
    await expect(
      withTransaction(database.prisma, async (tx) => {
        await tx.markets.create({ data: market("0xa", "a", "0xta") });
        throw new Error("halfway");
      }),
    ).rejects.toThrow("halfway");

    expect(await database.prisma.markets.count()).toBe(0);
    await database.disconnect();
  });

  it("rolls back when the database rejects the second write", async () => {
    const database = await fresh();
    await expect(
      withTransaction(database.prisma, async (tx) => {
        await tx.markets.create({ data: market("0xa", "a", "0xta") });
        // Same symbol_key: violates the unique constraint.
        await tx.markets.create({ data: market("0xb", "a", "0xtb") });
      }),
    ).rejects.toThrow();

    expect(await database.prisma.markets.count()).toBe(0);
    await database.disconnect();
  });
});
