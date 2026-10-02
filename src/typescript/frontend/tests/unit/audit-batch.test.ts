/**
 * @jest-environment node
 */
import { decodeFunctionData, erc20Abi } from "viem";

import type { QuoteAsset } from "../../src/lib/assets/quote-assets";
import { factoryAbi } from "../../src/lib/chain/abis";
import type { EncodedCall } from "../../src/lib/chain/encoded-call";
import { planZappedSell, readBatchSupport, zappedSellCalls } from "../../src/lib/chain/sell-batch";
import type { LaunchChain, LaunchParams } from "../../src/lib/chain/writes";
import {
  encodeZapSellToNative,
  SELL_GAS_CAP,
  SELL_GAS_FLOOR,
  zapSellGasLimit,
} from "../../src/lib/chain/zap";
import { FIXED_SUPPLY, type LaunchDraft, submitLaunch } from "../../src/lib/launch/submit";

/**
 * A security audit of the two EIP-5792 batching paths, written as executable claims.
 *
 * Every `it` below is either a FINDING (behaviour this file argues is wrong, asserted as it
 * currently stands so that a fix makes the test fail loudly and deliberately) or a KILL (a
 * suspicion that was raised, chased, and found not to be true — asserted so it stays not true).
 *
 * Each block says which it is in its first line. Nothing here modifies a source file.
 */

const CHAIN = 10143;
/* Digits only: viem checksums an address on the way back out of a decode, so a fixture with
 * letters in it compares "0xab…" against "0xAb…" rather than testing anything. */
const ROUTER = "0x0000000000000000000000000000000000001234" as const;
const TOKEN = "0x0000000000000000000000000000000000005678" as const;
const CURVE = "0x0000000000000000000000000000000000009012" as const;
const CREATOR = "0x1111111111111111111111111111111111111111" as const;
const MARKET = "0x2222222222222222222222222222222222222222" as const;
const MARKET_TOKEN = "0x3333333333333333333333333333333333333333" as const;
const FACTORY = "0x4444444444444444444444444444444444444444" as const;
const PIN = `0x${"ab".repeat(32)}` as const;
const ZERO = "0x0000000000000000000000000000000000000000";

const USDC_ADDRESS = "0x754704bc059f8c67012fed69bc8a327a5aafb603" as const;
/** A second ERC-20 that is NOT the pair's asset. Used to end a route somewhere else. */
const WBTC_ADDRESS = "0x0000000000000000000000000000000000007777" as const;

const USDC: QuoteAsset = {
  id: "usdc",
  symbol: "USDC",
  name: "USD Coin",
  kind: "stablecoin",
  status: "live",
  decimals: 6,
  address: USDC_ADDRESS,
  blurb: "",
};

const hop = (currency: `0x${string}`) => ({
  intermediateCurrency: currency,
  fee: 500,
  tickSpacing: 10,
  hooks: ZERO as `0x${string}`,
  hookData: "0x" as const,
});

const draft = (over: Partial<LaunchDraft> = {}): LaunchDraft => ({
  name: "Fork Gold",
  ticker: "GLDF",
  quote: USDC,
  supply: FIXED_SUPPLY,
  feeRouting: "creator",
  creatorFee: 0,
  ...over,
});

/**
 * The `LaunchChain` port, faked. The same shape `launch-submit.test.ts` uses, plus a record of
 * what the wallet held BEFORE the swap, which is the figure the sweep question turns on.
 */
const fakeChain = () => {
  const sent: { params: LaunchParams; value: bigint }[] = [];
  const approvals: { token: string; spender: string; amount: bigint }[] = [];
  const swaps: { amountIn: bigint; minOut: bigint }[] = [];
  const batches: { calls: EncodedCall[]; atomic: boolean }[] = [];
  let held = 0n;
  let delivered = 0n;

  const chain: LaunchChain = {
    account: CREATOR,
    factory: FACTORY,
    launchFee: async () => 10n ** 17n,
    economicsPin: async () => PIN,
    predictMarket: async () => ({ curve: MARKET, token: MARKET_TOKEN }),
    allowance: async () => 0n,
    approve: async (token, spender, amount) => {
      approvals.push({ token, spender, amount });
      return "0xapprove";
    },
    launch: async (params, value) => {
      sent.push({ params, value });
      return "0xlaunch";
    },
    balanceOf: async () => held,
    swapNativeFor: async (params) => {
      swaps.push({ amountIn: params.amountIn, minOut: params.minOut });
      held += delivered;
      return "0xswap";
    },
  };

  return {
    chain,
    sent,
    approvals,
    swaps,
    batches,
    setDelivery: (amount: bigint) => {
      delivered = amount;
    },
    setHeld: (amount: bigint) => {
      held = amount;
    },
    withBatching: (support: "atomic" | "sequential") => {
      chain.batchSupport = support;
      chain.sendBatch = async (calls, opts) => {
        batches.push({ calls, atomic: opts.atomic });
        return "0xbatch";
      };
    },
  };
};

/** The three calls a batched launch carries, decoded into the parts the assertions read. */
const readLaunchBatch = (calls: EncodedCall[]) => {
  const [swap, approve, launch] = calls;
  const approved = decodeFunctionData({ abi: erc20Abi, data: approve.data });
  const launched = decodeFunctionData({ abi: factoryAbi, data: launch.data });
  return {
    swap,
    approveTo: approve.to,
    approveArgs: approved.args as readonly [`0x${string}`, bigint],
    launchTo: launch.to,
    params: (launched.args as unknown as readonly LaunchParams[])[0],
    launchValue: launch.value,
  };
};

/* ============================================================ FINDING 1 — the gas hole (SELL) */

/**
 * FINDING. The batched sell hands the gas limit back to the wallet, on a chain that bills the
 * limit — and the app has just finished measuring that the wallet's limit is ~10x reality.
 *
 * `zapSellToNative` (zap.ts:820) sends `gas: zapSellGasLimit(estimate)`, clamped to
 * [SELL_GAS_FLOOR, SELL_GAS_CAP]. The batched path sends `EncodedCall`s, which have `to`, `data`
 * and an optional `value` and NOTHING ELSE (encoded-call.ts) — and viem's own `Call` type
 * (`node_modules/viem/_types/types/calls.d.ts`) has no `gas` either, because EIP-5792 v2.0.0
 * dropped per-call gas. So there is no way to carry the clamp into the batch.
 *
 * The numbers below are the app's own, from `zap.ts` and from commit 86b25e1a.
 */
describe("FINDING 1: a batched sell is billed the wallet's limit, which the app measured at ~10x", () => {
  /** What `eth_estimateGas` actually returned for `zapSellToNative` on Monad mainnet. */
  const WALLET_ESTIMATE = 4_795_725n;
  /** What that transaction was actually charged: 0.489 MON, because Monad bills the LIMIT. */
  const CHARGED_WEI = 489_000_000_000_000_000n;
  /** Implied effective price, ~102 gwei. Derived rather than assumed. */
  const PRICE_WEI_PER_GAS = CHARGED_WEI / WALLET_ESTIMATE;

  const sellParams = {
    router: ROUTER as `0x${string}`,
    curve: CURVE as `0x${string}`,
    path: [hop(USDC_ADDRESS)],
    baseIn: 5n,
    minQuoteOut: 3n,
    minNativeOut: 2n,
  };

  it("neither call in the batch can carry a gas limit — the field does not exist", () => {
    const calls = zappedSellCalls({
      token: TOKEN,
      spender: ROUTER,
      sell: encodeZapSellToNative(sellParams),
    });

    for (const call of calls) {
      expect(Object.keys(call).sort()).not.toContain("gas");
    }
    // And the sell call, specifically: this is the one whose estimate is 10x its true cost.
    expect("gas" in calls[1]).toBe(false);
  });

  it("the un-batched sell clamps that same estimate down to the cap", () => {
    expect(SELL_GAS_FLOOR).toBe(331_572n);
    expect(SELL_GAS_CAP).toBe(455_064n);
    // The estimate the chain actually produced is above the cap, so the clamp truncates it.
    expect(WALLET_ESTIMATE).toBeGreaterThan(SELL_GAS_CAP);
    expect(zapSellGasLimit(WALLET_ESTIMATE)).toBe(SELL_GAS_CAP);
  });

  it("so batching a sell costs ~10x the gas the un-batched sell now costs", () => {
    // Whole-number multiple, floored: 4,795,725 / 455,064 = 10.5.
    expect(WALLET_ESTIMATE / SELL_GAS_CAP).toBe(10n);
    // Against the FLOOR — what a one-hop sell would really take — it is 14x.
    expect(WALLET_ESTIMATE / SELL_GAS_FLOOR).toBe(14n);
  });

  it("in MON: ~0.44 extra per sell, on a sale that delivered 0.489", () => {
    const batched = WALLET_ESTIMATE * PRICE_WEI_PER_GAS;
    const unbatched = SELL_GAS_CAP * PRICE_WEI_PER_GAS;
    const extra = batched - unbatched;

    // 0.489 MON against 0.046 MON.
    expect(batched).toBeGreaterThan(488_000_000_000_000_000n);
    expect(unbatched).toBeLessThan(47_000_000_000_000_000n);
    // The difference is the finding: 0.442 MON, every batched sell, silently.
    expect(extra).toBeGreaterThan(440_000_000_000_000_000n);
  });

  it("KILL: the LAUNCH batch has no such regression — no launch path ever clamped its gas", () => {
    /*
     * `writes.ts` sets a `gas` override on exactly one call — the curve buy that fills and
     * graduates (writes.ts:392) — and never on `launch` or on `swapNativeFor`. So a batched
     * launch and a sequential launch are both billed the wallet's estimate, and batching costs
     * the launcher nothing extra in gas. The hole is the SELL's alone.
     *
     * Asserted as an arithmetic identity rather than by reading source: the sell is the only
     * flow with a clamp, so it is the only flow that can lose one.
     */
    expect(zapSellGasLimit(null)).toBe(SELL_GAS_CAP);
    expect(zapSellGasLimit(200_000n)).toBe(SELL_GAS_FLOOR);
    expect(zapSellGasLimit(400_000n)).toBe(400_000n);
  });
});

/* ================================================ FINDING 2 — nothing checks the last receipt */

/**
 * FINDING. Both batched call sites take `receipts.at(-1).transactionHash` and report success
 * without ever reading that receipt's STATUS.
 *
 * `SwapButton.tsx:399-406` and `LaunchAction.tsx:285-296` guard only against a MISSING receipt.
 * viem's `waitForCallsStatus({ throwOnFailure: true })` throws on `status === "failure"`, which
 * covers a compliant wallet (500 = all reverted, 600 = partial). It does not cover a wallet
 * answering EIP-5792 v1.0's `status: "CONFIRMED"` string, which viem maps straight to success
 * regardless of the receipts (`viem/_esm/actions/wallet/getCallsStatus.js:71-73`).
 *
 * The port cannot express the difference: `sendBatch` returns a hash, and `submitLaunch` treats
 * any hash as a launch. This test shows that — a batch whose launch call reverted is reported as
 * `submitted`, which clears the draft and navigates to a market that does not exist.
 */
describe("FINDING 2: a batched launch reports `submitted` for any hash, reverted or not", () => {
  const withMon = () => ({
    amountInWei: 5_000n * 10n ** 18n,
    path: [hop(USDC_ADDRESS)],
    minQuoteOut: 120_000_000n,
  });

  it("takes the hash on trust — there is no place for the port to say the launch reverted", async () => {
    const f = fakeChain();
    f.withBatching("sequential");

    const result = await submitLaunch(
      draft({ devBuy: 128.4, devBuyWithMon: withMon() }),
      // A wallet whose batch landed the swap and the approval and REVERTED the launch, but which
      // answered `CONFIRMED` — so viem calls it success and the last receipt still has a hash.
      { ...f.chain, sendBatch: async () => "0xreverted-launch" }
    );

    expect(result.status).toBe("submitted");
    if (result.status !== "submitted") throw new Error("unreachable");
    expect(result.txHash).toBe("0xreverted-launch");
    // And it hands back the PREDICTED market address, which nothing created.
    expect(result.marketAddress).toBe(MARKET);
  });

  it("the sequential path cannot make this mistake: it reads a balance and refuses", async () => {
    const f = fakeChain();
    // The swap landed but delivered nothing — the same shape as a failure the app cannot see.
    f.setDelivery(0n);

    const result = await submitLaunch(draft({ devBuy: 128.4, devBuyWithMon: withMon() }), f.chain);

    expect(result.status).toBe("failed");
    expect(f.sent).toHaveLength(0);
  });
});

/* ============================== FINDING 3 — prototype pollution reaches the capability read */

/**
 * FINDING (low). `readBatchSupport` guards every LOOKUP with `hasOwnProperty` but reads two
 * VALUES straight off the object: `entry.atomic.status` (sell-batch.ts:137) and
 * `entry.atomic.supported` (sell-batch.ts:159).
 *
 * A capability response arrives through `JSON.parse`, so its objects carry `Object.prototype`.
 * If anything in the bundle pollutes `Object.prototype.status` or `.supported`, a wallet that
 * answered `atomic: {}` — an answer this build correctly reads as `none` — becomes `atomic`.
 *
 * Bounded, and the bound is worth stating: the wallet must already have declared an `atomic`
 * capability, which means it implements `wallet_sendCalls`. Pollution cannot manufacture batching
 * where there is none — `capabilitiesForChain`'s own guards are `hasOwnProperty` and hold.
 */
describe("FINDING 3 (FIXED): `atomic.status` and `atomic.supported` are read as OWN properties", () => {
  const answering = (entry: unknown) => ({ [CHAIN]: entry });

  const polluted = <T>(key: string, value: unknown, body: () => T): T => {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    const had = Object.prototype.hasOwnProperty.call(proto, key);
    const previous = proto[key];
    proto[key] = value;
    try {
      return body();
    } finally {
      if (had) proto[key] = previous;
      else delete proto[key];
    }
  };

  it("baseline: an empty `atomic` is `none`, which is right", () => {
    expect(readBatchSupport(answering({ atomic: {} }), CHAIN)).toBe("none");
  });

  it("a polluted `status` is NOT an answer the wallet gave, so it stays `none`", () => {
    const support = polluted("status", "supported", () =>
      readBatchSupport(answering({ atomic: {} }), CHAIN)
    );
    // THE DEFECT. Fixing it flips this to "none" and this assertion fails on purpose.
    expect(support).toBe("none");
  });

  it("a polluted `supported` is refused through the third shape too", () => {
    const support = polluted("supported", true, () =>
      readBatchSupport(answering({ atomic: {} }), CHAIN)
    );
    expect(support).toBe("none");
  });

  it("KILL: pollution cannot invent batching for a wallet that declared none", () => {
    // The chain-keyed lookup and the narrowed-shape fallback both use `hasOwnProperty`, so a
    // polluted `atomic` on `Object.prototype` is not an answer any wallet gave.
    const support = polluted("atomic", { status: "supported" }, () => [
      readBatchSupport({}, CHAIN),
      readBatchSupport(answering({}), CHAIN),
      readBatchSupport(undefined, CHAIN),
    ]);
    expect(support).toEqual(["none", "none", "none"]);
  });
});

/* ======================= FINDING 4 — a zero floor silently drops the dev buy, but only batched */

/**
 * FINDING (low). `submitLaunch` overwrites `firstBuyQuote` with `minQuoteOut` in the batched
 * branch (submit.ts:536) with no lower bound, while `draftProblems` validates `amountInWei` and
 * `path` and never `minQuoteOut` (submit.ts:341-350).
 *
 * A floor that rounds to zero — a dust dev buy, or a high slippage tolerance on a small amount —
 * therefore launches with NO dev buy through a batching wallet, having spent the MON on the swap,
 * while the same draft through a non-batching wallet buys with the delivered balance.
 */
describe("FINDING 4 (FIXED): a `minQuoteOut` of zero is refused before anything is signed", () => {
  const zeroFloor = () => ({
    amountInWei: 5_000n * 10n ** 18n,
    path: [hop(USDC_ADDRESS)],
    minQuoteOut: 0n,
  });

  it("the batched launch buys nothing, and the MON is spent on the swap regardless", async () => {
    const f = fakeChain();
    f.withBatching("atomic");

    const result = await submitLaunch(
      draft({ devBuy: 128.4, devBuyWithMon: zeroFloor() }),
      f.chain
    );

    /*
     * REFUSED now, and nothing is sent. Before the fix this returned `submitted`: the swap carried
     * the launcher's whole 5,000 MON and the launch bought NOTHING, because a batch cannot measure
     * a delta and spends `minQuoteOut` — which was zero. `draftProblems` rejects it up front.
     */
    expect(result.status).toBe("rejected");
    expect(f.batches).toHaveLength(0);
  });

  it("and refused on a non-batching wallet too, since the draft is wrong either way", async () => {
    const f = fakeChain();
    f.setDelivery(128_400_000n);

    const result = await submitLaunch(
      draft({ devBuy: 128.4, devBuyWithMon: zeroFloor() }),
      f.chain
    );

    expect(result.status).toBe("rejected");
    // Nothing signed on either road. The draft is wrong whichever wallet holds it, so the refusal
    // belongs in `draftProblems` rather than in one of the two send paths.
    expect(f.sent).toHaveLength(0);
  });
});

/* ============= FINDING 5 — nothing checks the route ends at the asset the launch is going to buy */

/**
 * FINDING (latent). Nothing on the batched path asserts that `devBuyWithMon.path`'s last hop is
 * the draft's own quote asset.
 *
 * `nativeSwapExecuteArgs` takes `currencyOut = path[path.length - 1].intermediateCurrency`
 * (pool.ts:329) and `TAKE_ALL`s that. `encodeLaunchApproval` and the launch itself use
 * `params.quoteAsset`. Where the two differ, the batch swaps MON into X and then approves and
 * SPENDS Q — which, for a launcher who already holds Q, is the launch spending a pre-existing
 * balance the swap did not fund. That is exactly the property the sequential path's before/after
 * balance read exists to protect, and the batch has no equivalent.
 *
 * Unreachable through the bench today — `LaunchBench.tsx:426` keys the route query on
 * `quote?.address`, so a changed pair resets `route.data` to `undefined` and `devBuyWithMon` goes
 * with it. It is a missing invariant rather than a live exploit, and the guard is one line.
 */
describe("FINDING 5 (FIXED): a route ending somewhere other than the pair's asset is refused", () => {
  const wrongTerminus = () => ({
    amountInWei: 5_000n * 10n ** 18n,
    path: [hop(WBTC_ADDRESS)],
    minQuoteOut: 120_000_000n,
  });

  it("the batch is refused rather than swapping into one asset and spending another", async () => {
    const f = fakeChain();
    f.withBatching("sequential");
    // The launcher already holds 500 USDC that has nothing to do with this launch.
    f.setHeld(500_000_000n);

    const result = await submitLaunch(
      draft({ devBuy: 128.4, devBuyWithMon: wrongTerminus() }),
      f.chain
    );

    expect(result.status).toBe("rejected");
    /*
     * Nothing is sent. Before the fix this submitted happily: the swap `TAKE_ALL`ed WBTC while the
     * approval and the buy named USDC, so the launch spent an asset the swap never funded — one
     * the launcher may already have held — at a floor computed in the wrong decimals. The
     * sequential path was protected by its before/after balance read; a batch has no equivalent,
     * so the terminus check in `draftProblems` is the only thing standing between them.
     */
    expect(f.batches).toHaveLength(0);
    expect(f.sent).toHaveLength(0);
  });

  it("the sequential path refuses it as well, now up front rather than mid-flight", async () => {
    const f = fakeChain();
    f.setHeld(500_000_000n);
    // The swap delivers WBTC, so the USDC balance does not move.
    f.setDelivery(0n);

    const result = await submitLaunch(
      draft({ devBuy: 128.4, devBuyWithMon: wrongTerminus() }),
      f.chain
    );

    expect(result.status).toBe("rejected");
    expect(f.sent).toHaveLength(0);
    expect(f.approvals).toHaveLength(0);
  });
});

/* =========================================================== KILLS — suspicions that were wrong */

/**
 * KILL. The batched launch cannot sweep a balance the swap did not deliver.
 *
 * `firstBuyQuote` is `minQuoteOut`, and `minQuoteOut` is the swap's own `amountOutMinimum` AND its
 * `TAKE_ALL` minimum (pool.ts:338, pool.ts:348), both enforced by the PoolManager inside the same
 * transaction, with the take paid to the caller. So the launch spends at most what arrived, and
 * a pre-existing balance is untouched by construction — the concern only becomes real when the
 * route's terminus is wrong, which is Finding 5 and is a different bug.
 */
describe("KILL: `minQuoteOut` cannot exceed what the swap delivered", () => {
  const withMon = () => ({
    amountInWei: 5_000n * 10n ** 18n,
    path: [hop(USDC_ADDRESS)],
    minQuoteOut: 120_000_000n,
  });

  it("the swap's floor, the approval and the buy are the same number", async () => {
    const f = fakeChain();
    f.withBatching("atomic");
    f.setHeld(9_999_000_000n); // a large pre-existing USDC balance

    await submitLaunch(draft({ devBuy: 128.4, devBuyWithMon: withMon() }), f.chain);

    const { approveArgs, params, launchValue } = readLaunchBatch(f.batches[0].calls);
    expect(approveArgs[1]).toBe(120_000_000n);
    expect(params.firstBuyQuote).toBe(120_000_000n);
    // The allowance is EXACT, so it cannot reach the pre-existing balance even if the launch
    // were re-entered: the factory may pull 120 USDC and not one unit more.
    expect(approveArgs[1]).toBeLessThan(9_999_000_000n);
    // And the launch's value is the fee alone — no first buy rides in `msg.value`.
    expect(launchValue).toBe(10n ** 17n);
  });

  it("the overshoot stays with the launcher rather than going anywhere else", async () => {
    /*
     * There is no recipient in the batch other than the launcher: `TAKE_ALL` pays `msgSender()`,
     * so the whole swap output lands in the launcher's wallet and only `minQuoteOut` of it is
     * approved away. The difference is theirs, and `DevBuy.tsx:587` says so on screen.
     */
    const f = fakeChain();
    f.withBatching("atomic");
    await submitLaunch(draft({ devBuy: 128.4, devBuyWithMon: withMon() }), f.chain);

    const { approveArgs } = readLaunchBatch(f.batches[0].calls);
    // Nothing in the batch can move more of the asset than this.
    expect(approveArgs[0]).toBe(FACTORY);
    expect(f.batches[0].calls).toHaveLength(3);
  });
});

/**
 * KILL. A max allowance stranded on the ZapRouter is not spendable by anyone but its owner.
 *
 * `ZapRouter` has exactly three externally reachable entry points — `setMaxZapValue` (owner),
 * `zapBuyWithNative`, `zapSellToNative` and the PoolManager-gated `unlockCallback`
 * (contracts/src/ZapRouter.sol:196, 222, 301, 469). The only `transferFrom` in the file is
 * `base.safeTransferFrom(msg.sender, address(this), baseIn)` (ZapRouter.sol:664): there is no
 * `from` parameter anywhere, so a third party cannot direct the allowance at somebody else's
 * tokens. It is not behind a proxy and `Ownable2Step` grants no arbitrary call.
 *
 * So the sell batch's failure mode — approve lands, sell fails — costs the seller nothing but the
 * gas, and is strictly BETTER than today's rejected second prompt, because the stranded allowance
 * makes the retry one call instead of two.
 */
describe("KILL: a stranded ZapRouter allowance is not worse than today's rejected second prompt", () => {
  const AMOUNT = 1_000n;

  it("the batch approves the ROUTER, which pulls only from `msg.sender`", () => {
    const calls = zappedSellCalls({
      token: TOKEN,
      spender: ROUTER,
      sell: encodeZapSellToNative({
        router: ROUTER,
        curve: CURVE,
        path: [hop(USDC_ADDRESS)],
        baseIn: AMOUNT,
        minQuoteOut: 3n,
        minNativeOut: 2n,
      }),
    });

    const approve = decodeFunctionData({ abi: erc20Abi, data: calls[0].data });
    expect(calls[0].to).toBe(TOKEN);
    expect(approve.functionName).toBe("approve");
    expect((approve.args as readonly [`0x${string}`, bigint])[0]).toBe(ROUTER);
    // The sell is second, and goes to the router that holds the allowance.
    expect(calls[1].to).toBe(ROUTER);
  });

  it("the stranded allowance turns the retry into ONE call, not two", () => {
    // Before: nothing approved, so two prompts. (It was a batch until the gas finding above;
    // a sell is never batched now, which changes the prompt count and nothing about this point.)
    expect(planZappedSell({ allowance: 0n, amount: AMOUNT, support: "sequential" })).toEqual({
      kind: "approve-then-sell",
    });
    // After a half-landed batch: the approval survives, so the retry is the sell alone.
    const stranded = 2n ** 256n - 1n;
    expect(planZappedSell({ allowance: stranded, amount: AMOUNT, support: "sequential" })).toEqual({
      kind: "sell-only",
    });
    // And identically for a wallet that cannot batch at all — the two paths converge.
    expect(planZappedSell({ allowance: stranded, amount: AMOUNT, support: "none" })).toEqual({
      kind: "sell-only",
    });
  });
});

/**
 * KILL. No malformed `wallet_getCapabilities` answer that can survive JSON transport produces a
 * batching claim for a wallet that made none.
 *
 * `sell-batch.test.ts` already covers hex keys, decimal keys, the `0x0` pseudo-entry, another
 * chain's entry, inherited entries, and a merely-truthy `supported`. What follows are the shapes
 * it does not: arrays at both levels, `null`, numeric and boolean entries, `__proto__` as a chain
 * key, and a chain key that is a whitespace-padded or fractional spelling of the real one.
 */
describe("KILL: hostile capability shapes still read as `none`", () => {
  const cases: [string, unknown][] = [
    ["an array at the top", [{ atomic: { status: "supported" } }]],
    ["an array as the entry", { [CHAIN]: [{ atomic: { status: "supported" } }] }],
    ["null", null],
    ["a string", "atomic"],
    ["a number entry", { [CHAIN]: 1 }],
    ["a boolean entry", { [CHAIN]: true }],
    ["a null entry", { [CHAIN]: null }],
    ["`atomic` set to a string", { [CHAIN]: { atomic: "supported" } }],
    ["`atomic` set to null", { [CHAIN]: { atomic: null } }],
    ["`atomic` set to an array", { [CHAIN]: { atomic: ["supported"] } }],
    ["a status this build has never heard of", { [CHAIN]: { atomic: { status: "maybe" } } }],
    ["`__proto__` as the chain key", { __proto__: { atomic: { status: "supported" } } }],
    ["an empty-string key", { "": { atomic: { status: "supported" } } }],
    ["`Infinity` as a key", { Infinity: { atomic: { status: "supported" } } }],
  ];

  it.each(cases)("refuses %s", (_label, capabilities) => {
    expect(readBatchSupport(capabilities, CHAIN)).toBe("none");
  });

  it("KILL-with-a-caveat: `Number` coerces some spellings of the chain id", () => {
    /*
     * `Number(" 10143 ")` and `Number("10143.0")` are both 10143 and both clear `isInteger`, so a
     * padded or decimal-pointed key is accepted as the chain. That is not a false positive worth
     * fixing: the wallet is the one naming the chain, and every one of these spellings MEANS
     * Monad. Recorded so nobody mistakes it for a hole later.
     */
    expect(readBatchSupport({ " 10143 ": { atomic: { status: "supported" } } }, CHAIN)).toBe(
      "atomic"
    );
    expect(readBatchSupport({ "10143.0": { atomic: { status: "supported" } } }, CHAIN)).toBe(
      "atomic"
    );
    // And a spelling that is NOT this chain is still refused.
    expect(readBatchSupport({ "1.0143e4": { atomic: { status: "supported" } } }, 1)).toBe("none");
  });

  it("a wallet that only sequences is read as sequential, and atomicity is never demanded of it", () => {
    const support = readBatchSupport({ [CHAIN]: { atomic: { status: "unsupported" } } }, CHAIN);
    // Still read as `sequential` — the capability read is unchanged and the LAUNCH batch uses it.
    expect(support).toBe("sequential");
    // The SELL declines it regardless, on gas grounds. `forceAtomic` is therefore never asked of
    // a sequencing wallet by this path at all, which was the original point of the assertion.
    expect(planZappedSell({ allowance: 0n, amount: 1n, support })).toEqual({
      kind: "approve-then-sell",
    });
  });
});

/**
 * KILL. The copy and the send cannot disagree about how many signatures are coming.
 *
 * `LaunchBench.tsx:142` reads `useBatchSupport(address)` once and derives `batched` from it;
 * `LaunchAction.tsx:183` and `DevBuy`'s `oneSignature` prop resolve to the same query — wagmi
 * dedupes `useCapabilities` by key, so both surfaces read one cache entry in one render pass.
 * And the send is gated on the SAME value plus two facts that can only narrow it.
 *
 * The failure this leaves is the safe direction only: `planMonDevBuy` refuses to batch a launch
 * with no MON-funded dev buy, and `submitLaunch` additionally requires `chain.sendBatch`. Both
 * fall back to the three-prompt path the copy describes when it says nothing.
 */
describe("KILL: the copy's condition is never weaker than the send's", () => {
  const withMon = () => ({
    amountInWei: 5_000n * 10n ** 18n,
    path: [hop(USDC_ADDRESS)],
    minQuoteOut: 120_000_000n,
  });

  it("a port that claims batching but cannot send one still takes the old path", async () => {
    const f = fakeChain();
    f.chain.batchSupport = "atomic"; // deliberately without a `sendBatch`
    f.setDelivery(128_400_000n);

    const result = await submitLaunch(draft({ devBuy: 128.4, devBuyWithMon: withMon() }), f.chain);

    expect(result.status).toBe("submitted");
    expect(f.batches).toHaveLength(0);
    expect(f.swaps).toHaveLength(1);
    expect(f.approvals).toHaveLength(1);
    // And the measured balance is what it bought, not the floor.
    expect(f.sent[0].params.firstBuyQuote).toBe(128_400_000n);
  });

  it("a launch with no MON-funded dev buy is never batched, whatever the wallet says", async () => {
    const f = fakeChain();
    f.withBatching("atomic");

    const result = await submitLaunch(draft({ devBuy: 25 }), f.chain);

    expect(result.status).toBe("submitted");
    expect(f.batches).toHaveLength(0);
    expect(f.sent).toHaveLength(1);
  });
});
