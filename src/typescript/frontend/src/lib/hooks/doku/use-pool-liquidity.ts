"use client";

import { useReadContract } from "wagmi";

import { stateViewAbi } from "@/lib/chain/abis";
import { poolIdFrom } from "@/lib/chain/pool-id";
import { CONTRACTS, poolKeyFor } from "@/lib/chain/wagmi";
import type { MarketModel } from "@/lib/models";

/**
 * What a graduated market's pool is holding, in whole units of its quote asset.
 *
 * ## Why this is not simply a balance read
 *
 * Under v4 there is no pool contract to hold a balance. Every pool's funds sit in one PoolManager
 * singleton, and a pool's share of them is described by `liquidity` — the constant `L` of the
 * position, which is neither of the two amounts and cannot be read as one. The amounts have to be
 * derived from `L` and the current price, and which of the two is the money depends on the sort
 * order of the pair.
 *
 * ## The full-range shortcut, and why it is exact here rather than convenient
 *
 * For a position spanning ticks `[a, b]`, holding `L`:
 *
 *     amount1 = L · (√P − √Pa)          amount0 = L · (1/√P − 1/√Pb)
 *
 * `DokuGraduation` mints at `minUsableTick(TICK_SPACING)` … `maxUsableTick(TICK_SPACING)` — the
 * widest range the spacing allows — so `√Pa` is ~2⁻³² and `√Pb` ~2³², and both correction terms
 * vanish against any price a launched market trades at. That leaves `amount1 = L·√P` and
 * `amount0 = L/√P`, and multiplying the second by the price `P = (√P)²` gives exactly the first.
 *
 * A full-range position is therefore **balanced in value at every price**: the token side is worth
 * precisely what the quote side is worth. So the pool's total, in quote terms, is the quote side
 * doubled — no second price lookup, and no chance of the two halves being priced inconsistently.
 *
 * Returns `null` while bonding, and while the two reads are in flight. `null` is "not known", never
 * `0` — a market whose pool has not answered yet must not render as a market with no liquidity in
 * it.
 */

/** `sqrtPriceX96` is a Q64.96 fixed-point number: the ratio, times 2⁹⁶. */
const Q96 = 1n << 96n;

export function usePoolLiquidity(market: MarketModel): number | null {
  const graduated = Boolean(market.state.poolAddress);
  const token = market.market.tokenAddress as `0x${string}`;
  const quoteAsset = market.market.quote.asset as `0x${string}`;

  const poolKey = poolKeyFor(token, quoteAsset);
  const poolId = graduated ? poolIdFrom(poolKey) : undefined;

  const { data: slot0 } = useReadContract({
    address: CONTRACTS.stateView,
    abi: stateViewAbi,
    functionName: "getSlot0",
    args: poolId ? [poolId] : undefined,
    // The same 8s cadence the price read uses: both move on every swap, and a figure fetched once
    // is the same staleness problem in a different place.
    query: { enabled: graduated, refetchInterval: 8_000 },
  });

  const { data: liquidity } = useReadContract({
    address: CONTRACTS.stateView,
    abi: stateViewAbi,
    functionName: "getLiquidity",
    args: poolId ? [poolId] : undefined,
    query: { enabled: graduated, refetchInterval: 8_000 },
  });

  if (!slot0 || liquidity === undefined) return null;

  const sqrtPriceX96 = (slot0 as readonly [bigint, number, number, number])[0];
  const L = liquidity as bigint;
  if (sqrtPriceX96 <= 0n || L <= 0n) return null;

  /*
   * Which side is the money.
   *
   * `poolKeyFor` sorts the pair, so the quote is currency0 on some markets and currency1 on others
   * — native MON sorts to address(0) and is always currency0, while a six-decimal stablecoin may
   * land either side of the token it is paired with. Getting this backwards does not throw; it
   * reports the token side as the dollar side, which is wrong by the whole price.
   */
  const quoteIsCurrency0 = poolKey.currency0.toLowerCase() === quoteAsset.toLowerCase();
  const quoteRaw = quoteIsCurrency0 ? (L * Q96) / sqrtPriceX96 : (L * sqrtPriceX96) / Q96;

  // Both sides, in the quote's units: a full-range position holds equal value in each.
  const total = Number((quoteRaw * 2n * 1_000_000n) / 10n ** BigInt(market.market.quote.decimals));
  const whole = total / 1_000_000;
  return Number.isFinite(whole) && whole > 0 ? whole : null;
}
