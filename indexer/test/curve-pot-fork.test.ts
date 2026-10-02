import { createPublicClient, createTestClient, createWalletClient, defineChain, formatEther, http, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/legacy.js";
import { SINK_REWARDS } from "../src/indexer/generations.js";
import { viemKeeperChain } from "../src/indexer/processing/keeper-chain.js";
import { KeeperState, runFundPass } from "../src/indexer/processing/keeper.js";
import { memoryDb, seedMarket } from "./helpers.js";

/**
 * The holders' share a curve is left holding at graduation, released by the funding pass — against
 * the contracts it will really call, on a fork of Monad mainnet.
 *
 * GEN8 is generation 8's live dividends market. On 2026-09-19 it was 1.9% of the way to its
 * 305,868 MON target with 42 MON of holder fees locked in `BondingCurve.pendingFees`, where
 * `collectFees()` reverts `NotGraduated`. Here one buy fills the curve and graduates it (real
 * graduator, real hook, a real `RewardVault` deployed by them), which leaves 0.7% of the whole raise
 * on the curve. Nothing on chain moves it from there. The pass must: through the real viem adapter.
 *
 *   anvil --fork-url https://rpc.monad.xyz --port 8647
 *   CURVE_FORK_RPC=http://127.0.0.1:8647 npx vitest run test/curve-pot-fork.test.ts
 *
 * Nothing here can reach mainnet: every client is given the fork's URL and no other.
 */

const FORK = process.env.CURVE_FORK_RPC;
const HOOK = "0x7979A6CEa35EEc926A81384c3E8330588e216fcf" as const;
const GRADUATION = "0xBe0EE14cF50B65dAb78f22068551677b3BF60941" as const;
const CURVE = "0x118f73debdf7b740ad13efd325e0d6f13f569993" as const;
const TOKEN = "0x22c8d4821f5067b954ab117c77849e47db9849ad" as const;
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const NATIVE = "0x0000000000000000000000000000000000000000";

const curveAbi = parseAbi([
  "function buy(uint256 minBaseOut, uint256 deadline) payable returns (uint256)",
  "function pendingFees() view returns (uint256)",
  "function quoteRaised() view returns (uint256)",
  "function quoteTarget() view returns (uint256)",
  "function autoGraduationGasHint() view returns (uint256)",
  "function collectFees()",
]);
const graduationAbi = parseAbi([
  "function graduated(address curve) view returns (bool)",
  "function sinkOf(address curve) view returns (address)",
  "function poolIdOf(address curve) view returns (bytes32)",
]);
const vaultAbi = parseAbi([
  "function currentInterval() view returns (uint256)",
  "function pending(uint256) view returns (uint256)",
  "function unallocated() view returns (uint256)",
]);
const hookAbi = parseAbi(["function owedSink(bytes32 id) view returns (uint256)"]);

describe.skipIf(!FORK)("the curve's holder pot, released by the funding pass on a fork of Monad mainnet", () => {
  const chain = defineChain({
    id: 143,
    name: "Monad (fork)",
    nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [FORK ?? "http://127.0.0.1:0"] } },
  });
  const account = privateKeyToAccount(ANVIL_KEY);
  let client: ReturnType<typeof createPublicClient>;
  let db: Db;
  let vault: `0x${string}`;
  let poolId: `0x${string}`;

  beforeAll(async () => {
    client = createPublicClient({ chain, transport: http(FORK), cacheTime: 0 });
    const test = createTestClient({ chain, mode: "anvil", transport: http(FORK) });
    const wallet = createWalletClient({ account, chain, transport: http(FORK) });
    await test.setBalance({ address: account.address, value: parseEther("400000") });

    // Before graduation the pot is locked: this is the state a holder of GEN8 is in today.
    await expect(
      client.simulateContract({ account: account.address, address: CURVE, abi: curveAbi, functionName: "collectFees" }),
    ).rejects.toThrow();

    // One buy for everything the curve still wants. It refunds what it cannot take, and graduates
    // in the same transaction if it is given the gas the graduation needs.
    const [raised, target, hint] = await Promise.all([
      client.readContract({ address: CURVE, abi: curveAbi, functionName: "quoteRaised" }),
      client.readContract({ address: CURVE, abi: curveAbi, functionName: "quoteTarget" }),
      client.readContract({ address: CURVE, abi: curveAbi, functionName: "autoGraduationGasHint" }),
    ]);
    const hash = await wallet.writeContract({
      address: CURVE,
      abi: curveAbi,
      functionName: "buy",
      args: [1n, 2n ** 64n],
      value: ((target - raised) * 103n) / 100n,
      gas: hint + 2_000_000n,
    });
    expect((await client.waitForTransactionReceipt({ hash })).status).toBe("success");
    expect(await client.readContract({ address: GRADUATION, abi: graduationAbi, functionName: "graduated", args: [CURVE] })).toBe(true);

    vault = await client.readContract({ address: GRADUATION, abi: graduationAbi, functionName: "sinkOf", args: [CURVE] });
    poolId = await client.readContract({ address: GRADUATION, abi: graduationAbi, functionName: "poolIdOf", args: [CURVE] });

    // GEN8 as the indexer would hold it after ingesting that graduation.
    db = await memoryDb();
    await seedMarket(db, CURVE, TOKEN, 104_694_496);
    await db.query("UPDATE markets SET generation = 2, quote_asset = $2, quote_decimals = 18 WHERE market_address = $1", [CURVE, NATIVE]);
    await db.query(
      `INSERT INTO graduations (market_address, pool_address, pool_id, sink, sink_kind, token_id,
                                quote_amount, base_amount, liquidity, block_number, block_hash,
                                log_index, tx_hash, ts)
       VALUES ($1,'0x188d586ddcf52439676ca21a244753fa19f9ea8e',$2,$3,$4,0,0,0,0,106300000,'0xbb',0,'0xgtx',NOW())`,
      [CURVE, poolId, vault.toLowerCase(), SINK_REWARDS],
    );
  }, 300_000);

  it("finds 0.7% of the whole raise still on the graduated curve, and puts it in the vault", async () => {
    const pot = await client.readContract({ address: CURVE, abi: curveAbi, functionName: "pendingFees" });
    // 42 MON was there before; the filling buy added 0.7% of ~300,000 MON.
    expect(pot).toBeGreaterThan(parseEther("2000"));
    expect(await client.readContract({ address: vault, abi: vaultAbi, functionName: "unallocated" })).toBe(0n);

    const keeper = viemKeeperChain({ chain, rpcUrl: FORK ?? "", privateKey: ANVIL_KEY, graduation: GRADUATION, hook: HOOK });
    const state = new KeeperState(keeper.address);
    const r = await runFundPass(db, keeper, state);

    expect(r.failed).toEqual([]);
    expect(r.funded).toEqual([vault.toLowerCase()]);
    expect(await client.readContract({ address: CURVE, abi: curveAbi, functionName: "pendingFees" })).toBe(0n);
    expect(await client.readContract({ address: HOOK, abi: hookAbi, functionName: "owedSink", args: [poolId] })).toBe(0n);
    // Every wei of it reached the vault, spread forward over seven daily epochs by the vault itself.
    expect(await client.readContract({ address: vault, abi: vaultAbi, functionName: "unallocated" })).toBe(pot);
    const k = await client.readContract({ address: vault, abi: vaultAbi, functionName: "currentInterval" });
    let sum = 0n;
    const perDay: string[] = [];
    for (let j = 0n; j < 7n; j += 1n) {
      const p = await client.readContract({ address: vault, abi: vaultAbi, functionName: "pending", args: [k + j] });
      expect(p).toBeGreaterThan(0n);
      sum += p;
      perDay.push(Number(formatEther(p)).toFixed(1));
    }
    expect(sum).toBe(pot);
    console.log(`released ${formatEther(pot)} MON from the curve -> vault, as daily epochs of ${perDay.join(" / ")} MON`);

    // And the pass does not look at the curve again.
    const again = await runFundPass(db, keeper, state);
    expect(again.failed).toEqual([]);
    expect(state.snapshot().failed).toBe(0);
  }, 300_000);
});
