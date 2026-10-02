import type { PublicClient, WalletClient } from "viem";
import { erc20Abi } from "viem";

import { curveAbi, factoryAbi, graduationAbi } from "./abis";
import type { EncodedCall } from "./encoded-call";
import type { BatchSupport } from "./sell-batch";
import { clampSlippageBps } from "./slippage";

/**
 * The write path: launch, buy, sell.
 *
 * The two arguments a trading UI is most likely to get wrong are slippage and deadline, and both
 * fail in the direction of the user losing money rather than seeing an error. They are computed
 * here, once, with guards — not inline at each call site.
 */

export class SlippageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlippageError";
  }
}

/**
 * The widest tolerance the app will send. 50% — generous enough for a thin curve in its first
 * minutes, narrow enough that it is still a limit.
 */
export const MAX_SLIPPAGE_BPS = 5_000;

/**
 * Turns a quoted amount into the minimum the trade may deliver.
 *
 * The guard is the point. A slippage field that accepts 10,000 bps sets the floor to zero, which
 * is a standing offer to be sandwiched for the whole trade — and it arrives from a text box, so
 * trusting it is a decision, not a default.
 */
export function applySlippage(quoted: bigint, toleranceBps: number): bigint {
  if (!Number.isInteger(toleranceBps) || toleranceBps < 0) {
    throw new SlippageError(`slippage must be a whole number of basis points: ${toleranceBps}`);
  }
  if (toleranceBps > MAX_SLIPPAGE_BPS) {
    throw new SlippageError(
      `slippage of ${toleranceBps} bps exceeds the ${MAX_SLIPPAGE_BPS} bps limit`
    );
  }
  // Integer arithmetic, rounding down. Rounding up would put the floor above what the trade can
  // deliver, so a fair fill would revert.
  return (quoted * BigInt(10_000 - toleranceBps)) / 10_000n;
}

/**
 * The floor a trade is signed with, from a setting that came from anywhere.
 *
 * `applySlippage` is the arithmetic and refuses a tolerance it will not sign; this is the entry
 * point for a setting that has not been vetted yet — the box, `localStorage`, an older build — and
 * brings it into range first. It is the ONLY way the panel should turn a quote into a minimum: the
 * direct curve and pool path computed its own floor from the raw stored number, and a wallet whose
 * storage still held 10,000 bps signed `minBaseOut = 0` on every ordinary trade while the zap,
 * which clamped, signed a real one. Two floors for one setting is how that happens; this is one.
 */
export function minimumOut(quoted: bigint, setting: bigint | number): bigint {
  return applySlippage(quoted, Number(clampSlippageBps(setting)));
}

/**
 * A deadline, in **seconds**.
 *
 * `Date.now()` is milliseconds, and a deadline in milliseconds is roughly a thousand times further
 * away than intended — which disables the protection completely while looking like it works.
 */
export function deadlineFrom(nowMs: number, windowSecs: number): bigint {
  if (!Number.isFinite(windowSecs) || windowSecs <= 0) {
    throw new Error(`deadline window must be positive: ${windowSecs}`);
  }
  return BigInt(Math.floor(nowMs / 1000) + Math.floor(windowSecs));
}

export interface TradeParams {
  curve: `0x${string}`;
  /** What the curve is expected to return, from a simulation or a quote. */
  quoted: bigint;
  slippageBps: number;
  deadlineSecs?: number;
}

/**
 * Native MON, as a quote-asset field spells it.
 *
 * `address(0)` and not `null`. A market row that carries no quote column is a generation-1 market,
 * which is MON — so absence and this value mean the same thing, and the model already resolves one
 * into the other.
 */
export const NATIVE_QUOTE = "0x0000000000000000000000000000000000000000" as const;

/** Whether a market's quote asset is the chain's own currency. Case-insensitive: rows vary. */
export const isNativeQuote = (asset: string): boolean => asset.toLowerCase() === NATIVE_QUOTE;

/** The three ways into `BondingCurve`, which are mutually exclusive on chain. */
export type CurveBuyEntry = "buy" | "buyWithToken" | "buyWithPermit";

/**
 * Which entry point this market's curve accepts.
 *
 * There is no forgiving path. `buy` is payable and reverts `QuoteIsNotNative()` on an ERC-20
 * market; `buyWithToken` pulls the quote and reverts `QuoteIsNative()` on a MON one. The choice is
 * therefore a property of the MARKET, read from its own `quote_asset`, and never of whichever
 * balance a component happened to have to hand.
 *
 * A permit is preferred where the caller has one, because it collapses the approval and the buy
 * into a single signature. It is meaningless over native MON — there is no token to sign for — so
 * a permit supplied against a native quote is ignored rather than honoured into a revert.
 */
export function curveBuyEntry(params: { quoteAsset: string; hasPermit?: boolean }): CurveBuyEntry {
  if (isNativeQuote(params.quoteAsset)) return "buy";
  return params.hasPermit ? "buyWithPermit" : "buyWithToken";
}

/**
 * `quoteBuy`'s five values, named.
 *
 * It returned four in generation 1 and returns five now — `creatorTax` was inserted between the
 * anti-sniper tax and the refund. A destructure that still expects four reads the CREATOR TAX as
 * the refund and never sees the refund at all, which is the difference between "you will get some
 * of this back" and "this market has graduated". Named once, here, so no call site counts.
 */
export interface BuyQuote {
  baseOut: bigint;
  /** The 1% protocol fee. */
  fee: bigint;
  /** The decaying launch tax. Zero once the window closes. */
  antiSniperTax: bigint;
  /** The creator's own charge. Theirs, not the protocol's — show it as its own line. */
  creatorTax: bigint;
  /** What the curve will hand back, unspent. */
  refund: bigint;
}

/** `quoteSell`'s three. There is no anti-sniper tax on a sell and no refund. */
export interface SellQuote {
  quoteOut: bigint;
  fee: bigint;
  creatorTax: bigint;
}

export const buyQuoteFrom = (
  tuple: readonly [bigint, bigint, bigint, bigint, bigint]
): BuyQuote => ({
  baseOut: tuple[0],
  fee: tuple[1],
  antiSniperTax: tuple[2],
  creatorTax: tuple[3],
  refund: tuple[4],
});

export const sellQuoteFrom = (tuple: readonly [bigint, bigint, bigint]): SellQuote => ({
  quoteOut: tuple[0],
  fee: tuple[1],
  creatorTax: tuple[2],
});

/**
 * Whether this quote is the closed curve answering, rather than a trade.
 *
 * A curve that has filled does not revert when it is quoted — `quoteBuy` returns the whole input
 * as `refund` and nothing out. As a tuple of numbers that is indistinguishable from a very small
 * trade, so the panel rendered zeros, kept its button lit, and reverted `CurveClosed()` on every
 * click. It is a STATE and has to be read as one.
 *
 * The test that matters is `baseOut === 0`. The buy that FILLS a curve also carries a large refund
 * — it takes only what the curve still needed — and treating that as graduated would refuse the
 * single most important trade in a market's life.
 */
export function curveIsClosed(quote: BuyQuote, quoteIn: bigint): boolean {
  if (quoteIn <= 0n) return false;
  return quote.baseOut === 0n && quote.refund >= quoteIn;
}

const DEFAULT_DEADLINE_SECS = 120;

/**
 * A buy on the curve.
 *
 * `quoteIn` is RAW units of the market's own quote asset, and `quoteAsset` is the address that
 * says which asset that is. They travel together because either alone is a number without a unit,
 * and a number without a unit is how a six-decimal amount gets scaled by eighteen.
 */
export interface CurveBuyParams extends TradeParams {
  quoteIn: bigint;
  /** `NATIVE_QUOTE` for MON. From the market row's `quote_asset`, never from a global. */
  quoteAsset: `0x${string}`;
  /**
   * An EIP-2612 signature over the quote token, where the wallet produced one.
   *
   * Optional, and absent today: the panel approves instead. It is in the shape because the
   * contract has the entry point and because the alternative — discovering at the wallet that
   * there was a one-signature path — is worse than an unused field.
   */
  permit?: { v: number; r: `0x${string}`; s: `0x${string}` };
}

/**
 * How far below `remaining` a buy still counts as the one that will fill the curve.
 *
 * FOUR TIMES, not the 5% it began as, and the number is doing real work.
 *
 * The old margin only caught a buy that came within 4.2% of `remaining` ON ITS OWN. It therefore
 * missed the case that actually happens in a contested block: TWO buys that together fill the curve
 * while neither is close to it alone. Two buyers each taking half of what is left are each 50%
 * short, so neither is flagged, and whichever the block orders last carries an ordinary limit —
 * about 106,000 gas — into a transaction that now has to graduate the market as well, which needs
 * 999,241. `_tryAutoGraduate` forwards 63/64 of what is left, finds it nowhere near enough, and
 * swallows the failure by design so the buyer's own trade survives. The market fills, closes, and
 * has no pool.
 *
 * A multiple rather than a percentage, because the risk is not "did I misjudge the size" — it is
 * "how many buyers of about this size fit in the gap". At 4x, any pair of buys that together fill
 * the curve carries the graduation limit on both, and so does any group of four.
 *
 * The asymmetry is what settles it. Being wrong in this direction costs the buyer the difference
 * between a 2.5M limit and the ~106k they needed — 0.48 MON at 202 gwei, about a cent, and only on
 * the handful of buys that come near the end of a curve. Being wrong in the other direction strands
 * the entire raise until someone notices and graduates the market by hand.
 */
const FILL_MARGIN_MULTIPLE = 4n;

/**
 * Predicts whether this buy is the one that fills the curve, and therefore graduates it.
 *
 * DELIBERATELY ROUNDS UP, and see `FILL_MARGIN_MULTIPLE` for how far. The prediction is racy —
 * another buy or a sell landing first, or the anti-sniper rate moving with `block.timestamp`,
 * changes `remaining` between quote and inclusion — so it says "will fill" for anything in the same
 * neighbourhood as the gap. Paying the large gas limit on a near-miss costs the buyer a cent; the
 * reverse silently leaves a filled market with no pool.
 */
export function willLikelyFill(
  monIn: bigint,
  remaining: bigint,
  multiple = FILL_MARGIN_MULTIPLE
): boolean {
  if (remaining === 0n) return false;
  /*
   * The GROSS, not the amount net of the protocol fee.
   *
   * Netting the fee off first was in here and it pointed the wrong way. This predicate exists to
   * over-fire: every deduction makes it fire less often, and the whole asymmetry is that a false
   * positive costs a cent while a false negative strands a raise. It also mattered at the exact
   * boundary — four buyers each taking a quarter of what remains are precisely the group the 4x
   * margin is meant to cover, and a 1% haircut put them just outside it.
   */
  return monIn * multiple >= remaining;
}

/**
 * Finishes a graduation the filling buy could not.
 *
 * `DokuGraduation.graduate` is permissionless by design — anyone may push a filled market over the
 * line — and normally nobody calls it, because the buy that fills the curve calls it inline. This
 * is the path for when that inline call was STARVED: `_tryAutoGraduate` forwards 63/64 of the
 * remaining gas and swallows any failure, so a buy that carried an ordinary limit into a
 * transaction that also had to create a pool leaves the market filled, closed, and poolless. The
 * contract has always been able to recover from that. Nothing in this app ever asked it to.
 *
 * The gas hint comes from the curve rather than from a constant here: `autoGraduationGasHint` is
 * what the curve itself says its graduation costs, so a future graduation that costs more cannot
 * leave this function sending too little. `eth_estimateGas` cannot be trusted for it either — the
 * estimator returns a limit at which the market fills and does NOT graduate, because the failure it
 * would have to observe is swallowed.
 */
export async function graduateMarket(
  wallet: WalletClient,
  publicClient: PublicClient,
  params: { graduation: `0x${string}`; curve: `0x${string}` }
): Promise<`0x${string}`> {
  const account = wallet.account;
  if (!account) throw new Error("no connected account");

  const hint = (await publicClient.readContract({
    address: params.curve,
    abi: curveAbi,
    functionName: "autoGraduationGasHint",
  })) as bigint;

  const { request } = await publicClient.simulateContract({
    address: params.graduation,
    abi: graduationAbi,
    functionName: "graduate",
    args: [params.curve],
    account,
    // Plus a quarter, because Monad bills the LIMIT and the difference between a generous limit and
    // a tight one on this call is a few cents against a raise that is otherwise frozen.
    gas: hint + hint / 4n,
  });
  return wallet.writeContract(request);
}

/**
 * Buys with MON. `value` is the gross amount; the fee and tax come out of it on chain.
 *
 * ## Why this does not just forward the wallet's gas estimate
 *
 * The buy that fills a curve also GRADUATES it, in the same transaction, inside a `try`/`catch`.
 * `eth_estimateGas` binary-searches for the lowest limit at which the TRANSACTION succeeds — and
 * because the catch swallows the failure, the transaction succeeds at every limit above the buy
 * body's own cost. The estimator therefore returns a limit at which the market does not graduate,
 * and nothing about the receipt says so. Measured on Monad's own RPC: the estimate comes back
 * 12,869 gas short, which is `G/63`, the EIP-150 headroom an estimator cannot observe.
 *
 * The blanket fix — a generous limit on every buy — is worse here than elsewhere, because Monad
 * charges at the LIMIT rather than at usage. It would bill every buyer in every market extra
 * forever so that one transaction in each market's life works.
 *
 * So: override the limit ONLY on the buy that is going to fill, and read that limit FROM THE CURVE
 * rather than hardcoding it, so a future curve can change what graduation costs without stranding
 * this file.
 *
 * An ordinary buy is left to the estimator, because on an ordinary buy the estimator is right —
 * there is no swallowed inner call for it to be blind to. An earlier revision hardcoded that tier
 * too, at 180,000, "because an estimate that happens to be right today is not a policy". Measured
 * against the curve that ships, a buyer's FIRST purchase in a market costs 210,219: cold storage
 * for their token balance and for the curve's own slots. So every buyer's first trade in every
 * market ran out of gas and reverted, while the simulation that preceded it passed — because
 * `simulateContract` does not apply the limit the wallet is about to send. Subsequent buys cost
 * 105,990 and fit under the constant, which is why it looked like it worked.
 *
 * Monad charges at the LIMIT rather than at usage, so a generous blanket limit is not a free fix
 * either: it would bill every buyer in every market for headroom almost none of them use.
 */
export async function buy(
  wallet: WalletClient,
  publicClient: PublicClient,
  params: TradeParams & { monIn: bigint }
): Promise<`0x${string}`> {
  return buyOnCurve(wallet, publicClient, {
    ...params,
    quoteIn: params.monIn,
    quoteAsset: NATIVE_QUOTE,
  });
}

/**
 * A buy on the curve, whatever the market is priced in.
 *
 * Every amount here is in RAW units of THAT MARKET'S quote asset — six decimals for USDC and for
 * gold, eight for the wrapped bitcoins, eighteen for MON. There is no global eighteen anywhere on
 * this path; the panel scales by `quote_decimals` off the market row before it ever reaches here.
 *
 * The entry point comes from `curveBuyEntry`, and the difference is not cosmetic: `buy` is payable
 * and `buyWithToken` pulls, so calling the wrong one reverts `QuoteIsNative()` or
 * `QuoteIsNotNative()` after the wallet has already been opened. An ERC-20 quote must have
 * approved **the curve** — not the factory, which is the launch path's spender — for `quoteIn`.
 */
export async function buyOnCurve(
  wallet: WalletClient,
  publicClient: PublicClient,
  params: CurveBuyParams
): Promise<`0x${string}`> {
  const account = wallet.account;
  if (!account) throw new Error("no connected account");

  const entry = curveBuyEntry({
    quoteAsset: params.quoteAsset,
    hasPermit: params.permit !== undefined,
  });

  const [remaining, graduationGas] = await Promise.all([
    publicClient.readContract({ address: params.curve, abi: curveAbi, functionName: "remaining" }),
    publicClient.readContract({
      address: params.curve,
      abi: curveAbi,
      functionName: "autoGraduationGasHint",
    }),
  ]);

  const minOut = applySlippage(params.quoted, params.slippageBps);
  const deadline = deadlineFrom(Date.now(), params.deadlineSecs ?? DEFAULT_DEADLINE_SECS);

  /*
   * One simulation per shape, rather than one with a computed argument list.
   *
   * viem types `args` against the named function, so the three arms cannot be collapsed without
   * casting the tuple — and a cast here would let a wrong-length argument list through to a wallet
   * rather than to the compiler. See the note on `LaunchParams` for the same argument about order.
   */
  const fills = willLikelyFill(params.quoteIn, remaining as bigint);
  /**
   * The gas override, applied to whichever request comes back.
   *
   * `gas` is added only on the buy that is going to fill the curve — see the note above `buy` for
   * why an estimator cannot see the swallowed graduation call, and why a blanket limit is not a
   * free fix on a chain that charges at the limit.
   */
  const gas = fills ? { gas: graduationGas as bigint } : {};

  if (entry === "buy") {
    const { request } = await publicClient.simulateContract({
      address: params.curve,
      abi: curveAbi,
      functionName: "buy",
      args: [minOut, deadline],
      // EXACT. The curve refunds the overshoot itself; sending more than `quoteIn` would be
      // spending money the receipt never mentions.
      value: params.quoteIn,
      account,
    });
    return wallet.writeContract({ ...request, ...gas });
  }

  if (entry === "buyWithPermit") {
    const permit = params.permit!;
    const { request } = await publicClient.simulateContract({
      address: params.curve,
      abi: curveAbi,
      functionName: "buyWithPermit",
      args: [params.quoteIn, minOut, deadline, permit.v, permit.r, permit.s],
      account,
    });
    return wallet.writeContract({ ...request, ...gas });
  }

  const { request } = await publicClient.simulateContract({
    address: params.curve,
    abi: curveAbi,
    functionName: "buyWithToken",
    // No `value`. An ERC-20 market pulls the quote through the allowance the buyer gave the
    // CURVE; MON sent alongside has nothing to pay for and reverts.
    args: [params.quoteIn, minOut, deadline],
    account,
  });
  return wallet.writeContract({ ...request, ...gas });
}

/** Sells tokens back to the curve. The caller is responsible for the approval. */
export async function sell(
  wallet: WalletClient,
  publicClient: PublicClient,
  params: TradeParams & { tokensIn: bigint }
): Promise<`0x${string}`> {
  const account = wallet.account;
  if (!account) throw new Error("no connected account");

  const { request } = await publicClient.simulateContract({
    address: params.curve,
    abi: curveAbi,
    functionName: "sell",
    args: [
      params.tokensIn,
      applySlippage(params.quoted, params.slippageBps),
      deadlineFrom(Date.now(), params.deadlineSecs ?? DEFAULT_DEADLINE_SECS),
    ],
    account,
  });
  return wallet.writeContract(request);
}

/**
 * The metadata struct, exactly as `DokuFactory.Metadata` declares it.
 *
 * Eight strings, in order. Every one of them has a BYTE cap on chain, and `lib/launch/submit`
 * checks them before anything is built — see `META_LIMITS` there.
 */
export interface LaunchMetadata {
  name: string;
  ticker: string;
  logoURI: string;
  bannerURI: string;
  description: string;
  website: string;
  x: string;
  telegram: string;
}

/**
 * `DokuFactory.LaunchParams` — one struct, ten fields, in this order.
 *
 * The order is the ABI's and is not an implementation detail: viem encodes a tuple positionally
 * from the ABI, so a field renamed here and not there is silently encoded into its neighbour's
 * slot. `routedRecipient` and `taxRecipient` are adjacent addresses, which is exactly the pair
 * that would be indistinguishable if it happened.
 */
export interface LaunchParams {
  meta: LaunchMetadata;
  /** `address(0)` for native MON. */
  quoteAsset: `0x${string}`;
  /**
   * Where this market's share of the levy goes: 0 burns it, 1 pays holders, 2 pays the creator.
   *
   * IMMUTABLE from the moment this transaction lands — there is no setter on the factory, the
   * curve, the hook or the sink. Sending the wrong value cannot be corrected.
   */
  sink: 0 | 1 | 2;
  /**
   * Who receives the routed share. **Zero unless `sink` is 2 (creator).**
   *
   * A holders or buyback market pays its sink; naming an address there is meaningless at best.
   * This is NOT the creator tax's destination — that is `taxRecipient`, a different charge with a
   * different lifetime.
   */
  routedRecipient: `0x${string}`;
  /** 0-1000, and a multiple of 10. */
  creatorTaxBps: number;
  taxRecipient: `0x${string}`;
  /**
   * The commitment to the terms, from `economicsPin(quoteAsset, sink, creatorTaxBps)`.
   *
   * Read FRESH, immediately before sending. A moved target or launch fee reverts
   * `EconomicsChanged()`.
   */
  economicsPin: `0x${string}`;
  /** The creator's own buy, in RAW units of the quote asset. Zero for no dev buy. */
  firstBuyQuote: bigint;
  firstBuyMinOut: bigint;
  deadline: bigint;
}

/** Burn the market's share of the levy: buy the token back and destroy it. */
export const SINK_BURN = 0 as const;
/** Pay it out to holders, claimable per epoch. */
export const SINK_REWARDS = 1 as const;
/** Pay it to the creator's nominated recipient. New in generation 2. */
export const SINK_CREATOR = 2 as const;

/**
 * Everything `submitLaunch` needs from the chain, and nothing else.
 *
 * A port rather than a viem client, for two reasons. It keeps `lib/launch/submit` — where the
 * mapping and the validation live, and where the mistakes with money in them are — testable
 * without a node, an RPC or a configured deployment. And it names the six operations a launch
 * actually performs, so the ORDER of them is visible in one place: predict, fee, approve, pin,
 * send. That order is load-bearing; see `economicsPin`.
 *
 * The last two members are OPTIONAL and describe the wallet rather than the protocol: whether it
 * takes an EIP-5792 batch, and how to send one. A port without them is the port this app has
 * always had, and it takes the path this app has always taken.
 */
export interface LaunchChain {
  /** The connected wallet. Becomes the market's creator and the default tax recipient. */
  account: `0x${string}`;
  factory: `0x${string}`;
  /** Owner-tunable, so it is read rather than compiled in. */
  launchFee(who: `0x${string}`): Promise<bigint>;
  economicsPin(
    quoteAsset: `0x${string}`,
    sink: number,
    creatorTaxBps: number
  ): Promise<`0x${string}`>;
  /** Where the market will live, before the transaction lands. */
  predictMarket(creator: `0x${string}`): Promise<{ curve: `0x${string}`; token: `0x${string}` }>;
  allowance(token: `0x${string}`, owner: `0x${string}`, spender: `0x${string}`): Promise<bigint>;
  approve(token: `0x${string}`, spender: `0x${string}`, amount: bigint): Promise<`0x${string}`>;
  /** @param value EXACT — `launchFee + firstBuyQuote` for a native quote, `launchFee` otherwise. */
  launch(params: LaunchParams, value: bigint): Promise<`0x${string}`>;
  /**
   * What this wallet holds of an ERC-20, read AFTER the swap rather than assumed from the quote.
   *
   * A swap delivers what it delivers. Launching against the quoted figure instead reverts on any
   * shortfall — the allowance would be short by exactly the amount the price moved — and it would
   * revert after the launcher had already paid for the swap.
   */
  balanceOf(token: `0x${string}`, owner: `0x${string}`): Promise<bigint>;
  /**
   * Swaps native MON into the pair's asset and leaves it in the launcher's own wallet.
   *
   * Its own transaction, and it has to be: the coin does not exist until the launch, so there is
   * nothing to buy on, and the factory records `msg.sender` as the creator — a contract doing this
   * on the launcher's behalf would be the creator. Waited on, like `approve`, because the launch
   * that follows spends what it produced.
   */
  swapNativeFor(params: {
    path: readonly {
      intermediateCurrency: `0x${string}`;
      fee: number;
      tickSpacing: number;
      hooks: `0x${string}`;
      hookData: `0x${string}`;
    }[];
    amountIn: bigint;
    minOut: bigint;
  }): Promise<`0x${string}`>;
  /**
   * What this wallet promises about an EIP-5792 batch on Monad. **Absent means `none`.**
   *
   * Optional because it is a fact about the WALLET rather than about the protocol, and because
   * every caller and every test that predates batching describes a port without it — which must
   * keep meaning exactly what it meant: swap, approve, launch, three prompts, unchanged.
   *
   * It is here rather than inferred from `sendBatch` being present because the two answers are not
   * the same. `sendBatch` says a batch can be sent; this says whether atomicity may be demanded of
   * it, and demanding it of a wallet that only sequences is a refusal rather than a stronger
   * guarantee. `planMonDevBuy` is the one place that reads it.
   */
  batchSupport?: BatchSupport;
  /**
   * Sends the launch as ONE `wallet_sendCalls` and answers with the hash the launch landed at.
   *
   * Optional, and that is the fallback discipline in the type system: a port without it cannot
   * take the batched branch, so every existing call site and every existing test keeps the
   * three-transaction path byte for byte.
   *
   * **This is not a router.** Each call in the batch is made by the wallet itself, so `msg.sender`
   * is the launcher on all three and the factory records the launcher as the creator — see
   * `launch-batch`, where the difference between a batch and a contract launching on somebody's
   * behalf is the reason any of this is allowed.
   *
   * A batch answers with an id rather than a hash, so the implementation waits for the calls to
   * land and returns the LAST receipt's transaction — the launch. Returning the swap's would send
   * the launcher to a block explorer showing a swap and link the market page to a transaction that
   * created no market.
   *
   * @param opts.atomic Ask the wallet to guarantee all-or-nothing. True only where it said it can.
   */
  sendBatch?(calls: EncodedCall[], opts: { atomic: boolean }): Promise<`0x${string}`>;
}

/**
 * The real port, over viem.
 *
 * Each write is simulated before it is signed. A simulation turns a wasted gas fee into an error
 * message: `EconomicsChanged()`, `QuoteNotEnabled()` and a metadata cap all revert, and all three
 * are things the launcher can act on if they are told before the wallet opens rather than after.
 */
export function launchChain(
  wallet: WalletClient,
  publicClient: PublicClient,
  factory: `0x${string}`,
  /**
   * The MON swap that funds a dev buy, passed IN rather than imported.
   *
   * This module is the protocol — the factory and the curve — and `pool.ts` is Uniswap, which
   * already depends on this one for `applySlippage` and `deadlineFrom`. Importing it back would
   * make the two mutually dependent, for one function used by one flow. The launch page composes
   * them; see `LaunchAction`.
   */
  swapNativeFor: LaunchChain["swapNativeFor"],
  /**
   * The wallet's batching, passed in whole or not at all.
   *
   * One optional argument rather than two, because the capability and the sender are answers to
   * the same question and a port carrying one without the other is a state nobody meant: a
   * `sendBatch` with no support reading says "batch, but I cannot tell you how", and a support
   * reading with no sender is a promise with nothing behind it.
   *
   * Omitted everywhere except the launch page, and omitting it is not a degraded mode — it is the
   * path this app has always taken and still takes for every wallet that cannot batch.
   */
  batch?: {
    support: BatchSupport;
    send: NonNullable<LaunchChain["sendBatch"]>;
  }
): LaunchChain {
  const account = wallet.account;
  if (!account) throw new Error("no connected account");

  return {
    account: account.address,
    factory,
    batchSupport: batch?.support,
    sendBatch: batch?.send,

    launchFee: (who) =>
      publicClient.readContract({
        address: factory,
        abi: factoryAbi,
        functionName: "launchFee",
        args: [who],
      }) as Promise<bigint>,

    economicsPin: (quoteAsset, sink, creatorTaxBps) =>
      publicClient.readContract({
        address: factory,
        abi: factoryAbi,
        functionName: "economicsPin",
        args: [quoteAsset, sink, creatorTaxBps],
      }) as Promise<`0x${string}`>,

    predictMarket: async (creator) => {
      const [curve, token] = (await publicClient.readContract({
        address: factory,
        abi: factoryAbi,
        functionName: "predictMarket",
        args: [creator],
      })) as [`0x${string}`, `0x${string}`];
      return { curve, token };
    },

    allowance: (token, owner, spender) =>
      publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner, spender],
      }) as Promise<bigint>,

    approve: async (token, spender, amount) => {
      const { request } = await publicClient.simulateContract({
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, amount],
        account,
      });
      const hash = await wallet.writeContract(request);
      // Waited on, not fired and forgotten. The launch that follows pulls against this allowance,
      // and sending it before the approval confirms is a revert the launcher pays for.
      await publicClient.waitForTransactionReceipt({ hash });
      return hash;
    },

    launch: async (params, value) => {
      const { request } = await publicClient.simulateContract({
        address: factory,
        abi: factoryAbi,
        functionName: "launch",
        args: [params],
        value,
        account,
      });
      return wallet.writeContract(request);
    },

    balanceOf: (token, owner) =>
      publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
      }) as Promise<bigint>,

    swapNativeFor,
  };
}
