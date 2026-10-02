/**
 * @jest-environment node
 */
import { decodeFunctionData, erc20Abi } from "viem";

import { factoryAbi } from "../../src/lib/chain/abis";
import {
  encodeLaunchApproval,
  encodeLaunchCall,
  monDevBuyCalls,
  planMonDevBuy,
} from "../../src/lib/chain/launch-batch";
import { encodeSwapNativeFor } from "../../src/lib/chain/pool";
import { readBatchSupport } from "../../src/lib/chain/sell-batch";
import type { LaunchParams } from "../../src/lib/chain/writes";

const CHAIN = 10143;
/* Digits only, deliberately: viem checksums an address on the way back out of a decode, and a
 * fixture with letters in it would be comparing "0xab…" against "0xAb…" rather than testing this
 * module. */
const FACTORY = "0x0000000000000000000000000000000000004444" as `0x${string}`;
const WBTC = "0x0000000000000000000000000000000000005678" as `0x${string}`;
const CREATOR = "0x0000000000000000000000000000000000001111" as `0x${string}`;
const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;

/** 0.004 WBTC at eight decimals — the floor a MON swap was signed with. */
const MIN_QUOTE_OUT = 400_000n;
const AMOUNT_IN = 5_000n * 10n ** 18n;
const LAUNCH_FEE = 10n ** 17n;

const PATH = [
  {
    intermediateCurrency: WBTC,
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
  quoteAsset: WBTC,
  sink: 2,
  routedRecipient: CREATOR,
  creatorTaxBps: 0,
  taxRecipient: CREATOR,
  economicsPin: `0x${"ab".repeat(32)}`,
  firstBuyQuote: MIN_QUOTE_OUT,
  firstBuyMinOut: 0n,
  deadline: 1_800_000_000n,
};

describe("choosing how to send a MON-funded launch", () => {
  it("batches, atomically, when the wallet promises atomicity", () => {
    expect(planMonDevBuy({ support: "atomic", hasDevBuyWithMon: true })).toEqual({
      kind: "batched",
      atomic: true,
    });
  });

  it("batches without demanding atomicity when the wallet only sequences", () => {
    // `forceAtomic: true` on a sequential wallet is a REFUSAL, so the flag has to follow the
    // capability rather than the wish — a working one-prompt launch would become an error.
    expect(planMonDevBuy({ support: "sequential", hasDevBuyWithMon: true })).toEqual({
      kind: "batched",
      atomic: false,
    });
  });

  it("keeps the three-transaction path when the wallet cannot batch", () => {
    expect(planMonDevBuy({ support: "none", hasDevBuyWithMon: true })).toEqual({
      kind: "sequential",
    });
  });

  it("never batches a launch that has no MON-funded dev buy", () => {
    // There is nothing to batch: no swap, and on a MON pair no approval either. A batch of one
    // call is a strictly worse ordinary transaction, whatever the wallet can do.
    for (const support of ["atomic", "sequential", "none"] as const) {
      expect(planMonDevBuy({ support, hasDevBuyWithMon: false })).toEqual({ kind: "sequential" });
    }
  });
});

/**
 * The fallback discipline, end to end.
 *
 * `readBatchSupport` is what turns a wallet's answer into the `support` this module takes, and its
 * own tests cover every shape. What matters here is the join: every uncertain answer has to arrive
 * as `none` and come out as `sequential`, because the failure in the other direction is a
 * `wallet_sendCalls` a wallet acknowledges and never executes — a launch the creator believes they
 * signed, with no coin, no swap, and a cleared draft.
 */
describe("an uncertain capability always launches the old way", () => {
  const answers: unknown[] = [
    undefined,
    null,
    "atomic",
    {},
    { [CHAIN]: null },
    { [CHAIN]: {} },
    { [CHAIN]: { atomic: { status: "maybe" } } },
    // Merely truthy, which is not `true`.
    { [CHAIN]: { atomicBatch: { supported: "true" } } },
    { [CHAIN]: { atomicBatch: { supported: 1 } } },
    // Another chain's answer, which says nothing about Monad.
    { 1: { atomic: { status: "supported" } } },
  ];

  it.each(answers.map((a) => [JSON.stringify(a) ?? "undefined", a] as const))(
    "falls back on %s",
    (_label, answer) => {
      const support = readBatchSupport(answer, CHAIN);
      expect(support).toBe("none");
      expect(planMonDevBuy({ support, hasDevBuyWithMon: true })).toEqual({ kind: "sequential" });
    }
  );
});

describe("the calls the launch batch carries", () => {
  const swap = encodeSwapNativeFor({ path: PATH, amountIn: AMOUNT_IN, minOut: MIN_QUOTE_OUT });
  const approve = encodeLaunchApproval(WBTC, FACTORY, MIN_QUOTE_OUT);
  const launch = encodeLaunchCall(FACTORY, params, LAUNCH_FEE);

  it("puts them in the only order that works: swap, approve, launch", () => {
    /*
     * Reversed or shuffled, an atomic wallet reverts the lot and a sequential one lands whatever
     * prefix worked — in the worst case a swap and an approval, no coin, and the launcher holding
     * an asset they bought in order to spend.
     */
    const calls = monDevBuyCalls({ swap, approve, launch });
    expect(calls).toEqual([swap, approve, launch]);
    expect(calls[0].to).toBe(swap.to);
    expect(calls[1].to).toBe(WBTC);
    expect(calls[2].to).toBe(FACTORY);
  });

  it("approves EXACTLY the swap's floor, to the FACTORY", () => {
    /*
     * Exact, not max: a launch allowance has no second use, the factory pulls the first buy inside
     * the launch itself, and an allowance that outlived it would be a permanent claim on the
     * launcher's WBTC granted by a prompt that says "launch".
     *
     * And the factory, never the curve. The curve is the natural guess — it holds the reserves —
     * and approving it is a signature that succeeds and a launch that still reverts.
     */
    const decoded = decodeFunctionData({ abi: erc20Abi, data: approve.data });
    expect(decoded.functionName).toBe("approve");
    expect(decoded.args).toEqual([FACTORY, MIN_QUOTE_OUT]);
    expect(approve.to).toBe(WBTC);
  });

  it("carries the MON on the swap and the fee on the launch, and nothing on the approval", () => {
    // Each call in a batch carries its own value. The swap's input currency IS native, so the MON
    // is its `msg.value`; the launch owes the factory its fee; an ERC-20 approval moves none.
    expect(swap.value).toBe(AMOUNT_IN);
    expect(launch.value).toBe(LAUNCH_FEE);
    expect(approve.value).toBeUndefined();
    expect(Object.keys(approve).sort()).toEqual(["data", "to"]);
  });

  it("encodes the launch against the factory, with the params it was given", () => {
    const decoded = decodeFunctionData({ abi: factoryAbi, data: launch.data });
    expect(decoded.functionName).toBe("launch");
    const sent = (decoded.args as unknown as readonly LaunchParams[])[0];
    expect(sent.quoteAsset).toBe(WBTC);
    expect(sent.firstBuyQuote).toBe(MIN_QUOTE_OUT);
    expect(sent.economicsPin).toBe(params.economicsPin);
    // Zero, and not a floor: the first buy happens inside the transaction that creates the market,
    // at a price nothing can front-run.
    expect(sent.firstBuyMinOut).toBe(0n);
  });

  it("refuses to encode a swap with no hops in it", () => {
    // A path of nothing is a swap that settles native it never spends. Better a throw here than a
    // batch the wallet signs.
    expect(() =>
      encodeSwapNativeFor({ path: [], amountIn: AMOUNT_IN, minOut: MIN_QUOTE_OUT })
    ).toThrow(/hop/i);
  });
});
