import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/legacy.js";
import {
  burnSinkAbi,
  curve2Abi,
  factory2Abi,
  graduation2Abi,
  hook2Abi,
  rewardVaultAbi,
} from "../src/indexer/abi.js";
import { applyLog, orderForApply } from "../src/indexer/ingestion/ingest.js";
import { poolIdOf, poolKeyFor } from "../src/indexer/processing/pool-key.js";
import { memoryDb, ZERO } from "./helpers.js";
import {
  ALICE,
  cfg2,
  CREATOR,
  CURVE,
  FACTORY2,
  fakeLog,
  GRADUATION2,
  HOOK2,
  TOKEN,
  TS,
  USDC,
} from "./gen2-logs.js";

const VAULT = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";

describe("per-market sinks", () => {
  let db: Db;
  const id = poolIdOf(poolKeyFor(USDC, TOKEN, HOOK2));
  const rewards = async () =>
    (
      await db.query<Record<string, string>>(
        "SELECT dividends_funded::text AS f, dividends_paid::text AS p, burned_tokens::text AS b FROM market_rewards WHERE market_address = $1",
        [CURVE],
      )
    ).rows[0]!;

  beforeEach(async () => {
    db = await memoryDb();
    for (const { log, decoded } of [
      fakeLog({
        abi: factory2Abi,
        eventName: "MarketLaunched",
        address: FACTORY2,
        args: {
          curve: CURVE,
          token: TOKEN,
          creator: CREATOR,
          quoteAsset: USDC,
          quoteTarget: 1n,
          sink: 1,
          routedRecipient: ZERO,
          creatorTaxBps: 0,
          taxRecipient: ALICE,
        },
      }),
      fakeLog({
        abi: graduation2Abi,
        eventName: "Graduated",
        address: GRADUATION2,
        args: {
          curve: CURVE,
          id,
          token: TOKEN,
          quoteAsset: USDC,
          quoteAmount: 1n,
          baseAmount: 1n,
          tokenId: 1n,
        },
      }),
      fakeLog({
        abi: hook2Abi,
        eventName: "PoolRegistered",
        address: HOOK2,
        args: {
          id,
          token: TOKEN,
          sink: 1,
          sinkAddr: VAULT,
          protocolBps: 30,
          lpBps: 70,
          creatorTaxBps: 0,
        },
      }),
    ])
      await applyLog(db, log, decoded, TS, cfg2, () => {});
  });

  it("Funded and Claimed on the vault become dividends funded and paid", async () => {
    const f = fakeLog({
      abi: rewardVaultAbi,
      eventName: "Funded",
      address: VAULT,
      args: { amount: 1_000n },
    });
    await applyLog(db, f.log, f.decoded, TS, cfg2, () => {});
    const c = fakeLog({
      abi: rewardVaultAbi,
      eventName: "Claimed",
      address: VAULT,
      args: { holder: ALICE, epoch: 1n, amount: 400n },
    });
    await applyLog(db, c.log, c.decoded, TS, cfg2, () => {});
    expect(await rewards()).toEqual({ f: "1000", p: "400", b: "0" });
    const { rows } = await db.query<{ recipient: string | null; venue: string }>(
      "SELECT recipient, venue FROM fee_events WHERE kind = 'dividend'",
    );
    expect(rows[0]).toEqual({ recipient: ALICE, venue: "sink" });
  });

  it("Burned on a burn sink counts tokens burned", async () => {
    const b = fakeLog({
      abi: burnSinkAbi,
      eventName: "Burned",
      address: VAULT,
      args: { amount: 5n * 10n ** 18n, newTotalSupply: 1n },
    });
    await applyLog(db, b.log, b.decoded, TS, cfg2, () => {});
    expect((await rewards()).b).toBe((5n * 10n ** 18n).toString());
  });

  it("ignores sink events from an address no graduation points at", async () => {
    const f = fakeLog({
      abi: rewardVaultAbi,
      eventName: "Funded",
      address: "0x9999999999999999999999999999999999999999",
      args: { amount: 1n },
    });
    await applyLog(db, f.log, f.decoded, TS, cfg2, () => {});
    expect((await rewards()).f).toBe("0");
  });

  /**
   * A dividends market's `FeesCollected` names the REWARD VAULT, not a person.
   *
   * `BondingCurve.collectFees` emits `FeesCollected(feeRecipient(), amount)` on the non-CREATOR
   * branch, and `feeRecipient()` is the market's own sink there. Task 6 wrote a `creator_ledger`
   * row for it -- unclaimable, but still counting the vault as an earner -- while this task books
   * the same quote again as `dividend_funded`. One amount, two aggregates, two meanings.
   *
   * Gated on `routing`, which is on the market from its launch event, rather than on the sink
   * address, which does not arrive until the deferred `PoolRegistered`. The two conditions are
   * equivalent by construction (`feeRecipient()` consults the sink exactly when routing is not
   * CREATOR) and only one of them is knowable when the collection is applied.
   */
  it("does not book a dividends market's collection as creator income", async () => {
    const c = fakeLog({
      abi: curve2Abi,
      eventName: "FeesCollected",
      address: CURVE,
      args: { recipient: VAULT, amount: 900n },
    });
    await applyLog(db, c.log, c.decoded, TS, cfg2, () => {});

    expect((await db.query("SELECT 1 FROM creator_ledger")).rows).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM creator_balances")).rows).toHaveLength(0);
    // The market's own pending figure still falls: the money did leave the curve.
    const { rows } = await db.query<{ c: string }>(
      "SELECT routed_collected::text AS c FROM market_rewards WHERE market_address = $1",
      [CURVE],
    );
    expect(rows[0]!.c).toBe("900");
  });

  /**
   * The sink address arrives on a DEFERRED log, and a range holds more than one transaction.
   *
   * `PoolRegistered` is applied after its own transaction's other logs because `graduate()`
   * initialises the pool before it announces. Deferring it to the end of the whole RANGE instead
   * puts it after a later transaction's `Funded` too -- and that `Funded` finds no
   * `graduations.sink`, returns silently, and the market's dividends are permanently short by
   * whatever the vault was paid in that range. A backfill covers a hundred blocks at a time, so
   * this is the common case there rather than a corner.
   */
  it("applies a later transaction's vault event after the graduation that named the vault", async () => {
    const fresh = await memoryDb();
    const launch = fakeLog({
      abi: factory2Abi,
      eventName: "MarketLaunched",
      address: FACTORY2,
      block: 10,
      tx: "0xlaunch",
      logIndex: 0,
      args: {
        curve: CURVE,
        token: TOKEN,
        creator: CREATOR,
        quoteAsset: USDC,
        quoteTarget: 1n,
        sink: 1,
        routedRecipient: ZERO,
        creatorTaxBps: 0,
        taxRecipient: ALICE,
      },
    });
    await applyLog(fresh, launch.log, launch.decoded, TS, cfg2, () => {});

    // One graduation transaction, in the order the chain emits it: the hook registers the pool
    // inside `graduate()`, before the `Graduated` that creates the row it patches.
    const registered = fakeLog({
      abi: hook2Abi,
      eventName: "PoolRegistered",
      address: HOOK2,
      block: 20,
      tx: "0xgraduate",
      logIndex: 0,
      args: {
        id,
        token: TOKEN,
        sink: 1,
        sinkAddr: VAULT,
        protocolBps: 30,
        lpBps: 70,
        creatorTaxBps: 0,
      },
    });
    const graduated = fakeLog({
      abi: graduation2Abi,
      eventName: "Graduated",
      address: GRADUATION2,
      block: 20,
      tx: "0xgraduate",
      logIndex: 1,
      args: {
        curve: CURVE,
        id,
        token: TOKEN,
        quoteAsset: USDC,
        quoteAmount: 1n,
        baseAmount: 1n,
        tokenId: 1n,
      },
    });
    // A later transaction, in the same range.
    const funded = fakeLog({
      abi: rewardVaultAbi,
      eventName: "Funded",
      address: VAULT,
      block: 25,
      tx: "0xfund",
      logIndex: 0,
      args: { amount: 4_242n },
    });

    for (const entry of orderForApply([registered, graduated, funded]))
      await applyLog(fresh, entry.log, entry.decoded, TS, cfg2, () => {});

    const { rows } = await fresh.query<{ f: string }>(
      "SELECT dividends_funded::text AS f FROM market_rewards WHERE market_address = $1",
      [CURVE],
    );
    expect(rows[0]!.f).toBe("4242");
  });
});
