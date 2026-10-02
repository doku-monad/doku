import http from "node:http";
import { defineChain, parseTransaction } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BURN_MAX_TX_COST_WEI } from "../src/indexer/processing/burn.js";
import { viemKeeperChain } from "../src/indexer/processing/keeper-chain.js";
import { KeeperState, spend } from "../src/indexer/processing/keeper.js";

/**
 * What the keeper SIGNS, against a node that cannot be trusted about fees or gas.
 *
 * `spend()` prices a write — the reserve guard, and the burn pass's ceiling — at one fee. Left to
 * itself the wallet asks the node for fees AGAIN at signing time, and on a node that implements
 * `eth_fillTransaction` it lets the node fill in gas and fees outright. Either way the guards bound
 * a number that is not the one on the transaction: measured here, a write that passed a 0.25 MON
 * ceiling was signed for more than 14 MON.
 *
 * The node below is honest until the adapter has simulated the write, and hostile from then on —
 * which is exactly the moment the wallet prepares and signs: a 100,000 gwei tip, and an
 * `eth_fillTransaction` (Monad's RPC really implements it) that offers a 30M gas limit and the
 * same absurd fee. viem DOES ask it to fill; what is pinned here is that the keeper's own gas and
 * fee survive that, which is viem's behaviour today and must stay its behaviour on every upgrade.
 * Every assertion is on the raw transaction handed to `eth_sendRawTransaction`, the only thing
 * that is real.
 * Nothing here touches a network: the node is an HTTP server on a loopback port, and the key is
 * anvil's first.
 */

const GWEI = 10n ** 9n;
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const HOSTILE_TIP = 100_000n * GWEI;
const HOSTILE_GAS = 30_000_000n;
const ESTIMATE = 115_000n;
const hex = (n: bigint | number): string => `0x${BigInt(n).toString(16)}`;
const word = `0x${"00".repeat(31)}01${"00".repeat(31)}01` as const;

describe("what the keeper signs, against a node that lies about fees and gas", () => {
  let server: http.Server;
  let rpcUrl: string;
  let methods: string[] = [];
  let raws: `0x${string}`[] = [];
  /** The node turns hostile once a write has been simulated: from then on it is signing time. */
  const hostile = (): boolean => methods.includes("eth_call");

  const answer = (method: string, params: unknown[]): unknown => {
    methods.push(method);
    switch (method) {
      case "eth_chainId":
        return hex(143);
      case "eth_getBlockByNumber":
        return { number: hex(1000), baseFeePerGas: hex(100n * GWEI), timestamp: hex(1), hash: `0x${"11".repeat(32)}`, transactions: [] };
      case "eth_maxPriorityFeePerGas":
        return hex(hostile() ? HOSTILE_TIP : 2n * GWEI);
      case "eth_gasPrice":
        return hex(hostile() ? HOSTILE_TIP : 102n * GWEI);
      case "eth_estimateGas":
        return hex(ESTIMATE);
      case "eth_call":
        return word;
      case "eth_getTransactionCount":
        return hex(7);
      case "eth_getBalance":
        return hex(78n * 10n ** 18n);
      case "eth_fillTransaction": {
        // A node that offers to complete the transaction itself. viem uses this for a local
        // account's gas ESTIMATE too, so it answers honestly until signing time, like everything
        // else here — and generously afterwards.
        const req = (params[0] ?? {}) as Record<string, string>;
        const lie = hostile();
        return {
          raw: "0x",
          tx: {
            type: "0x2",
            chainId: hex(143),
            nonce: req.nonce ?? hex(7),
            from: req.from,
            to: req.to,
            input: req.data ?? req.input ?? "0x",
            value: "0x0",
            gas: hex(lie ? HOSTILE_GAS : ESTIMATE),
            maxFeePerGas: hex(lie ? HOSTILE_TIP : 122n * GWEI),
            maxPriorityFeePerGas: hex(lie ? HOSTILE_TIP : 2n * GWEI),
            accessList: [],
            hash: `0x${"cd".repeat(32)}`,
          },
        };
      }
      case "eth_sendRawTransaction":
        raws.push(params[0] as `0x${string}`);
        return `0x${"ab".repeat(32)}`;
      case "eth_getTransactionReceipt":
        return {
          status: "0x1",
          transactionHash: `0x${"ab".repeat(32)}`,
          blockNumber: hex(1002),
          blockHash: `0x${"11".repeat(32)}`,
          transactionIndex: "0x0",
          from: `0x${"00".repeat(20)}`,
          to: `0x${"00".repeat(20)}`,
          cumulativeGasUsed: "0x1",
          gasUsed: "0x1",
          effectiveGasPrice: "0x1",
          logs: [],
          logsBloom: `0x${"00".repeat(256)}`,
          type: "0x2",
          contractAddress: null,
        };
      case "eth_blockNumber":
        return hex(1010);
      case "eth_getTransactionByHash":
        return null;
      default:
        throw new Error(`unmocked ${method}`);
    }
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        const parsed = JSON.parse(body) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
        const one = (r: { id: number; method: string; params: unknown[] }) => {
          try {
            return { jsonrpc: "2.0", id: r.id, result: answer(r.method, r.params) };
          } catch (e) {
            return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: (e as Error).message } };
          }
        };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    rpcUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    methods = [];
    raws = [];
  });

  const adapter = () => {
    const chain = defineChain({
      id: 143,
      name: "Monad (mock)",
      nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    return viemKeeperChain({
      chain,
      rpcUrl,
      privateKey: ANVIL_KEY,
      graduation: `0x${"22".repeat(20)}`,
      hook: `0x${"33".repeat(20)}`,
    });
  };

  const SINK = `0x${"44".repeat(20)}` as const;
  const POOL = `0x${"55".repeat(32)}` as const;

  it("is a hostile node: a write handed no fee is signed at whatever it says, far past the ceiling", async () => {
    const k = adapter();
    const priced = await k.feePerGas();

    await k.burn(SINK, 143_750n);

    const tx = parseTransaction(raws[0]!);
    expect(priced).toBeLessThan(1_000n * GWEI);
    expect(tx.gas! * tx.maxFeePerGas!).toBeGreaterThan(BURN_MAX_TX_COST_WEI);
  });

  it("signs a burn at exactly the limit and the fee spend() priced, whatever the node offers to fill in", async () => {
    const k = adapter();
    const state = new KeeperState(k.address);
    const purse = { wei: await k.balance() };
    let priced: { gas: bigint; fee: bigint } | null = null;

    const hash = await spend(
      k,
      state,
      purse,
      "burn the sink",
      {},
      () => k.estimateBurn(SINK),
      (gas, fee) => {
        priced = { gas, fee };
        return k.burn(SINK, gas, fee);
      },
      BURN_MAX_TX_COST_WEI,
    );

    expect(hash).not.toBeNull();
    const tx = parseTransaction(raws[0]!);
    expect(priced).toEqual({ gas: ESTIMATE + ESTIMATE / 4n, fee: tx.maxFeePerGas });
    expect(tx.gas).toBe(ESTIMATE + ESTIMATE / 4n);
    expect(tx.maxPriorityFeePerGas! <= tx.maxFeePerGas!).toBe(true);
    expect(tx.gas! * tx.maxFeePerGas!).toBeLessThanOrEqual(BURN_MAX_TX_COST_WEI);
    expect(tx.chainId).toBe(143);
    // The node WAS asked, and its 30M gas and 100,000 gwei were on offer. They are not on the transaction.
    expect(methods).toContain("eth_fillTransaction");
    expect(tx.gas).not.toBe(HOSTILE_GAS);
    expect(tx.maxFeePerGas).not.toBe(HOSTILE_TIP);
  });

  const FEE = 123n * GWEI;
  const GAS = 200_000n;
  const writes: [string, (k: ReturnType<typeof adapter>) => Promise<`0x${string}`>][] = [
    ["graduate", (k) => k.graduate(`0x${"66".repeat(20)}`, GAS, FEE)],
    ["collect", (k) => k.collect(7n, GAS, FEE)],
    ["collectFees", (k) => k.collectFees(`0x${"66".repeat(20)}`, GAS, FEE)],
    ["sweep", (k) => k.sweep(POOL, GAS, FEE)],
    ["fund", (k) => k.fund(SINK, GAS, FEE)],
    ["createEpochs", (k) => k.createEpochs(SINK, 3n, GAS, FEE)],
    ["claim", (k) => k.claim(SINK, `0x${"77".repeat(20)}`, 0n, 2n, GAS, FEE)],
    ["burn", (k) => k.burn(SINK, GAS, FEE)],
  ];

  it.each(writes)("%s is signed at the fee and limit it was given, in every job", async (_name, send) => {
    const k = adapter();
    await k.feePerGas(); // the estimate a caller's guards were priced with; the node lies from here on

    await send(k);

    const tx = parseTransaction(raws[raws.length - 1]!);
    expect(tx.gas).toBe(GAS);
    expect(tx.maxFeePerGas).toBe(FEE);
    expect(tx.maxPriorityFeePerGas! <= FEE).toBe(true);
    expect(methods).toContain("eth_fillTransaction");
  });

  it("still signs 1559 at the priced fee when the estimate fell back to the legacy gas price, leaving nothing for a fill to supply", async () => {
    const k = adapter();
    // The 1559 estimate fails (a transient RPC error is enough), so `feePerGas()` answers with the
    // legacy price and its margin — and there is no tip to reuse.
    const honest = answer;
    const swap = (handler: (method: string, params: unknown[]) => unknown) => {
      server.removeAllListeners("request");
      server.on("request", (req, res) => {
        let body = "";
        req.on("data", (c: Buffer) => (body += c.toString()));
        req.on("end", () => {
          const parsed = JSON.parse(body) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
          const one = (r: { id: number; method: string; params: unknown[] }) => {
            try {
              return { jsonrpc: "2.0", id: r.id, result: handler(r.method, r.params) };
            } catch (e) {
              return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: (e as Error).message } };
            }
          };
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)));
        });
      });
    };
    swap((method, params) => {
      // Both halves of the 1559 estimate: with only the tip missing viem derives one from
      // `gasPrice - baseFee`, and the estimate succeeds after all.
      if ((method === "eth_maxPriorityFeePerGas" || method === "eth_getBlockByNumber") && !hostile()) {
        throw new Error("upstream timeout");
      }
      return honest(method, params);
    });

    try {
      const fee = await k.feePerGas();
      await k.burn(SINK, GAS, fee);

      const tx = parseTransaction(raws[raws.length - 1]!);
      expect(fee).toBe((102n * GWEI * 125n) / 100n);
      expect(tx.type).toBe("eip1559");
      expect(tx.maxFeePerGas).toBe(fee);
      expect(tx.maxPriorityFeePerGas).toBe(fee);
      expect(tx.gas).toBe(GAS);
    } finally {
      swap(honest);
    }
  });
});
