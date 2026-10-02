import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/legacy.js";
import { curveAbi } from "../src/indexer/abi.js";
import { applyLog } from "../src/indexer/ingestion/ingest.js";
import { memoryDb, seedMarket } from "./helpers.js";
import { ALICE, cfg2, CURVE, fakeLog, TOKEN, TS } from "./gen2-logs.js";

/**
 * A stranger's contract whose `Sold` shares the legacy signature. The protocol-event query has no
 * address filter, so this log reaches `applyLog` exactly as a DOKU curve's would.
 *
 * On 2026-09-21 a clone of an unrelated launchpad (`0x3658…e371`, factory `0xC584…0C77`) emitted
 * `Sold(address,uint256,uint256,uint256,uint256)` at block 106,851,757. The legacy handler inserted
 * it as a swap, `swaps.market_address` is a foreign key, the pass failed, and every retry failed
 * the same way: the cursor never moved again and the site froze for nineteen hours.
 */
const STRANGER = "0x3658f2c0f89b7ae5440837fe73fcb5479f55e371";

describe("a foreign contract emitting the legacy Bought/Sold signature", () => {
  let db: Db;

  beforeEach(async () => {
    db = await memoryDb();
    await seedMarket(db, CURVE, TOKEN);
  });

  const count = async (): Promise<number> => {
    const { rows } = await db.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM swaps");
    return Number(rows[0]!.n);
  };

  it("is ignored rather than failing the pass", async () => {
    const sold = fakeLog({
      abi: curveAbi,
      eventName: "Sold",
      address: STRANGER,
      block: 106_851_757,
      args: { seller: ALICE, baseIn: 5n * 10n ** 18n, quoteOut: 10n ** 18n, fee: 10n ** 16n, quoteRaised: 0n },
    });
    await expect(applyLog(db, sold.log, sold.decoded, TS, cfg2, () => {})).resolves.toBeUndefined();
    expect(await count()).toBe(0);

    const bought = fakeLog({
      abi: curveAbi,
      eventName: "Bought",
      address: STRANGER,
      block: 106_851_758,
      args: { buyer: ALICE, quoteIn: 10n ** 18n, baseOut: 5n * 10n ** 18n, fee: 10n ** 16n, tax: 0n, quoteRaised: 10n ** 18n },
    });
    await expect(applyLog(db, bought.log, bought.decoded, TS, cfg2, () => {})).resolves.toBeUndefined();
    expect(await count()).toBe(0);
  });

  it("still records the same signature from a market on record", async () => {
    const sold = fakeLog({
      abi: curveAbi,
      eventName: "Sold",
      address: CURVE,
      block: 106_851_757,
      args: { seller: ALICE, baseIn: 5n * 10n ** 18n, quoteOut: 10n ** 18n, fee: 10n ** 16n, quoteRaised: 0n },
    });
    await applyLog(db, sold.log, sold.decoded, TS, cfg2, () => {});
    expect(await count()).toBe(1);
  });
});
