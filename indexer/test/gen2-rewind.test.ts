import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/legacy.js";
import {
  creatorSinkAbi,
  curve2Abi,
  factory2Abi,
  graduation2Abi,
  hook2Abi,
  rewardVaultAbi,
} from "../src/indexer/abi.js";
import { applyLog } from "../src/indexer/ingestion/ingest.js";
import { poolIdOf, poolKeyFor } from "../src/indexer/processing/pool-key.js";
import { rewindTo } from "../src/indexer/sync/rewind.js";
import { memoryDb } from "./helpers.js";
import {
  ALICE,
  cfg2,
  CREATOR,
  CREATOR_SINK,
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
/** The address the CreatorSink events above the fork hand the market's income to. */
const BOB = "0x5050505050505050505050505050505050505050";
const POOL_ID = poolIdOf(poolKeyFor(USDC, TOKEN, HOOK2));

/** Every log this suite replays, in chain order, each tagged with the block it landed in. */
function history(): { block: number; log: ReturnType<typeof fakeLog> }[] {
  const at = (block: number, log: ReturnType<typeof fakeLog>) => ({ block, log });
  return [
    at(
      100,
      fakeLog({
        abi: factory2Abi,
        eventName: "MarketLaunched",
        address: FACTORY2,
        block: 100,
        tx: "0xlaunch",
        logIndex: 0,
        args: {
          curve: CURVE,
          token: TOKEN,
          creator: CREATOR,
          quoteAsset: USDC,
          quoteTarget: 1n,
          sink: 2,
          routedRecipient: CREATOR,
          creatorTaxBps: 100,
          taxRecipient: ALICE,
        },
      }),
    ),
    at(
      100,
      fakeLog({
        abi: factory2Abi,
        eventName: "MetadataSet",
        address: FACTORY2,
        block: 100,
        tx: "0xlaunch",
        logIndex: 1,
        args: {
          curve: CURVE,
          name: "First",
          ticker: "ONE",
          logoURI: "",
          bannerURI: "",
          description: "v1",
          website: "",
          x: "",
          telegram: "",
        },
      }),
    ),
    at(
      110,
      fakeLog({
        abi: curve2Abi,
        eventName: "Bought",
        address: CURVE,
        block: 110,
        tx: "0xbuy110",
        logIndex: 0,
        args: {
          buyer: ALICE,
          quoteIn: 1_000n,
          baseOut: 1n,
          fee: 10n,
          antiSniperTax: 0n,
          creatorTax: 10n,
          quoteRaised: 1_000n,
          price: 1n,
        },
      }),
    ),
    at(
      112,
      fakeLog({
        abi: curve2Abi,
        eventName: "FeesCollected",
        address: CURVE,
        block: 112,
        tx: "0xcollect112",
        logIndex: 0,
        args: { recipient: CREATOR, amount: 4n },
      }),
    ),
    // Above the fork from here down.
    at(
      120,
      fakeLog({
        abi: curve2Abi,
        eventName: "Bought",
        address: CURVE,
        block: 120,
        tx: "0xbuy120",
        logIndex: 0,
        args: {
          buyer: ALICE,
          quoteIn: 1_000n,
          baseOut: 1n,
          fee: 10n,
          antiSniperTax: 0n,
          creatorTax: 10n,
          quoteRaised: 2_000n,
          price: 2n,
        },
      }),
    ),
    at(
      120,
      fakeLog({
        abi: factory2Abi,
        eventName: "MetadataSet",
        address: FACTORY2,
        block: 120,
        tx: "0xmeta120",
        logIndex: 0,
        args: {
          curve: CURVE,
          name: "First",
          ticker: "ONE",
          logoURI: "",
          bannerURI: "",
          description: "v2",
          website: "",
          x: "",
          telegram: "",
        },
      }),
    ),
    at(
      120,
      fakeLog({
        abi: curve2Abi,
        eventName: "FeesCollected",
        address: CURVE,
        block: 120,
        tx: "0xcollect120",
        logIndex: 0,
        args: { recipient: CREATOR, amount: 7n },
      }),
    ),
    at(
      121,
      fakeLog({
        abi: graduation2Abi,
        eventName: "Graduated",
        address: GRADUATION2,
        block: 121,
        tx: "0xgraduate",
        logIndex: 0,
        args: {
          curve: CURVE,
          id: POOL_ID,
          token: TOKEN,
          quoteAsset: USDC,
          quoteAmount: 1n,
          baseAmount: 1n,
          tokenId: 1n,
        },
      }),
    ),
    at(
      121,
      fakeLog({
        abi: hook2Abi,
        eventName: "PoolRegistered",
        address: HOOK2,
        block: 121,
        tx: "0xgraduate",
        logIndex: 1,
        args: {
          id: POOL_ID,
          token: TOKEN,
          sink: 2,
          sinkAddr: VAULT,
          protocolBps: 30,
          lpBps: 70,
          creatorTaxBps: 100,
        },
      }),
    ),
    at(
      121,
      fakeLog({
        abi: creatorSinkAbi,
        eventName: "Registered",
        address: CREATOR_SINK,
        block: 121,
        tx: "0xgraduate",
        logIndex: 2,
        args: { market: CURVE, id: POOL_ID, quote: USDC, routed: CREATOR, tax: BOB },
      }),
    ),
    at(
      122,
      fakeLog({
        abi: rewardVaultAbi,
        eventName: "Funded",
        address: VAULT,
        block: 122,
        tx: "0xfund",
        logIndex: 0,
        args: { amount: 500n },
      }),
    ),
    at(
      123,
      fakeLog({
        abi: creatorSinkAbi,
        eventName: "Credited",
        address: CREATOR_SINK,
        block: 123,
        tx: "0xpull",
        logIndex: 0,
        args: { who: CREATOR, quote: USDC, amount: 60n, kind: 0 },
      }),
    ),
    at(
      123,
      fakeLog({
        abi: creatorSinkAbi,
        eventName: "Pulled",
        address: CREATOR_SINK,
        block: 123,
        tx: "0xpull",
        logIndex: 1,
        args: { market: CURVE, routedAmount: 60n, taxAmount: 0n },
      }),
    ),
    // The two logs that move a market's payee, both above the fork. Nothing else in this history
    // touches `routed_recipient` or `tax_recipient` after the launch, so a rewind that cannot
    // restore them leaves the market pointing at BOB rather than back at CREATOR and ALICE.
    at(
      124,
      fakeLog({
        abi: creatorSinkAbi,
        eventName: "RecipientTransferred",
        address: CREATOR_SINK,
        block: 124,
        tx: "0xtransfer",
        logIndex: 0,
        args: { market: CURVE, from: CREATOR, to: BOB },
      }),
    ),
  ];
}

async function replay(db: Db, upTo = Number.MAX_SAFE_INTEGER): Promise<void> {
  for (const { block, log } of history()) {
    if (block > upTo) continue;
    await applyLog(db, log.log, log.decoded, TS, cfg2, () => {});
  }
}

/**
 * Every table a rewind is supposed to leave consistent, with the columns that cannot be equal
 * across two runs stripped out.
 *
 * `id` is a sequence and `updated_at` is a wall clock; both differ between a database that saw
 * four logs and one that saw twelve and then unwound eight. Everything else is a claim about the
 * chain, and a rewind that reconstructs rather than merely deletes has to reproduce all of it.
 */
const DUMPS: { table: string; sql: string }[] = [
  {
    table: "swaps",
    sql: `SELECT market_address, trader, is_buy, venue, quote_amount::text, base_amount::text,
                 fee::text, tax::text, creator_tax::text, quote_raised::text, price::text,
                 block_number::text, log_index, tx_hash
            FROM swaps ORDER BY block_number, log_index`,
  },
  {
    table: "fee_events",
    sql: `SELECT market_address, kind, recipient, quote_asset, amount::text, venue,
                 block_number::text, log_index, tx_hash
            FROM fee_events ORDER BY block_number, log_index, kind`,
  },
  {
    table: "creator_ledger",
    sql: `SELECT who, quote_asset, market_address, kind, claimable_delta::text, earned_delta::text,
                 block_number::text, log_index, tx_hash
            FROM creator_ledger ORDER BY block_number, log_index, kind`,
  },
  {
    table: "metadata_updates",
    sql: `SELECT market_address, name, ticker, description, metadata_hash, block_number::text,
                 log_index, tx_hash
            FROM metadata_updates ORDER BY block_number, log_index`,
  },
  {
    table: "market_rewards",
    sql: `SELECT market_address, protocol_generated::text, protocol_collected::text,
                 routed_generated::text, routed_collected::text, tax_generated::text,
                 tax_collected::text, dividends_funded::text, dividends_paid::text,
                 burned_tokens::text
            FROM market_rewards ORDER BY market_address`,
  },
  {
    table: "creator_balances",
    sql: `SELECT who, quote_asset, claimable::text, earned_lifetime::text
            FROM creator_balances ORDER BY who, quote_asset`,
  },
  {
    table: "market_state",
    sql: `SELECT market_address, quote_raised::text, last_price::text, volume_quote::text,
                 trade_count, holders, ready_to_graduate, ready_block::text, pool_address, pool_id,
                 block_number::text
            FROM market_state ORDER BY market_address`,
  },
  {
    table: "markets",
    sql: `SELECT market_address, symbol, name, ticker, description, metadata_hash, generation,
                 quote_asset, routing, routed_recipient, tax_recipient, total_supply::text
            FROM markets ORDER BY market_address`,
  },
  {
    table: "graduations",
    sql: `SELECT market_address, pool_id, sink, sink_kind, block_number::text
            FROM graduations ORDER BY block_number, log_index`,
  },
  {
    table: "candlesticks",
    sql: `SELECT market_address, period_secs, bucket_start, open::text, high::text, low::text,
                 close::text, volume_quote::text, trade_count
            FROM candlesticks ORDER BY market_address, period_secs, bucket_start`,
  },
];

async function dump(db: Db): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const { table, sql } of DUMPS) out[table] = (await db.query(sql)).rows;
  return out;
}

/** The two columns that name who a market's future routed income and creator tax belong to. */
async function recipients(db: Db): Promise<{ routed: string | null; tax: string | null }> {
  const { rows } = await db.query<{ routed: string | null; tax: string | null }>(
    "SELECT routed_recipient AS routed, tax_recipient AS tax FROM markets WHERE market_address = $1",
    [CURVE],
  );
  return rows[0]!;
}

describe("rewind across gen-2 tables", () => {
  let db: Db;
  beforeEach(async () => {
    db = await memoryDb();
    await replay(db, 120);
  });

  it("drops fee and ledger rows above the fork and recomputes the projections", async () => {
    await rewindTo(db, 115n);
    const fees = await db.query("SELECT 1 FROM fee_events");
    // The surviving trade's three components, plus the collection at block 112.
    expect(fees.rows).toHaveLength(4);
    const rw = await db.query<{ r: string; rc: string }>(
      "SELECT routed_generated::text AS r, routed_collected::text AS rc FROM market_rewards WHERE market_address = $1",
      [CURVE],
    );
    expect(rw.rows[0]).toEqual({ r: "7", rc: "4" });
    const bal = await db.query<{ e: string }>(
      "SELECT earned_lifetime::text AS e FROM creator_balances WHERE who = $1",
      [CREATOR],
    );
    // The block-120 collection is gone; the block-112 one survives, so the creator's lifetime
    // total is that one alone rather than either zero or both.
    expect(bal.rows[0]).toEqual({ e: "4" });
  });

  it("restores the newest surviving metadata onto the market", async () => {
    await rewindTo(db, 115n);
    const { rows } = await db.query<{ description: string }>(
      "SELECT description FROM markets WHERE market_address = $1",
      [CURVE],
    );
    expect(rows[0]!.description).toBe("v1");
    expect((await db.query("SELECT 1 FROM metadata_updates")).rows).toHaveLength(1);
  });

  it("removes the market entirely when its launch is above the fork", async () => {
    await rewindTo(db, 100n);
    expect((await db.query("SELECT 1 FROM markets")).rows).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM market_rewards")).rows).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM fee_events")).rows).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM creator_ledger")).rows).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM creator_balances")).rows).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM metadata_updates")).rows).toHaveLength(0);
  });

  /**
   * `Registered` and `RecipientTransferred` are the only two logs that name a DIFFERENT payee for
   * a market's future income, and they used to write the column with nothing behind them. A reorg
   * that orphans either of them has to put the payee back, or every later collection is credited
   * to an address the chain never chose.
   */
  it("restores the recipients that events above the fork changed", async () => {
    const rewound = await memoryDb();
    await replay(rewound);
    expect(await recipients(rewound)).toEqual({ routed: BOB, tax: BOB });

    await rewindTo(rewound, 115n);
    expect(await recipients(rewound)).toEqual({ routed: CREATOR, tax: ALICE });
  });

  /**
   * The only assertion that proves a REWIND rather than a DELETE.
   *
   * Two databases are shown the same history: one is stopped at the fork, the other is run past
   * it -- through a graduation, a vault funding and a creator-sink pull -- and then wound back to
   * the fork. Every table has to agree, column for column.
   *
   * Counting rows cannot see the failure this catches. A projection is an accumulator's worth of
   * arithmetic over rows that are now gone: delete the rows and `market_rewards` still holds the
   * old totals, `creator_balances` still holds the old lifetime, the candles still hold the last
   * price, and every one of those is a plausible number that nothing downstream ever questions.
   * Reconstruction is the property; equality with a database that never saw the orphaned blocks
   * is the only way to state it.
   */
  it("reconstructs exactly the database that never saw the orphaned blocks", async () => {
    const rewound = await memoryDb();
    await replay(rewound); // the whole history, past the fork
    await rewindTo(rewound, 115n);

    const never = await memoryDb();
    await replay(never, 115); // stopped at the fork instead

    const [a, b] = [await dump(rewound), await dump(never)];
    for (const { table } of DUMPS) expect(a[table], `${table} after rewind`).toEqual(b[table]);

    // Non-empty, or the comparison above passes by comparing nothing.
    expect(b.swaps).toHaveLength(1);
    expect(b.fee_events).toHaveLength(4);
    expect(b.creator_ledger).toHaveLength(1);
    expect(b.market_rewards).toHaveLength(1);
  });
});
