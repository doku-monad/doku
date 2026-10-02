import { formatUnits } from "viem";

import { clampSlippageBps } from "./slippage";
import type { Venue } from "./venue";
import type { DescribedTxError } from "./wallet-state";
import { describeTxError } from "./wallet-state";
import { applySlippage } from "./writes";
import { candidateRoutes, MAX_ZAP_IMPACT_BPS, NATIVE, nativeTradingAllowed, type Path, sellRoutes } from "./zap-routes";

/**
 * Everything the trade panel needs to decide about trading in MON on a market that is priced in
 * something else — MON in on a buy, MON out on a sell — with no chain and no React.
 *
 * The panel is a renderer. Every judgement that could be wrong — whether the option exists at all,
 * what to show while a route is being measured, what to say when there is no route, what the two
 * slippage floors are, and what a revert meant — is a function here, because none of it is testable
 * where it was: there is no component-test harness in this repo, so logic left in a `.tsx` file is
 * covered by nothing but review.
 *
 * It imports no address and reads no environment. The router's address arrives as a `boolean` the
 * caller resolved, so this module can be exercised in both states — present and absent — in the
 * same test run, which is the only way to check the absent one at all.
 */

/**
 * Which asset the trader spends on a buy, or is paid in on a sell.
 *
 * `quote` is the market's own asset and is always available — it is what the curve and the pool
 * actually deal in. `native` is the shortcut: a Uniswap swap bolted onto the same transaction, in
 * front of a buy or behind a sell.
 *
 * Not called `PayWith` any more, because on a sell nobody is paying with the MON they receive, and
 * a name that is a lie on half its uses is a name that gets read wrong on the other half.
 */
export type SideAsset = "quote" | "native";

/**
 * Which asset choices this trade actually has.
 *
 * ALWAYS contains `quote`, which is the market's own asset and the default — today's behaviour,
 * unchanged. A single-entry list means the control renders nothing at all: one option is not a
 * choice, and a control offering it is furniture.
 *
 * `native` means MON goes IN on a buy and comes OUT on a sell, and the same conditions gate both.
 * Each one removes a different way for the feature to be worse than absent:
 *
 *   - **The venue is KNOWN.** "Not yet known" counts as no, because the read that settles it takes
 *     a moment and the alternative is offering the option and withdrawing it under the pointer.
 *   - **On a CURVE market, the zap router is configured.** Without an address there is no
 *     contract, so the option must be GONE rather than disabled — a disabled control on a feature
 *     with nothing behind it is a promise somebody has to break.
 *   - **The market is not already priced in MON.** Both route functions answer this by returning
 *     nothing for the native asset. A MON market needs no swap in either direction: the curve is
 *     already taking and paying the chain's own token, and `zapBuyWithNative` reverts
 *     `NativeQuoteNeedsNoZap()` rather than quietly passing through.
 *   - **Some route exists, IN THE DIRECTION BEING TRADED.** `candidateRoutes` walks MON → quote
 *     for a buy; `sellRoutes` walks quote → MON for a sell. Those are two separate walks and not
 *     one list reversed — `routesBetween` in `zap-routes.ts` explains why the two sets are not
 *     mirror images of each other, and why asking the wrong one would silently drop routes that
 *     are short from where this trade actually starts.
 *
 * The direction is no longer a gate of its own. It was one — `isSell` returned `["quote"]` before
 * anything else was even looked at — for exactly as long as there was no way back out. There is
 * one now: the curve sells into its quote asset and the swap carries that on to MON, which is the
 * buy path run backwards.
 *
 * **A graduated market needs no zap router at all**, and that is why `routerConfigured` is checked
 * per venue rather than up front. Its curve is closed for good, so there is nothing to zap into or
 * out of — but its pool is an ordinary Uniswap v4 pool, which means MON → … → quote → token, or
 * the same path read right to left, is a single multi-hop swap through the UniversalRouter the
 * panel already uses for every pool trade. The ZapRouter exists precisely because a CURVE is not a
 * pool and cannot be reached that way.
 */
export function sideAssetOptions(input: {
  /** The ZapRouter. Required for a curve trade and irrelevant to a pool one. */
  routerConfigured: boolean;
  quoteAsset: string;
  isSell: boolean;
  venue: Venue;
  venueKnown: boolean;
}): SideAsset[] {
  if (!input.venueKnown) return ["quote"];
  // Gold markets trade in gold only on the market page; see `NO_NATIVE_TRADING`.
  if (!nativeTradingAllowed(input.quoteAsset)) return ["quote"];
  if (input.venue === "curve" && !input.routerConfigured) return ["quote"];
  const routes = input.isSell ? sellRoutes(input.quoteAsset) : candidateRoutes(input.quoteAsset);
  if (routes.length === 0) return ["quote"];
  return ["quote", "native"];
}

/**
 * The two floors a zap carries, from the one slippage setting the trader chose.
 *
 * They bound different legs and neither is redundant. `minQuoteOut` bounds the SWAP — it is what
 * makes a route that moved against the trader revert before the curve is touched — and `minBaseOut`
 * bounds the CURVE, which is the only figure the trader actually receives.
 *
 * Both sit the same tolerance below their own quoted value rather than compounding, and that is
 * deliberate: `minBaseOut` is what the trader agreed to receive, so it is the effective bound on
 * the whole transaction. The swap floor beside it can only make a trade that was going to breach
 * that one fail sooner and for less gas.
 */
export function zapBounds(input: {
  /** What the route quoted, in raw units of the market's quote asset. */
  quoteOut: bigint;
  /** What the curve quoted for that much quote, in base units. */
  baseOut: bigint;
  slippageBps: number;
}): { minQuoteOut: bigint; minBaseOut: bigint } {
  return {
    minQuoteOut: applySlippage(input.quoteOut, input.slippageBps),
    minBaseOut: applySlippage(input.baseOut, input.slippageBps),
  };
}

export type ZapPlan =
  /** Nothing typed yet. The panel shows the fields and no verdict. */
  | { kind: "idle" }
  /** A route is being measured. Nothing quoted may be shown, because it is about to change. */
  | { kind: "quoting" }
  /** No route is good enough at this size. The message is the whole point — see below. */
  | { kind: "unavailable"; message: string }
  /** Above the router's own spend ceiling. Refused here rather than at the wallet. */
  | { kind: "over-cap"; message: string; maximum: bigint }
  | {
      kind: "ready";
      /** Raw quote units the swap leg is expected to deliver. */
      quoteOut: bigint;
      /** Base units the curve will give for that. What the trader receives. */
      baseOut: bigint;
      minQuoteOut: bigint;
      minBaseOut: bigint;
      impactBps: number;
    };

/**
 * What the panel should be showing about a MON payment right now.
 *
 * The order of the checks is the design. The ceiling is tested BEFORE the route, because the router
 * refuses an oversized zap before it touches a pool and because telling somebody their size is over
 * the limit while a spinner spins is two pieces of news delivered in the wrong order. "Not answered
 * yet" is `undefined` and is folded into `quoting` rather than into `unavailable`: a route that has
 * not been measured is not a route that failed, and rendering the failure message for a quarter of
 * a second on every keystroke would teach people to ignore it.
 */
export function zapPlan(input: {
  /** MON to spend, in wei. */
  amountIn: bigint;
  /** True while the debounce is pending or the quote is in flight. */
  quoting: boolean;
  /**
   * The chosen route — `null` when nothing was deep enough, `undefined` when the answer has not
   * arrived. The two are different states and collapsing them is what produces a panel that
   * accuses the pools of being thin before it has asked them anything.
   */
  route: { amountOut: bigint; impactBps: number } | null | undefined;
  /** The curve's `quoteBuy` on the route's output, in base units. `undefined` until it answers. */
  baseOut: bigint | undefined;
  slippageBps: number;
  /** The router's ceiling in wei, `0n` for none, `undefined` before it has been read. */
  maximum: bigint | undefined;
  /** The market's own asset, named in every message so the alternative is concrete. */
  quoteSymbol: string;
}): ZapPlan {
  if (input.amountIn <= 0n) return { kind: "idle" };

  if (input.maximum !== undefined && input.maximum > 0n && input.amountIn > input.maximum) {
    return {
      kind: "over-cap",
      maximum: input.maximum,
      message: `This route accepts at most ${formatMonAmount(input.maximum)} MON in one trade. Buy a smaller amount, or pay with ${input.quoteSymbol}.`,
    };
  }

  if (input.quoting || input.route === undefined) return { kind: "quoting" };

  if (input.route === null) {
    return {
      kind: "unavailable",
      message: `MON cannot be swapped into ${input.quoteSymbol} for a trade this size — the pools are too thin, and the price you would get is not one worth taking. Pay with ${input.quoteSymbol} instead, or try a smaller amount.`,
    };
  }

  if (input.baseOut === undefined) return { kind: "quoting" };

  const bounds = zapBounds({
    quoteOut: input.route.amountOut,
    baseOut: input.baseOut,
    slippageBps: input.slippageBps,
  });
  return {
    kind: "ready",
    quoteOut: input.route.amountOut,
    baseOut: input.baseOut,
    impactBps: input.route.impactBps,
    ...bounds,
  };
}

/**
 * The same verdict for a market that has GRADUATED, where the whole trade is one swap.
 *
 * Deliberately a second function rather than a flag on `zapPlan`, because the two differ in every
 * part that matters and a shared one would be a list of branches:
 *
 *   - **There is one leg, so there is one floor.** The curve zap bounds the swap and the curve
 *     separately; here the swap IS the trade and the tokens it returns are the only figure the
 *     buyer receives.
 *   - **There is no ceiling.** `maxZapValue` belongs to the ZapRouter, which is not in this path.
 *     Applying it here would refuse a trade the chain would have accepted, on a route that is an
 *     ordinary pool buy with an extra hop in front of it.
 *   - **There is no second quote to wait for.** No `baseOut` arrives later from a curve: the
 *     quoter walks the whole path, including the market's own pool, and answers in tokens.
 */
export type PoolZapPlan =
  | { kind: "idle" }
  | { kind: "quoting" }
  | { kind: "unavailable"; message: string }
  | {
      kind: "ready";
      /** Base units the swap delivers. What the buyer receives. */
      baseOut: bigint;
      minBaseOut: bigint;
      impactBps: number;
    };

export function poolZapPlan(input: {
  /** MON to spend, in wei. */
  amountIn: bigint;
  quoting: boolean;
  /**
   * The chosen route, measured over the WHOLE path — MON through to the market's own token.
   * `null` when nothing was deep enough, `undefined` before the answer has arrived.
   */
  route: { amountOut: bigint; impactBps: number } | null | undefined;
  slippageBps: number;
  quoteSymbol: string;
}): PoolZapPlan {
  if (input.amountIn <= 0n) return { kind: "idle" };
  if (input.quoting || input.route === undefined) return { kind: "quoting" };

  if (input.route === null) {
    return {
      kind: "unavailable",
      message: `MON cannot be swapped into ${input.quoteSymbol} for a trade this size — the pools are too thin, and the price you would get is not one worth taking. Pay with ${input.quoteSymbol} instead, or try a smaller amount.`,
    };
  }

  return {
    kind: "ready",
    baseOut: input.route.amountOut,
    minBaseOut: applySlippage(input.route.amountOut, input.slippageBps),
    impactBps: input.route.impactBps,
  };
}

/**
 * The one sentence a trader gets when the swap leg cannot be had at this size, on a SELL.
 *
 * Shared by both sell plans deliberately. It is the whole point of the `unavailable` state — not a
 * broken quote and not a dead button, but the alternative in words — and two copies of it are two
 * things to keep in step. It reads the other way round from the buy's: the market's own asset is
 * what the trader would be LEFT holding rather than what they would have to go and acquire, so it
 * is offered as something to take, not something to pay with.
 */
function sellUnavailableMessage(quoteSymbol: string): string {
  return `${quoteSymbol} cannot be swapped into MON for a trade this size — the pools are too thin, and the price you would get is not one worth taking. Take ${quoteSymbol} instead, or try a smaller amount.`;
}

/**
 * The mirror of `ZapPlan`, for selling a coin on a live CURVE and walking away with MON.
 *
 * Two legs again, so two floors again: the curve pays out in the market's quote asset and the swap
 * carries that on to MON. `nativeOut` is the only figure the seller actually receives, and
 * `quoteOut` is the intermediate that the swap consumes.
 */
export type SellZapPlan =
  /** Nothing typed yet. The panel shows the fields and no verdict. */
  | { kind: "idle" }
  /** The curve or a route is being measured. Nothing quoted may be shown; it is about to change. */
  | { kind: "quoting" }
  /** No route is good enough at this size. The message is the whole point — see above. */
  | { kind: "unavailable"; message: string }
  /** The MON this sell would produce is above the router's own ceiling. */
  | { kind: "over-cap"; message: string; maximum: bigint }
  | {
      kind: "ready";
      /** Raw quote units the curve is expected to pay for the tokens sold. */
      quoteOut: bigint;
      /** Wei the swap leg turns that into. What the seller receives. */
      nativeOut: bigint;
      minQuoteOut: bigint;
      minNativeOut: bigint;
      impactBps: number;
    };

/**
 * What the panel should be showing about being paid in MON right now.
 *
 * `undefined` and `null` mean different things here exactly as they do in `zapPlan`: `undefined` is
 * "the answer has not arrived" and folds into `quoting`, `null` is "asked, and no route was good
 * enough" and becomes `unavailable`. Collapsing them produces a panel that accuses the pools of
 * being thin before it has asked them anything, once per keystroke, which is how a real warning
 * becomes one people have learned to look past.
 *
 * ## The ceiling is tested AFTER the route here, and that inversion is deliberate
 *
 * `zapPlan` documents the opposite order and is right to: on a buy, `amountIn` is the MON being
 * spent and the ceiling is a bound on that same number, so it can be checked before a single pool
 * is touched.
 *
 * On a sell it cannot. **`amountIn` is raw units of the market's TOKEN and `maximum` is MON wei.**
 * They are different assets with different decimals, so `amountIn > maximum` is not a comparison at
 * all — it is arithmetic on two unrelated scales, and it fails in both directions at once: a
 * perfectly ordinary sell of a token with more decimals than MON is refused, and a genuinely
 * oversized one sails through to revert at the wallet. Neither failure prints anything a reader
 * could catch, because both produce a plausible-looking panel.
 *
 * So the ceiling is measured against `route.amountOut`, the only figure in this function that is
 * denominated in MON — which means it cannot be evaluated until the route has answered, and
 * therefore has to sit below the `quoting` and `route === null` branches. It is placed immediately
 * after them rather than at the end, so the news still arrives as early as this direction allows.
 */
export function sellZapPlan(input: {
  /**
   * Tokens to sell, in RAW BASE UNITS of the market's own token — NOT in MON, and not comparable
   * to `maximum`. See the ceiling note above.
   */
  amountIn: bigint;
  /** True while the debounce is pending or a quote is in flight. */
  quoting: boolean;
  /**
   * The chosen quote → MON route. `amountOut` is wei. `null` when nothing was deep enough,
   * `undefined` when the answer has not arrived.
   */
  route: { amountOut: bigint; impactBps: number } | null | undefined;
  /** The curve's `quoteSell` for `amountIn`, in raw quote units. `undefined` until it answers. */
  quoteOut: bigint | undefined;
  slippageBps: number;
  /** The router's ceiling in wei, `0n` for none, `undefined` before it has been read. */
  maximum: bigint | undefined;
  /** The market's own asset, named in every message so the alternative is concrete. */
  quoteSymbol: string;
}): SellZapPlan {
  if (input.amountIn <= 0n) return { kind: "idle" };

  if (input.quoting || input.route === undefined) return { kind: "quoting" };

  if (input.route === null) {
    return { kind: "unavailable", message: sellUnavailableMessage(input.quoteSymbol) };
  }

  if (input.maximum !== undefined && input.maximum > 0n && input.route.amountOut > input.maximum) {
    return {
      kind: "over-cap",
      maximum: input.maximum,
      message: `This route accepts at most ${formatMonAmount(input.maximum)} MON in one trade, and this sell would produce ${formatMonAmount(input.route.amountOut)}. Sell a smaller amount, or take ${input.quoteSymbol}.`,
    };
  }

  if (input.quoteOut === undefined) return { kind: "quoting" };

  /*

   * A curve that pays NOTHING is not a trade, and `0n` is an answer rather than a pending one.

   *

   * `undefined` folds into `quoting` above; zero used to fall straight through and produce a

   * `ready` plan with `minQuoteOut: 0n` — a signed floor of zero on the curve leg, which is a

   * standing offer to be given nothing for the tokens. `BondingCurve.sell` documents that a

   * zero payout is reachable with ORDINARY amounts on a coarse quote: one troy ounce of gold

   * is 1e6 raw units, so a few hundred whole tokens round away. Gold is exactly the market

   * class this feature exists for.

   *

   * The panel happened not to reach it — a guard in `SwapComponent.tsx` holds the route query

   * until the curve answers non-zero — but that guard lives in a `.tsx`, which this repo has

   * no harness for, and it also renders an eternal spinner instead of saying why. Refusing

   * here says it, and says it somewhere that is tested.

   */

  if (input.quoteOut === 0n) {
    return {
      kind: "unavailable",

      message: `This sale is too small to pay anything in ${input.quoteSymbol}. Sell more.`,
    };
  }

  // Each floor sits its own tolerance below its own quoted value rather than compounding, for the
  // reason `zapBounds` gives: `minNativeOut` is what the seller agreed to receive and is therefore
  // the effective bound on the whole transaction, and the swap-leg floor beside it can only make a
  // trade that was going to breach that one fail sooner and for less gas.
  return {
    kind: "ready",
    quoteOut: input.quoteOut,
    nativeOut: input.route.amountOut,
    minQuoteOut: applySlippage(input.quoteOut, input.slippageBps),
    minNativeOut: applySlippage(input.route.amountOut, input.slippageBps),
    impactBps: input.route.impactBps,
  };
}

/**
 * The same verdict for selling out of a market that has GRADUATED, where the whole trade is one
 * swap.
 *
 * A second function rather than a flag on `sellZapPlan`, for the reasons `poolZapPlan` gives about
 * the buy side, read backwards:
 *
 *   - **There is one leg, so there is one floor.** The curve sell bounds the curve and the swap
 *     separately; here the swap IS the trade, token through to MON, and the wei it returns are the
 *     only figure the seller receives.
 *   - **There is no ceiling, and this one has no `over-cap` state at all.** `maxZapValue` belongs
 *     to the ZapRouter, which is not in this path. Applying it here would refuse a trade the chain
 *     would have accepted, on a route that is an ordinary pool sell with an extra hop after it.
 *   - **There is no second quote to wait for.** No `quoteOut` arrives later from a curve: the
 *     quoter walks the whole path, including the market's own pool, and answers in wei.
 */
export type PoolSellZapPlan =
  | { kind: "idle" }
  | { kind: "quoting" }
  | { kind: "unavailable"; message: string }
  | {
      kind: "ready";
      /** Wei the swap delivers. What the seller receives. */
      nativeOut: bigint;
      minNativeOut: bigint;
      impactBps: number;
    };

export function poolSellZapPlan(input: {
  /** Tokens to sell, in raw base units of the market's own token. */
  amountIn: bigint;
  quoting: boolean;
  /**
   * The chosen route, measured over the WHOLE path — the market's own token through to MON.
   * `null` when nothing was deep enough, `undefined` before the answer has arrived.
   */
  route: { amountOut: bigint; impactBps: number } | null | undefined;
  slippageBps: number;
  quoteSymbol: string;
}): PoolSellZapPlan {
  if (input.amountIn <= 0n) return { kind: "idle" };
  if (input.quoting || input.route === undefined) return { kind: "quoting" };

  if (input.route === null) {
    return { kind: "unavailable", message: sellUnavailableMessage(input.quoteSymbol) };
  }

  return {
    kind: "ready",
    nativeOut: input.route.amountOut,
    minNativeOut: applySlippage(input.route.amountOut, input.slippageBps),
    impactBps: input.route.impactBps,
  };
}

/**
 * The assets a route passes through, in order, starting with MON.
 *
 * Shown rather than summarised. A trade that reads "MON → USDC → WBTC" crosses two pools, pays two
 * fees and depends on two lots of liquidity, and a buyer who is told only "pay with MON" has been
 * sold the second pool without being shown it.
 *
 * @param symbolOf the registry's answer for an address, or undefined for an asset it has never
 *        heard of — which is possible, because the route graph is measured from the chain and the
 *        catalogue is edited by hand. A shortened address is a worse label than a ticker and a much
 *        better one than a blank.
 */
const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

export function routeLabels(
  path: Path,
  symbolOf: (address: string) => string | undefined
): string[] {
  if (path.length === 0) return [];
  const label = (address: string) =>
    symbolOf(address) ?? (address.toLowerCase() === NATIVE ? "MON" : shortAddress(address));
  return [label(path[0].from), ...path.map((hop) => label(hop.to))];
}

/**
 * Price impact as a person reads it.
 *
 * Two decimals, because the difference between 0.4% and 0.04% is the difference between a fine
 * trade and a free one and both round to "0%" at zero places. A non-zero impact too small to print
 * becomes `<0.01%` rather than `0.00%`: a route that costs something must never claim it is free,
 * however little that something is.
 */
export function formatImpactBps(bps: number): string {
  if (bps <= 0) return "0.00%";
  if (bps < 1) return "<0.01%";
  return `${(bps / 100).toFixed(2)}%`;
}

/**
 * How loudly to say it.
 *
 * Anything reaching this function already passed `MAX_ZAP_IMPACT_BPS` — a route worse than that was
 * never offered — so these are gradations of acceptable, not warnings of danger. Colouring a
 * fifteen-basis-point route red would be an alarm about nothing, and a panel that cries wolf is one
 * people stop reading.
 */
export function impactSeverity(bps: number): "ok" | "warn" | "high" {
  if (bps >= (MAX_ZAP_IMPACT_BPS * 2) / 3) return "high";
  if (bps >= 50) return "warn";
  return "ok";
}

/**
 * A MON amount for a sentence, not for a receipt.
 *
 * Four decimals at most and trailing zeros removed, so a ceiling of exactly twenty-five reads as
 * "25 MON" rather than "25.0000 MON" — a number with meaningless precision on it reads as a
 * computed value rather than as a limit somebody chose.
 */
export function formatMonAmount(wei: bigint): string {
  const whole = Number(formatUnits(wei, 18));
  if (!Number.isFinite(whole)) return formatUnits(wei, 18);
  return whole.toFixed(4).replace(/\.?0+$/, "");
}

/**
 * `ZapTooLarge(offered, maximum)`, pulled back out of whatever threw it.
 *
 * The router carries an owner-set spend cap and it can be lowered between the panel reading it and
 * the trader signing, so this revert reaches real people even with the check above in place. Read
 * as a generic failure it arrives as "the contract rejected this transaction", which names nothing
 * anybody can act on.
 *
 * Two routes in, because the error takes two shapes. viem decodes a custom error into
 * `data.errorName` and `data.args` when it built the request itself, and hands back a printed
 * message when the rejection came from the node after the fact.
 */
export function decodeZapTooLarge(error: unknown): { offered: bigint; maximum: bigint } | null {
  const found = decodeCapRevert(error, "ZapTooLarge");
  return found === null ? null : { offered: found.amount, maximum: found.maximum };
}

/**
 * `SellTooLarge(paid, maximum)`, the same revert from the other end of the trade.
 *
 * The router applies its spend cap to the MON a zap MOVES, and on a sell that is the MON the swap
 * produced rather than the MON somebody offered — so the panel's own check, which reads a route
 * quote taken moments earlier, can be under the ceiling while the transaction that lands is over
 * it. A route that improved between the quote and the signature is enough to do it, and so is an
 * owner lowering the cap in between. Read as a generic failure this arrives as "the contract
 * rejected this transaction", which names nothing anybody can act on.
 */
export function decodeSellTooLarge(error: unknown): { paid: bigint; maximum: bigint } | null {
  const found = decodeCapRevert(error, "SellTooLarge");
  return found === null ? null : { paid: found.amount, maximum: found.maximum };
}

/**
 * One reader for both ceiling reverts, because they are the same error twice over.
 *
 * Both declare `(amount, maximum)` in that order, and both arrive in two shapes — viem decodes a
 * custom error into `data.errorName` and `data.args` when it built the request itself, and hands
 * back a printed message when the rejection came from the node after the fact. Two copies of that
 * pair of lookups would be two places for the regex to drift, and the regex is the half that has
 * no type checker behind it.
 *
 * The names do not collide: neither string is a substring of the other, so a `SellTooLarge` message
 * cannot be read as a `ZapTooLarge` one.
 */
function decodeCapRevert(
  error: unknown,
  errorName: string
): { amount: bigint; maximum: bigint } | null {
  for (const node of errorChain(error)) {
    const data = (node as { data?: { errorName?: string; args?: readonly unknown[] } }).data;
    if (data?.errorName !== errorName) continue;
    const [amount, maximum] = (data.args ?? []) as readonly unknown[];
    if (typeof amount === "bigint" && typeof maximum === "bigint") return { amount, maximum };
  }

  // Positional, in the order the errors declare their arguments: the amount first, then the
  // ceiling. `\D+` skips whatever punctuation the printer put between them.
  const match = new RegExp(`${errorName}\\D+(\\d+)\\D+(\\d+)`).exec(messageOf(error));
  if (match) return { amount: BigInt(match[1]), maximum: BigInt(match[2]) };
  return null;
}

/**
 * What went wrong with a zap, in words.
 *
 * Only the two ceilings are handled here. Everything else — a rejection in the wallet, an ordinary
 * revert, and in particular MONAD'S 10 MON RESERVE, which a zap is subject to like any other
 * transaction that spends MON — is already named by `describeTxError`, and a second implementation
 * of those would be a second place for the reserve message to go stale.
 */
export function describeZapError(error: unknown): DescribedTxError {
  const cap = decodeZapTooLarge(error);
  if (cap) {
    return {
      kind: "reverted",
      message: `This route accepts at most ${formatMonAmount(cap.maximum)} MON in one trade, and this one offered ${formatMonAmount(cap.offered)}. Buy a smaller amount.`,
    };
  }

  /*
   * The sell's ceiling is on what would be PAID OUT, not on what was put in — the seller never
   * named a MON figure, so the sentence has to supply the one the router objected to.
   *
   * "would have paid you" rather than "would have produced", since ZapRouter v3. The ceiling
   * weighs `_sweepNative`'s own return value, and that can exceed what the swap leg produced —
   * MON reaching the router by any other route is paid out too, and is weighed too. Saying
   * "produced" would name a smaller number than the one the router actually refused.
   */
  const paid = decodeSellTooLarge(error);
  if (paid) {
    return {
      kind: "reverted",
      message: `This route accepts at most ${formatMonAmount(paid.maximum)} MON in one trade, and this one would have paid you ${formatMonAmount(paid.paid)}. Sell a smaller amount.`,
    };
  }

  return describeTxError(error);
}

/** Every error in a `cause` chain, outermost first. Depth-bounded: a cycle would not terminate. */
function* errorChain(error: unknown): Generator<object> {
  let node = error;
  for (let depth = 0; depth < 10 && node !== null && typeof node === "object"; depth++) {
    yield node as object;
    node = (node as { cause?: unknown }).cause;
  }
}

/** Everything a viem error prints, joined — `metaMessages` is where a decoded revert's args land. */
function messageOf(error: unknown): string {
  const e = (error ?? {}) as { message?: string; shortMessage?: string; metaMessages?: string[] };
  return [e.shortMessage, e.message, ...(e.metaMessages ?? [])].filter(Boolean).join("\n");
}

/**
 * The slippage tolerance, clamped to something the write path will accept.
 *
 * The setting arrives from `localStorage`, where a custom value may be anything an older build
 * wrote — and `applySlippage` THROWS above its limit, because a 100% tolerance sets the floor to
 * zero, which is a standing offer to be sandwiched for the whole trade. That throw is correct on
 * the write path and fatal on the render path: the bounds are computed while the panel draws, so
 * an unclamped setting would replace the market page with an error boundary rather than refuse a
 * trade.
 *
 * Clamping rather than refusing, because the trade is still one the trader can have — at the widest
 * tolerance the control offers. The rule itself lives in `./slippage`, shared with the direct path,
 * so a zap and an ordinary buy from the same setting sign the same floor. It used to be a private
 * clamp to 50% here and no clamp at all there.
 */
export function zapSlippageBps(setting: bigint | number): number {
  return Number(clampSlippageBps(setting));
}

/**
 * Ten to the power of `n`, without the exponent operator.
 *
 * SWC lowers `**` to `Math.pow` for this project's browserslist target, and `Math.pow` throws on a
 * BigInt — the same trap that has taken two routes down here before, documented in `pool-price.ts`
 * and `liquidity-calls.ts`. Those were module-level constants and failed at import; this one is
 * inside a function, so it would wait and then throw on the first trade someone tried to restate,
 * which is worse. Built from a string because the exponent is a runtime value and cannot be a
 * literal.
 */
const pow10 = (n: number): bigint => BigInt(`1${"0".repeat(n)}`);

/**
 * The same number of whole units, re-scaled to a different asset's decimals.
 *
 * What "5" should mean after switching which asset you are paying with. The alternative — leaving
 * the raw amount alone — silently turns 5 USDC into five millionths of a MON, or 5 MON into five
 * trillion units of gold, and the field goes on rendering a number the whole time.
 *
 * Truncates when moving to fewer decimals, which loses at most one raw unit of the destination and
 * never invents value the trader does not have.
 */
export function restateAmount(amount: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (fromDecimals === toDecimals) return amount;
  if (toDecimals > fromDecimals) return amount * pow10(toDecimals - fromDecimals);
  return amount / pow10(fromDecimals - toDecimals);
}
