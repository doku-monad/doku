/**
 * One entry in the hero's "Best runners" showcase.
 *
 * Flattened on the server rather than passed as a `MarketModel`, and deliberately so. Everything
 * here is a plain number, a string, or `null` — no `bigint`, no `Date` — because this crosses the
 * server/client boundary and React's serializer rejects a `bigint` outright and re-hydrates a
 * `Date` as a string anyway. Converting at the edge also means the arithmetic (base units to MON,
 * closes to a percentage) happens once, on the server, instead of in four sibling components that
 * can each round it differently.
 */
export interface HotMover {
  /** The curve — the market's key everywhere data is keyed. */
  address: string;
  /** The token — what the market's PAGE is keyed by. See `lib/market-path`. */
  tokenAddress: string;
  /** The coin's display name. */
  name: string;
  /** Ticker without the `$`. */
  ticker: string;
  /** A logo URL, or `null` — the row falls back to a monogram built from the ticker. */
  logo: string | null;
  /**
   * Market cap in whole units of THIS MARKET'S OWN quote asset. The headline figure on the card.
   *
   * Not MON, which is what it was and what the figure was scaled as — a hard-coded 1e18 against a
   * board that now holds markets quoted in six-decimal gold and eight-decimal bitcoin. It comes off
   * `marketCapQuote`, which the service has already normalised, divided by the quote's own
   * decimals. **Rows are not addable**: four caps in four currencies do not sum to anything.
   */
  marketCap: number;
  /** The service's dollar figure, or `null` where the quote has no price. See `lib/market-cap`. */
  marketCapUsd: number | null;
  /** The quote's symbol as the chain reports it — the unit `marketCap` is shown in without a price. */
  quoteSymbol: string | null;
  /**
   * When this market last traded, as epoch milliseconds.
   *
   * A number rather than a `Date` because it is rendered as a relative age ("4m ago") that has to
   * keep counting on the client — and a `Date` sent through an RSC payload arrives as a string, so
   * every consumer would have to re-parse it. `null` when the market has no swaps the indexer knows
   * about, which is rendered as "—" rather than as a fabricated timestamp.
   */
  lastSwapAt: number | null;
  /**
   * Change across the window, as a percentage, **computed by the service**.
   *
   * `SlimMarketRow.changeWindow`, not a figure derived from the candle series beside it. Two
   * components computing a change from two resamplings of the same data is how the hero and the
   * card come to disagree about whether a market is up.
   *
   * `null` when the service reported none — a market that has traded once has no change to report,
   * and rendering `0.0%` there states something the data does not say.
   */
  changePct: number | null;
  /**
   * Closing prices across the window, oldest first.
   *
   * Raw prices, not normalised: the sparkline scales them to its own box, and pre-normalising here
   * would throw away the only thing that tells the component whether the series is flat.
   */
  spark: number[];
  /**
   * Rolling volume over the window, in whole units of this market's own quote asset.
   *
   * Not on the card; it is what the list is ranked by, and the service does the ranking. Carried so
   * a row that made the list can be shown to have earned its place.
   */
  volume24h: number;
  /**
   * The same rolling volume in dollars, when the quote asset is priced; `null` when it is not, and
   * the board then shows the quote figure with its symbol instead. This is the board's "24h" column:
   * the list is ranked by it, so it is what the reader is owed in the last column.
   */
  volume24hUsd: number | null;
}

/**
 * One ticket on the hero's coin tape: the coin's picture, its market cap and the day's change.
 *
 * Nothing else, deliberately. The tape carried a rank, the pair, the ticker, the name, the change
 * and a bonding meter, and at forty pixels a second that is a table nobody can read. What survives
 * is what a glance can take in: whose picture, how big, which way.
 */
export interface RailItem {
  /** The curve — the market's key everywhere data is keyed. */
  address: string;
  /** The token — what the market's PAGE is keyed by. See `lib/market-path`. */
  tokenAddress: string;
  /** Ticker without the `$`. Not drawn — it names the ticket to a screen reader and a tooltip. */
  ticker: string;
  /** The coin's display name. Not drawn, for the same reason. */
  name: string;
  /** A logo URL, or `null` — the ticket falls back to a monogram built from the ticker. */
  logo: string | null;
  /** The quote's symbol as the chain reports it: the unit of `marketCap` where there is no price. */
  quoteSymbol: string | null;
  /** Market cap in whole units of this market's own quote asset — see `HotMover.marketCap`. */
  marketCap: number;
  /** The service's dollar figure, or `null` where the quote has no price. See `lib/market-cap`. */
  marketCapUsd: number | null;
  /** The day's change as a percentage, from the service. `null` where there is nothing to compare. */
  changePct: number | null;
}
