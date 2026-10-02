import { type Chain, type ContractFunctionParameters, createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createNonceManager, jsonRpc } from "viem/nonce";
import type { BurnChain } from "./burn.js";
import type { FundingChain, KeeperChain } from "./keeper.js";
import type { PayoutChain } from "./payout.js";

/**
 * The keeper's chain port, backed by viem.
 *
 * Kept apart from `keeper.ts` so the policy there never imports a signer: the unit tests drive it
 * against a fake, and this file is the only place a private key is ever turned into an account.
 */

const graduationAbi = parseAbi([
  "function graduated(address curve) view returns (bool)",
  "function graduate(address curve) returns (bytes32 id, uint256 tokenId)",
]);

const curveAbi = parseAbi([
  "function readyToGraduate() view returns (bool)",
  "function autoGraduationGasHint() view returns (uint256)",
  // The holders' share of curve trades, left on the curve at graduation until somebody collects it.
  "function pendingFees() view returns (uint256)",
  "function collectFees()",
]);

/** `SeedLocker`, which `DokuGraduation` constructs and holds as a public immutable. */
const lockerAbi = parseAbi([
  "function locker() view returns (address)",
  "function collect(uint256 tokenId)",
]);

/**
 * The hook's two sink ledgers and the one call that moves money between them.
 *
 * `PoolId` is a user-defined value type over `bytes32`, so the selector is the one this signature
 * hashes to and there is nothing to translate.
 */
const hookAbi = parseAbi([
  "function pendingSink(bytes32 id) view returns (uint256)",
  "function owedSink(bytes32 id) view returns (uint256)",
  "function sweep(bytes32 id)",
]);

const vaultAbi = parseAbi([
  "function currentInterval() view returns (uint256)",
  "function fund() returns (uint256 amount)",
  "function epochCount() view returns (uint256)",
  "function snapshotBlockFor(uint256 k) view returns (uint256)",
  "function createEpochs(uint256 maxSteps) returns (uint256 opened)",
  // The payout half: what an epoch holds, who may claim it, and the one call that pays a holder.
  "function epochs(uint256 k) view returns (uint256 snapshotBlock, uint256 amount, uint256 eligibleSupply, uint256 claimed)",
  "function sweepableFrom(uint256 k) view returns (uint256)",
  "function isExcluded(address who) view returns (bool)",
  "function weightOf(address holder, uint256 epochIndex) view returns (uint256)",
  "function hasClaimed(uint256 k, address holder) view returns (bool)",
  "function claim(address holder, uint256 from, uint256 to) returns (uint256 total)",
]);

/**
 * `DokuHook.markets(id)`: the hook's own record of a pool, written once by the graduator at
 * `registerPool` and never changed. Field order is the struct's packing order in `DokuHook.sol`;
 * `test/burn-fork.test.ts` reads it off the deployed hook, so a drift here fails there.
 */
const hookMarketAbi = parseAbi([
  "struct Market { bool registered; uint8 sink; uint16 protocolBps; uint16 sinkBps; bool seeded; bool quoteIsCurrency0; uint16 creatorTaxBps; address sinkAddr; uint16 makerBps0; uint16 makerBps1; uint128 seedLiquidity; int24 seedTickLower; int24 seedTickUpper; }",
  "function markets(bytes32 id) view returns (Market)",
]);

/** A market's `BurnSink`: one call, no arguments, which pulls the hook's owed ledger and burns it. */
const burnSinkAbi = parseAbi(["function burn() returns (uint256 amount)"]);

export function viemKeeperChain(opts: {
  chain: Chain;
  rpcUrl: string;
  privateKey: `0x${string}`;
  graduation: `0x${string}`;
  /** The generation's `DokuHook`. Absent means no funding pass; graduations are unaffected. */
  hook?: `0x${string}`;
}): KeeperChain & FundingChain & PayoutChain & BurnChain {
  /*
   * One nonce source for four jobs. Graduation, funding, payout and burn each sign from this account on
   * their own clocks, and viem's default fills a nonce from `getTransactionCount(pending)` at send
   * time — two sends in the same window read the same count and the second is rejected as a
   * replacement, which lands in that market's backoff as a failure it did not earn. The nonce
   * manager hands out consecutive nonces in-process and resyncs from the node.
   */
  const account = privateKeyToAccount(opts.privateKey, {
    nonceManager: createNonceManager({ source: jsonRpc() }),
  });
  /*
   * The keeper's OWN transport, not the ingest loop's. A payout pass over a market with thousands
   * of holders is thousands of reads, and on the shared client they queued in front of every
   * ingest pass; here they batch into JSON-RPC arrays on a transport nothing else waits on.
   */
  const client = createPublicClient({
    chain: opts.chain,
    transport: http(opts.rpcUrl, { batch: { wait: 16 } }),
    cacheTime: 0,
  });
  const wallet = createWalletClient({ account, chain: opts.chain, transport: http(opts.rpcUrl) });
  const { graduation } = opts;

  /**
   * The hook, or a loud failure.
   *
   * Every funding method needs it and none of them can invent it. Throwing here rather than at
   * configuration time keeps the graduation half usable on a deployment that has no `DOKU_HOOK2`,
   * which is the same rollback the rest of gen 2 has.
   */
  const hook = (): `0x${string}` => {
    if (!opts.hook) throw new Error("no hook configured: the funding pass needs DOKU_HOOK2");
    return opts.hook;
  };

  /**
   * `SeedLocker`, read off the graduator once and remembered.
   *
   * It is `DokuGraduation.locker()`, a public immutable set in that contract's constructor — so
   * asking the graduator is strictly better than a new environment variable: a deployment cannot
   * configure the wrong locker, and there is nothing to keep in step when a generation moves.
   */
  let lockerAddress: Promise<`0x${string}`> | null = null;
  const locker = (): Promise<`0x${string}`> => {
    lockerAddress ??= client.readContract({
      address: graduation,
      abi: lockerAbi,
      functionName: "locker",
    });
    return lockerAddress;
  };

  /**
   * The fee fields a write is SIGNED with, from the fee its caller's guards were priced at.
   *
   * Left alone, `writeContract` does not sign at the fee `feePerGas()` reported. Monad's RPC
   * implements `eth_fillTransaction` (checked 2026-09-19), viem asks it to complete every
   * transaction a local account sends, and whatever fee the node answers with — times 1.2 — is what
   * gets signed. The reserve and ceiling checks, made a moment earlier against a different
   * estimate, then bound a number that is not the one on the transaction: against a mock node that
   * answered the second question differently, a write that passed a 0.25 MON ceiling was signed at
   * 14.39 MON.
   *
   * viem keeps a caller's own `gas`, `maxFeePerGas` and `maxPriorityFeePerGas` over the node's, so
   * supplying all three makes `gas * fee` the most the transaction can cost on any node.
   * `test/keeper-chain-fees.test.ts` pins exactly that against a node that offers a hostile fill,
   * because it is a library's behaviour and a library can change.
   *
   * ALWAYS 1559, and always both fields. The tip is the one that came with the priced estimate,
   * capped at the fee. When that estimate fell back to the legacy gas price there is no tip to
   * reuse, so the tip is the fee itself: `min(base + tip, maxFee)` is then simply the fee, which is
   * what the guards priced — dearer than it need be on a rare fallback, and never more than was
   * checked. Signing legacy instead would leave `maxFeePerGas` unset for a fill to supply.
   * No fee given — a caller that predates this — leaves viem's own behaviour untouched.
   */
  let lastTip: bigint | null = null;
  const signedAt = (fee: bigint | undefined): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | Record<string, never> => {
    if (fee === undefined) return {};
    const tip = lastTip === null || lastTip > fee ? fee : lastTip;
    return { maxFeePerGas: fee, maxPriorityFeePerGas: tip };
  };

  return {
    address: account.address,
    graduated: (curve) =>
      client.readContract({ address: graduation, abi: graduationAbi, functionName: "graduated", args: [curve] }),
    ready: (curve) =>
      client.readContract({ address: curve, abi: curveAbi, functionName: "readyToGraduate" }),
    gasHint: (curve) =>
      client.readContract({ address: curve, abi: curveAbi, functionName: "autoGraduationGasHint" }),
    balance: () => client.getBalance({ address: account.address }),
    gasPrice: () => client.getGasPrice(),
    async feePerGas() {
      try {
        const { maxFeePerGas, maxPriorityFeePerGas } = await client.estimateFeesPerGas();
        if (maxFeePerGas !== undefined && maxFeePerGas > 0n) {
          lastTip = maxPriorityFeePerGas ?? 0n;
          return maxFeePerGas;
        }
      } catch {
        // No 1559 estimate from this node: fall through to the legacy price with a margin.
      }
      lastTip = null;
      return ((await client.getGasPrice()) * 125n) / 100n;
    },
    async graduate(curve, gas, fee) {
      // Simulated first because a revert here is free and a revert on chain is billed at the
      // limit. The simulation's request carries the gas so the send uses the same limit.
      const { request } = await client.simulateContract({
        address: graduation,
        abi: graduationAbi,
        functionName: "graduate",
        args: [curve],
        account,
        gas,
      });
      const hash = await wallet.writeContract({ ...request, gas, ...signedAt(fee) } as typeof request);
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`graduate(${curve}) reverted in ${hash}`);
      return hash;
    },

    // ------------------------------------------------------------------- the funding half

    currentInterval: (vault) =>
      client.readContract({ address: vault, abi: vaultAbi, functionName: "currentInterval" }),
    curveFees: (curve) => client.readContract({ address: curve, abi: curveAbi, functionName: "pendingFees" }),
    estimateCollectFees: (curve) =>
      client.estimateContractGas({ address: curve, abi: curveAbi, functionName: "collectFees", account }),
    async collectFees(curve, gas, fee) {
      const { request } = await client.simulateContract({
        address: curve,
        abi: curveAbi,
        functionName: "collectFees",
        account,
        gas,
      });
      const hash = await wallet.writeContract({ ...request, gas, ...signedAt(fee) } as typeof request);
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`collectFees() on ${curve} reverted in ${hash}`);
      return hash;
    },
    pendingSink: (poolId) =>
      client.readContract({ address: hook(), abi: hookAbi, functionName: "pendingSink", args: [poolId] }),
    owedSink: (poolId) =>
      client.readContract({ address: hook(), abi: hookAbi, functionName: "owedSink", args: [poolId] }),

    /**
     * Not quotable on this chain, and it says so rather than saying zero.
     *
     * v4's PositionManager exposes no fee getter. The two honest reconstructions are a simulated
     * zero-liquidity `DECREASE_LIQUIDITY` — which `eth_call` cannot give us, because the number we
     * want is a state change inside the call and not its return value — and `StateView`'s
     * `getPositionInfo`/`getFeeGrowthInside` pair, which is exact and two reads, and which Monad
     * MAINNET cannot serve: `StateView` is listed "not deployed" there (`docs/doku/deployments.md`).
     *
     * `frontend/src/lib/chain/position-fees.ts` reaches the same wall and takes the same position:
     * "Returning nothing renders as a dash beside a Collect action, which is true. Returning zero
     * would be a claim, and the wrong one." The keeper's caller has a fallback for `null` — the
     * pool's swap height, which cannot say how much has accrued but can prove nothing has — and
     * would have no defence at all against a fabricated zero. When a `StateView` is deployed on
     * the network this process serves, this is the one function that changes.
     */
    seedFees: () => Promise.resolve(null),

    estimateCollect: async (tokenId) =>
      client.estimateContractGas({
        address: await locker(),
        abi: lockerAbi,
        functionName: "collect",
        args: [tokenId],
        account,
      }),
    async collect(tokenId, gas, fee) {
      const address = await locker();
      const { request } = await client.simulateContract({
        address,
        abi: lockerAbi,
        functionName: "collect",
        args: [tokenId],
        account,
        gas,
      });
      const hash = await wallet.writeContract({ ...request, gas, ...signedAt(fee) } as typeof request);
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`collect(${tokenId}) reverted in ${hash}`);
      return hash;
    },

    estimateSweep: (poolId) =>
      client.estimateContractGas({
        address: hook(),
        abi: hookAbi,
        functionName: "sweep",
        args: [poolId],
        account,
      }),
    async sweep(poolId, gas, fee) {
      const { request } = await client.simulateContract({
        address: hook(),
        abi: hookAbi,
        functionName: "sweep",
        args: [poolId],
        account,
        gas,
      });
      const hash = await wallet.writeContract({ ...request, gas, ...signedAt(fee) } as typeof request);
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`sweep(${poolId}) reverted in ${hash}`);
      return hash;
    },

    estimateFund: (vault) =>
      client.estimateContractGas({ address: vault, abi: vaultAbi, functionName: "fund", account }),
    async fund(vault, gas, fee) {
      const { request } = await client.simulateContract({
        address: vault,
        abi: vaultAbi,
        functionName: "fund",
        account,
        gas,
      });
      const hash = await wallet.writeContract({ ...request, gas, ...signedAt(fee) } as typeof request);
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`fund() on ${vault} reverted in ${hash}`);
      return hash;
    },

    blockNumber: () => client.getBlockNumber(),
    epochCount: (vault) => client.readContract({ address: vault, abi: vaultAbi, functionName: "epochCount" }),
    snapshotBlockFor: (vault, k) =>
      client.readContract({ address: vault, abi: vaultAbi, functionName: "snapshotBlockFor", args: [k] }),
    estimateCreateEpochs: (vault, maxSteps) =>
      client.estimateContractGas({
        address: vault,
        abi: vaultAbi,
        functionName: "createEpochs",
        args: [maxSteps],
        account,
      }),
    async createEpochs(vault, maxSteps, gas, fee) {
      const { request } = await client.simulateContract({
        address: vault,
        abi: vaultAbi,
        functionName: "createEpochs",
        args: [maxSteps],
        account,
        gas,
      });
      const hash = await wallet.writeContract({ ...request, gas, ...signedAt(fee) } as typeof request);
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`createEpochs() on ${vault} reverted in ${hash}`);
      return hash;
    },

    // ------------------------------------------------------------------- the burn half

    async sinkOf(poolId) {
      const m = await client.readContract({
        address: hook(),
        abi: hookMarketAbi,
        functionName: "markets",
        args: [poolId],
      });
      return { registered: m.registered, kind: m.sink, sinkAddr: m.sinkAddr };
    },
    estimateBurn: (sink) =>
      client.estimateContractGas({ address: sink, abi: burnSinkAbi, functionName: "burn", account }),
    /**
     * `BurnSink.burn()`. The sink pulls `owedSink` from the hook itself and destroys its whole
     * balance, so the keeper chooses only WHEN: it names no amount and no recipient, and there is
     * nothing for a leaked key to redirect.
     */
    async burn(sink, gas, fee) {
      const { request } = await client.simulateContract({
        address: sink,
        abi: burnSinkAbi,
        functionName: "burn",
        account,
        gas,
      });
      const hash = await wallet.writeContract({ ...request, gas, ...signedAt(fee) } as typeof request);
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`burn() on ${sink} reverted in ${hash}`);
      return hash;
    },

    // ------------------------------------------------------------------- the payout half

    epoch: async (vault, k) => {
      const [snapshotBlock, amount, eligibleSupply, claimed] = await client.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "epochs",
        args: [k],
      });
      return { snapshotBlock, amount, eligibleSupply, claimed };
    },
    sweepableFrom: (vault, k) =>
      client.readContract({ address: vault, abi: vaultAbi, functionName: "sweepableFrom", args: [k] }),
    /**
     * One holder's standing in every open epoch, in ONE round trip: `isExcluded`, then `weightOf`
     * and `hasClaimed` per epoch, through Multicall3. Sequential reads made a two-thousand-holder
     * market a hundred thousand round trips a pass.
     */
    async holderEpochs(vault, holder, epochs) {
      // Three shapes in one array: typed loosely here and narrowed on the way out, which is
      // exactly as safe as three separate typed reads because the ABI fixes each return.
      const contracts: ContractFunctionParameters[] = [
        { address: vault, abi: vaultAbi, functionName: "isExcluded", args: [holder] },
        ...epochs.map((k) => ({ address: vault, abi: vaultAbi, functionName: "weightOf", args: [holder, k] })),
        ...epochs.map((k) => ({ address: vault, abi: vaultAbi, functionName: "hasClaimed", args: [k, holder] })),
      ];
      /*
       * `allowFailure: true`: one reverting leaf must not throw the whole holder into backoff
       * and, after six passes, out of the walk until restart. A failed `isExcluded` reads as
       * excluded, a failed `weightOf` as no weight and a failed `hasClaimed` as claimed — every
       * one of which makes the pass SKIP, never send. The holder is seen again on the next walk.
       */
      const results = await client.multicall({ allowFailure: true, contracts });
      const n = epochs.length;
      const ok = <T>(i: number, fallback: T): T => {
        const r = results[i];
        return r && r.status === "success" ? (r.result as T) : fallback;
      };
      return {
        excluded: ok<boolean>(0, true),
        weights: epochs.map((_, i) => ok<bigint>(1 + i, 0n)),
        claimed: epochs.map((_, i) => ok<boolean>(1 + n + i, true)),
      };
    },
    estimateClaim: (vault, holder, from, to) =>
      client.estimateContractGas({
        address: vault,
        abi: vaultAbi,
        functionName: "claim",
        args: [holder, from, to],
        account,
      }),
    /**
     * `claim(holder, from, to)`, never `claimTo`: the contract pays `holder` and only `holder`,
     * whoever signs. The keeper can choose whom to pay and pay the gas, and can do nothing else.
     */
    async claim(vault, holder, from, to, gas, fee) {
      const { request } = await client.simulateContract({
        address: vault,
        abi: vaultAbi,
        functionName: "claim",
        args: [holder, from, to],
        account,
        gas,
      });
      const hash = await wallet.writeContract({ ...request, gas, ...signedAt(fee) } as typeof request);
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`claim(${holder}, ${from}, ${to}) on ${vault} reverted in ${hash}`);
      return hash;
    },
  };
}
