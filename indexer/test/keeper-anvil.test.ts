import { decodeEventLog, parseAbi, parseEther } from "viem";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/legacy.js";
import { ingestOnce, type IngestConfig } from "../src/indexer/ingestion/ingest.js";
import { viemKeeperChain } from "../src/indexer/processing/keeper-chain.js";
import { KeeperState, runKeeperPass } from "../src/indexer/processing/keeper.js";
import { startScenario, type Scenario } from "./anvil.js";
import { memoryDatabase, transactional } from "./helpers.js";

/**
 * A market stranded the way production strands one, and the keeper un-stranding it.
 *
 * The filling buy is sent with a gas limit that covers the buy and not the graduation it also has
 * to pay for — which is exactly what a wallet's own estimate does, because the graduation runs
 * inside a swallowed call the estimator cannot see fail. The curve fills, `AutoGraduationFailed`
 * is emitted, `readyToGraduate` latches, `graduated()` stays false, and both legs are shut. Then
 * the keeper — through the real viem adapter, against this real chain — sends the graduation the
 * buyer could not, and the next ingest pass records the pool.
 *
 * Unit tests cover the policy against a fake. This is the one test that proves the adapter, the
 * ABI fragments, the gas limit and the contract's own idea of "stranded" all agree.
 */

const curveAbi = parseAbi([
  "function buy(uint256 minBaseOut, uint256 deadline) payable returns (uint256)",
  "function readyToGraduate() view returns (bool)",
  "event AutoGraduationFailed(uint256 gasLeft)",
]);
const graduationAbi = parseAbi(["function graduated(address curve) view returns (bool)"]);

const NO_GEN1_FACTORY = "0x0000000000000000000000000000000000000f01" as const;

/** The scenario's deployer key: anvil's first account, already holding 10,000 ETH. */
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

describe("the graduation keeper against a live chain", () => {
  let s: Scenario;
  let db: Db;
  let cfg: IngestConfig;

  const mine = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await s.client.request({ method: "anvil_mine", params: [] } as never);
    }
  };

  beforeAll(async () => {
    s = await startScenario(8581, { launchOnly: true });
    const database = await memoryDatabase();
    db = database.legacy;
    cfg = {
      factory: NO_GEN1_FACTORY,
      factory2: s.factory,
      graduation: s.graduation,
      graduation2: s.graduation,
      hook2: s.hook,
      creatorSink: s.creatorSink,
      quoteRegistry: s.quoteRegistry,
      poolManager: s.poolManager,
      startBlock: 0n,
      ...transactional(database),
    };
    delete process.env.START_BLOCK;
    await ingestOnce(s.client, db, cfg);
  }, 300_000);

  afterAll(() => s?.stop());

  it("fills the curve with a starved buy, and the keeper graduates what the buyer could not", async () => {
    // The fill. 5,000 MON against a 1,000 MON target — the overshoot is refunded — with a limit
    // that is generous for a buy and hopeless for a graduation. EIP-150 forwards 63/64 of what is
    // left into the swallowed call, so the outer keeps enough to emit the failure and return.
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const hash = await s.wallet.writeContract({
      address: s.curve,
      abi: curveAbi,
      functionName: "buy",
      args: [0n, deadline],
      value: parseEther("5000"),
      gas: 1_000_000n,
      chain: foundry,
      account: s.wallet.account!,
    });
    const receipt = await s.client.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");

    let starved: bigint | null = null;
    for (const log of receipt.logs) {
      try {
        const d = decodeEventLog({ abi: curveAbi, data: log.data, topics: log.topics });
        if (d.eventName === "AutoGraduationFailed") starved = (d.args).gasLeft;
      } catch {
        // Other contracts' events in the same transaction.
      }
    }
    expect(starved, "the filling buy should have failed to graduate").not.toBeNull();
    expect(starved!).toBeLessThan(2_500_000n);

    // The chain's own account of the state this leaves behind.
    expect(
      await s.client.readContract({ address: s.curve, abi: curveAbi, functionName: "readyToGraduate" }),
    ).toBe(true);
    expect(
      await s.client.readContract({
        address: s.graduation,
        abi: graduationAbi,
        functionName: "graduated",
        args: [s.curve],
      }),
    ).toBe(false);

    // And the indexer's: ready, poolless — the row the keeper polls.
    await mine(8);
    await ingestOnce(s.client, db, cfg);
    const before = await db.query<{ ready_to_graduate: boolean; pool_address: string | null }>(
      "SELECT ready_to_graduate, pool_address FROM market_state WHERE market_address = $1",
      [s.curve],
    );
    expect(before.rows[0]).toEqual({ ready_to_graduate: true, pool_address: null });

    // The keeper, through the real adapter.
    const chain = viemKeeperChain({
      chain: foundry,
      rpcUrl: s.rpcUrl,
      privateKey: DEPLOYER_KEY,
      graduation: s.graduation,
    });
    const state = new KeeperState(chain.address);
    const pass = await runKeeperPass(db, chain, state);
    expect(pass.graduated).toEqual([s.curve]);
    expect(pass.failed).toEqual([]);
    expect(state.snapshot()).toMatchObject({ graduated: 1, failed: 0, heldByReserve: 0 });
    expect(state.snapshot().lastTx).toMatch(/^0x[0-9a-f]{64}$/);

    expect(
      await s.client.readContract({
        address: s.graduation,
        abi: graduationAbi,
        functionName: "graduated",
        args: [s.curve],
      }),
    ).toBe(true);

    // A second pass finds nothing to do: the chain says graduated before the indexer does.
    const again = await runKeeperPass(db, chain, state);
    expect(again.graduated).toEqual([]);
    expect(again.skipped).toEqual([s.curve]);

    // And once the graduation is ingested, the row itself says so.
    await mine(8);
    await ingestOnce(s.client, db, cfg);
    const after = await db.query<{ pool_address: string | null; pool_id: string | null }>(
      "SELECT pool_address, pool_id FROM market_state WHERE market_address = $1",
      [s.curve],
    );
    expect(after.rows[0]!.pool_address).toBe(s.poolManager);
    expect(after.rows[0]!.pool_id).toBe(s.poolId);
    expect(await runKeeperPass(db, chain, state)).toMatchObject({ candidates: 0 });
  }, 180_000);
});
