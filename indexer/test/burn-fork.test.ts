import { createPublicClient, createTestClient, defineChain, http, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/legacy.js";
import { SINK_BURN } from "../src/indexer/generations.js";
import { BURN_MAX_TX_COST_WEI, runBurnPass, SWEEP_GAS_PAD } from "../src/indexer/processing/burn.js";
import { viemKeeperChain } from "../src/indexer/processing/keeper-chain.js";
import { KeeperState } from "../src/indexer/processing/keeper.js";
import { memoryDb, seedMarket } from "./helpers.js";

/**
 * The burn pass against the contracts it will actually call: a fork of Monad mainnet.
 *
 * The unit tests drive the policy against a fake, and a fake agrees with whatever it was told. This
 * is the test that the real hook's `pendingSink`/`owedSink`/`sweep`, the real `BurnSink.burn()`, the
 * adapter's ABI fragments and the gas the estimates ask for all agree — on TB1, generation 8's
 * buyback test market, which on 2026-09-19 held 748,666 tokens nobody had swept.
 *
 * Skipped unless pointed at a fork, because it needs the network and a running anvil:
 *
 *   anvil --fork-url https://rpc.monad.xyz --port 8645
 *   BURN_FORK_RPC=http://127.0.0.1:8645 npx vitest run test/burn-fork.test.ts
 *
 * The key is anvil's first account, funded on the fork by `anvil_setBalance`. Nothing here can
 * reach mainnet: the adapter is given the fork's URL and no other.
 */

const FORK = process.env.BURN_FORK_RPC;

const HOOK = "0x7979A6CEa35EEc926A81384c3E8330588e216fcf" as const;
const GRADUATION = "0xBe0EE14cF50B65dAb78f22068551677b3BF60941" as const;
const TB1 = {
  market: "0x3732812616dd27eacaef8b5fb11e80d3e9861b32",
  token: "0x41b09720e157edc8621fd36a1e5bf1fc4ff781b5",
  sink: "0x885180a347fdd749235ea42e5e792564ce959d01",
  poolId: "0x5aa72717122963345fed680bbe2a117a63c629165e33545cdfec419c59b69d4e",
  /** `market_state.last_price` as the live API served it on 2026-09-19. */
  lastPrice: "183921093688965072142895292862",
} as const;
const NATIVE = "0x0000000000000000000000000000000000000000";
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

const hookAbi = parseAbi([
  "function pendingSink(bytes32 id) view returns (uint256)",
  "function owedSink(bytes32 id) view returns (uint256)",
]);
const tokenAbi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

describe.skipIf(!FORK)("the burn pass against a fork of Monad mainnet", () => {
  const chain = defineChain({
    id: 143,
    name: "Monad (fork)",
    nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [FORK ?? "http://127.0.0.1:0"] } },
  });
  const keeper = privateKeyToAccount(ANVIL_KEY).address;
  // Built in `beforeAll`, not here: a skipped `describe` still runs its body to collect the tests,
  // and a transport with no URL throws on construction — which would fail the suite it is skipping.
  let client: ReturnType<typeof createPublicClient>;
  let db: Db;

  /** The ingest loop caught up as of now, which the pass requires before it will read anything. */
  const current = (d: Db) =>
    d.query(
      `INSERT INTO indexer_status (id, last_block, chain_head, updated_at) VALUES (1, 999998, 1000000, NOW())
       ON CONFLICT (id) DO UPDATE SET last_block = EXCLUDED.last_block, chain_head = EXCLUDED.chain_head,
                                      updated_at = NOW()`,
    );

  const ledgers = async () => ({
    pending: await client.readContract({ address: HOOK, abi: hookAbi, functionName: "pendingSink", args: [TB1.poolId] }),
    owed: await client.readContract({ address: HOOK, abi: hookAbi, functionName: "owedSink", args: [TB1.poolId] }),
    supply: await client.readContract({ address: TB1.token, abi: tokenAbi, functionName: "totalSupply" }),
    sinkBalance: await client.readContract({ address: TB1.token, abi: tokenAbi, functionName: "balanceOf", args: [TB1.sink] }),
  });

  beforeAll(async () => {
    client = createPublicClient({ chain, transport: http(FORK), cacheTime: 0 });
    const test = createTestClient({ chain, mode: "anvil", transport: http(FORK) });
    await test.setBalance({ address: keeper, value: parseEther("100") });

    // TB1 as the indexer holds it, so the pass's own SQL names it rather than a hand-built row.
    db = await memoryDb();
    await seedMarket(db, TB1.market, TB1.token, 104_700_000);
    await db.query(
      "UPDATE markets SET generation = 2, quote_asset = $2, quote_decimals = 18 WHERE market_address = $1",
      [TB1.market, NATIVE],
    );
    await db.query("UPDATE market_state SET last_price = $2 WHERE market_address = $1", [TB1.market, TB1.lastPrice]);
    await db.query(
      `INSERT INTO graduations (market_address, pool_address, pool_id, sink, sink_kind, token_id,
                                quote_amount, base_amount, liquidity, block_number, block_hash,
                                log_index, tx_hash, ts)
       VALUES ($1,'0x188d586ddcf52439676ca21a244753fa19f9ea8e',$2,$3,$4,0,0,0,0,104700001,'0xbb',0,'0xgtx',NOW())`,
      [TB1.market, TB1.poolId, TB1.sink, SINK_BURN],
    );
    await current(db);
    // MON at two and a half cents, as the catalogue had it: TB1's pending burn is worth ~$0.0035.
    await db.query(
      "INSERT INTO quote_assets (id, address, symbol, decimals, usd_price) VALUES ('mon', $1, 'MON', 18, 0.0254)",
      [NATIVE],
    );
  }, 120_000);

  const adapter = () =>
    viemKeeperChain({ chain, rpcUrl: FORK ?? "", privateKey: ANVIL_KEY, graduation: GRADUATION, hook: HOOK });

  it("reads the deployed hook's own record of TB1: registered, BURN, and this sink", async () => {
    // The adapter's `markets(bytes32)` fragment against the real struct. A field out of order
    // would decode the sink address out of the wrong bytes, and this is where that shows.
    const named = await adapter().sinkOf(TB1.poolId);
    expect(named.registered).toBe(true);
    expect(named.kind).toBe(SINK_BURN);
    expect(named.sinkAddr.toLowerCase()).toBe(TB1.sink);
  }, 60_000);

  it("refuses a database row that names any other address as TB1's sink, and sends nothing", async () => {
    const before = await ledgers();
    const wrong = await memoryDb();
    await seedMarket(wrong, TB1.market, TB1.token, 104_700_000);
    await wrong.query("UPDATE markets SET generation = 2, quote_asset = $2, quote_decimals = 18 WHERE market_address = $1", [TB1.market, NATIVE]);
    await wrong.query("UPDATE market_state SET last_price = $2 WHERE market_address = $1", [TB1.market, TB1.lastPrice]);
    await wrong.query(
      `INSERT INTO graduations (market_address, pool_address, pool_id, sink, sink_kind, token_id,
                                quote_amount, base_amount, liquidity, block_number, block_hash,
                                log_index, tx_hash, ts)
       VALUES ($1,'0x188d586ddcf52439676ca21a244753fa19f9ea8e',$2,$3,$4,0,0,0,0,104700001,'0xbb',0,'0xgtx',NOW())`,
      [TB1.market, TB1.poolId, "0x00000000000000000000000000000000000bad00", SINK_BURN],
    );
    await current(wrong);

    const r = await runBurnPass(wrong, adapter(), new KeeperState(keeper), { minUsd: 0 });

    expect(r.burned).toEqual([]);
    expect(r.failed).toEqual(["0x00000000000000000000000000000000000bad00"]);
    expect(await ledgers()).toEqual(before);
  }, 120_000);

  it("leaves TB1's fraction of a cent alone at the default hundred dollar floor", async () => {
    const before = await ledgers();
    expect(before.pending + before.owed).toBeGreaterThan(0n);

    await current(db);
    const r = await runBurnPass(db, adapter(), new KeeperState(keeper), { minUsd: 100 });

    expect(r).toEqual({ behind: false, low: false, candidates: 1, swept: [], burned: [], skipped: [TB1.sink], failed: [] });
    expect(await ledgers()).toEqual(before);
  }, 120_000);

  it("sweeps and burns it with the floor lifted, and the supply falls by exactly what was accrued", async () => {
    const before = await ledgers();
    const state = new KeeperState(keeper);
    await current(db);

    // What the policy decided each write may cost — the limit and the fee `spend` priced its
    // reserve and ceiling at — recorded on the way into the real adapter.
    const chain = adapter();
    const priced: { what: string; gas: bigint; fee: bigint | undefined; hash: `0x${string}` }[] = [];
    const sweep = chain.sweep.bind(chain);
    const burn = chain.burn.bind(chain);
    const estimates: Record<string, bigint> = {};
    const estimateSweep = chain.estimateSweep.bind(chain);
    const estimateBurn = chain.estimateBurn.bind(chain);
    chain.estimateSweep = async (id) => (estimates.sweep = await estimateSweep(id));
    chain.estimateBurn = async (sink) => (estimates.burn = await estimateBurn(sink));
    chain.sweep = async (id, gas, fee) => {
      const hash = await sweep(id, gas, fee);
      priced.push({ what: "sweep", gas, fee, hash });
      return hash;
    };
    chain.burn = async (sink, gas, fee) => {
      const hash = await burn(sink, gas, fee);
      priced.push({ what: "burn", gas, fee, hash });
      return hash;
    };

    const r = await runBurnPass(db, chain, state, { minUsd: 0 });

    expect(r).toEqual({
      behind: false,
      low: false,
      candidates: 1,
      swept: [TB1.sink],
      burned: [TB1.sink],
      skipped: [],
      failed: [],
    });

    // The transactions AS MINED carry exactly that limit and exactly that fee: the wallet made no
    // estimate of its own, so `gas * maxFeePerGas` — which is under the ceiling — is the most
    // either could have cost on any node.
    expect(priced.map((p) => p.what)).toEqual(["sweep", "burn"]);
    const padded = estimates.sweep! + SWEEP_GAS_PAD;
    expect(priced[0]!.gas).toBe(padded + padded / 4n);
    expect(priced[1]!.gas).toBe(estimates.burn! + estimates.burn! / 4n);
    for (const p of priced) {
      const tx = await client.getTransaction({ hash: p.hash });
      expect(p.fee).toBeDefined();
      expect(tx.gas).toBe(p.gas);
      expect(tx.maxFeePerGas).toBe(p.fee);
      expect(tx.maxPriorityFeePerGas! <= tx.maxFeePerGas!).toBe(true);
      expect(tx.gas * tx.maxFeePerGas!).toBeLessThanOrEqual(BURN_MAX_TX_COST_WEI);
      expect((await client.getTransactionReceipt({ hash: p.hash })).status).toBe("success");
    }
    const after = await ledgers();
    expect(after.pending).toBe(0n);
    expect(after.owed).toBe(0n);
    expect(after.sinkBalance).toBe(0n);
    // A fork has no other traders, so what burned is what was there: both ledgers and any tokens
    // already sitting in the sink.
    expect(before.supply - after.supply).toBe(before.pending + before.owed + before.sinkBalance);
    expect(state.snapshot().burns).toBe(1);
    expect(state.snapshot().failed).toBe(0);

    // And the same process does not come back for more inside the day.
    await current(db);
    const again = await runBurnPass(db, adapter(), state, { minUsd: 0 });
    expect(again.burned).toEqual([]);
    expect(await ledgers()).toEqual(after);
  }, 180_000);
});
