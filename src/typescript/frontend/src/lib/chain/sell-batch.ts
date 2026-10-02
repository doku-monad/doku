import { encodeFunctionData, erc20Abi, maxUint256 } from "viem";

import type { EncodedCall } from "./encoded-call";

/**
 * Deciding whether a zapped sell can be one wallet prompt instead of two, and building the pair of
 * calls when it can.
 *
 * A zapped BUY has always been one signature: MON rides as `value`, so there is nothing to approve.
 * A zapped SELL is the router pulling the seller's ERC-20, which needs `approve` first — two
 * prompts for one trade, and the roughest edge in the feature. EIP-5792's `wallet_sendCalls` takes
 * both calls together, and a wallet that supports it asks once.
 *
 * Everything here is pure, and that is deliberate rather than tidy. This repository has no
 * component-test harness, so a decision left inside `SwapButton.tsx` is covered by nothing but
 * review — and the decision this module makes is one where being wrong is expensive in a specific
 * way: batching through a wallet that does not really batch is a sell that appears to be signed and
 * never happens. So the rule is stated once, here, where it can be tested, and every ambiguity
 * resolves to the two-transaction path that has always worked.
 */

/**
 * What a wallet promises about a batch, in the only three degrees that change what this app does.
 *
 * - `atomic` — the calls land together or not at all. The best case, and the one worth asking for
 *   explicitly, because it makes a half-executed sell impossible.
 * - `sequential` — the wallet accepts the batch and runs the calls one after another, without
 *   guaranteeing they share a transaction. Still worth taking: it is exactly what the seller gets
 *   today from two separate prompts, minus one prompt. A failure between approve and sell leaves an
 *   allowance and no sale — which is precisely today's outcome when someone rejects the second
 *   prompt, so nothing regresses.
 * - `none` — send the two transactions. Includes every case where the answer was unclear.
 */
export type BatchSupport = "atomic" | "sequential" | "none";

/** An object, and specifically not an array — every shape below has to clear this first. */
function isPlainish(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Own property only. A capability inherited from a prototype is not an answer a wallet gave. */
function has(entry: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(entry, key);
}

/**
 * The capability entry for one chain, out of whatever `wallet_getCapabilities` answered.
 *
 * Keyed by CHAIN, because capabilities are per chain and a wallet that batches on its own L2 may
 * not batch on Monad. Reading the first entry, or ignoring the key, is how an app ends up sending
 * `wallet_sendCalls` to a wallet that never claimed to support it here.
 *
 * Returns null — never a guess — for anything that is not an object of objects.
 */
function capabilitiesForChain(
  capabilities: unknown,
  chainId: number
): Record<string, unknown> | null {
  if (!isPlainish(capabilities)) return null;
  for (const [key, value] of Object.entries(capabilities)) {
    /*
     * `Number` reads "10143" and "0x279f" alike, and that is the point. viem normalises the map's
     * keys to decimal numbers; the raw RPC answer, and older builds, key it by hex quantity. A
     * lookup that knew only one form would miss the entry on the other and fall back forever —
     * which is safe, and would also mean this feature silently never turns on.
     */
    const keyed = Number(key);
    /*
     * Not every key in this map is a chain. Coinbase's documented capability response carries a
     * `"0x0"` pseudo-entry for `gasLimitOverride`, and `Number("")` is 0 as well — so a positive
     * whole number is the test, rather than "parses as a number". Nothing is lost: there is no
     * chain 0, and `NaN !== chainId` was already skipping the rest.
     */
    if (!Number.isInteger(keyed) || keyed <= 0 || keyed !== chainId) continue;
    return isPlainish(value) ? value : null;
  }

  /*
   * No entry under this chain. One shape is left, and it is worth reading rather than guessing at.
   *
   * viem NARROWS the answer itself when its `getCapabilities` is passed a `chainId`: with the
   * argument it returns `capabilities[chainId]` — the entry — and without it the whole map
   * (`viem/actions/wallet/getCapabilities.ts:86-88`). wagmi's `useCapabilities` forwards whatever
   * `chainId` it is given (`@wagmi/core/src/actions/getCapabilities.ts:33-38`), so the shape that
   * arrives here is decided by one optional argument at a call site two files away.
   *
   * Neither caller passes it today, which is why the keyed lookup above is the real path and stays
   * first. But a future edit adding `chainId: EXPECTED_CHAIN_ID` — a change that looks like a
   * tightening — would hand this function an entry, get `none` forever, and turn batching off with
   * no error anywhere. Silent and safe is still the failure worth catching.
   *
   * The test is an own `atomic` or `atomicBatch` key, which cannot collide with the map it is
   * standing in for: that map's keys are chain ids. And it is read AFTER the keyed lookup and only
   * when that found nothing, so every answer this function already gave, it still gives —
   * including `none` for another chain's entry, which is the property the whole module is built
   * around.
   */
  if (has(capabilities, "atomic") || has(capabilities, "atomicBatch")) return capabilities;
  return null;
}

/**
 * What this wallet will do with a batch on this chain, read from both shapes of the spec.
 *
 * EIP-5792 changed how a wallet declares this, and both shapes are in the wild:
 *
 * - the current one, `atomic: { status: "supported" | "ready" | "unsupported" }`, where `ready`
 *   means the wallet can batch atomically once the user agrees to an upgrade — still one prompt, so
 *   it counts;
 * - the earlier one, `atomicBatch: { supported: true }`, which is what wallets shipped against the
 *   draft and what several still answer.
 *
 * **Every uncertainty returns `none`.** Not an object, no entry for this chain, an entry that is
 * not an object, a `status` string this build has never heard of, `supported` that is not literally
 * `true` — all of it falls back to two transactions. The failure being avoided is not cosmetic: a
 * `wallet_sendCalls` sent to a wallet that does not implement it throws at best, and at worst is
 * acknowledged by a wallet that returns an id and does nothing, which is a sell the seller believes
 * they signed and which never lands. Two prompts is the cost of being wrong in the other direction,
 * and it is the cost of doing nothing at all.
 *
 * The newer field wins where both are present: a wallet that answers `atomic` is answering the
 * spec as it now stands, and `atomicBatch` beside it is a legacy echo rather than a second opinion.
 */
export function readBatchSupport(capabilities: unknown, chainId: number): BatchSupport {
  const entry = capabilitiesForChain(capabilities, chainId);
  if (entry === null) return "none";

  /*
   * The newer field DECIDES where it is present, rather than merely being tried first. A wallet
   * that answers `atomic` at all is answering the spec as it now stands, so an `atomic` this build
   * cannot read is an unreadable answer — not an invitation to go looking for a legacy field that
   * might say something more convenient.
   */
  if (has(entry, "atomic")) {
    if (!isPlainish(entry.atomic)) return "none";
    /*
     * An OWN property, like every other read in this file.
     *
     * A capability response arrives through `JSON.parse` and therefore carries `Object.prototype`.
     * Reading `.status` directly means a polluted `Object.prototype.status = "supported"` turns a
     * wallet answering `atomic: {}` — correctly `none` — into `"atomic"`, and the app then demands
     * `atomicRequired` of a wallet that never claimed it. Bounded, because the wallet must already
     * have declared an own `atomic` key, so pollution cannot manufacture batching out of nothing.
     * But a value nobody sent is not an answer, and `has()` is what every other lookup here uses.
     */
    const status = has(entry.atomic, "status") ? entry.atomic.status : undefined;
    if (status === "supported" || status === "ready") return "atomic";
    /*
     * `unsupported` is not "no batching". A wallet only answers the `atomic` capability at all if
     * it implements `wallet_sendCalls`; what it is declining is the atomicity guarantee, not the
     * batch. So the calls still go in one prompt, executed in order — see `BatchSupport`.
     */
    if (status === "unsupported") return "sequential";
    /*
     * A THIRD published shape: `atomic: { supported: true }`, with no `status` at all.
     *
     * Coinbase publishes all three at once — `atomicBatch.supported` in its batching guide,
     * `atomic.status` in the CDP SDK's types, and this one in its JSON-RPC reference's "Full
     * Capabilities Response". Only `status` is the spec. This is read because the shape is
     * published rather than because it is elegant, and because the wallet it belongs to reaches
     * this app as an injected provider whose response is not documented anywhere.
     *
     * Read LAST and only where there is no `status` to read. A wallet that answered `status` has
     * answered the spec, and a `status` this build cannot parse stays unreadable — `supported`
     * beside it is not a second opinion to fall back on. `=== true`, like everything else here.
     */
    if (
      !has(entry.atomic, "status") &&
      has(entry.atomic, "supported") &&
      entry.atomic.supported === true
    ) {
      return "atomic";
    }
    return "none";
  }

  if (has(entry, "atomicBatch") && isPlainish(entry.atomicBatch)) {
    /* `=== true` and not a truthiness check. `"false"`, `1` and `{}` are all truthy, and a wallet
     * answering any of them is a wallet this build has not been read against. */
    return entry.atomicBatch.supported === true ? "atomic" : "none";
  }

  return "none";
}

/**
 * How to send a zapped curve sell: one call, two calls in one prompt, or two prompts.
 *
 * `sell-only` outranks every batching question, because it is not one. When the allowance already
 * covers the sale there is nothing to batch, and a batch of a single call is a strictly worse
 * ordinary transaction — an extra RPC method, an id instead of a hash to follow, and a wallet UI
 * that shows a "batch" containing one thing.
 */
export type ZappedSellPlan =
  /** The allowance already covers it. Send `zapSellToNative` exactly as this app always has. */
  | { kind: "sell-only" }
  /** Today's path: approve, wait for it, then sell. Two prompts, and no change to either. */
  | { kind: "approve-then-sell" }
  /** Approve and sell in one `wallet_sendCalls`. `atomic` asks the wallet to guarantee both. */
  | { kind: "batched"; atomic: boolean };

/**
 * Picks the plan, from the two facts that decide it: is an approval needed, and can the wallet
 * batch.
 *
 * The allowance is read first and on every sell, which is the same rule `ensureAllowance` has
 * always followed — prompting for a signature the chain does not need is the fastest way to make a
 * wallet feel untrustworthy, and on a token that must be zeroed before its allowance is raised it
 * is also a revert.
 */
export function planZappedSell(input: {
  /** What the router may already pull, raw units, read fresh from the token. */
  allowance: bigint;
  /** Market tokens being sold, raw units. */
  amount: bigint;
  support: BatchSupport;
}): ZappedSellPlan {
  if (input.allowance >= input.amount) return { kind: "sell-only" };

  /*
   * NEVER BATCHED, however capable the wallet is — and the reason is Monad, not EIP-5792.
   *
   * `zapSellToNative` clamps its gas limit to [SELL_GAS_FLOOR, SELL_GAS_CAP] because this chain
   * bills the LIMIT rather than the usage, and `eth_estimateGas` returns ~4,795,725 for a call
   * measured at 240,000–271,000. A batch has nowhere to put that clamp: EIP-5792 v2.0.0 dropped
   * per-call `gas`, and viem's `Call` type has no field for it either. So `wallet_sendCalls` hands
   * the limit back to the very estimator the clamp exists to correct.
   *
   * Measured on the real transaction the clamp was written for: 4,795,725 gas at ~102 gwei is
   * 0.489 MON, against 0.046 at the cap. Batching a sell therefore trades ONE SIGNATURE for about
   * 0.44 MON — 10.5x the clamped ceiling, and on that trade it was 100% of the proceeds rather
   * than 9.5%. The commit that introduced batching claimed it was "no worse than today's two
   * prompts"; on this chain that was simply wrong.
   *
   * Everything else here stays. The launch batch still uses `readBatchSupport` and the encoders,
   * and re-enabling this is one line the day a wallet-side gas hint exists.
   */
  void input.support;
  return { kind: "approve-then-sell" };
}

/**
 * The approval a batched sell carries: max, to the ROUTER, on the market's token.
 *
 * Deliberately the same `maxUint256` the two-transaction path sends. An approval sized to this one
 * trade would leave a different allowance behind depending on which path the seller's wallet
 * happened to take, so the next sell would prompt for one wallet and not the other — the same trade
 * costing a different number of signatures on different machines, for no reason a seller could ever
 * work out.
 *
 * The spender is the ZapRouter, never the curve. A direct curve sell approves the curve because the
 * curve pulls; a zapped sell approves the router, which pulls and then approves the curve itself
 * inside the one transaction. Approving the curve here is a signature that succeeds and a sell that
 * still reverts.
 */
export function encodeMaxApproval(token: `0x${string}`, spender: `0x${string}`): EncodedCall {
  return {
    to: token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, maxUint256],
    }),
  };
}

/**
 * The batch itself: approve, then sell, in that order.
 *
 * The order is the whole contract of this function and it is not stylistic. Reversed, the sell runs
 * before the allowance exists: an atomic wallet reverts the pair, and a sequential one lands the
 * approval alone — a signature spent, no sale, and an allowance left open to a router the seller
 * has stopped using. Building the array at a call site is how that gets got wrong once and never
 * noticed, which is why it is built here and asserted in a test.
 */
export function zappedSellCalls(input: {
  token: `0x${string}`;
  /** The ZapRouter — the contract that pulls. */
  spender: `0x${string}`;
  /** From `encodeZapSellToNative`: the sell, encoded rather than simulated. See that docblock. */
  sell: EncodedCall;
}): EncodedCall[] {
  return [encodeMaxApproval(input.token, input.spender), input.sell];
}
