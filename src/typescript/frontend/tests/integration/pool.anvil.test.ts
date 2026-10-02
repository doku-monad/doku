/**
 * @jest-environment node
 */
import { erc20Abi, parseEther } from "viem";

import { NATIVE_CURRENCY } from "../../src/lib/chain/addresses";
import type * as PoolModule from "../../src/lib/chain/pool";
import { type LocalChain, startLocalChain } from "./anvil";

/**
 * Trading a market after graduation, through the router a wallet actually uses.
 *
 * ## Why this one forks mainnet when the others do not
 *
 * The app swaps through Uniswap's `UniversalRouter`, which this repository does not vendor and
 * cannot deploy — so on an empty chain there is nothing to route through. Routing the test through
 * v4-core's `PoolSwapTest` instead would prove the pool works and prove nothing about the app,
 * because the two share no encoding: `PoolSwapTest` takes a `PoolKey` and a struct, while
 * UniversalRouter takes a command byte string and a parallel array of ABI-encoded inputs, one of
 * which is itself a nested `(actions, params)` pair. Almost everything that can go wrong in
 * `pool.ts` lives in that encoding.
 *
 * So this forks Monad mainnet, where the router, the PoolManager, V4Quoter and Permit2 all exist
 * at the addresses production uses, and `LocalScenario` deploys DOKU against them.
 *
 * ## Which UniversalRouter
 *
 * Two are live. Sampling 400 blocks of real `Swap` logs from the PoolManager and tallying the
 * indexed `sender` — the contract that called `swap` — gave 14 of 55 swaps to
 * `0x0d97dc33…` and **zero** to `0xFdf682F5…`, the newer v2.1.1 the plan had assumed was
 * canonical. The rest were aggregators routing through their own contracts. That is the answer to
 * OQ3, and it is the address configured here.
 *
 * Skips rather than fails without `MONAD_RPC_URL`, so the suite stays runnable offline — the
 * curve-phase integration tests cover everything before graduation and need no network.
 */
const FORK_RPC = process.env.MONAD_RPC_URL ?? "";
const describeFork = FORK_RPC ? describe : describe.skip;

const UNIVERSAL_ROUTER = "0x0d97dc33264bfc1c226207428a79b26757fb9dc3";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
/** Real USDC on Monad mainnet, which the fork carries along with its pools. */
const MAINNET_USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as const;

describeFork("pool trading on a graduated market", () => {
  let chain: LocalChain;
  /* The module's own type, taken from the module. `import type * as PoolModule` names a
     namespace, which is not itself a type — the annotation compiled only because the suite was
     outside `tsconfig`. */
  let pool: typeof PoolModule;

  /**
   * The pair, not just the token.
   *
   * `pool.ts` takes a `PoolMarket` — the token AND what it is priced in — because the quote asset
   * decides the sort order of the v4 key, which side of the swap is `zeroForOne`, and whether a buy
   * carries `value`. These call sites passed a bare token address, which was the shape before the
   * module was rewritten for v4 and had stopped compiling; nothing said so, because this suite was
   * outside `tsconfig` and this file is skipped without a fork RPC. The scenario launches a
   * native-MON market, so the quote is `NATIVE_CURRENCY`.
   */
  const market = () => ({ token: chain.token, quoteAsset: NATIVE_CURRENCY });

  beforeAll(async () => {
    chain = await startLocalChain(8571, { launchOnly: false, fork: true });

    /**
     * The app reads its addresses from the environment at MODULE LOAD, so they have to be set
     * before `pool.ts` is first imported — and the DOKU half of them is not known until the
     * scenario has run. Hence the dynamic import: a static one would capture whatever was in the
     * environment when jest hoisted it, which is nothing.
     */
    process.env.NEXT_PUBLIC_MONAD_CHAIN_ID = "143";
    process.env.NEXT_PUBLIC_MONAD_RPC_URL = chain.rpcUrl;
    process.env.NEXT_PUBLIC_DOKU_FACTORY = chain.factory;
    process.env.NEXT_PUBLIC_DOKU_GRADUATION = chain.factory;
    process.env.NEXT_PUBLIC_DOKU_REGISTRY = chain.factory;
    process.env.NEXT_PUBLIC_DOKU_HOOK = chain.hook;
    process.env.NEXT_PUBLIC_V4_POOL_MANAGER = chain.poolManager;
    process.env.NEXT_PUBLIC_V4_QUOTER = chain.quoter;
    process.env.NEXT_PUBLIC_V4_STATE_VIEW = chain.stateView;
    process.env.NEXT_PUBLIC_V4_POSITION_MANAGER = chain.poolManager;
    process.env.NEXT_PUBLIC_UNIVERSAL_ROUTER = UNIVERSAL_ROUTER;
    process.env.NEXT_PUBLIC_PERMIT2 = PERMIT2;

    /**
     * The registry has to be cleared, not just the environment set.
     *
     * `pool.ts` is imported dynamically for exactly the reason above, but it imports
     * `addresses.ts`, and THAT module was already evaluated — the static `NATIVE_CURRENCY` import
     * at the top of this file loads it when jest hoists, long before this runs. A dynamic import
     * then returns the cached copy, holding whatever addresses the environment had at hoist time.
     * The symptom was not a missing variable: `CONTRACTS.quoter` pointed at an address with no
     * code, so `quoteExactInputSingle` returned "0x" and every quote failed to decode.
     */
    jest.resetModules();
    pool = await import("../../src/lib/chain/pool");
  }, 600_000);

  afterAll(() => chain?.stop());

  const tokenBalance = () =>
    chain.publicClient.readContract({
      address: chain.token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [chain.wallet.account!.address],
    }) as Promise<bigint>;

  it("graduated into a pool that exists", async () => {
    const slot0 = (await chain.publicClient.readContract({
      address: chain.stateView,
      abi: [
        {
          type: "function",
          name: "getSlot0",
          stateMutability: "view",
          inputs: [{ type: "bytes32" }],
          outputs: [
            { type: "uint160" },
            { type: "int24" },
            { type: "uint24" },
            { type: "uint24" },
          ],
        },
      ] as const,
      functionName: "getSlot0",
      args: [chain.poolId],
    })) as readonly [bigint, number, number, number];
    expect(slot0[0]).toBeGreaterThan(0n);
  }, 120_000);

  /**
   * The quote path, against the quoter the app actually calls.
   *
   * `V4Quoter` is not a view function — it performs the swap and reverts with the result — so this
   * also proves the app SIMULATES it rather than reading it, which is the mistake that turns a
   * working quote into a permanent "call reverted" in the UI.
   */
  it("quotes a buy through V4Quoter", async () => {
    const out = await pool.quotePoolBuy(chain.publicClient, market(), parseEther("1"));
    expect(out).toBeGreaterThan(0n);
  }, 120_000);

  it("quotes a sell in the other direction", async () => {
    const held = await tokenBalance();
    expect(held).toBeGreaterThan(0n);
    const out = await pool.quotePoolSell(chain.publicClient, market(), held / 100n);
    expect(out).toBeGreaterThan(0n);
  }, 120_000);

  /**
   * A buy, end to end, through UniversalRouter.
   *
   * This is the assertion the whole fork exists for: the command byte, the nested action string,
   * `SETTLE_ALL`/`TAKE_ALL` and the `PoolKey` all have to be right together, and any one of them
   * wrong is a revert rather than a wrong number. A native-MON buy needs no approval at all, which
   * is the one place v4 is simpler than V3 rather than harder.
   */
  it("buys from the pool with native MON, in one signature", async () => {
    const before = await tokenBalance();
    const monIn = parseEther("1");
    const quoted = await pool.quotePoolBuy(chain.publicClient, market(), monIn);

    const hash = await pool.buyFromPool(chain.wallet, chain.publicClient, {
      ...market(),
      quoteIn: monIn,
      quoted,
      slippageBps: 500,
    });
    const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
    expect(await tokenBalance()).toBeGreaterThan(before);
  }, 180_000);

  /**
   * The multi-hop encoder, against a real two-pool route on the fork.
   *
   * This is the launch page's dev buy and the first two thirds of a graduated market's MON buy:
   * `SWAP_EXACT_IN` rather than `SWAP_EXACT_IN_SINGLE`, a `PathKey[]` rather than a `PoolKey`, and
   * a `SETTLE_ALL` that names native MON while `TAKE_ALL` names an asset two pools away. Every one
   * of those is a different encoding from the single-pool swap above, and a mistake in any of them
   * is a revert rather than a wrong number.
   *
   * The route is chosen by the app's own `quoteZapRoutes` against the real mainnet pools the fork
   * carries, so this also exercises the candidate walk and the choice — not a path written by hand
   * in a test to match the code it is testing.
   */
  it("swaps MON into another asset across a real multi-hop route", async () => {
    const zap = await import("../../src/lib/chain/zap");
    const monIn = parseEther("5");
    const route = await zap.quoteZapRoutes(chain.publicClient, {
      quoteAsset: MAINNET_USDC,
      amountIn: monIn,
    });
    // A fork of mainnet has the MON/USDC pool in it. No route here means the fork is not what this
    // test thinks it is, and asserting on a swap afterwards would report that as an encoding bug.
    expect(route).not.toBeNull();
    expect(route!.amountOut).toBeGreaterThan(0n);

    const owner = chain.wallet.account!.address;
    const balance = () =>
      chain.publicClient.readContract({
        address: MAINNET_USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
      }) as Promise<bigint>;

    const before = await balance();
    const hash = await pool.swapNativeFor(chain.wallet, chain.publicClient, {
      path: route!.pathKeys,
      amountIn: monIn,
      // Five percent, because a fork's pool moves under the quote as this test's own earlier
      // swaps land. The floor being exercised is that TAKE_ALL names the LAST currency.
      minOut: (route!.amountOut * 95n) / 100n,
    });
    const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
    expect(await balance()).toBeGreaterThan(before);
  }, 180_000);

  /**
   * The same encoder ending inside a DOKU pool, which is the part with a HOOK on it.
   *
   * A graduated market's MON buy is one swap that ends in the market's own pool, and that pool is
   * not an ordinary one: `DokuHook` runs on every swap and takes the levy. The route here is a
   * single hop because the scenario's market is priced in MON — the panel would never offer MON on
   * such a market, and it does not have to for this to be the assertion that matters, which is that
   * the multi-hop form settles a hooked pool correctly and takes the market's own token out.
   */
  it("buys a graduated market's token with MON through the multi-hop form", async () => {
    const before = await tokenBalance();
    const key = await import("../../src/lib/chain/addresses").then((m) =>
      m.poolKeyFor(chain.token, NATIVE_CURRENCY),
    );
    const hash = await pool.buyFromPoolWithNative(chain.wallet, chain.publicClient, {
      path: [
        {
          intermediateCurrency: chain.token,
          fee: key.fee,
          tickSpacing: key.tickSpacing,
          hooks: key.hooks,
          hookData: "0x",
        },
      ],
      amountIn: parseEther("1"),
      // A floor of one raw unit: the assertion is that the swap SETTLES, and a tight bound on a
      // fork whose price this suite keeps moving would fail for a reason that is not the encoding.
      minOut: 1n,
    });
    const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
    expect(await tokenBalance()).toBeGreaterThan(before);
  }, 180_000);

  /**
   * A sell, which needs the two-step Permit2 allowance.
   *
   * UniversalRouter holds no allowance of its own: the token approves PERMIT2, and Permit2 is then
   * told to let the ROUTER spend. Approving the router directly is the trap — that transaction
   * succeeds and the swap still reverts. Both halves are exercised here, through the same helper
   * the UI uses to decide which signatures to ask for.
   */
  it("sells to the pool, through Permit2", async () => {
    const held = await tokenBalance();
    const tokensIn = held / 50n;
    expect(tokensIn).toBeGreaterThan(0n);

    const owner = chain.wallet.account!.address;
    const needed = await pool.permit2ApprovalsNeeded(chain.publicClient, {
      token: chain.token,
      owner,
      amount: tokensIn,
    });
    // Nothing has been approved on a fresh market, so both must be reported as missing. A helper
    // that said "nothing needed" here would send the user straight into a reverting swap.
    expect(needed.needsTokenApproval).toBe(true);
    expect(needed.needsPermit2Approval).toBe(true);

    const approve = await chain.wallet.writeContract({
      address: chain.token,
      abi: erc20Abi,
      functionName: "approve",
      args: [PERMIT2 as `0x${string}`, (1n << 160n) - 1n],
      chain: chain.wallet.chain,
      account: chain.wallet.account!,
    });
    await chain.publicClient.waitForTransactionReceipt({ hash: approve });

    const permit = await chain.wallet.writeContract({
      address: PERMIT2 as `0x${string}`,
      abi: [
        {
          type: "function",
          name: "approve",
          stateMutability: "nonpayable",
          inputs: [
            { name: "token", type: "address" },
            { name: "spender", type: "address" },
            { name: "amount", type: "uint160" },
            { name: "expiration", type: "uint48" },
          ],
          outputs: [],
        },
      ] as const,
      functionName: "approve",
      args: [
        chain.token,
        UNIVERSAL_ROUTER as `0x${string}`,
        (1n << 160n) - 1n,
        Number((1n << 48n) - 1n),
      ],
      chain: chain.wallet.chain,
      account: chain.wallet.account!,
    });
    await chain.publicClient.waitForTransactionReceipt({ hash: permit });

    // And now the helper agrees there is nothing left to sign.
    const after = await pool.permit2ApprovalsNeeded(chain.publicClient, {
      token: chain.token,
      owner,
      amount: tokensIn,
    });
    expect(after.needsTokenApproval).toBe(false);
    expect(after.needsPermit2Approval).toBe(false);

    const quoted = await pool.quotePoolSell(chain.publicClient, market(), tokensIn);
    const hash = await pool.sellToPool(chain.wallet, chain.publicClient, {
      ...market(),
      tokensIn,
      quoted,
      slippageBps: 500,
    });
    const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
    expect(await tokenBalance()).toBeLessThan(held);
  }, 240_000);

  /**
   * The slippage floor is enforced by the venue, not by the UI.
   *
   * Asking for more out than the pool can give must revert. A floor the frontend merely displays
   * is not a floor.
   */
  it("reverts when the slippage floor cannot be met", async () => {
    const monIn = parseEther("1");
    const quoted = await pool.quotePoolBuy(chain.publicClient, market(), monIn);
    await expect(
      pool.buyFromPool(chain.wallet, chain.publicClient, {
        ...market(),
        quoteIn: monIn,
        // Twice what the pool just said it would give, at zero tolerance.
        quoted: quoted * 2n,
        slippageBps: 0,
      }),
    ).rejects.toThrow();
  }, 180_000);
});
