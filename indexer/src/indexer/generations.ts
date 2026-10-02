/**
 * What differs between the two generations of DOKU contracts, in one place.
 *
 * Gen 1 is the live emoji launchpad (factory `0xEE1c4D64…`, two hooks, two graduations). Gen 2 is
 * the pairs launchpad from the shared interface: same source files modified in place, deployed
 * fresh. Both are followed by one process, and the ONLY way to tell which one a log belongs to is
 * the address that emitted it — the market's factory, the market's curve, the graduator, the hook.
 */
export type Generation = 1 | 2;

/** `Sinks.sol` kinds, shared by both generations; CREATOR is new in gen 2. */
export const SINK_BURN = 0;
export const SINK_REWARDS = 1;
export const SINK_CREATOR = 2;

/** The UI's words for the same three values (`FeeRouting.tsx`). */
export type RoutingName = "buyback" | "holders" | "creator";

export function routingName(sink: number | null | undefined): RoutingName | null {
  switch (sink) {
    case SINK_BURN:
      return "buyback";
    case SINK_REWARDS:
      return "holders";
    case SINK_CREATOR:
      return "creator";
    default:
      return null;
  }
}

export function routingSink(name: string): number | null {
  switch (name) {
    case "buyback":
      return SINK_BURN;
    case "holders":
      return SINK_REWARDS;
    case "creator":
      return SINK_CREATOR;
    default:
      return null;
  }
}

/** Gen-2 curve constants (`BondingCurve.sol`, `DokuToken.sol`). */
export const GEN2_TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;
export const GEN2_CURVE_SUPPLY = 777_777_778n * 10n ** 18n;
export const GEN2_BASE_VIRTUAL_CEILING = 1_088_888_889_200_000_000_000_000_000n;
export const GEN2_PROTOCOL_BPS = 30n;
export const GEN2_ROUTED_BPS = 70n;
export const GEN2_FEE_BPS = 100n;

/** v4 spells native MON this way inside a PoolKey and the registry spells it the same way. */
export const NATIVE_QUOTE = "0x0000000000000000000000000000000000000000";

/**
 * The divisor that turns `price × supply` into a quote amount, chosen by the market's generation.
 *
 * A stored price is quote units per base unit, scaled — and the two generations do not use the same
 * scale. Generation 1's curve returns `quote_wei * 1e18 / base_wei`. Generation 2's returns
 * `quote * 1e36 / base` (`BondingCurve._price`): the same quantity scaled a further 1e18, chosen so
 * a six-decimal quote against a 1e27 reserve does not truncate to a couple of raw units. Supply is
 * in base units, so the product carries the price's scale and that is what has to come back out.
 *
 * Dividing every generation by 1e18 made every generation-2 market cap a quintillion times too
 * large — nothing crashed, no consistency check noticed, and the number still looked like a number.
 * It lives here, once, because the same CASE is needed by the API's `CAP_COLUMNS` and by the
 * `market_stats` rollup, and two copies of a 1e18-versus-1e36 decision is how it comes back.
 *
 * @param alias the `markets` alias in the query being built.
 */
export function priceScaleSql(alias: string): string {
  return `(CASE WHEN ${alias}.generation = 2 THEN 1e36 ELSE 1e18 END)`;
}

/**
 * The factor between the two generations' price scales: 1e18 against 1e36.
 *
 * Only one price on the service is derived rather than emitted: `poolSpotPrice` reads a
 * `sqrtPriceX96`, which is a ratio of raw amounts and carries no generation with it. Left at 1e18
 * on a graduated generation-2 market it would sit in the same column, the same candles and the
 * same all-time-high as that market's curve prices at 1e36 — a scale that changes at graduation,
 * which nothing downstream could detect and no cap could be right on both sides of.
 *
 * It is HANDED TO `poolSpotPrice` as part of its `scale`, never multiplied onto what it returns.
 * That function divides, so a factor applied afterwards is applied to an already-truncated number,
 * and on a quote as coarse as six-decimal gold the 1e18 figure is below 1 and truncates to zero.
 */
export const GEN2_PRICE_SCALE_UP = 10n ** 18n;

/**
 * The price a generation-2 curve opens at, before anybody has traded it.
 *
 * `BondingCurve.initialize` sets the virtual reserves to `(BASE_VIRTUAL_CEILING, quoteTarget * 2/5)`
 * and the stored price is `quote * 1e36 / base`, so the opening price follows from the target alone
 * — no chain read, no first trade.
 *
 * Recorded at launch because the alternative is a zero, and a zero does not read as "not traded
 * yet". It reads as worthless: the board prints a $0.00 market cap beside a real coin. Every market
 * launched without a first buy looked like that, which on a pairs launchpad is most of them — a
 * creator quoting in gold or in USDC rarely holds the quote asset at the moment they launch.
 *
 * The integer division truncates, as the contract's does; the same expression on both sides is
 * what makes the recorded opening price equal to the first price the curve will quote.
 */
export function gen2OpeningPrice(quoteTarget: bigint): bigint {
  const quoteFloor = (quoteTarget * 2n) / 5n;
  return (quoteFloor * 10n ** 36n) / GEN2_BASE_VIRTUAL_CEILING;
}
