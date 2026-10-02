/**
 * @jest-environment node
 */
import { decodeFunctionData, erc20Abi, maxUint256 } from "viem";

import { factoryAbi } from "../../src/lib/chain/abis";
import type { EncodedCall } from "../../src/lib/chain/encoded-call";
import {
  encodeLaunchApproval,
  encodeLaunchCall,
  monDevBuyCalls,
  planMonDevBuy,
} from "../../src/lib/chain/launch-batch";
import { encodeSwapNativeFor } from "../../src/lib/chain/pool";
import { planZappedSell, readBatchSupport, zappedSellCalls } from "../../src/lib/chain/sell-batch";
import type { LaunchParams } from "../../src/lib/chain/writes";
import { encodeZapSellToNative, zapRouterAbi } from "../../src/lib/chain/zap";

/**
 * The batch actually going out, through a wallet.
 *
 * Every other test of this feature stops at the boundary: `sell-batch` and `launch-batch` are
 * asserted as pure functions, and `launch-submit` asserts the port — the three calls handed to
 * `sendBatch`. Nothing exercised what happens once a wallet is on the other end of it, and that is
 * the half where "one prompt" is either true or a sell that appears to be signed and never lands.
 *
 * So: a fake wallet client that records the `wallet_sendCalls` it is given and answers with an id,
 * and a `waitForCallsStatus` that answers with receipts. What is asserted is everything that
 * decides whether the batch does what the button says — the calls, their order, their `to`, their
 * decoded `data`, their `value`, whether atomicity was demanded, and which receipt becomes the
 * hash the interface then shows.
 *
 * ## What this does NOT cover, stated plainly
 *
 * `sendBatch` itself — the six lines that call `sendCalls`, wait, and take the last receipt — is
 * written inline in `SwapButton.tsx` and `LaunchAction.tsx`, which this repository has no harness
 * to render. `sendBatchVia` below is those lines, and it is a MIRROR rather than the code that
 * ships: it proves the rule is right, not that the components implement it. Extracting that
 * adapter into `sell-batch.ts`/`launch-batch.ts` and having both components call it would close
 * the gap, and is the one change this file argues for.
 *
 * Everything else here — the calls, the plan, the capability read — is the shipping code itself.
 */

const CHAIN = 10143;
/* Digits only, deliberately: viem checksums an address on the way back out of a decode, and a
 * fixture with letters in it would be comparing "0xab…" against "0xAb…" rather than testing this
 * module. */
const ROUTER = "0x0000000000000000000000000000000000001234" as `0x${string}`;
const TOKEN = "0x0000000000000000000000000000000000005678" as `0x${string}`;
const CURVE = "0x0000000000000000000000000000000000009012" as `0x${string}`;
const QUOTE = "0x0000000000000000000000000000000000003456" as `0x${string}`;
const FACTORY = "0x0000000000000000000000000000000000004444" as `0x${string}`;
const CREATOR = "0x0000000000000000000000000000000000001111" as `0x${string}`;
const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;

const APPROVE_TX = "0x00000000000000000000000000000000000000000000000000000000000000a1" as const;
const SWAP_TX = "0x00000000000000000000000000000000000000000000000000000000000000a2" as const;
const LAST_TX = "0x00000000000000000000000000000000000000000000000000000000000000ff" as const;
const BATCH_ID = "0xbatch-id";

/** A capability answer shaped the way viem hands it back: keyed by chain, as a number. */
const answering = (entry: unknown) => ({ [CHAIN]: entry });

/** The subset of a viem wallet client a batch actually uses. */
interface SentBatch {
  account: { address: `0x${string}` };
  chain: { id: number } | undefined;
  calls: readonly EncodedCall[];
  forceAtomic: boolean;
}

interface Waited {
  id: string;
  throwOnFailure: boolean;
}

const fakeWallet = (receipts: { transactionHash: `0x${string}` }[] | undefined) => {
  const sent: SentBatch[] = [];
  const waited: Waited[] = [];
  return {
    sent,
    waited,
    account: { address: CREATOR },
    chain: { id: CHAIN },
    sendCalls: async (params: SentBatch) => {
      sent.push(params);
      return { id: BATCH_ID };
    },
    waitForCallsStatus: async (params: Waited) => {
      waited.push(params);
      return { receipts };
    },
  };
};

type FakeWallet = ReturnType<typeof fakeWallet>;

/**
 * The adapter both components write inline, mirrored so it can be run.
 *
 * The two rules it exists to hold: `forceAtomic` follows the CAPABILITY and never the wish — a
 * wallet that batches sequentially must refuse `atomicRequired`, so asking blindly turns a working
 * one-prompt send into an error — and the hash handed back is the LAST receipt's, because an
 * atomic batch has one receipt and a sequential one has the approval in front of the trade.
 */
const sendBatchVia =
  (wallet: FakeWallet) =>
  async (calls: EncodedCall[], opts: { atomic: boolean }): Promise<`0x${string}`> => {
    const { id } = await wallet.sendCalls({
      account: wallet.account,
      chain: wallet.chain,
      calls,
      forceAtomic: opts.atomic,
    });
    const { receipts } = await wallet.waitForCallsStatus({ id, throwOnFailure: true });
    const landed = receipts?.at(-1)?.transactionHash;
    if (!landed) {
      throw new Error("Your wallet confirmed the batch but returned no transaction.");
    }
    return landed;
  };

const sellParams = {
  router: ROUTER,
  curve: CURVE,
  path: [
    {
      intermediateCurrency: QUOTE,
      fee: 500,
      tickSpacing: 10,
      hooks: ZERO,
      hookData: "0x" as const,
    },
  ],
  baseIn: 5n,
  minQuoteOut: 3n,
  minNativeOut: 2n,
};

/**
 * A zapped sell, from the wallet's capability answer to the hash the toast reads.
 *
 * This is the path a seller takes: the wallet says what it can do, `readBatchSupport` decides,
 * `planZappedSell` picks, `zappedSellCalls` builds, and the wallet is handed the result. Nothing
 * is stubbed between the answer and the batch.
 */
describe("a zapped sell is never batched, and the reason is the gas", () => {
  /*
   * This block used to drive a batched sell end to end. It does not any more, because a sell must
   * not be batched at all.
   *
   * `zapSellToNative` clamps its gas limit to [331,572, 455,064] because Monad bills the LIMIT and
   * `eth_estimateGas` returns ~4,795,725 for a call measured at 240,000-271,000. EIP-5792 v2.0.0
   * dropped per-call `gas`, and viem's `Call` type has no field for it — so a batch hands the
   * limit back to the very estimator the clamp exists to correct. Measured on the real mainnet
   * sell the clamp was written for: 0.489 MON batched against 0.046 clamped, about 0.44 MON a
   * sell, and on that trade 100% of the proceeds instead of 9.5%.
   *
   * One signature is not worth ten times the fee. The launch batch keeps every helper below.
   */
  const planFor = (capabilities: unknown, allowance: bigint) =>
    planZappedSell({
      allowance,
      amount: sellParams.baseIn,
      support: readBatchSupport(capabilities, CHAIN),
    });

  it.each([
    ["an atomic wallet", { atomic: { status: "supported" } }],
    ["a ready wallet", { atomic: { status: "ready" } }],
    ["a sequencing wallet", { atomic: { status: "unsupported" } }],
    ["the legacy shape", { atomicBatch: { supported: true } }],
    ["the third published shape", { atomic: { supported: true } }],
  ])("refuses to batch for %s", (_label, caps) => {
    expect(planFor(answering(caps), 0n).kind).toBe("approve-then-sell");
  });

  it("never reaches the batch sender at all", async () => {
    const wallet = fakeWallet([{ transactionHash: APPROVE_TX }, { transactionHash: LAST_TX }]);
    const plan = planFor(answering({ atomic: { status: "supported" } }), 0n);
    // The guard the call site uses. With no `batched` plan there is nothing to send.
    if (plan.kind === "batched") {
      await sendBatchVia(wallet)([], { atomic: true });
    }
    expect(wallet.sent).toHaveLength(0);
  });

  it("still builds the calls correctly, because the LAUNCH batch uses them", () => {
    // `zappedSellCalls` and `encodeMaxApproval` are shared. Re-enabling a sell batch the day a
    // wallet-side gas hint exists should be one line, not a rebuild.
    const calls = zappedSellCalls({
      token: TOKEN,
      spender: ROUTER,
      sell: encodeZapSellToNative(sellParams),
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].to).toBe(TOKEN);
    const approve = decodeFunctionData({ abi: erc20Abi, data: calls[0].data });
    expect(approve.functionName).toBe("approve");
    // The ROUTER, never the curve.
    expect(approve.args).toEqual([ROUTER, maxUint256]);
    expect(calls[1].to).toBe(ROUTER);
    const sell = decodeFunctionData({ abi: zapRouterAbi, data: calls[1].data });
    expect(sell.functionName).toBe("zapSellToNative");
    // Neither call moves native in — the seller is being paid, not paying.
    expect(calls[0].value).toBeUndefined();
    expect(calls[1].value).toBeUndefined();
  });
});

/**
 * A MON-funded dev buy, from the capability answer to the hash the market page opens on.
 *
 * Three calls rather than two, and the one that has to be right is the last: an atomic batch has a
 * single receipt, a sequential one has the swap and the approval in front of the launch, and
 * returning the swap's hash would link the new market's page to a transaction that created no
 * market.
 */
describe("a MON-funded dev buy, batched, end to end", () => {
  const MIN_QUOTE_OUT = 400_000n;
  const AMOUNT_IN = 5_000n * 10n ** 18n;
  const LAUNCH_FEE = 10n ** 17n;
  const PATH = [
    {
      intermediateCurrency: QUOTE,
      fee: 500,
      tickSpacing: 10,
      hooks: ZERO,
      hookData: "0x" as const,
    },
  ];

  const params: LaunchParams = {
    meta: {
      name: "Fork Gold",
      ticker: "GLDF",
      logoURI: "",
      bannerURI: "",
      description: "",
      website: "",
      x: "",
      telegram: "",
    },
    quoteAsset: QUOTE,
    sink: 2,
    routedRecipient: CREATOR,
    creatorTaxBps: 0,
    taxRecipient: CREATOR,
    economicsPin: `0x${"ab".repeat(32)}`,
    firstBuyQuote: MIN_QUOTE_OUT,
    firstBuyMinOut: 0n,
    deadline: 1_800_000_000n,
  };

  const sendLaunch = async (capabilities: unknown) => {
    const wallet = fakeWallet([
      { transactionHash: SWAP_TX },
      { transactionHash: APPROVE_TX },
      { transactionHash: LAST_TX },
    ]);
    const support = readBatchSupport(capabilities, CHAIN);
    const plan = planMonDevBuy({ support, hasDevBuyWithMon: true });
    if (plan.kind !== "batched") return { wallet, support, plan, hash: null };
    const hash = await sendBatchVia(wallet)(
      monDevBuyCalls({
        swap: encodeSwapNativeFor({ path: PATH, amountIn: AMOUNT_IN, minOut: MIN_QUOTE_OUT }),
        approve: encodeLaunchApproval(QUOTE, FACTORY, MIN_QUOTE_OUT),
        launch: encodeLaunchCall(FACTORY, params, LAUNCH_FEE),
      }),
      { atomic: plan.atomic }
    );
    return { wallet, support, plan, hash };
  };

  it("sends ONE `wallet_sendCalls` carrying swap, approve and launch, in that order", async () => {
    const { wallet } = await sendLaunch(answering({ atomic: { status: "supported" } }));

    expect(wallet.sent).toHaveLength(1);
    const { calls } = wallet.sent[0];
    expect(calls).toHaveLength(3);

    /*
     * The approval is for an asset the swap has not delivered yet — legal, since an allowance is a
     * promise rather than a transfer, but only if it precedes the pull. The launch pulls. Shuffled,
     * an atomic wallet reverts the lot and a sequential one lands whatever prefix worked: in the
     * worst case a swap and an approval, no coin, and the launcher holding an asset they bought in
     * order to spend.
     */
    const [swap, approve, launch] = calls;

    // The MON rides as the swap's own value — each call in a batch carries its own.
    expect(swap.value).toBe(AMOUNT_IN);

    expect(approve.to).toBe(QUOTE);
    expect(approve.value).toBeUndefined();
    const decodedApprove = decodeFunctionData({ abi: erc20Abi, data: approve.data });
    expect(decodedApprove.functionName).toBe("approve");
    // The FACTORY, never the curve, and EXACTLY the first buy: this allowance has no life after
    // the launch that spends it.
    expect(decodedApprove.args).toEqual([FACTORY, MIN_QUOTE_OUT]);

    expect(launch.to).toBe(FACTORY);
    // The fee ALONE, and exact: a batched launch is never a native-quote launch, so no first buy
    // rides in `msg.value`, and the factory reverts on more.
    expect(launch.value).toBe(LAUNCH_FEE);
    const decodedLaunch = decodeFunctionData({ abi: factoryAbi, data: launch.data });
    expect(decodedLaunch.functionName).toBe("launch");
    const sent = (decodedLaunch.args as unknown as readonly LaunchParams[])[0];
    expect(sent.quoteAsset).toBe(QUOTE);
    expect(sent.firstBuyQuote).toBe(MIN_QUOTE_OUT);
  });

  it("returns the LAST receipt's hash, which is the launch and not the swap", async () => {
    const { hash } = await sendLaunch(answering({ atomic: { status: "supported" } }));
    expect(hash).toBe(LAST_TX);
    expect(hash).not.toBe(SWAP_TX);
    expect(hash).not.toBe(APPROVE_TX);
  });

  it("demands atomicity only where the wallet said it has it", async () => {
    const atomic = await sendLaunch(answering({ atomic: { status: "supported" } }));
    expect(atomic.wallet.sent[0].forceAtomic).toBe(true);

    const sequential = await sendLaunch(answering({ atomic: { status: "unsupported" } }));
    expect(sequential.wallet.sent[0].forceAtomic).toBe(false);
  });

  it("sends no batch at all when the wallet did not claim one", async () => {
    /*
     * The failure this guards is the expensive one: a `wallet_sendCalls` a wallet acknowledges and
     * never executes is a launch the creator believes they signed — no coin, no swap, and the
     * draft cleared.
     */
    for (const answer of [
      undefined,
      null,
      "atomic",
      {},
      { 1: { atomic: { status: "supported" } } },
    ]) {
      const { wallet, plan } = await sendLaunch(answer);
      expect(plan).toEqual({ kind: "sequential" });
      expect(wallet.sent).toHaveLength(0);
    }
  });
});
