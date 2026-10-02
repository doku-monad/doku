"use client";

import { useReadContract } from "wagmi";

import { stateViewAbi } from "@/lib/chain/abis";
import { poolIdFrom } from "@/lib/chain/pool-id";
import { priceFromSqrtX96 } from "@/lib/chain/pool-price";
import { CONTRACTS, poolKeyFor } from "@/lib/chain/wagmi";
import type { MarketModel } from "@/lib/models";

/**
 * The current price of a graduated market, read from its pool.
 *
 * Without this a graduated market's price and market cap are whatever they were at the moment it
 * left the curve, forever: the indexer derives `last_price` from curve swaps, and a closed curve
 * never emits another one. The frozen number looks exactly like a live one.
 *
 * Returns null while bonding — there is no pool then, and the curve's own price is correct.
 *
 * ## There is no pool contract to call
 *
 * It read `slot0()` and `token0()` off a V3 pool at `market.state.poolAddress`. Under v4 a pool is
 * state inside one PoolManager singleton addressed by `keccak256(PoolKey)`, and `poolAddress` is
 * only the indexer's "has it graduated" flag — calling it would be calling the market's own token
 * contract or nothing at all. So the key is built from the market's pair and read through
 * StateView, and `poolAddress` is used for what it is: a boolean.
 *
 * ## The decimals, which is where this silently prints zero
 *
 * `sqrtPriceX96` encodes a ratio of RAW units, and `priceFromSqrtX96` returns it the right way up
 * for an eighteen-decimal pair. A market's token is always eighteen decimals; its quote need not
 * be. Against six-decimal gold the raw ratio is a million times the figure a person means by "the
 * price", so the ratio is scaled by the difference here — as a multiplication on the float, not as
 * a second integer division, because one whole token of a young gold market is worth about 1.39e-9
 * ounces and an integer division would floor every one of them to zero.
 */

/** Every DOKU token is eighteen decimals. The quote asset is the side that varies. */
const BASE_DECIMALS = 18;

export function usePoolPrice(market: MarketModel): number | null {
  const graduated = Boolean(market.state.poolAddress);
  const token = market.market.tokenAddress as `0x${string}`;
  const quoteAsset = market.market.quote.asset as `0x${string}`;
  const quoteDecimals = market.market.quote.decimals;

  const poolKey = poolKeyFor(token, quoteAsset);
  const poolId = graduated ? poolIdFrom(poolKey) : undefined;

  const { data: slot0 } = useReadContract({
    address: CONTRACTS.stateView,
    abi: stateViewAbi,
    functionName: "getSlot0",
    args: poolId ? [poolId] : undefined,
    // Polled: the pool moves with every trade, and a price fetched once is the same staleness
    // problem in a different place.
    query: { enabled: graduated, refetchInterval: 8_000 },
  });

  if (!slot0) return null;
  const sqrtPriceX96 = (slot0 as readonly [bigint, number, number, number])[0];

  /*
   * The quote is passed where the wrapper used to go.
   *
   * `priceFromSqrtX96`'s third argument is "which of the two currencies is the money" — it was
   * named for WMON because for a while the money was always MON. Handing it the market's own quote
   * asset asks the same question of a pair that no longer has a constant answer.
   */
  const ratio = priceFromSqrtX96(sqrtPriceX96, poolKey.currency0, quoteAsset);
  if (ratio <= 0) return null;
  const price = ratio * 10 ** (BASE_DECIMALS - quoteDecimals);
  return price > 0 && Number.isFinite(price) ? price : null;
}
