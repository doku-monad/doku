import { formatUnits } from "viem";

/**
 * Price impact on the curve, measured on the leg that actually reaches it.
 *
 * ## The figure this replaces charged the trader twice in the telling
 *
 * The panel used to divide the whole amount typed by the tokens received and compare that to spot.
 * On a market minutes old that reports a catastrophe on a trade that moved nothing: a one MON buy
 * against a 305,900 MON curve read **+99.35%**, because the anti-sniper launch tax starts at 50%
 * and only about half of that MON is ever spent on the buyer's own tokens. The tax and the fee are
 * already printed as their own rows on the same receipt — folding them into "price impact" bills
 * them a second time, in the one number a trader reads to decide whether their size is sensible.
 * The same shape, quieter, sat on the sell side: `quoteSell` takes its levies off the top, so every
 * sell reported at least the fee as impact and a dust-sized one read −1.00%.
 *
 * Price impact is the CURVE's answer to this trade and nothing else: how far the constant-product
 * price moved. A deduction that never touched the reserves cannot move them, and one that did —
 * see the anti-sniper tax below — bought somebody else's tokens.
 *
 * ## What reaches the curve, on a buy
 *
 * `BondingCurve._levy` splits a gross into a held share and a curve share, then splits the curve
 * share again:
 *
 *     curveAmount = gross − protocol − creatorTax − (BURN market ? 0 : routed)
 *     burnSpend   = antiSniper + (BURN market ? routed : 0)
 *     quoteIn     = curveAmount − burnSpend        ← the buyer's own leg
 *
 * `quoteIn` is the only part `_simulate` spends on the tokens `quoteBuy` returns. `burnSpend` runs
 * through the curve too, FIRST and at the pre-trade price, but it buys tokens that are burned — so
 * pairing it with `baseOut` divides one trade's quote by a different trade's tokens.
 *
 * `quoteBuy` does not return `quoteIn`, and this file does not re-derive the split — it subtracts
 * the four figures the contract does return. That is exact on both sinks, because `fee` is
 * `protocol + routed` by construction and the routed share is either held (subtracted once, as
 * part of `fee`) or spent on the burn (subtracted once, inside `antiSniperTax`'s companion term —
 * see the identity in `buyQuoteOnCurve`). Re-implementing `_levy` here instead would be a copy of
 * contract arithmetic that starts correct and drifts.
 *
 * ## And on a sell
 *
 * `quoteSell` returns the proceeds already net of both levies, so the curve's own movement is the
 * gross — the net plus what was taken off it.
 */

/** The deductions `quoteBuy` reports alongside `baseOut`. */
export interface BuyLevies {
  /** The 1% protocol fee: `protocol + routed`. */
  fee: bigint;
  /** The decaying launch tax. Zero once the window closes. */
  antiSniperTax: bigint;
  /** The launcher's own charge, zero to ten percent. */
  creatorTax: bigint;
  /** What the curve hands back when the buy overshoots the raise. */
  refund: bigint;
}

/** What `quoteSell` reports. `quoteOut` is already net of both. */
export interface SellProceeds {
  quoteOut: bigint;
  fee: bigint;
  creatorTax: bigint;
}

/**
 * The buyer's own leg of a buy, in raw quote units.
 *
 * Equal to `Levy.quoteIn` to the wei on every sink, which is worth stating because the two
 * expressions look nothing alike:
 *
 *     non-BURN: curveAmount = gross − protocol − creatorTax − routed = gross − fee − creatorTax
 *               quoteIn     = curveAmount − antiSniper
 *     BURN:     curveAmount = gross − protocol − creatorTax
 *               quoteIn     = curveAmount − antiSniper − routed      = gross − fee − creatorTax − antiSniper
 *
 * Both land on `gross − fee − creatorTax − antiSniper`. The refund comes off as well: on a buy
 * that fills the market the curve takes only what it still needed, and counting money handed back
 * as money spent would report the largest impact in a market's life on the trade that ends it.
 * `_levy` recomputes forward from the smaller gross and pushes both the unspent remainder and the
 * rounding dust into `refund`, so subtracting it here matches whichever branch ran.
 *
 * Negative is unrepresentable on a real quote — the levies are shares of the same gross — so a
 * negative result means the caller paired a quote with an amount from a different trade, and zero
 * is returned rather than a price impact computed from nonsense.
 */
export function buyQuoteOnCurve(quoteIn: bigint, levies: BuyLevies): bigint {
  const onCurve =
    quoteIn - levies.fee - levies.creatorTax - levies.antiSniperTax - levies.refund;
  return onCurve > 0n ? onCurve : 0n;
}

/**
 * What a sell actually took out of the curve, in raw quote units.
 *
 * `quoteSell` computes the gross from the reserves and then subtracts the fee and the creator tax
 * from it, so the movement the seller caused is the sum of the three. Using the net instead is
 * what made a sell of ten thousand tokens against a 305,900 MON curve — a millionth of the raise —
 * report −1.00%, which is the fee wearing the impact row's label.
 */
export function sellQuoteOnCurve(proceeds: SellProceeds): bigint {
  return proceeds.quoteOut + proceeds.fee + proceeds.creatorTax;
}

/** One leg of a trade on the curve, both sides in their OWN asset's raw units. */
export interface CurveLeg {
  /** Quote that reached the reserves — `buyQuoteOnCurve` or `sellQuoteOnCurve`. */
  quoteOnCurve: bigint;
  /** The tokens that leg bought or sold. */
  baseOnCurve: bigint;
  /** The QUOTE ASSET's decimals: 6 for USDC and gold, 8 for cbBTC, 18 for MON. */
  quoteDecimals: number;
  /** The token's. Eighteen on every launched market, and named so it cannot be assumed. */
  baseDecimals: number;
  /** Whole quote units per whole token, before the trade. */
  spotPrice: number;
}

/**
 * How far the trade moved the curve, as a signed percentage of spot.
 *
 * Positive on a buy and negative on a sell, which is the direction each pushes the price. Each
 * side is divided by its OWN asset's decimals before they meet: the two happen to cancel on a MON
 * market and are wrong by 1e12 on a six-decimal one, which renders as a perfectly ordinary number.
 *
 * `null` is a real answer and the caller renders it as an absent row rather than a zero — an
 * unpriced market, an unquoted trade and a trade with no impact are three different things, and
 * printing 0.00% for the first two claims a measurement nobody made.
 */
export function curvePriceImpactPct(leg: CurveLeg): number | null {
  if (leg.quoteOnCurve <= 0n || leg.baseOnCurve <= 0n) return null;
  if (!Number.isFinite(leg.spotPrice) || leg.spotPrice <= 0) return null;
  const quote = Number(formatUnits(leg.quoteOnCurve, leg.quoteDecimals));
  const base = Number(formatUnits(leg.baseOnCurve, leg.baseDecimals));
  if (!Number.isFinite(quote) || !Number.isFinite(base) || base === 0) return null;
  return (quote / base / leg.spotPrice - 1) * 100;
}
