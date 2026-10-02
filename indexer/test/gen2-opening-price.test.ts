import { describe, expect, it } from "vitest";

import { factory2Abi } from "../src/indexer/abi.js";
import { GEN2_BASE_VIRTUAL_CEILING, gen2OpeningPrice } from "../src/indexer/generations.js";
import { applyLog } from "../src/indexer/ingestion/ingest.js";
import { ALICE, cfg2, CREATOR, CURVE, FACTORY2, fakeLog, TOKEN, TS, USDC } from "./gen2-logs.js";
import { memoryDb } from "./helpers.js";

/**
 * The price a generation-2 market has before anybody trades it.
 *
 * A curve opens at `(BASE_VIRTUAL_CEILING, quoteTarget * 2 / 5)` — see `BondingCurve.initialize` —
 * so a market with no trades still has a defined price and a defined market cap. Recording zero
 * instead does not read as "not traded yet": the board prints a $0.00 market cap, which reads as
 * worthless, and every market launched without a first buy looked like that. Only markets quoted
 * in an asset the launcher does not hold, which on a pairs launchpad is most of them.
 */
describe("gen2OpeningPrice", () => {
  /** MON's live target: ~$8,000 at launch, and divisible by five as the registry demands. */
  const MON_TARGET = 305868390948742537150460n;

  it("is the opening reserve ratio at generation 2's 1e36 scale", () => {
    const quoteFloor = (MON_TARGET * 2n) / 5n;
    expect(gen2OpeningPrice(MON_TARGET)).toBe(
      (quoteFloor * 10n ** 36n) / GEN2_BASE_VIRTUAL_CEILING,
    );
  });

  it("lands just under the price the live MONKE market recorded on its first buy", () => {
    // Measured on Monad mainnet: MONKE's price after a 4 MON first buy. The opening price must sit
    // below it and within a percent, which is what a 4 MON buy into an 8,000 MON target moves.
    const afterFirstBuy = 112367142068445986524612998055180n;
    const open = gen2OpeningPrice(MON_TARGET);
    expect(open).toBeLessThan(afterFirstBuy);
    expect(Number((afterFirstBuy - open) * 10000n / open)).toBeLessThan(100);
  });

  it("does not truncate to zero on a six-decimal quote as coarse as gold", () => {
    // XAUt0's live target: 1.80959 troy ounces, at six decimals.
    expect(gen2OpeningPrice(1809590n)).toBeGreaterThan(0n);
  });

  it("is zero only for a zero target, which the registry refuses", () => {
    expect(gen2OpeningPrice(0n)).toBe(0n);
  });

  it("scales linearly with the target, because the base reserve is a constant", () => {
    expect(gen2OpeningPrice(8000000000n) * 2n).toBe(gen2OpeningPrice(16000000000n));
  });
});

describe("a generation-2 launch records the opening price", () => {
  it("gives an untraded market a price the board can turn into a market cap", async () => {
    const db = await memoryDb();
    await db.query(
      `INSERT INTO quote_assets (id, address, symbol, decimals, registered, enabled)
       VALUES ('usdc', $1, 'USDC', 6, TRUE, TRUE)`,
      [USDC],
    );
    const target = 8_000_000_000n;
    const { log, decoded } = fakeLog({
      abi: factory2Abi,
      eventName: "MarketLaunched",
      address: FACTORY2,
      args: {
        curve: CURVE,
        token: TOKEN,
        creator: CREATOR,
        quoteAsset: USDC,
        quoteTarget: target,
        sink: 0,
        routedRecipient: "0x0000000000000000000000000000000000000000",
        creatorTaxBps: 0,
        taxRecipient: ALICE,
      },
    });
    await applyLog(db, log, decoded, TS, cfg2, () => {});

    const { rows } = await db.query<{ last_price: string }>(
      "SELECT last_price::text AS last_price FROM market_state WHERE market_address = $1",
      [CURVE],
    );
    expect(rows).toHaveLength(1);
    expect(BigInt(rows[0]!.last_price)).toBe(gen2OpeningPrice(target));
    expect(BigInt(rows[0]!.last_price)).toBeGreaterThan(0n);
  });
});
