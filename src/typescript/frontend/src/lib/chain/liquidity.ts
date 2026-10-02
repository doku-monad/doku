import { POOL_TICK_SPACING, toNominal } from "./config";
import { MAX_TICK, MIN_TICK, nearestUsableTick, sqrtRatioAtTick } from "./tick-math";
import { applySlippage } from "./writes";

/**
 * Providing liquidity to a graduated market's pool.
 *
 * A V3 position takes both tokens at a ratio the current price decides, so the second amount is
 * never the user's to choose — it is computed. Getting it wrong means a revert, or worse a mint
 * that quietly consumes far more of one side than the panel showed.
 *
 * **Full range, always.** Graduation mints one full-range position and burns it precisely so a
 * market can never fall out of range and stop quoting. A concentrated range belongs to someone who
 * is around to rebalance it, and a launchpad's providers are not; offering a range picker here
 * would mostly produce positions that silently stop earning.
 *
 * The protocol's own position being burned does not close the pool. The burn makes *that* position
 * unwithdrawable; anyone may still mint their own, and withdraw it again.
 */

/*
 * `1n << 96n`, not `2n ** 96n`.
 *
 * SWC compiles the exponentiation operator down to `Math.pow` for this project's browserslist
 * target, and `Math.pow` throws `TypeError: Cannot convert a BigInt value to a number` on BigInt
 * arguments. Because this is a module-level constant, the throw happens while the module is being
 * *evaluated* — so the whole route fails to load rather than any one component erroring, and the
 * stack points at `Math.pow (<anonymous>)` with no clue that the source ever said `**`.
 *
 * A left shift is the same value and survives the transpile untouched.
 */
const Q96 = 1n << 96n;

/**
 * The widest range this pool will accept, and the prices at its edges.
 *
 * `MIN_TICK`/`MAX_TICK` themselves are not usable: v4 requires both bounds to be multiples of the
 * pool's tick spacing, and ±887272 is not one. These are rounded inward to the nearest usable tick.
 *
 * DERIVED, not written down. The previous version hardcoded ±887200 with hand-copied sqrt ratios —
 * correct for Uniswap V3's 1% tier, whose spacing is 200, and wrong for this pool, whose spacing is
 * 60. `887200 % 60` is 40, so the widest range the UI could offer was one v4 rejects outright, and
 * every deposit reverted. Deriving both the ticks and their ratios from `POOL_TICK_SPACING` removes
 * the two places that could disagree with the pool.
 */
export const FULL_RANGE = {
  tickLower: nearestUsableTick(MIN_TICK, POOL_TICK_SPACING),
  tickUpper: nearestUsableTick(MAX_TICK, POOL_TICK_SPACING),
  get sqrtRatioLowerX96() {
    return sqrtRatioAtTick(this.tickLower);
  },
  get sqrtRatioUpperX96() {
    return sqrtRatioAtTick(this.tickUpper);
  },
} as const;

/** The same bounds, as a range the functions below take. */
export const FULL_RANGE_TICKS = {
  tickLower: FULL_RANGE.tickLower,
  tickUpper: FULL_RANGE.tickUpper,
} as const;

/**
 * Which tokens a range needs funding with.
 *
 * A position is two-sided only while the price is *inside* it. A range entirely above the price is
 * waiting to sell token0 and holds token0 alone; one entirely below holds token1 alone. So a
 * single-token deposit is not a separate feature — it is what a range that does not straddle the
 * price already means, and the panel only has to stop asking for the side that is not used.
 *
 * A range starting exactly at the current tick counts as above it: nothing of token1 is in it yet.
 */
export function depositSides(range: {
  tickLower: number;
  tickUpper: number;
  tickCurrent: number;
}): { needsToken0: boolean; needsToken1: boolean } {
  const { tickLower, tickUpper, tickCurrent } = range;
  if (tickCurrent < tickLower) return { needsToken0: true, needsToken1: false };
  if (tickCurrent >= tickUpper) return { needsToken0: false, needsToken1: true };
  return { needsToken0: true, needsToken1: true };
}

/**
 * The liquidity a given amount of token0 buys over a range.
 *
 * Uniswap's `LiquidityAmounts.getLiquidityForAmount0`, in bigint. The intermediate product is
 * formed before dividing — at the full range the two sqrt ratios differ by nineteen orders of
 * magnitude, and dividing first truncates the result to nothing.
 */
function liquidityForAmount0(sqrtLower: bigint, sqrtUpper: bigint, amount0: bigint): bigint {
  const intermediate = (sqrtLower * sqrtUpper) / Q96;
  return (amount0 * intermediate) / (sqrtUpper - sqrtLower);
}

/** Uniswap's `LiquidityAmounts.getLiquidityForAmount1`. */
function liquidityForAmount1(sqrtLower: bigint, sqrtUpper: bigint, amount1: bigint): bigint {
  return (amount1 * Q96) / (sqrtUpper - sqrtLower);
}

/** Uniswap's `LiquidityAmounts.getAmount0ForLiquidity`. */
function amount0ForLiquidity(sqrtLower: bigint, sqrtUpper: bigint, liquidity: bigint): bigint {
  return ((liquidity * Q96 * (sqrtUpper - sqrtLower)) / sqrtUpper) / sqrtLower;
}

/** Uniswap's `LiquidityAmounts.getAmount1ForLiquidity`. */
function amount1ForLiquidity(sqrtLower: bigint, sqrtUpper: bigint, liquidity: bigint): bigint {
  return (liquidity * (sqrtUpper - sqrtLower)) / Q96;
}

export interface RangeAmounts {
  amount0: bigint;
  amount1: bigint;
  liquidity: bigint;
}

/**
 * Both sides of a position over an arbitrary range, from whichever side was given.
 *
 * Three cases, and the middle one is the only one people picture. Below the range the position is
 * all token0; above it, all token1; inside, both, in a ratio the price decides. Uniswap's
 * `LiquidityAmounts` is the same three cases, and this follows it because a position minted on a
 * different formula than the pool prices it with is a position that reverts or overpays.
 *
 * Everything is derived through the position's *liquidity* rather than through a price ratio.
 * Liquidity is what the pool actually stores, and going via it is what makes the two input
 * directions agree with each other and with the contract.
 */
export function amountsForRange(params: {
  sqrtPriceX96: bigint;
  tickLower: number;
  tickUpper: number;
  amount0?: bigint;
  amount1?: bigint;
}): RangeAmounts {
  const { sqrtPriceX96, tickLower, tickUpper, amount0, amount1 } = params;
  if (sqrtPriceX96 <= 0n) {
    throw new Error("the pool has no price yet — it has never been initialised");
  }
  if (tickLower >= tickUpper) {
    throw new Error(`the range is empty or inverted: ${tickLower} to ${tickUpper}`);
  }
  if (amount0 === undefined && amount1 === undefined) {
    throw new Error("one side of the pair must be given");
  }

  const lower = sqrtRatioAtTick(tickLower);
  const upper = sqrtRatioAtTick(tickUpper);
  // Clamped rather than compared to the tick, so the boundary cases agree with the ratios the
  // amounts are computed from rather than with a separately rounded tick.
  const price = sqrtPriceX96 < lower ? lower : sqrtPriceX96 > upper ? upper : sqrtPriceX96;

  const below = price <= lower; // entirely above the market: token0 only
  const above = price >= upper; // entirely below the market: token1 only

  let liquidity: bigint;
  if (below) {
    if (amount0 === undefined) {
      throw new Error("this range holds token0 only — give the token0 amount");
    }
    liquidity = liquidityForAmount0(lower, upper, amount0);
  } else if (above) {
    if (amount1 === undefined) {
      throw new Error("this range holds token1 only — give the token1 amount");
    }
    liquidity = liquidityForAmount1(lower, upper, amount1);
  } else if (amount0 !== undefined) {
    liquidity = liquidityForAmount0(price, upper, amount0);
  } else {
    liquidity = liquidityForAmount1(lower, price, amount1!);
  }

  if (liquidity <= 0n) {
    throw new Error("the amount must be positive, and large enough to be worth some liquidity");
  }

  return {
    amount0: below || !above ? amount0ForLiquidity(price, upper, liquidity) : 0n,
    amount1: above || !below ? amount1ForLiquidity(lower, price, liquidity) : 0n,
    liquidity,
  };
}

/**
 * What a position holds, from the liquidity it was minted with.
 *
 * The inverse of pairing, and shown before anyone confirms a withdrawal: "remove liquidity" with
 * no numbers beside it is a button people are right not to press.
 */
export function positionAmounts(
  sqrtPriceX96: bigint,
  liquidity: bigint,
  tickLower: number,
  tickUpper: number,
): { amount0: bigint; amount1: bigint } {
  if (liquidity <= 0n) return { amount0: 0n, amount1: 0n };

  const lower = sqrtRatioAtTick(tickLower);
  const upper = sqrtRatioAtTick(tickUpper);
  // Clamped into the position's own range: a position the price has left holds one token only, and
  // computing it against the live price instead would report a balance it does not have.
  const price = sqrtPriceX96 < lower ? lower : sqrtPriceX96 > upper ? upper : sqrtPriceX96;

  return {
    amount0: price >= upper ? 0n : amount0ForLiquidity(price, upper, liquidity),
    amount1: price <= lower ? 0n : amount1ForLiquidity(lower, price, liquidity),
  };
}

/**
 * The minimums a mint may settle for.
 *
 * `mint` takes a floor on each side because the price moves between reading it and the transaction
 * landing, and the contract then takes a different ratio than the panel showed. Without a floor a
 * mint can consume far more of one token than the user agreed to — the same failure a swap without
 * a slippage limit has, in a shape that is easier to overlook because nothing is being "sold".
 *
 * Shares `applySlippage` with the trade path, so the ceiling on tolerance is one rule rather than
 * two that can drift apart.
 */
export function withMintFloor(
  amounts: { amount0: bigint; amount1: bigint },
  slippageBps: number,
): { amount0Min: bigint; amount1Min: bigint } {
  return {
    amount0Min: applySlippage(amounts.amount0, slippageBps),
    amount1Min: applySlippage(amounts.amount1, slippageBps),
  };
}

/**
 * What a position is worth, denominated in MON.
 *
 * Both sides at the pool's live price, which is the price the position would actually be unwound
 * at — not the indexer's last trade, which can be minutes stale and is a different number from the
 * one a withdrawal would settle at.
 *
 * A missing price is a state, not a failure: a pool whose `slot0` has not been read yet has none.
 * The MON side is still known and still true, so that is what comes back, and the caller decides
 * whether to render the figure or a dash. Returning `NaN` would be more honest in isolation and
 * much worse in aggregate — one unreadable pool would turn every total that sums these into NaN.
 */
export function positionValueMon(
  amountMon: bigint,
  amountToken: bigint,
  monPerToken: number,
): number {
  if (!Number.isFinite(monPerToken) || monPerToken <= 0) return toNominal(amountMon);
  return toNominal(amountMon) + toNominal(amountToken) * monPerToken;
}
