/**
 * What a market's token is worth, after a trade.
 *
 * This used to be the average execution price of the trade itself — MON paid divided by tokens
 * received. That is a real number and it is not the price. A buy walks the curve upward, so its
 * average sits *below* the price it leaves behind; a sell walks it downward, so its average sits
 * *above*. The two are not comparable, and consecutive trades produce a sawtooth that does not
 * track the curve at all.
 *
 * The symptom on a live testnet market: a 3 MON buy printed 1.43e-7, the 1.3 MON sell after it
 * printed 2.02e-7. The chart rose 41% on a sell, and market cap rose with it — both moving in the
 * direction opposite to what had just happened.
 *
 * So the price is the *post-trade spot price*, derived rather than measured. On the curve that is
 * a function of what has been raised, which is why `quoteRaised` is on every event. In the pool it
 * is `sqrtPriceX96`, which V3 reports in the swap itself.
 */

/** Mirrors `BondingCurve.BASE_VIRTUAL_CEILING`: where the virtual base reserve starts. */
const BASE_VIRTUAL_CEILING = 49_000_000n * 10n ** 18n;

/**
 * Fixed-point scale for a generation-1 price, and the default this module works in.
 *
 * Exported because it is not the only scale a stored price can carry any more: a generation-2
 * price is `quote * 1e36 / base`, and the factor between them has to be applied *inside* the
 * division that produces the number — see `poolSpotPrice`.
 */
export const PRICE_SCALE = 10n ** 18n;
const WAD = PRICE_SCALE;

const Q96 = 2n ** 96n;
const Q192 = Q96 * Q96;

/**
 * The curve's spot price after `quoteRaised` has been raised, in MON per whole token, scaled 1e18.
 *
 * Reserves are virtual and start at `(BASE_VIRTUAL_CEILING, quoteTarget * 0.4)`. Constant product
 * keeps `base * quote` fixed, so after raising `R`:
 *
 *     quote = 0.4·T + R
 *     base  = k / quote            where k = BASE_VIRTUAL_CEILING · 0.4·T
 *     spot  = quote / base = quote² / k
 *
 * Squared before dividing, in bigint, because the two reserves differ by about seven orders of
 * magnitude — dividing first would truncate the result to zero for any realistic market.
 */
export function curveSpotPrice(quoteRaised: bigint, quoteTarget: bigint): bigint {
  if (quoteTarget <= 0n) return 0n;
  const raised = quoteRaised > 0n ? quoteRaised : 0n;

  // 0.4 as a fraction rather than a decimal: these are wei, and 0.4 is not representable.
  const quoteStart = (quoteTarget * 2n) / 5n;
  if (quoteStart === 0n) return 0n;

  const quote = quoteStart + raised;
  const k = BASE_VIRTUAL_CEILING * quoteStart;
  return (quote * quote * WAD) / k;
}

/**
 * A graduated market's spot price, from the `sqrtPriceX96` its pool reported.
 *
 * Used instead of the curve formula because a graduated curve's `quoteRaised` never moves again —
 * deriving from it would freeze the price at the moment of graduation while the pool beside it
 * keeps trading, and a frozen figure looks exactly like a live one.
 *
 * `sqrtPriceX96` means the same thing on v4 as it did on V3 — sqrt(token1/token0) in Q64.96 — so
 * this function did not change with the migration. What changed is how its second argument is
 * decided: see `marketTokenIsCurrency0`.
 *
 * @param sqrtPriceX96 from the pool's swap event
 * @param marketTokenIsToken0 which side of the pair holds the market's token. On every DOKU pool
 *        this is `false` — `currency0` is native MON — but it is passed rather than assumed, and
 *        getting it backwards yields the reciprocal: a price wrong by orders of magnitude that
 *        still renders as an ordinary number.
 * @param scale the fixed-point scale the caller stores prices at: `PRICE_SCALE` for generation 1,
 *        `PRICE_SCALE * GEN2_PRICE_SCALE_UP` for generation 2. It is an ARGUMENT rather than a
 *        factor the caller multiplies the result by, and that distinction is the whole reason it
 *        exists — see below.
 */
export function poolSpotPrice(
  sqrtPriceX96: bigint,
  marketTokenIsToken0: boolean,
  scale: bigint = PRICE_SCALE,
): bigint {
  if (sqrtPriceX96 <= 0n) return 0n;
  const ratioX192 = sqrtPriceX96 * sqrtPriceX96;
  if (ratioX192 === 0n) return 0n;

  /**
   * token1-per-token0, scaled. Multiplied by `scale` BEFORE dividing, because a token worth a
   * fraction of a whole quote unit has a ratio far below 1 and integer division would reach zero
   * first.
   *
   * The scale has to come in here rather than be applied to the result, and a six-decimal quote is
   * where the difference stops being academic. Generation 2 stores `quote * 1e36 / base`, and this
   * used to return the 1e18 figure which the caller then multiplied by 1e18. On a gold market —
   * six decimals, one token a troy ounce — the 1e18 figure for a token worth ~0.02 raw units of
   * gold per whole token is 0.0236, which truncates to **zero**; multiplying afterwards multiplies
   * zero. Every gold market's price, candles and market cap fell to nothing the moment it
   * graduated, and nothing threw. Measured on a Monad mainnet fork; see `test/gen2-fork.test.ts`.
   */
  return marketTokenIsToken0
    ? (ratioX192 * scale) / Q192
    : (Q192 * scale) / ratioX192;
}
