/*
 * The row fixture is shared rather than declared here.
 *
 * It used to be a partial literal in this file and another in `market-list-resilience`, both
 * missing the twenty columns the service has grown since — invisibly, because both were cast and
 * the suite was excluded from `tsconfig`. `tests/fixtures/market-row` is typed `MarketRow`, so the
 * next column is a compile error in one place instead of an `undefined` reaching a `BigInt()`.
 */
import type { SwapRow } from "../../src/lib/api/types";
import {
  toCandlestickModel,
  toHolderModel,
  toMarketModel,
  toSwapModel,
} from "../../src/lib/models";
import { MARKET_ROW as marketRow } from "../fixtures/market-row";

const swapRow: SwapRow = {
  id: "42",
  market_address: "0xcurve",
  trader: "0xTrader",
  is_buy: true,
  venue: "curve" as const,
  quote_amount: "4966830000000000000",
  base_amount: "44401037165082108902333622",
  fee: "100000000000000000",
  tax: "4933170000000000000",
  quote_raised: "4966830000000000000",
  price: "111857553000000000",
  block_number: "14",
  block_hash: "0xblock",
  log_index: 0,
  tx_hash: "0xtx",
  ts: "2026-08-18T00:01:00.000Z",
};

describe("market model", () => {
  /**
   * The timestamp bump order sorts on.
   *
   * It is derived on read by the indexer, so it is a real column that can simply be absent from an
   * older response — and a market that has never traded genuinely has none. Both have to come back
   * as `null` rather than an Invalid Date, because `getTime()` on one of those is `NaN` and a `NaN`
   * in a comparator silently scrambles the whole grid instead of failing.
   */
  it("reads when the market last traded, and tolerates never", () => {
    const traded = toMarketModel({
      ...marketRow,
      last_swap_at: "2026-08-29T09:10:55.000Z",
    } as never);
    expect(traded.state.lastSwapAt).toEqual(new Date("2026-08-29T09:10:55.000Z"));

    expect(
      toMarketModel({ ...marketRow, last_swap_at: null } as never).state.lastSwapAt
    ).toBeNull();

    const { last_swap_at: _omitted, ...withoutField } = { ...marketRow, last_swap_at: null };
    expect(toMarketModel(withoutField as never).state.lastSwapAt).toBeNull();
  });

  it("is identified by its address", () => {
    const m = toMarketModel(marketRow);
    expect(m.market.marketAddress).toBe("0xcurve");
    expect(m.market.tokenAddress).toBe("0xtoken");
  });

  /**
   * Amounts must be `bigint` end to end.
   *
   * `quote_target` here is 1,000 MON, which is 1e21 in base units — three orders of magnitude past
   * what a float64 represents exactly. Parsed as a number it comes back subtly wrong, and every
   * progress bar and price derived from it inherits the error without anything failing.
   */
  it("keeps amounts as bigint past the float64 exact range", () => {
    const m = toMarketModel(marketRow);
    expect(m.state.quoteTarget).toBe(1_000_000_000_000_000_000_000n);
    expect(m.state.quoteTarget > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(m.state.quoteRaised).toBe(500_000_000_000_000_000_000n);
  });

  /// A rolling window, distinct from all-time volume. Conflating them makes a market that traded
  /// once a year ago look as busy as one trading now.
  it("keeps 24h volume separate from all-time volume", () => {
    const m = toMarketModel(marketRow);
    expect(m.state.volume24h).toBe(42_000_000_000_000_000_000n);
    expect(m.state.volumeQuote).toBe(900_000_000_000_000_000_000n);
  });

  /// An indexer that predates the field must not crash the page; zero is the honest reading.
  it("treats a missing 24h volume as zero", () => {
    const { volume_24h: _omitted, ...withoutField } = marketRow;
    expect(toMarketModel(withoutField as never).state.volume24h).toBe(0n);
  });

  /// Market cap and the peak it is measured against — the two figures a launchpad card leads with.
  it("carries market cap and its all-time high", () => {
    const m = toMarketModel(marketRow);
    expect(m.state.marketCap).toBe(5_000_000_000_000_000_000_000n);
    expect(m.state.athMarketCap).toBe(10_000_000_000_000_000_000_000n);
  });

  /// The market page recomputes the cap from a live price, so it needs the supply itself — and
  /// without this it read "—" wherever no chain was reachable to ask.
  it("carries the token supply the cap was computed from", () => {
    expect(toMarketModel(marketRow).state.totalSupply).toBe(45_000_000_000_000_000_000_000_000n);
  });

  /// Computed once, so the card and the hero cannot disagree about the same market.
  it("reports how far the cap sits below its peak", () => {
    expect(toMarketModel(marketRow).state.athProgress).toBeCloseTo(0.5, 10);
  });

  it("reads a market at its own high as one", () => {
    const atPeak = { ...marketRow, market_cap: marketRow.ath_market_cap };
    expect(toMarketModel(atPeak).state.athProgress).toBe(1);
  });

  /// A market with no trades has no peak. Dividing by it would render as NaN or, worse, as 100%.
  it("reports no progress toward a peak that does not exist", () => {
    const untraded = { ...marketRow, market_cap: "0", ath_market_cap: "0" };
    expect(toMarketModel(untraded).state.athProgress).toBe(0);
  });

  it("reports curve progress as a fraction of the target", () => {
    expect(toMarketModel(marketRow).state.progress).toBeCloseTo(0.5, 10);
  });

  /// A market whose target is zero is a misconfiguration, not a market that is 100% complete. The
  /// difference matters because the second renders as "ready to graduate".
  it("reports zero progress rather than dividing by zero", () => {
    const m = toMarketModel({ ...marketRow, quote_target: "0" });
    expect(m.state.progress).toBe(0);
  });

  it("carries the pool address only once it has graduated", () => {
    expect(toMarketModel(marketRow).state.poolAddress).toBeNull();
    expect(
      toMarketModel({ ...marketRow, pool_address: "0xpool", ready_to_graduate: true }).state
        .poolAddress
    ).toBe("0xpool");
  });

  it("parses the launch time as a date", () => {
    expect(toMarketModel(marketRow).market.launchedAt.toISOString()).toBe(
      "2026-08-18T00:00:00.000Z"
    );
  });
});

describe("swap model", () => {
  it("maps a buy to a non-sell", () => {
    expect(toSwapModel(swapRow, 1).swap.isSell).toBe(false);
    expect(toSwapModel({ ...swapRow, is_buy: false }, 1).swap.isSell).toBe(true);
  });

  it("keeps the token amount exact", () => {
    expect(toSwapModel(swapRow, 1).swap.baseVolume).toBe(44_401_037_165_082_108_902_333_622n);
  });

  /// The tax is the anti-sniper mechanism and the thing a trader most wants explained. Dropping it
  /// from the model is how a UI ends up unable to say why a buy filled short.
  it("carries the fee and the tax separately", () => {
    const s = toSwapModel(swapRow, 1);
    expect(s.swap.fee).toBe(100_000_000_000_000_000n);
    expect(s.swap.tax).toBe(4_933_170_000_000_000_000n);
  });

  it("lowercases the trader address so it compares against a connected wallet", () => {
    expect(toSwapModel(swapRow, 1).swap.trader).toBe("0xtrader");
  });

  /// The post-trade curve total. Present so a live view can update progress from the trade feed
  /// it is already polling, instead of asking the indexer where the curve stands.
  /// Fee and tax mean different things per venue, so a row that does not say which is a row whose
  /// zero-fee column cannot be interpreted.
  it("carries the venue that filled the trade", () => {
    expect(toSwapModel(swapRow, 1).swap.venue).toBe("curve");
    expect(toSwapModel({ ...swapRow, venue: "pool" }, 1).swap.venue).toBe("pool");
  });

  /// An indexer predating the column recorded only curve trades, which is what it means.
  it("treats a missing venue as the curve", () => {
    const { venue: _omitted, ...older } = swapRow;
    expect(toSwapModel(older as never, 1).swap.venue).toBe("curve");
  });

  it("carries the curve total after the trade", () => {
    expect(toSwapModel(swapRow, 1).swap.quoteRaised).toBe(4_966_830_000_000_000_000n);
  });

  it("orders by block and id rather than by an invented nonce", () => {
    const s = toSwapModel(swapRow, 1);
    expect(s.block.number).toBe(14n);
    expect(s.id).toBe("42");
  });
});

describe("candlestick model", () => {
  // Prices are stored as 18-decimal fixed point, the same scaling the indexer computes them at.
  // 0.111857553 MON per token is what a market a few trades into its curve actually looks like.
  const row = {
    market_address: "0xcurve",
    period_secs: 3600,
    bucket_start: "2026-08-18T00:00:00.000Z",
    open: "111857553000000000",
    high: "223715106000000000",
    low: "111857553000000000",
    close: "200000000000000000",
    volume_quote: "4966830000000000000",
    trade_count: 4,
  };

  /**
   * The scaling, which is the part that goes wrong silently.
   *
   * The column holds 18-decimal fixed point. Handed to a chart unscaled, every price reads as
   * roughly 1e17 — and a chart with no absolute reference still draws a perfectly plausible line,
   * because the shape is identical. Only the axis labels are wrong, and only by eighteen orders
   * of magnitude.
   */
  it("converts fixed-point prices to real numbers", () => {
    const c = toCandlestickModel(row, 1, 18);
    expect(c.open).toBeCloseTo(0.111857553, 12);
    expect(c.high).toBeCloseTo(0.223715106, 12);
    expect(c.close).toBeCloseTo(0.2, 12);
  });

  /**
   * The same candle, read at the wrong generation.
   *
   * A candlestick row carries four prices and no generation, so the scale has to be supplied — and
   * supplying the wrong one is invisible on a chart, because the SHAPE is identical. Only the axis
   * moves, and only by eighteen orders of magnitude.
   */
  it("reads a generation-2 candle at 1e36, not 1e18", () => {
    const gen2 = toCandlestickModel(row, 2, 18);
    const gen1 = toCandlestickModel(row, 1, 18);

    // The same stored figure, a factor of 1e18 apart. Neither is zero: the conversion keeps the
    // fraction rather than truncating to a whole raw unit first.
    expect(gen2.open!).toBeCloseTo(0.111857553e-18, 30);
    expect(gen1.open!).toBeCloseTo(0.111857553, 12);
    expect(gen1.open! / gen2.open!).toBeCloseTo(1e18, -6);
  });

  /**
   * Six-decimal gold, not eighteen-decimal MON.
   *
   * The decimals are the QUOTE ASSET's and are a separate question from the generation. A single
   * global 18 is wrong for every six- and eight-decimal asset in the registry.
   */
  it("scales by the quote asset's own decimals", () => {
    const gold = toCandlestickModel({ ...row, open: "100000000000000000000" }, 2, 6);
    expect(gold.open).toBeCloseTo(0.0001, 12);
  });

  /// A caller that cannot say which generation gets nothing, rather than a plausible wrong number.
  it("returns null rather than guessing when the generation is unknown", () => {
    const unknown = toCandlestickModel(row, null, 18);
    expect(unknown.open).toBeNull();
    expect(unknown.close).toBeNull();
    // The volume is not a price and is unaffected — it was never generation-scaled.
    expect(unknown.volumeQuote).toBe(4_966_830_000_000_000_000n);
  });

  /// Charts take numbers, not bigints — but only prices convert. Volume stays exact.
  it("keeps volume exact while prices become numbers", () => {
    const c = toCandlestickModel(row, 1, 18);
    expect(c.volumeQuote).toBe(4_966_830_000_000_000_000n);
    expect(c.periodSecs).toBe(3600);
  });

  it("places the bucket at its start time", () => {
    expect(toCandlestickModel(row, 1, 18).bucketStart.toISOString()).toBe(
      "2026-08-18T00:00:00.000Z"
    );
  });
});

describe("holder model", () => {
  it("keeps the balance exact", () => {
    expect(
      toHolderModel({
        holder: "0xAbc",
        balance: "10000000000000000000000000",
        share: "0.041000",
        label: null,
      })
    ).toEqual({
      holder: "0xabc",
      balance: 10_000_000_000_000_000_000_000_000n,
      // From the endpoint. Recomputing it in the browser gives a different answer, because the
      // browser does not know which addresses are excluded from circulating supply.
      share: 0.041,
      label: null,
    });
  });
});

/**
 * The USD market cap the service sends is DOLLARS, in whole units.
 *
 * `market_stats.market_cap_usd` is `(cap_quote / 10^quote_decimals) * usd_price` — a
 * `NUMERIC(38,8)` that arrives as "2876.86443017". Reading it as an 18-decimal integer threw
 * `Cannot convert 2876.86443017 to a BigInt` inside the row parser, and the parser catches and
 * SKIPS such a row: `/api/markets` answered `{items: []}` with a cursor pointing at a real market,
 * and the command palette found nothing.
 *
 * It stayed hidden because the column is null until a price source is configured, and the null
 * branch returns early. Configuring one turned every market on the board unparseable at once.
 */
describe("a market's USD cap", () => {
  const withUsd = (v: string | null) => toMarketModel({ ...marketRow, market_cap_usd: v });

  it("is read as dollars, not as an 18-decimal integer", () => {
    expect(withUsd("2876.86443017").state.marketCapUsd).toBeCloseTo(2876.86443017, 8);
  });

  it("does not throw on the decimal string the service actually sends", () => {
    expect(() => withUsd("2876.86443017")).not.toThrow();
    expect(() => withUsd("0.00000000")).not.toThrow();
  });

  it("reads an exact zero as zero rather than as absent", () => {
    expect(withUsd("0.00000000").state.marketCapUsd).toBe(0);
  });

  it("stays null when the service has no price for the quote asset", () => {
    expect(withUsd(null).state.marketCapUsd).toBeNull();
  });

  it("keeps a cap far above what a 1e18 divisor would leave", () => {
    // The old path would have produced 2.9e-15 had it parsed at all. Anything under a cent from a
    // ~$2,876 cap is that bug returning.
    expect(withUsd("2876.86443017").state.marketCapUsd!).toBeGreaterThan(1);
  });
});
