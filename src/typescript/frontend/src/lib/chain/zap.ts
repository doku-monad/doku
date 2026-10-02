import { encodeFunctionData, type PublicClient, type WalletClient } from "viem";

import { curveAbi, v4QuoterAbi } from "./abis";
import { CONTRACTS, NATIVE_CURRENCY } from "./addresses";
import type { EncodedCall } from "./encoded-call";
import { deadlineFrom, willLikelyFill } from "./writes";
import {
  candidateRoutes,
  chooseRoute,
  type Path,
  type QuotedRoute,
  routeImpactBps,
  sellRoutes,
} from "./zap-routes";

/**
 * Talking to the zap router: quoting a route, and sending the buy.
 *
 * Deliberately NOT in `writes.ts`. Everything in that file is the protocol — the factory and the
 * curve, contracts that are deployed, immutable and load-bearing. This one calls a periphery
 * contract that may not exist on the network the app is pointed at, and a module that can be absent
 * should be importable without implying that anything else is. The separation is also the reason
 * the feature can be removed by deleting one environment variable: nothing in the trading path
 * reaches through here.
 *
 * The decisions — which route, whether to offer MON at all, what to say when the answer is no —
 * are in `zap-plan.ts`, which is pure. This file is the part that needs a chain.
 */

/**
 * Uniswap's `PathKey`, as the router and the quoter both take it.
 *
 * The first hop's INPUT is not in here. A path is read as "starting from the currency you are
 * spending, swap into each of these in turn", so `intermediateCurrency` is the currency a hop swaps
 * INTO — including on the last entry, which is therefore the market's quote asset rather than an
 * intermediate at all. Getting that backwards builds a path one asset short that still encodes and
 * still quotes, against pools that are not the ones intended.
 */
export interface PathKey {
  intermediateCurrency: `0x${string}`;
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
  hookData: `0x${string}`;
}

/**
 * No hook, and no hook data, on every hop of a zap.
 *
 * These are Uniswap's own pools — the MON/USDC pool, the USDC/WBTC pool — not DOKU's. A DOKU pool
 * carries `CONTRACTS.hook` and is the pool a graduated market trades in; putting that address on a
 * hop of the route would address a pool that has never been initialised, which reads as a route
 * with no liquidity rather than as a mistake.
 */
const NO_HOOK = "0x0000000000000000000000000000000000000000" as const;
const NO_HOOK_DATA = "0x" as const;

/**
 * The router's ABI, hand-written and minimal.
 *
 * `abis.ts` holds generated artifacts for contracts that ship with the protocol. This one is not
 * deployed anywhere yet, so there is no artifact to generate from and no address a wrong entry
 * could be sent to — but the errors matter and are listed: viem decodes a custom error only if it
 * is in the ABI it was given, and without `ZapTooLarge` the ceiling revert arrives as an
 * undecodable hex string that `describeZapError` could not tell from any other failure.
 */
export const zapRouterAbi = [
  {
    type: "function",
    name: "zapBuyWithNative",
    stateMutability: "payable",
    inputs: [
      { name: "curve", type: "address" },
      {
        name: "path",
        type: "tuple[]",
        components: [
          { name: "intermediateCurrency", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
          { name: "hookData", type: "bytes" },
        ],
      },
      { name: "minQuoteOut", type: "uint256" },
      { name: "minBaseOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "baseOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "zapSellToNative",
    stateMutability: "nonpayable",
    inputs: [
      { name: "curve", type: "address" },
      {
        name: "path",
        type: "tuple[]",
        components: [
          { name: "intermediateCurrency", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
          { name: "hookData", type: "bytes" },
        ],
      },
      { name: "baseIn", type: "uint256" },
      { name: "minQuoteOut", type: "uint256" },
      { name: "minNativeOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "nativeOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "maxZapValue",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "error",
    name: "ZapTooLarge",
    inputs: [
      { name: "offered", type: "uint256" },
      { name: "maximum", type: "uint256" },
    ],
  },
  { type: "error", name: "Expired", inputs: [] },
  { type: "error", name: "ZeroValue", inputs: [] },
  { type: "error", name: "UnknownMarket", inputs: [{ name: "curve", type: "address" }] },
  { type: "error", name: "NativeQuoteNeedsNoZap", inputs: [] },
  {
    type: "error",
    name: "InsufficientQuoteOut",
    inputs: [
      { name: "minimum", type: "uint256" },
      { name: "actual", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "SellTooLarge",
    inputs: [
      // `paid`, not `produced`. As of ZapRouter v3 the ceiling weighs what `_sweepNative` actually
      // pays the seller rather than the swap leg's v4 credit — the two differ whenever MON reaches
      // the router by any route other than the swap, which is precisely the bypass v3 closed.
      { name: "paid", type: "uint256" },
      { name: "maximum", type: "uint256" },
    ],
  },
  {
    /*
     * Distinct from `SellTooLarge`, and the distinction is not pedantry. The router checks its
     * ceiling twice: once cheaply against the floor the CALLER declared, and once against what the
     * sale actually PAID OUT. One error carrying both would put a declared floor in a slot named
     * `paid`, and every wallet and indexer decoding it would report a payout nobody received.
     */
    type: "error",
    name: "SellFloorTooLarge",
    inputs: [
      { name: "minNativeOut", type: "uint256" },
      { name: "maximum", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "InsufficientNativeOut",
    inputs: [
      { name: "minimum", type: "uint256" },
      { name: "actual", type: "uint256" },
    ],
  },
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "UnexpectedNativeDebit", inputs: [] },
  { type: "error", name: "OnlyPoolManagerPays", inputs: [] },
  { type: "error", name: "PathDoesNotEndAtNative", inputs: [{ name: "actual", type: "address" }] },
  { type: "error", name: "EmptyPath", inputs: [] },
  {
    type: "error",
    name: "PathTooLong",
    inputs: [
      { name: "hops", type: "uint256" },
      { name: "maximum", type: "uint256" },
    ],
  },
  { type: "error", name: "NativeIntermediate", inputs: [{ name: "hop", type: "uint256" }] },
  /*
   * The CURVE's own two, and they are not padding.
   *
   * `BondingCurve.sell` reverts `ZeroOutput` on a sale that would pay nothing, and its own comment
   * shows that is reachable with ORDINARY amounts on a coarse quote: one troy ounce of gold is 1e6
   * raw units, so anything under a few hundred whole tokens rounds to zero. Gold is exactly the
   * market class this feature exists for. `InsufficientOutput` is the curve's slippage floor.
   *
   * viem decodes a custom error only if it is in the ABI it was given, so an omitted one reaches
   * the seller as an undecodable hex string that `describeZapError` cannot tell from any other
   * failure.
   */
  { type: "error", name: "ZeroOutput", inputs: [] },
  { type: "error", name: "InsufficientOutput", inputs: [] },
  {
    type: "error",
    name: "InsufficientBaseOut",
    inputs: [
      { name: "minimum", type: "uint256" },
      { name: "actual", type: "uint256" },
    ],
  },
] as const;

/** A measured route: the hops, what the swap returns, and how much of that is the trade's own bite. */
export interface ZapRouteQuote extends QuotedRoute {
  /** The same route in the shape the router and the quoter take. Built once, here. */
  pathKeys: PathKey[];
}

/**
 * A route from `zap-routes` in the shape the contracts speak.
 *
 * Each hop contributes the currency it swaps INTO, so the native input the walk started from is
 * dropped — which is correct, and is the one transformation in this file that would fail silently
 * if it were wrong.
 */
export function toPathKeys(path: Path): PathKey[] {
  return path.map((hop) => ({
    intermediateCurrency: hop.to as `0x${string}`,
    fee: hop.fee,
    tickSpacing: hop.tickSpacing,
    hooks: NO_HOOK,
    hookData: NO_HOOK_DATA,
  }));
}

/**
 * The same route with the MARKET'S OWN POOL on the end, for a graduated market.
 *
 * A curve zap stops at the quote asset because a bonding curve is not a pool and cannot be a hop.
 * A graduated market has no such boundary: its pool is an ordinary v4 pool, so "buy this token
 * with MON" is one path — MON through the route to the quote asset, then quote to token — and one
 * swap, with no zap router in it.
 *
 * `hooks`, `fee` and `tickSpacing` come from the market's RECORDED key rather than from this app's
 * constants, and that is the part worth being careful about: two DOKU hooks are live on mainnet,
 * so a market that graduated under the older one lives in a pool whose key names it. Building the
 * last hop from today's constants would address a pool nobody has ever initialised — which quotes
 * zero, reads as "no route", and hides a market that trades perfectly well.
 */
export function poolZapPathKeys(
  path: Path,
  market: {
    token: `0x${string}`;
    poolKey: { fee: number; tickSpacing: number; hooks: `0x${string}` };
  }
): PathKey[] {
  return [
    ...toPathKeys(path),
    {
      intermediateCurrency: market.token,
      fee: market.poolKey.fee,
      tickSpacing: market.poolKey.tickSpacing,
      hooks: market.poolKey.hooks,
      hookData: NO_HOOK_DATA,
    },
  ];
}

/**
 * The same route with the MARKET'S OWN POOL on the FRONT, for selling a graduated market.
 *
 * The mirror of `poolZapPathKeys`, and deliberately not a symmetric one. A buy APPENDS the market's
 * pool because the buyer spends MON and the token is the last thing they arrive at; a sell PREPENDS
 * it because the seller spends the TOKEN, so the market's own pool is the first hop and the route
 * out to MON hangs off the quote asset it lands on. Building this by appending — or by reversing
 * the buy's keys — encodes a path that starts in an asset the seller does not hold, and that path
 * still encodes and still quotes, against pools that are not the ones intended.
 *
 * As on the buy side, `fee`, `tickSpacing` and `hooks` come from the market's RECORDED key and
 * never from this app's constants. Two DOKU hooks are live on mainnet, so a market that graduated
 * under the older one lives in a pool whose key names it — building this hop from today's constants
 * would address a pool nobody has ever initialised, which quotes zero and reads as "no route"
 * rather than as a bug.
 */
export function sellPoolZapPathKeys(
  route: Path,
  market: {
    quoteAsset: `0x${string}`;
    poolKey: { fee: number; tickSpacing: number; hooks: `0x${string}` };
  }
): PathKey[] {
  return [
    {
      intermediateCurrency: market.quoteAsset,
      fee: market.poolKey.fee,
      tickSpacing: market.poolKey.tickSpacing,
      hooks: market.poolKey.hooks,
      hookData: NO_HOOK_DATA,
    },
    ...toPathKeys(route),
  ];
}

/**
 * What one whole route returns for an exact input of `exactCurrency`.
 *
 * `quoteExactInput` rather than a chain of single-pool quotes: the quoter walks the path itself, so
 * a two-hop route costs one round trip instead of two and the intermediate amount never has to be
 * carried across a network boundary and re-scaled.
 *
 * ZERO on failure, deliberately. A candidate route can name a pool that was never initialised, or
 * one with no liquidity at this size, and the quoter reverts rather than returning zero. That is
 * not an error in this app — it is the answer, and `routeImpactBps` already reads a zero return as
 * a route that does not exist. Throwing would let one dead pool take down the quote for the five
 * live candidates beside it.
 *
 * `exactCurrency` is the currency being SPENT, which a `PathKey[]` cannot tell you: a path names
 * only what each hop swaps into, so the input is carried here or nowhere. It defaults to MON
 * because that is what a buy spends — a sell passes the market's quote asset, or the market's own
 * token when the market has graduated.
 */
async function quoteRoute(
  publicClient: PublicClient,
  pathKeys: PathKey[],
  amountIn: bigint,
  exactCurrency: `0x${string}` = NATIVE_CURRENCY
): Promise<bigint> {
  if (amountIn <= 0n) return 0n;
  try {
    const { result } = await publicClient.simulateContract({
      address: CONTRACTS.quoter,
      abi: v4QuoterAbi,
      functionName: "quoteExactInput",
      args: [
        {
          exactCurrency,
          path: pathKeys,
          exactAmount: amountIn,
        },
      ],
    });
    // `(amountOut, gasEstimate)`. The gas figure is the quoter's estimate of the swap, not of the
    // transaction, so it is not surfaced anywhere.
    return (result as readonly [bigint, bigint])[0];
  } catch {
    return 0n;
  }
}

/**
 * The best way to turn `amountIn` MON into this market's quote asset, or null.
 *
 * Every candidate is quoted TWICE — at the size being traded and at half of it — because that pair
 * is what measures depth. See `routeImpactBps`: comparing against a fixed small reference breaks on
 * exactly the routes that need checking, where a tiny reference amount buys less than one raw unit
 * of a six-decimal asset and quotes zero.
 *
 * Null is a real answer, not a failure, and the caller must say so plainly. It means every route
 * either does not exist or costs more than `MAX_ZAP_IMPACT_BPS` at this size, and the market's own
 * quote asset is what to ask for instead.
 */
export async function quoteZapRoutes(
  publicClient: PublicClient,
  params: { quoteAsset: string; amountIn: bigint }
): Promise<ZapRouteQuote | null> {
  const routes = candidateRoutes(params.quoteAsset);
  if (routes.length === 0 || params.amountIn <= 0n) return null;

  const quoted = await Promise.all(
    routes.map(async (path) => {
      const pathKeys = toPathKeys(path);
      // Both sizes in flight together. Serially this would be twelve round trips deep on a
      // six-candidate asset, on every debounced keystroke.
      const [amountOut, halfAmountOut] = await Promise.all([
        quoteRoute(publicClient, pathKeys, params.amountIn),
        quoteRoute(publicClient, pathKeys, params.amountIn / 2n),
      ]);
      return {
        path,
        pathKeys,
        amountOut,
        impactBps: routeImpactBps({ amountOut, halfAmountOut }),
      };
    })
  );

  const best = chooseRoute(quoted);
  // `chooseRoute` returns the object it was given, so this finds the one carrying `pathKeys`
  // rather than rebuilding them — identity, not a search by value.
  return best === null ? null : (quoted.find((q) => q === best) ?? null);
}

/**
 * The best way to turn `amountIn` MON into a GRADUATED market's own token, or null.
 *
 * Measured over the whole path, market pool included, so the number it returns is the tokens the
 * buyer receives rather than an intermediate they never hold. That also makes the impact figure
 * honest: a route can be deep all the way to the quote asset and still be a bad trade because the
 * market's own pool is thin, and quoting only the first part would hide exactly that.
 *
 * Same two-size measurement as `quoteZapRoutes`, for the same reason — see `routeImpactBps`.
 */
export async function quotePoolZapRoutes(
  publicClient: PublicClient,
  params: {
    quoteAsset: string;
    market: {
      token: `0x${string}`;
      poolKey: { fee: number; tickSpacing: number; hooks: `0x${string}` };
    };
    amountIn: bigint;
  }
): Promise<ZapRouteQuote | null> {
  const routes = candidateRoutes(params.quoteAsset);
  if (routes.length === 0 || params.amountIn <= 0n) return null;

  const quoted = await Promise.all(
    routes.map(async (path) => {
      const pathKeys = poolZapPathKeys(path, params.market);
      const [amountOut, halfAmountOut] = await Promise.all([
        quoteRoute(publicClient, pathKeys, params.amountIn),
        quoteRoute(publicClient, pathKeys, params.amountIn / 2n),
      ]);
      return {
        path,
        pathKeys,
        amountOut,
        impactBps: routeImpactBps({ amountOut, halfAmountOut }),
      };
    })
  );

  const best = chooseRoute(quoted);
  return best === null ? null : (quoted.find((q) => q === best) ?? null);
}

/**
 * The best way to turn a CURVE market's quote asset back into MON, or null.
 *
 * `amountIn` is what the CURVE WILL PAY OUT, in raw quote-asset units — not the number of market
 * tokens the seller typed, and not anything denominated in MON. A curve sell happens in two legs
 * inside one transaction: the curve buys the tokens back for its quote asset, and only then is
 * that quote swapped out to MON. The swap leg therefore has to be measured on the curve's payout,
 * which the caller obtains from the curve first. Passing the token amount here quotes a route with
 * a number that has the wrong asset AND usually the wrong decimals behind it, and the result is a
 * quote that is plausible, wrong, and shown to the seller as a price.
 *
 * Same two-size measurement as `quoteZapRoutes`, for the same reason — see `routeImpactBps`.
 *
 * Null is a real answer, not a failure. It means every route out of this quote asset either does
 * not exist or costs more than `MAX_ZAP_IMPACT_BPS` at this size, and the seller should be paid in
 * the market's own quote asset instead.
 */
export async function quoteSellZapRoutes(
  publicClient: PublicClient,
  params: { quoteAsset: string; amountIn: bigint }
): Promise<ZapRouteQuote | null> {
  const routes = sellRoutes(params.quoteAsset);
  if (routes.length === 0 || params.amountIn <= 0n) return null;

  const exactCurrency = params.quoteAsset as `0x${string}`;
  const quoted = await Promise.all(
    routes.map(async (path) => {
      const pathKeys = toPathKeys(path);
      const [amountOut, halfAmountOut] = await Promise.all([
        quoteRoute(publicClient, pathKeys, params.amountIn, exactCurrency),
        quoteRoute(publicClient, pathKeys, params.amountIn / 2n, exactCurrency),
      ]);
      return {
        path,
        pathKeys,
        amountOut,
        impactBps: routeImpactBps({ amountOut, halfAmountOut }),
      };
    })
  );

  const best = chooseRoute(quoted);
  // `chooseRoute` returns the object it was given, so this finds the one carrying `pathKeys`
  // rather than rebuilding them — identity, not a search by value.
  return best === null ? null : (quoted.find((q) => q === best) ?? null);
}

/**
 * The best way to turn `amountIn` of a GRADUATED market's own token into MON, or null.
 *
 * `amountIn` is market tokens in raw units — the thing the seller actually holds — because a
 * graduated sell is ONE swap with no curve in front of it: the market's pool is the first hop, and
 * the exact currency is the token itself. That is what makes this the honest number to show: the
 * market's own pool is usually the thinnest thing on the path, and measuring only the quote-to-MON
 * tail would report the depth of the part of the trade that was never in doubt.
 *
 * Same two-size measurement as `quoteZapRoutes`, for the same reason — see `routeImpactBps`.
 */
export async function quotePoolSellZapRoutes(
  publicClient: PublicClient,
  params: {
    quoteAsset: string;
    market: {
      token: `0x${string}`;
      poolKey: { fee: number; tickSpacing: number; hooks: `0x${string}` };
    };
    amountIn: bigint;
  }
): Promise<ZapRouteQuote | null> {
  const routes = sellRoutes(params.quoteAsset);
  if (routes.length === 0 || params.amountIn <= 0n) return null;

  // The first hop is built from the market's recorded key, so the quote asset it lands on has to
  // travel with it — `sellPoolZapPathKeys` names that hop and cannot infer it from the route,
  // whose own first hop starts where this one ends.
  const market = {
    quoteAsset: params.quoteAsset as `0x${string}`,
    poolKey: params.market.poolKey,
  };
  const quoted = await Promise.all(
    routes.map(async (path) => {
      const pathKeys = sellPoolZapPathKeys(path, market);
      const [amountOut, halfAmountOut] = await Promise.all([
        quoteRoute(publicClient, pathKeys, params.amountIn, params.market.token),
        quoteRoute(publicClient, pathKeys, params.amountIn / 2n, params.market.token),
      ]);
      return {
        path,
        pathKeys,
        amountOut,
        impactBps: routeImpactBps({ amountOut, halfAmountOut }),
      };
    })
  );

  const best = chooseRoute(quoted);
  return best === null ? null : (quoted.find((q) => q === best) ?? null);
}

/** The router's spend ceiling, in wei of MON. Zero means it has none. */
export async function readMaxZapValue(
  publicClient: PublicClient,
  router: `0x${string}`
): Promise<bigint> {
  return (await publicClient.readContract({
    address: router,
    abi: zapRouterAbi,
    functionName: "maxZapValue",
  })) as bigint;
}

/** Enough for three pool swaps and a curve buy, used only when the estimator declines to answer. */
const FALLBACK_ZAP_GAS = 1_000_000n;

/**
 * The gas limit a zap should carry, or null to leave it to the wallet.
 *
 * The same blind spot as a direct curve buy, one contract further away. A buy that FILLS the curve
 * also graduates the market in the same transaction, graduation runs inside a `try`/`catch` that
 * swallows its own failure, and `eth_estimateGas` therefore returns a limit at which the market
 * fills and does not graduate — no revert, no receipt anybody can read as wrong. The curve's own
 * `autoGraduationGasHint` is what covers the swallowed call, and it is ADDED to the estimate here
 * rather than used as the whole limit, because unlike a direct buy this transaction also pays for
 * one to three pool swaps before it reaches the curve.
 *
 * Only on the filling buy. Monad bills the gas LIMIT rather than the gas used, so a blanket
 * allowance would charge every buyer in every market for headroom that one transaction in a
 * market's life needs.
 */
export function zapGasLimit(input: {
  /** What the estimator returned, or null where it could not answer. */
  estimate: bigint | null;
  graduationHint: bigint;
  fills: boolean;
}): bigint | null {
  if (!input.fills) return null;
  // No estimate and a filling buy is the one case where guessing beats not trying: the alternative
  // is the wallet's own estimate, which is the number known to be short. This is deliberately
  // generous — it is paid once per market, by the buyer who graduates it.
  const body = input.estimate ?? FALLBACK_ZAP_GAS;
  return body + input.graduationHint;
}

const DEFAULT_DEADLINE_SECS = 120;

export interface ZapBuyParams {
  /** From `ZAP_ROUTER`. A caller holding `null` has no feature to call and must not reach here. */
  router: `0x${string}`;
  curve: `0x${string}`;
  path: PathKey[];
  /** MON to spend, in wei. Rides as `value`; the router refunds any dust it does not use. */
  monIn: bigint;
  /** Floors, already computed from the trader's own tolerance — see `zapBounds`. */
  minQuoteOut: bigint;
  minBaseOut: bigint;
  /**
   * What the swap leg is expected to deliver, in raw quote units.
   *
   * Not a bound — `minQuoteOut` is the bound. It is here only to predict whether this buy is the
   * one that fills the curve, which is a question about the QUOTE reaching the curve and cannot be
   * answered from the MON going in.
   */
  expectedQuoteOut: bigint;
  deadlineSecs?: number;
}

/**
 * Buys a market's token with native MON, swapping through v4 on the way.
 *
 * One signature and no approval: MON rides as `value`, the router holds the swapped quote for the
 * length of one transaction, and the tokens are forwarded to the caller. That is the whole point of
 * the contract — the alternative is acquire the quote asset, approve the curve, then buy, which is
 * three transactions and two assets a trader never wanted to hold.
 */
export async function zapBuyWithNative(
  wallet: WalletClient,
  publicClient: PublicClient,
  params: ZapBuyParams
): Promise<`0x${string}`> {
  const account = wallet.account;
  if (!account) throw new Error("no connected account");

  const deadline = deadlineFrom(Date.now(), params.deadlineSecs ?? DEFAULT_DEADLINE_SECS);
  const args = [
    params.curve,
    params.path,
    params.minQuoteOut,
    params.minBaseOut,
    deadline,
  ] as const;

  const [remaining, graduationHint] = await Promise.all([
    publicClient.readContract({ address: params.curve, abi: curveAbi, functionName: "remaining" }),
    publicClient.readContract({
      address: params.curve,
      abi: curveAbi,
      functionName: "autoGraduationGasHint",
    }),
  ]);

  const { request } = await publicClient.simulateContract({
    address: params.router,
    abi: zapRouterAbi,
    functionName: "zapBuyWithNative",
    args,
    value: params.monIn,
    account,
  });

  const fills = willLikelyFill(params.expectedQuoteOut, remaining as bigint);
  const estimate = fills
    ? await publicClient
        .estimateContractGas({
          address: params.router,
          abi: zapRouterAbi,
          functionName: "zapBuyWithNative",
          args,
          value: params.monIn,
          account,
        })
        // An estimator that declines is not a reason to abandon a trade that just simulated
        // cleanly; `zapGasLimit` has a fallback for exactly this.
        .catch(() => null)
    : null;
  const gas = zapGasLimit({ estimate, graduationHint: graduationHint as bigint, fills });

  return wallet.writeContract(gas === null ? request : { ...request, gas });
}

/**
 * What a sell REALLY costs, measured on a Monad mainnet fork on 2026-09-10 at block ~103,649,665
 * by `test_whatASellCostsInIsolationOnMainnetFork` in `contracts/test/ZapFork.t.sol`, which
 * brackets `zapSellToNative` alone with `gasleft()` either side and cools every account the buy
 * leg warmed first, because a Foundry test body is one transaction and a warm sell measures light.
 *
 *   USDC,  one hop            240,758 execution gas
 *   cbBTC, two hops (8 dec)   268,292
 *   gold,  two hops           270,699   <- the dearest of the three
 *
 * RE-MEASURE THESE IF THE SELL PATH CHANGES — the router, the curve's `sell`, or the route table.
 * That test asserts both bounds below against the live chain and names this file when it fails, in
 * the same way `zap-routes.ts` records the date its pool-depth survey was run.
 */
const SELL_GAS_MEASURED = 270_699n;

/**
 * What one more hop costs: the dearest two-hop shape minus the one-hop shape, from the same run.
 * It is the spread across the three measured shapes — about 12.4% — and it is the unit both bounds
 * below are counted in, so nothing here is a round number somebody liked.
 */
const SELL_GAS_PER_HOP = 30_873n;

/**
 * What a transaction pays before its first opcode, which `gasleft()` cannot see: 21,000 flat plus
 * the calldata. A two-hop `zapSellToNative` is 676 bytes and costs under 4,000 of it. Rounded up.
 */
const SELL_TX_INTRINSIC = 30_000n;

/**
 * The least a sell may be sent with: the dearest measured shape, plus one more hop, plus the
 * intrinsic cost. One more hop because `MAX_ZAP_HOPS` is 3 and the measured shapes stop at two, so
 * this covers the longest route this app can build.
 */
export const SELL_GAS_FLOOR = SELL_GAS_MEASURED + SELL_GAS_PER_HOP + SELL_TX_INTRINSIC;

/**
 * The most a sell may be sent with: the floor plus four more hops of headroom.
 *
 * Four, counted in the same measured unit rather than picked: one for a market with a non-zero
 * creator tax, which adds a transfer to a recipient this measurement never touched; one for a
 * PARTIAL sell, which leaves the seller's balance non-zero and so forgoes the storage-clear refund
 * a full sell collects; one for a quote asset whose `transfer` is dearer than the four measured;
 * and one for whatever was not thought of. That is a 37% margin over the floor and 51% over the
 * dearest sell actually measured.
 */
export const SELL_GAS_CAP = SELL_GAS_FLOOR + 4n * SELL_GAS_PER_HOP;

/**
 * The gas limit a zapped sell should carry.
 *
 * The reason this exists at all: MONAD BILLS THE LIMIT, NOT THE USAGE. On 2026-09-10 a real
 * `zapSellToNative` went out with the estimator's own limit of 4,795,725 and was charged for every
 * unit of it — 0.489 MON of gas to deliver 0.489 MON of proceeds, against a buy in the same minutes
 * that cost 446,442. The sell is not 10x the buy; measured in isolation it is roughly HALF of it.
 * The 10x was `eth_estimateGas` being pessimistic, and on this chain pessimism is a fee.
 *
 * So the estimate is clamped, in both directions, and the two directions are not symmetric:
 *
 *  - BELOW the floor the estimate is discarded, not trusted. An under-set limit reverts AND is
 *    billed, so the seller pays and receives nothing — strictly worse than over-paying. Never send
 *    less than a real sell was measured to need.
 *  - ABOVE the cap the estimate is truncated. An estimate an order of magnitude over measured
 *    reality is not caution, it is a transfer from the seller to the validator.
 *  - Between them the estimator is believed. It sees the actual market, route and balances; this
 *    function only knows what three shapes cost on one day.
 *
 * A null estimate takes the CAP rather than the floor. An estimator that declines to answer is the
 * case with the least information, and the bias there has to be generous.
 *
 * Unlike `zapGasLimit` this never returns null, i.e. never leaves the limit to the wallet: the
 * wallet's limit is the number this whole function exists because of. It also needs no equivalent
 * of that function's `graduationHint` — a sell moves the curve backwards, never reaches
 * `_tryAutoGraduate`, and so has no swallowed call for the estimator to be blind to.
 */
export function zapSellGasLimit(estimate: bigint | null): bigint {
  if (estimate === null) return SELL_GAS_CAP;
  if (estimate < SELL_GAS_FLOOR) return SELL_GAS_FLOOR;
  if (estimate > SELL_GAS_CAP) return SELL_GAS_CAP;
  return estimate;
}

export interface ZapSellParams {
  /** From `ZAP_ROUTER`. A caller holding `null` has no feature to call and must not reach here. */
  router: `0x${string}`;
  curve: `0x${string}`;
  /** The route from the market's quote asset to MON. Its last hop is native. */
  path: PathKey[];
  /** Market tokens to sell, raw units. Must already be approved to the ROUTER. */
  baseIn: bigint;
  /** Floors, already computed from the trader's own tolerance — see `sellZapPlan`. */
  minQuoteOut: bigint;
  minNativeOut: bigint;
  deadlineSecs?: number;
}

/**
 * Sells a curve market's token and pays the seller in native MON.
 *
 * The mirror of `zapBuyWithNative`, and two things about it differ in ways worth stating.
 *
 * **It needs an approval, and to the ROUTER.** A buy sends MON as `value`, so there is nothing to
 * approve; a sell is the router pulling an ERC-20, so the seller must approve it first. Approving
 * the CURVE instead — which is what the direct sell path does, because there the curve is the
 * puller — is an allowance nothing uses and a sell that still reverts. That approval is the
 * caller's job, as it is on every other path in this app.
 *
 * **Its gas limit is CLAMPED, and for the opposite reason to the buy's.** `zapBuyWithNative` adds
 * `autoGraduationGasHint` on a buy that fills the curve, because graduation runs inside a
 * swallowing `try`/`catch` and `eth_estimateGas` therefore returns a limit at which the market
 * fills and does not graduate — the estimate is too SMALL. A sell cannot fill anything: it moves
 * the curve backwards and `BondingCurve.sell` never reaches `_tryAutoGraduate`, so there is no
 * swallowed call and no blind spot. The estimate is too LARGE instead — measured at 4,795,725 on
 * chain against a real cost near 270,000 — and on a chain that bills the limit that gap is money.
 * `zapSellGasLimit` is where that is bounded, in both directions; this used to say the wallet's own
 * estimate was the right one, and a 0.489 MON gas bill on a 0.489 MON sale is what disproved it.
 */
export async function zapSellToNative(
  wallet: WalletClient,
  publicClient: PublicClient,
  params: ZapSellParams
): Promise<`0x${string}`> {
  const account = wallet.account;
  if (!account) throw new Error("no connected account");

  const deadline = deadlineFrom(Date.now(), params.deadlineSecs ?? DEFAULT_DEADLINE_SECS);
  const args = [
    params.curve,
    params.path,
    params.baseIn,
    params.minQuoteOut,
    params.minNativeOut,
    deadline,
  ] as const;

  const { request } = await publicClient.simulateContract({
    address: params.router,
    abi: zapRouterAbi,
    functionName: "zapSellToNative",
    args,
    account,
  });

  const estimate = await publicClient
    .estimateContractGas({
      address: params.router,
      abi: zapRouterAbi,
      functionName: "zapSellToNative",
      args,
      account,
    })
    // An estimator that declines is not a reason to abandon a trade that just simulated cleanly —
    // and unlike the buy, leaving the limit to the wallet is not an option here. `zapSellGasLimit`
    // answers the null case with the cap.
    .catch(() => null);

  /*
   * The clamp is VERIFIED, not assumed, and that distinction is the whole of this block.
   *
   * `SELL_GAS_CAP` was derived from three fork sells of 100 MON — about $2.60, annotated as such
   * in the test that measured them. A $2.60 swap crosses no initialised ticks. This app offers
   * routes up to `MAX_ZAP_IMPACT_BPS` (3%), which on a deep route is tens of thousands of dollars,
   * and every initialised tick a hop crosses costs roughly 12k gas. The headroom above a three-hop
   * sell is 123,492 — about ten crossings, for all three hops together.
   *
   * So a large enough sell genuinely needs more than the cap. Sending the cap anyway would revert
   * it, and on Monad the LIMIT is billed — the seller pays and receives nothing. Worse, the clamp
   * is deterministic: the retry computes the same limit and is billed again. That is a bricked
   * trade, which is a far worse outcome than the fee the clamp exists to save.
   *
   * One extra simulation settles it. If the clamped limit is enough, use it and keep the saving;
   * if it is not, defer to the estimator — pessimistic and expensive, but it completes. The cheap
   * sells this was written for are unaffected, and the expensive ones stop being impossible.
   */
  const clamped = zapSellGasLimit(estimate);
  const clampFits = await publicClient
    .simulateContract({
      address: params.router,
      abi: zapRouterAbi,
      functionName: "zapSellToNative",
      args,
      account,
      gas: clamped,
    })
    .then(() => true)
    .catch(() => false);

  return wallet.writeContract({
    ...request,
    // `estimate` is what the wallet would have sent anyway, so the fallback is never worse than
    // no clamp at all. `clamped` is only ever used where it has been shown to be sufficient.
    gas: clampFits ? clamped : (estimate ?? clamped),
  });
}

/**
 * One call in a batch: where it goes, what it says, and what native it carries.
 *
 * Declared here until a second batch needed it. It now lives in `encoded-call.ts`, a leaf, because
 * the `LaunchChain` port in `writes.ts` names it too — and this module imports `writes.ts`, so
 * declaring it here made that a cycle. Re-exported rather than moved out of sight: every importer
 * of `EncodedCall` from `./zap` is still correct.
 *
 * Neither call a batched sell carries has a `value`, and neither sets one. That field exists for
 * the launch batch, where the swap settles native MON and the launch owes the factory a fee.
 */
export type { EncodedCall };

/**
 * The same sell as `zapSellToNative`, encoded and deliberately NOT simulated, for one wallet prompt.
 *
 * A zapped sell is pulled, so it only works once `approve(token, router, amount)` has landed. Under
 * EIP-5792 both calls travel in a single `wallet_sendCalls` — one prompt instead of two — and at
 * the moment this call is built the approval is still sitting in the same batch, unexecuted.
 * `publicClient.simulateContract` therefore reverts on the allowance, on a trade that is perfectly
 * good. There is no simulation that could pass, so this variant does not attempt one, and
 * `zapSellToNative` keeps its simulate-then-write shape untouched for every wallet that cannot
 * batch.
 *
 * What skipping it costs is the error message. That simulation is what turns a doomed trade into a
 * clean sentence instead of a paid-for revert, and it is worth keeping — which is why it is still
 * there on the fallback path rather than being softened for this one. What it does NOT cost is
 * safety: `minQuoteOut` and `minNativeOut` are enforced by the router inside the transaction, so a
 * batched sell that would have been caught locally reverts on chain instead, having spent gas. The
 * seller cannot be filled at a price they did not agree to; they can be charged for finding out.
 *
 * The deadline is stamped at ENCODE time, as on every other path here. A batch left unsigned in a
 * wallet for longer than `deadlineSecs` expires rather than executing at a price nobody agreed to.
 */
export function encodeZapSellToNative(params: ZapSellParams): EncodedCall {
  const deadline = deadlineFrom(Date.now(), params.deadlineSecs ?? DEFAULT_DEADLINE_SECS);
  return {
    to: params.router,
    data: encodeFunctionData({
      abi: zapRouterAbi,
      functionName: "zapSellToNative",
      args: [
        params.curve,
        params.path,
        params.baseIn,
        params.minQuoteOut,
        params.minNativeOut,
        deadline,
      ] as const,
    }),
  };
}
