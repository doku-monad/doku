/**
 * The price a graduated market trades at.
 *
 * The indexer's `last_price` comes from curve swaps, and a graduated curve never emits another
 * one — so without this a market's price and market cap freeze at the moment it graduated and stay
 * there forever, while the pool beside them moves. The frozen figure looks exactly like a live one.
 *
 * A pool stores price as `sqrtPriceX96`: the square root of token1-per-token0, in Q64.96. Two
 * conversions have to be right, and both are easy to get wrong in a way that still renders:
 * squaring before descaling overflows, and ignoring currency ordering inverts the price.
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
 * Converts `sqrtPriceX96` to QUOTE units per whole token.
 *
 * @param sqrtPriceX96 from the pool's `slot0`
 * @param token0 the pool's `currency0` — the pair is sorted by address, so which side is the money
 *        is not a given
 * @param quoteAsset what the market is priced in: `NATIVE_CURRENCY` (`address(0)`) for MON, the
 *        token's own address for anything else. The parameter was called `wmon` and documented as
 *        "the wrapped native token", which is what it was under V3 — v4 holds native MON as
 *        `address(0)` and there is no wrapper, and the pair need not involve MON at all. Passed in
 *        rather than imported because which asset is the quote is a property of the MARKET, and a
 *        constant here made the function correct on exactly one pair and silently inverted on
 *        every other.
 *
 * The result is in whole quote units only where the quote has eighteen decimals, because both
 * sides are assumed 18 here. A six-decimal quote needs the decimal adjustment this does not do —
 * see the note below.
 */
export function priceFromSqrtX96(sqrtPriceX96: bigint, token0: string, quoteAsset: string): number {
  if (sqrtPriceX96 <= 0n) return 0;

  // Squared as a bigint first, then descaled by 2^192 in floating point. Converting
  // `sqrtPriceX96` to a number before squaring loses precision at the top of the range; squaring
  // and then converting keeps every bit that matters.
  const ratioX192 = sqrtPriceX96 * sqrtPriceX96;
  const token1PerToken0 = Number(ratioX192) / Number(Q96 * Q96);
  if (!Number.isFinite(token1PerToken0) || token1PerToken0 <= 0) return 0;

  /*
   * Both sides 18 decimals, so only the DIRECTION is adjusted.
   *
   * True for MON (18) against a launched token (18), which is every pool this is called for today.
   * It is NOT true for a six- or eight-decimal quote, where the ratio needs scaling by
   * `10 ** (d0 - d1)` as well — and the caller that would hit it, the liquidity panel, refuses a
   * non-native pool for the same reason rather than rendering a number that is off by 1e12.
   */
  const quoteIsToken0 = token0.toLowerCase() === quoteAsset.toLowerCase();
  return quoteIsToken0 ? 1 / token1PerToken0 : token1PerToken0;
}
