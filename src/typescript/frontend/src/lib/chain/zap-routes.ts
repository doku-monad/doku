/**
 * Paying for a coin with MON when the market is priced in something else.
 *
 * A DOKU market can be quoted in any registered asset, so buying one usually means holding that
 * asset first. The zap router removes that step: it swaps MON into the market's quote on Uniswap v4
 * and buys on the curve, in one transaction. What this module decides is WHICH swap — and, just as
 * importantly, when not to offer one at all.
 *
 * ## Why the shortest path is often the wrong one
 *
 * Measured on Monad mainnet: MON has a direct pool with cbBTC, and that pool holds about one MON.
 * Ten MON through it comes out 40% down; a hundred, 88%. Routing the same trade through USDC costs
 * a second pool fee and stays flat past a hundred thousand dollars. The direct route looks better
 * on paper and is catastrophic in practice.
 *
 * So nothing here prefers a route by shape. Every candidate is quoted at the size actually being
 * traded, and the one that returns most wins. That is also the only approach that survives
 * liquidity moving, which it does — a route that is deep this week can be dust next month, and a
 * table measured once would go on recommending it.
 *
 * ## And when every route is bad, there is no route
 *
 * A trade the pools cannot absorb is not offered. The app asks for the market's own quote asset
 * instead, which always works. Showing someone a confident price that costs them a quarter of their
 * money is worse than showing them one option fewer.
 */

/** Native MON, which is how a v4 `PoolKey` spells the chain's own token. */
export const NATIVE = "0x0000000000000000000000000000000000000000" as const;

/** One leg of a swap: a pool, and which way through it. */
export interface Hop {
  from: string;
  to: string;
  fee: number;
  tickSpacing: number;
}

export type Path = Hop[];

const USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603";
const USDT0 = "0xe7cd86e13ac4309349f30b3435a9d337750fc82d";
const WETH = "0xee8c0e9f1bffb4eb878d8f15f368a02a35481242";
const WBTC = "0x0555e30da8f98308edb960aa94c0db47230d2b9c";
const CBBTC = "0xd18b7ec58cdf4876f6afebd3ed1730e4ce10414b";
const GOLD = "0x01bff41798a0bcf287b996046ca68b395dbc1071";

/**
 * The pools that exist on Monad, as an undirected graph.
 *
 * Surveyed by quoting every ordered pair of registered assets at every standard fee tier and
 * keeping the tier that returned most. The depths below were measured at $1,000 of input on
 * 2026-09-09, and they are recorded so the claim is checkable rather than folklore — re-run the
 * survey rather than trusting this comment a year from now.
 *
 *   MON   -> USDC    500     1 bps      the on-ramp everything else depends on
 *   USDC  -> cbBTC   500     0 bps
 *   USDC  -> WETH    500     0 bps
 *   USDC  -> WBTC    500    23 bps
 *   WBTC  -> cbBTC   100     0 bps
 *   MON   -> USDT0  3000  4999 bps      thin at size, fine at ten dollars
 *   MON   -> cbBTC   500  5000 bps      about one MON deep; the trap the hop exists to avoid
 *   MON   -> WETH  10000  4998 bps      likewise
 *   USDT0 -> XAUt0   500  5000 bps      gold's only pool anywhere on the chain
 *   USDT0 -> WETH   3000  4999 bps
 *
 * The thin ones are kept. `MON -> USDT0` and `USDT0 -> XAUt0` are the ONLY way to reach USDT0 and
 * gold, and they price correctly at ten dollars even though they collapse at a thousand; dropping
 * them would remove those markets from the feature rather than protect anyone. The live quote is
 * what decides, per trade, and it already refuses them above the threshold.
 *
 * What is NOT here is `MON -> WBTC`. Every tier of it reverts at every size, from a tenth of a MON
 * upwards — not thin, absent. Listing a pool that cannot quote costs two wasted round trips on
 * every WBTC trade and can never win. WBTC is reached through USDC, and through cbBTC.
 *
 * There is no `USDC/USDT0` pool in v4 at all, which is why the two dollar rails are not
 * interchangeable here. Uniswap V3 has one, and adding it would be worth up to 163% more USDT0 on
 * a thousand-dollar trade — but no USDT0-quoted market exists yet, so it would be a second AMM
 * interface bought for nobody. See `contracts/README.md` for that measurement.
 *
 * Edges say only that a pool EXISTS and roughly how deep it was. Whether it is deep enough for a
 * given trade is decided by the quote, because depth is the thing that moves.
 */
const EDGES: [string, string, number, number][] = [
  [NATIVE, USDC, 500, 10],
  [NATIVE, USDT0, 3000, 60],
  [NATIVE, WETH, 10000, 200],
  [NATIVE, CBBTC, 500, 10],
  [USDC, WETH, 500, 10],
  [USDC, WBTC, 500, 10],
  [USDC, CBBTC, 500, 10],
  [USDT0, WETH, 3000, 60],
  [USDT0, GOLD, 500, 10],
  [WBTC, CBBTC, 100, 1],
];

/**
 * How many pools one swap may cross.
 *
 * Three. Every asset here is reachable within three, and each further hop is another pool fee, more
 * gas, and one more pool that can be thin — a longer path is rarely a better price.
 */
export const MAX_ZAP_HOPS = 3;

/**
 * How many paths to quote.
 *
 * Each candidate costs two quotes, one at the trade's size and one at half, and they run while
 * somebody is typing an amount. Six is enough to hold every genuinely different way to reach an
 * asset without turning a keystroke into a dozen round trips.
 */
export const MAX_ZAP_CANDIDATES = 6;

/** Both directions of each pool, indexed by the token being spent. */
const ADJACENCY: Map<string, Hop[]> = (() => {
  const map = new Map<string, Hop[]>();
  const add = (from: string, to: string, fee: number, tickSpacing: number) => {
    const list = map.get(from) ?? [];
    list.push({ from, to, fee, tickSpacing });
    map.set(from, list);
  };
  for (const [a, b, fee, spacing] of EDGES) {
    add(a, b, fee, spacing);
    add(b, a, fee, spacing);
  }
  return map;
})();

/**
 * Every way to get from `from` to `to`, shortest first.
 *
 * A breadth-first walk rather than a hand-written table, so adding one pool to `EDGES` makes every
 * route through it a candidate without anyone having to notice. That matters because the good
 * paths are not the obvious ones: WBTC is reachable through USDC and through cbBTC, and which is
 * cheaper depends on the size being traded and on the day.
 *
 * A token is never revisited — a cycle pays two pool fees to arrive where it started.
 *
 * ## Why selling walks the graph again instead of reversing the buy list
 *
 * `MAX_ZAP_CANDIDATES` truncates DURING the walk, not after it, so what the walk keeps is whatever
 * it reached first from ITS OWN starting token — and the graph is not symmetric about that. A
 * token with many pools fans out wide on the first level and spends the budget on routes a walk
 * from the other end would never have enqueued. Reversing the buy list would therefore hand the
 * seller a set that was selected for the wrong direction, silently missing the routes that are
 * short from where the seller actually starts.
 *
 * On the `EDGES` above the budget does not yet bind — nothing reaches six — so today the two sets
 * coincide. What already differs is the ORDER: selling WBTC or cbBTC finds the same routes in a
 * different sequence, because each walk meets its neighbours in its own order. That is the same
 * asymmetry, just not yet expensive, and one added pool is all it takes to turn it into a missing
 * route rather than a reshuffled one. Both directions therefore run the search; `ADJACENCY`
 * already carries every edge both ways, so this costs nothing but the walk.
 *
 * Empty when `from` and `to` are the same token, which needs no swap at all, and empty when one of
 * them has no pool, where the honest answer is that this trade cannot be routed.
 */
export function routesBetween(from: string, to: string): Path[] {
  const start = from.toLowerCase();
  const target = to.toLowerCase();
  if (start === target) return [];

  const found: Path[] = [];
  // Shortest first falls out of the queue order, which is also the order worth quoting: fewer hops
  // means fewer fees, so a longer path has to be meaningfully deeper to win.
  const queue: { at: string; path: Path; seen: Set<string> }[] = [
    { at: start, path: [], seen: new Set([start]) },
  ];

  while (queue.length > 0 && found.length < MAX_ZAP_CANDIDATES) {
    const { at, path, seen } = queue.shift()!;
    for (const edge of ADJACENCY.get(at) ?? []) {
      if (seen.has(edge.to)) continue;
      const next = [...path, edge];
      if (edge.to === target) {
        found.push(next);
        if (found.length >= MAX_ZAP_CANDIDATES) break;
        continue;
      }
      if (next.length < MAX_ZAP_HOPS) {
        queue.push({ at: edge.to, path: next, seen: new Set([...seen, edge.to]) });
      }
    }
  }
  return found;
}

/**
 * Quote assets whose markets the trade panel never offers to buy or sell in MON, even though a
 * route exists.
 *
 * Gold. Its only pool on the chain is USDT0/XAUt0, and the only way to USDT0 from MON is a thin
 * pool too: both measured 5000 bps short at $1,000, so the panel refused almost every MON trade
 * on a gold market anyway. The routes are left alone — the launch form's dev buy still uses them —
 * and only the market page's pay-with choice reads this, through `sideAssetOptions`.
 */
const NO_NATIVE_TRADING: ReadonlySet<string> = new Set([GOLD]);

/** Whether the trade panel may offer MON on a market priced in `quoteAsset`. */
export const nativeTradingAllowed = (quoteAsset: string): boolean => !NO_NATIVE_TRADING.has(quoteAsset.toLowerCase());

/**
 * Every way to spend MON on `quoteAsset`, for buying a coin the market prices in something else.
 *
 * Empty for a MON-quoted market, which needs no swap at all, and empty for an asset with no pool,
 * where the honest answer is that this cannot be paid for in MON.
 */
export const candidateRoutes = (quoteAsset: string): Path[] => routesBetween(NATIVE, quoteAsset);

/**
 * Every way to turn `quoteAsset` back into MON, for selling a coin and being paid in the chain's
 * own token.
 *
 * The mirror of `candidateRoutes`, and deliberately its own walk rather than its output reversed —
 * see `routesBetween` for why those are not the same set. Empty in exactly the cases the buy side
 * is empty: a MON-quoted market needs no swap, and an asset with no pool cannot be sold into MON.
 */
export const sellRoutes = (quoteAsset: string): Path[] => routesBetween(quoteAsset, NATIVE);

/**
 * How much depth the trade itself is eating, in basis points.
 *
 * Measured against the SAME ROUTE AT HALF THE SIZE, not against a fixed small reference. A flat
 * pool returns exactly twice as much for twice the input, so the shortfall against that is the
 * impact of the trade's own second half.
 *
 * The obvious alternative — quote something tiny and compare rates — fails on precisely the routes
 * that need checking. A tenth of a MON buys less than one raw unit of six-decimal gold, so the
 * reference quote returns zero, and a route that works perfectly at any real size reads as
 * infinitely deep or completely dead depending on which way the arithmetic falls. Halving the
 * actual trade cannot have that problem: whatever the destination's decimals, the reference is
 * within one power of two of a number that already quoted.
 */
export function routeImpactBps(input: { amountOut: bigint; halfAmountOut: bigint }): number {
  const { amountOut, halfAmountOut } = input;
  // A route that returns nothing is not shallow, it is absent — and calling that anything less
  // than total would let a dead pool pass the threshold below.
  if (amountOut <= 0n || halfAmountOut <= 0n) return 10_000;

  const linear = halfAmountOut * 2n;
  // Better than linear is rounding noise on small numbers, not a bonus; a negative impact would
  // sail through any ceiling.
  if (amountOut >= linear) return 0;
  return Number(((linear - amountOut) * 10_000n) / linear);
}

/**
 * The worst price impact a zap may carry before it is withdrawn as an option.
 *
 * Three percent. The deep routes measured under one percent at fifty thousand dollars, so this
 * keeps every route that works while dropping the dust pools that cost forty. It is a ceiling on
 * the SWAP leg only; the curve's own price impact is shown separately and is the trader's business.
 */
export const MAX_ZAP_IMPACT_BPS = 300;

export interface QuotedRoute {
  path: Path;
  amountOut: bigint;
  impactBps: number;
}

/**
 * The best quoted route, or null when none is good enough.
 *
 * Null is a real answer and the caller must handle it: it means this trade is not offered in MON,
 * and the market's own quote asset is what to ask for. A route that quoted nothing is discarded
 * rather than ranked, so a pool that does not exist cannot win by being the only entry.
 */
export function chooseRoute(quotes: QuotedRoute[]): QuotedRoute | null {
  let best: QuotedRoute | null = null;
  for (const quote of quotes) {
    if (quote.amountOut <= 0n) continue;
    if (quote.impactBps > MAX_ZAP_IMPACT_BPS) continue;
    if (best === null || quote.amountOut > best.amountOut) best = quote;
  }
  return best;
}
