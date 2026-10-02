import { POOL_FEE_TIER } from "./config";

/**
 * Which of an address's Uniswap positions are positions in a DOKU market.
 *
 * The position manager is one contract shared by every pool on the chain, so enumerating an
 * address's tokens returns positions in pools this app has never heard of alongside the ones it
 * has. Nothing on chain links a pool back to a market either — a position knows its pair, and the
 * pair is only recognisable as a market's because this app knows that market's token address.
 *
 * Pure and network-free on purpose. Every clause below is a place a real position can disappear
 * from somebody's screen, and on a page about deposited money that is worth having under test
 * rather than tangled into a hook where it cannot be exercised.
 */

/**
 * The fee tier DOKU graduates into.
 *
 * Re-exported from `config` rather than declared again. It was a second `10_000` living here, and
 * a matcher that disagrees with the mint path about which tier is DOKU's does not error — it
 * quietly matches nothing, and every position vanishes from both liquidity views.
 */
export { POOL_FEE_TIER as DOKU_FEE_TIER } from "./config";

/** One position as the position manager reports it, before anything is known about its market. */
export interface PositionRecord {
  tokenId: bigint;
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}

/** The least a market has to tell us for a position in it to be renderable. */
export interface MarketRef {
  marketAddress: string;
  tokenAddress: string;
  poolAddress: string | null;
  symbol: string;
}

export interface MatchedPosition extends PositionRecord {
  marketAddress: string;
  tokenAddress: string;
  /** Never null: a market without a pool is filtered out, because it cannot hold a position. */
  poolAddress: string;
  symbol: string;
  /** Which side of the pair the market's token sits on. Decides which amount is the MON one. */
  marketTokenIsToken0: boolean;
}

export function matchRecordsToMarkets(
  records: PositionRecord[],
  markets: MarketRef[],
  wmon: string,
): MatchedPosition[] {
  const wmonLower = wmon.toLowerCase();

  // Built once rather than searched per record: this runs over every position an address owns,
  // and both sides of that product can be in the hundreds.
  const byToken = new Map<string, MarketRef>();
  for (const m of markets) byToken.set(m.tokenAddress.toLowerCase(), m);

  const out: MatchedPosition[] = [];

  for (const record of records) {
    // An emptied position: withdrawn, never burned. Nothing to show and nothing to withdraw, and
    // showing one beside a real position invites withdrawing from the wrong row.
    if (record.liquidity <= 0n) continue;
    if (record.fee !== POOL_FEE_TIER) continue;

    const token0 = record.token0.toLowerCase();
    const token1 = record.token1.toLowerCase();

    // Exactly one side must be WMON. Neither side means it is some other pair entirely; both
    // sides cannot happen, and if it somehow did there would be no market token to look up.
    const marketTokenIsToken0 = token1 === wmonLower;
    const marketTokenIsToken1 = token0 === wmonLower;
    if (marketTokenIsToken0 === marketTokenIsToken1) continue;

    const market = byToken.get(marketTokenIsToken0 ? token0 : token1);
    if (!market || !market.poolAddress) continue;

    out.push({
      ...record,
      marketAddress: market.marketAddress,
      tokenAddress: market.tokenAddress,
      poolAddress: market.poolAddress,
      symbol: market.symbol,
      marketTokenIsToken0,
    });
  }

  return out;
}
