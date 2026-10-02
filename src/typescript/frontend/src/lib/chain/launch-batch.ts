import { encodeFunctionData, erc20Abi } from "viem";

import { factoryAbi } from "./abis";
import type { EncodedCall } from "./encoded-call";
import type { BatchSupport } from "./sell-batch";
import type { LaunchParams } from "./writes";

/**
 * Turning a MON-funded dev buy from three wallet prompts into one, and building the three calls it
 * travels as.
 *
 * ## Why a batch is legal here when a router is not
 *
 * `lib/launch/pay-with` explains at length why no contract can launch on the creator's behalf:
 * `DokuFactory.launch` records `msg.sender` as the creator, so a router doing this would BE the
 * creator and would own the market's creator fees for the life of the market. That argument is
 * correct and it is not an argument against this file.
 *
 * **EIP-5792 does not relay through a contract.** `wallet_sendCalls` hands the wallet a list of
 * calls the wallet itself makes; `msg.sender` on every one of them is the launcher's own address,
 * exactly as if they had signed three transactions in a row. So batching preserves creator
 * identity precisely where a router destroys it. The next reader will assume a batch is a router —
 * it is not, and the difference is the whole reason this exists.
 *
 * ## What a batch cannot do, and what that costs
 *
 * It cannot read a balance between its calls. The sequential path swaps, reads what ARRIVED, and
 * buys with that measured figure — see `submitLaunch`, where that read is the thing the whole flow
 * turns on. Inside one batch there is nothing to read, so the batched dev buy spends `minQuoteOut`
 * instead: the slippage-bounded floor the swap is already signed with.
 *
 * That is safe, and it is not free:
 *
 *   - **Safe.** The swap's own `amountOutMinimum` is `minQuoteOut`, enforced by the pool inside the
 *     transaction. Either at least that much arrives or the swap reverts and the batch never buys
 *     anything — so the launch cannot revert for a shortfall the launcher has already paid for,
 *     which is the failure the balance read exists to prevent.
 *   - **It sweeps nothing.** `minQuoteOut` came from THIS swap's floor, not from the wallet. A
 *     launcher who already held some of the pair's asset keeps every unit of it, which is the other
 *     thing the balance read was protecting.
 *   - **It is slightly smaller.** The difference between `minQuoteOut` and what actually arrived
 *     stays in the launcher's wallet, as the pair's asset. At the default tolerance that is a
 *     fraction of a percent, and it is a real behaviour difference rather than a free win: the same
 *     draft buys marginally less through a batching wallet than through one that cannot batch. The
 *     dev-buy step says so on screen; burying it would mean a launcher discovering it from a
 *     balance.
 */

/**
 * How a MON-funded launch should be sent: as it always has been, or as one prompt.
 *
 * There is no third state and deliberately no "batched, non-atomic is different" branch beyond the
 * flag. `atomic` travels with the plan because `wallet_sendCalls`'s `atomicRequired` must be asked
 * for only where the wallet said it has it — a wallet that batches sequentially REFUSES a batch
 * that demands atomicity, so asking blindly turns a working one-prompt launch into an error.
 */
export type MonDevBuyPlan =
  /** Swap, wait, approve, wait, launch. Three prompts, and not one byte of that path changes. */
  | { kind: "sequential" }
  /** Swap, approve and launch in one `wallet_sendCalls`. */
  | { kind: "batched"; atomic: boolean };

/**
 * Picks the plan, from the two facts that decide it.
 *
 * `hasDevBuyWithMon` outranks the capability, because a launch that is not funded in MON is one
 * transaction already. Batching a single call is a strictly worse ordinary transaction — an extra
 * RPC method, an id instead of a hash to follow, and a wallet showing a "batch" containing one
 * thing — and it would put every ordinary launch, including every launch on a MON pair, through a
 * code path that exists for a swap it never makes.
 *
 * **Every uncertainty is `sequential`.** `support` is `readBatchSupport`'s answer and nothing else,
 * so an unanswered, failed, unrecognised or merely-truthy capability has already resolved to
 * `"none"` before it arrives here — see that function for why every ambiguity has to land on the
 * path that works. The failure being avoided is a wallet that accepts `wallet_sendCalls`, returns
 * an id and does nothing, which is a launch the creator believes they signed: the coin does not
 * exist, the swap did not happen, and the draft has been cleared.
 */
export function planMonDevBuy(input: {
  support: BatchSupport;
  /** Whether this launch actually carries a MON-funded dev buy — a swap, an approval and a launch. */
  hasDevBuyWithMon: boolean;
}): MonDevBuyPlan {
  if (!input.hasDevBuyWithMon) return { kind: "sequential" };
  if (input.support === "none") return { kind: "sequential" };
  return { kind: "batched", atomic: input.support === "atomic" };
}

/**
 * The launch's approval: **exactly** the first buy, to the FACTORY.
 *
 * Exact, where `encodeMaxApproval` on the sell path is `maxUint256`, and the difference is the
 * point rather than an inconsistency. A max approval to the ZapRouter is a standing allowance to a
 * contract the seller uses on every trade, and matching what the two-transaction path already left
 * behind is what keeps a second sell from costing a different number of prompts on different
 * machines. A launch allowance has no second use: the factory pulls the first buy inside this one
 * transaction and never touches the launcher again. An allowance that outlived the launch would be
 * a permanent claim on the launcher's WBTC in exchange for nothing — and it would be granted by a
 * prompt that says "launch", which is not where anybody looks for one.
 *
 * The spender is the FACTORY, never the curve. The curve is the natural guess — it holds the
 * reserves and it is what every later buy approves — but the launch pulls the first buy itself, so
 * approving the curve is a signature that succeeds and a launch that still reverts.
 *
 * Unconditional, where the sequential path skips a re-approval it does not need. That path reads
 * the allowance first; a batch cannot branch on a read taken between its own calls, and the read
 * would be answering about a state the swap in front of it has not created yet. One redundant
 * approval inside a single prompt is the cost, and it is paid in gas rather than in signatures.
 */
export function encodeLaunchApproval(
  quoteAsset: `0x${string}`,
  factory: `0x${string}`,
  firstBuyQuote: bigint
): EncodedCall {
  return {
    to: quoteAsset,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [factory, firstBuyQuote],
    }),
  };
}

/**
 * The launch itself, encoded rather than simulated.
 *
 * Deliberately no simulation, and there is none that could pass: the approval this call spends
 * against is sitting in the same batch, unexecuted, and so is the swap that funds it. viem would
 * revert on an allowance that is perfectly good by the time the chain runs it. `launchChain.launch`
 * keeps its simulate-then-write shape for every wallet that cannot batch, which is where a
 * `QuoteNotEnabled()` or a metadata cap still becomes a sentence instead of a paid-for revert.
 *
 * `value` is the launch fee alone. A batched launch is never a native-quote launch — a MON pair
 * has nothing to swap and takes the single-signature path — so the `fee + firstBuyQuote` form that
 * a native quote needs cannot arise here. The value is still EXACT: the factory reverts on more.
 */
export function encodeLaunchCall(
  factory: `0x${string}`,
  params: LaunchParams,
  launchFee: bigint
): EncodedCall {
  return {
    to: factory,
    data: encodeFunctionData({ abi: factoryAbi, functionName: "launch", args: [params] }),
    value: launchFee,
  };
}

/**
 * The batch itself: swap, approve, launch, in that order.
 *
 * The order is the whole contract of this function and none of it is stylistic. The approval is
 * for an asset the swap has not delivered yet — legal, since an ERC-20 allowance is a promise
 * rather than a transfer, but only if it precedes the pull. The launch pulls. So:
 *
 *   - swap before launch, or the launch pulls an asset the wallet does not hold;
 *   - approve before launch, or the pull has no allowance to draw on.
 *
 * Reversed or shuffled, an atomic wallet reverts the lot — the launcher pays gas and gets nothing
 * — and a sequential one lands whatever prefix worked: in the worst case a swap and an approval,
 * no coin, and the launcher holding an asset they bought to spend. Building this array at a call
 * site is how that gets got wrong once and never noticed, which is why it is built here and
 * asserted in a test.
 */
export function monDevBuyCalls(input: {
  /** From `encodeSwapNativeFor`: MON into the pair's asset, carrying its own `value`. */
  swap: EncodedCall;
  /** From `encodeLaunchApproval`: exactly the first buy, to the factory. */
  approve: EncodedCall;
  /** From `encodeLaunchCall`: the launch, carrying the fee as `value`. */
  launch: EncodedCall;
}): EncodedCall[] {
  return [input.swap, input.approve, input.launch];
}
