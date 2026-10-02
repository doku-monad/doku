import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeEventLog, parseAbi, parseEther } from "viem";
import { foundry } from "viem/chains";
import type { Db } from "../src/db/legacy.js";
import { ingestOnce, type IngestConfig } from "../src/indexer/ingestion/ingest.js";
import { startScenario, type Scenario } from "./anvil.js";
import { memoryDatabase, transactional } from "./helpers.js";

const curveAbi = parseAbi([
  "function buy(uint256 minBaseOut, uint256 deadline) payable returns (uint256)",
]);

/**
 * The curve's `Bought`, declared here rather than imported from `src/indexer/abi.ts`.
 *
 * This decode reads what the CHAIN emitted, to compute the number the assertions below compare the
 * database against. Borrowing the indexer's ABI for it made the two the same claim: if the indexer
 * decoded the wrong event the expectation moved with it, and the test still passed. It stopped
 * passing for the opposite reason — the chain moved to generation 2 and the indexer's list did not
 * — which is the same coupling seen from the other side.
 *
 * Generation 2 splits the single `tax` into `antiSniperTax` and `creatorTax` and adds the
 * post-trade `price`, so this is a different signature and a different topic0, not a rename.
 */
const curveEvents = parseAbi([
  "event Bought(address indexed buyer, uint256 quoteIn, uint256 baseOut, uint256 fee, uint256 antiSniperTax, uint256 creatorTax, uint256 quoteRaised, uint256 price)",
]);

/**
 * The generation-1 factory, which this chain does not have.
 *
 * `IngestConfig.factory` is required, and its only job is to attribute a `MarketLaunched` to a
 * generation. On a generation-2-only chain it therefore names an address no contract is at.
 * Pointing it at `s.factory` alongside `factory2` would also work — `factoryAbis` writes the
 * generation-2 entry second and it would win — but it would work by insertion order, and the day
 * that order changed every launch here would silently decode as generation 1.
 */
const NO_GEN1_FACTORY = "0x0000000000000000000000000000000000000f01" as const;

/**
 * What happens when the chain changes its mind.
 *
 * Monad finalises in well under a second, so this is rare — but "rare" is the failure mode that
 * ships, because it never shows up in testing that only ever moves forward. A reorg here is a real
 * one: the node is rolled back to a snapshot and a *different* trade is mined at the same heights,
 * so the indexer has to notice that the history it stored no longer exists.
 */
describe("reorg handling", () => {
  let s: Scenario;
  let db: Db;
  let cfg: IngestConfig;
  let survivor: bigint;
  /**
   * The buys the chain already carried before this suite mined anything.
   *
   * Generation 2 launches with an untaxed first buy inside the launch transaction itself —
   * `LocalScenario._launch` sets `firstBuyQuote` — so `launchOnly` no longer means "no trades".
   * Read off the chain rather than out of our own rows, so the expectations below are still the
   * contract's numbers and not the indexer's.
   */
  let priorBuys: bigint[];

  const mine = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await s.client.request({ method: "anvil_mine", params: [] } as never);
    }
  };

  /**
   * Buys and returns the `quoteIn` the curve actually recorded.
   *
   * Not `msg.value`: the event carries the amount net of the protocol fee and the anti-sniper
   * tax, so hardcoding the MON sent would assert against a number the contract never emits.
   */
  const buy = async (mon: string): Promise<bigint> => {
    const hash = await s.wallet.writeContract({
      address: s.curve,
      abi: curveAbi,
      functionName: "buy",
      args: [0n, BigInt(Math.floor(Date.now() / 1000) + 3600)],
      value: parseEther(mon),
      chain: foundry,
      account: s.wallet.account!,
    });
    const r = await s.client.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`buy(${mon}) reverted`);
    await mine(8);

    for (const log of r.logs) {
      try {
        const d = decodeEventLog({ abi: curveEvents, data: log.data, topics: log.topics });
        if (d.eventName === "Bought") return (d.args as { quoteIn: bigint }).quoteIn;
      } catch {
        // Not a curve event — the same transaction also emits the token's Transfer.
      }
    }
    throw new Error(`buy(${mon}) emitted no Bought event`);
  };

  /** Every `Bought` the curve has emitted, decoded from the chain's logs. */
  const chainBuys = async (): Promise<bigint[]> => {
    const logs = await s.client.getLogs({ address: s.curve, fromBlock: 0n, toBlock: "latest" });
    const out: bigint[] = [];
    for (const log of logs) {
      try {
        const d = decodeEventLog({ abi: curveEvents, data: log.data, topics: log.topics });
        if (d.eventName === "Bought") out.push((d.args as { quoteIn: bigint }).quoteIn);
      } catch {
        // Not a curve event — the launch transaction also emits the token's Transfer.
      }
    }
    return out;
  };

  const swaps = async () => {
    const { rows } = await db.query<{ quote_amount: string; block_number: string }>(
      "SELECT quote_amount, block_number FROM swaps ORDER BY block_number",
    );
    return rows;
  };

  beforeAll(async () => {
    s = await startScenario(8553, { launchOnly: true });
    const database = await memoryDatabase();
    db = database.legacy;
    cfg = {
      // Generation 2 is what this chain runs. The addresses come from the scenario, and the
      // generation of a log is decided by the address that emitted it, never by its name.
      factory: NO_GEN1_FACTORY,
      factory2: s.factory,
      // `graduation` is both the default accepted `Graduated` emitter and the address the holder
      // count excludes, so it names the real graduator. `graduation2` and `quoteRegistry` are not
      // read yet; they are set so this cfg describes the chain rather than the current handlers.
      graduation: s.graduation,
      graduation2: s.graduation,
      // Without this the PoolKey rebuilt for every graduation cannot be checked against the
      // emitted id, and `handleGraduated2` throws rather than guess.
      hook2: s.hook,
      creatorSink: s.creatorSink,
      quoteRegistry: s.quoteRegistry,
      poolManager: s.poolManager,
      startBlock: 0n,
      ...transactional(database),
    };
    priorBuys = await chainBuys();
    // The launch's own first buy, and nothing else: `launchOnly` skips `_trade`.
    expect(priorBuys).toHaveLength(1);
    await ingestOnce(s.client, db, cfg);
  }, 300_000);

  afterAll(() => s?.stop());

  const quotes = (rows: { quote_amount: string }[]) => rows.map((r) => r.quote_amount);
  const priorQuotes = () => priorBuys.map((q) => q.toString());

  it("drops the orphaned trade and keeps the one that survived", async () => {
    const snapshot = (await s.client.request({
      method: "anvil_snapshot",
      params: [],
    } as never));

    // The trade that will be reorged away.
    const orphaned = await buy("10");
    await ingestOnce(s.client, db, cfg);
    const before = await swaps();
    // The launch buy, then the trade about to be orphaned. The snapshot was taken after the
    // launch, so the launch survives the revert and is part of both expectations.
    expect(quotes(before)).toEqual([...priorQuotes(), orphaned.toString()]);

    // Roll the node back and mine a different history at the same heights.
    await s.client.request({ method: "anvil_revert", params: [snapshot] } as never);
    survivor = await buy("25");
    await ingestOnce(s.client, db, cfg);

    const after = await swaps();
    // The launch buy and the survivor, and NOT the orphan. The 10 MON trade never happened on the
    // chain that exists now, and an indexer that keeps it is serving a trade no block contains.
    expect(quotes(after)).toEqual([...priorQuotes(), survivor.toString()]);
    expect(survivor).not.toBe(orphaned);
  }, 120_000);

  /// Aggregates are the part a rewind is most likely to miss: deleting the swap row is obvious,
  /// while the volume it already added to `market_state` is not, and nothing throws if it lingers.
  it("does not leave the orphaned trade's volume in the aggregates", async () => {
    const { rows } = await db.query<{ volume_quote: string; trade_count: number }>(
      "SELECT volume_quote, trade_count FROM market_state WHERE market_address = $1",
      [s.curve],
    );
    expect(rows[0]!.trade_count).toBe(priorBuys.length + 1);
    const expected = priorBuys.reduce((sum, q) => sum + q, 0n) + survivor;
    expect(rows[0]!.volume_quote).toBe(expected.toString());
  });

  it("leaves the indexer pointed at a block that still exists", async () => {
    const { rows } = await db.query<{ last_block: string; last_block_hash: string }>(
      "SELECT last_block, last_block_hash FROM indexer_status WHERE id = 1",
    );
    const stored = rows[0]!;
    const onChain = await s.client.getBlock({ blockNumber: BigInt(stored.last_block) });
    expect(onChain.hash).toBe(stored.last_block_hash);
  });
});
