/**
 * @jest-environment node
 */
import { deriveLiveState } from "../../src/lib/hooks/doku/use-market-live";
import { type MarketModel, type SwapModel, toMarketModel } from "../../src/lib/models";
/*
 * The market is built from a whole row rather than hand-written as a partial model.
 *
 * A literal here has to be kept in step with `MarketModel` by hand, and it was not: the model grew
 * a generation, a quote asset, a normalised price and a 24-hour change, and this fixture kept
 * compiling because the suite was outside `tsconfig`. Going through `toMarketModel` means the
 * fixture is whatever the mapper produces, which is the thing under test everywhere else.
 */
import { marketRow } from "../fixtures/market-row";

const market: MarketModel = toMarketModel(
  marketRow({
    quote_raised: (100n * 10n ** 18n).toString(),
    quote_target: (1_000n * 10n ** 18n).toString(),
    last_price: "1",
    volume_quote: "0",
    volume_24h: "0",
    trade_count: 1,
    holders: 1,
    total_supply: (45_000_000n * 10n ** 18n).toString(),
    market_cap: "0",
    ath_market_cap: "0",
  })
);

const swap = (quoteRaised: bigint, price: bigint): SwapModel => ({
  id: "1",
  market: { marketAddress: "0xcurve" },
  swap: {
    trader: "0xa",
    isSell: false,
    // A graduated market keeps trading, on the pool, and the feed says which venue filled each
    // trade — the fee and tax columns mean different things on the two.
    venue: "curve" as const,
    quoteVolume: 1n,
    baseVolume: 1n,
    price,
    /* The same price with the generation scale taken off. Null is what a feed that could not
       resolve its market's generation carries, and the live-state derivation must survive it. */
    priceQuote: price,
    fee: 0n,
    tax: 0n,
    quoteRaised,
  },
  block: { number: 1n, txHash: "0xtx", time: new Date() },
});

describe("live curve state", () => {
  it("keeps the server's state when no trade has arrived", () => {
    expect(deriveLiveState(market, [])).toBe(market);
  });

  /// The point of the exercise: the trade feed already carries the curve total, so the progress
  /// bar can move without a second request.
  it("advances progress from the newest trade", () => {
    const live = deriveLiveState(market, [swap(500n * 10n ** 18n, 7n)]);
    expect(live.state.quoteRaised).toBe(500n * 10n ** 18n);
    expect(live.state.progress).toBeCloseTo(0.5, 10);
    expect(live.state.lastPrice).toBe(7n);
  });

  /// A buy can overshoot the target within a single trade; the curve refunds the excess, but the
  /// event still reports the total. A progress bar past 100% renders as an overflowing bar.
  it("clamps progress at one when a trade fills the curve", () => {
    const live = deriveLiveState(market, [swap(2_000n * 10n ** 18n, 1n)]);
    expect(live.state.progress).toBe(1);
  });

  it("does not divide by a zero target", () => {
    const broken = { ...market, state: { ...market.state, quoteTarget: 0n } };
    expect(deriveLiveState(broken, [swap(5n, 1n)]).state.progress).toBe(0);
  });

  /// Derivation must not mutate the object React is rendering from.
  it("returns a new object rather than editing the server's", () => {
    const live = deriveLiveState(market, [swap(500n * 10n ** 18n, 7n)]);
    expect(live).not.toBe(market);
    expect(market.state.quoteRaised).toBe(100n * 10n ** 18n);
  });
});
