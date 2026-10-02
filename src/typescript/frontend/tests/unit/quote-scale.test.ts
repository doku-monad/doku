/**
 * @jest-environment node
 */
import {
  priceScaleFor,
  quotePerWholeToken,
  quotePerWholeTokenNumber,
  UNKNOWN_GENERATION,
} from "../../src/lib/chain/quote-scale";

/**
 * The scale a stored price carries, and the four defects that came from assuming it.
 *
 * Generation 1's curve returns `quote_wei * 1e18 / base_wei`. Generation 2's returns
 * `quote * 1e36 / base`. Base is 18 decimals in both, so the first is quote RAW units per WHOLE
 * token and the second is the same figure multiplied by a further 1e18.
 *
 * The indexer divides that scale out for the CAPS and leaves it on the PRICES, and `generation` is
 * carried on exactly two of the seven shapes that hold a price. Four separate defects of this
 * shape were found and fixed on the service — a market cap wrong by a quintillion in three places,
 * and a price that fell by the same factor at graduation. This is the client's one place to get it
 * right.
 */
describe("the generation price scale", () => {
  it("knows both scales, and treats anything but 2 as generation 1", () => {
    expect(priceScaleFor(1)).toBe(10n ** 18n);
    expect(priceScaleFor(2)).toBe(10n ** 36n);
  });

  /**
   * A generation-1 MON market. 0.111857553 MON per whole token, which is what a market a few
   * trades into its curve actually looks like — and MON is 18 decimals, so the raw figure IS the
   * stored one.
   */
  it("leaves a generation-1 price alone", () => {
    expect(quotePerWholeToken("111857553000000000", 1)).toBe(111_857_553_000_000_000n);
    expect(quotePerWholeTokenNumber("111857553000000000", 1, 18)).toBeCloseTo(0.111857553, 12);
  });

  /**
   * A generation-2 gold market: six decimals, one token a troy ounce.
   *
   * A whole token worth 0.0001 XAUt0 is 100 raw units. Stored, that is
   * `100 * 1e36 / 1e18 = 1e20`. Divided by 1e18 — the generation-1 assumption — it reads as 100
   * WHOLE ounces per token instead of one ten-thousandth of one: wrong by a factor of a
   * quintillion, and still a perfectly ordinary-looking number on a chart.
   */
  it("takes the extra 1e18 off a generation-2 price", () => {
    expect(quotePerWholeToken(10n ** 20n, 2)).toBe(100n);
    expect(quotePerWholeTokenNumber(10n ** 20n, 2, 6)).toBeCloseTo(0.0001, 12);

    // The bug this exists to prevent, stated as an inequality rather than trusted to a comment.
    expect(quotePerWholeToken(10n ** 20n, 1)).not.toBe(quotePerWholeToken(10n ** 20n, 2));
  });

  /**
   * The same coin, priced in six-decimal USDC and in eighteen-decimal MON.
   *
   * The scale is the generation's; the DECIMALS are the quote asset's, and the two are independent.
   * A single global `TOKEN_DECIMALS = 18` gets the second one wrong for every six- and
   * eight-decimal quote in the registry.
   */
  it("scales by the quote's own decimals, not by a global 18", () => {
    // 2.5 USDC per whole token: 2_500_000 raw units, stored at generation 2.
    const usdc = 2_500_000n * 10n ** 18n;
    expect(quotePerWholeTokenNumber(usdc, 2, 6)).toBeCloseTo(2.5, 9);
    // The same stored figure read at 18 decimals is 2.5e-12 — not "a bit off", invisible.
    expect(quotePerWholeTokenNumber(usdc, 2, 18)).toBeLessThan(1e-9);
  });

  /**
   * A row that did not say which generation it is.
   *
   * `AccountSwapRow`, `BalanceRow` and `CandlestickRow` carry a price and no generation. Guessing
   * 1 for those is precisely the assumption that produced the four defects, so the helper refuses
   * to scale rather than guessing, and the caller renders nothing instead of a wrong number.
   */
  it("refuses to scale a price whose generation is unknown", () => {
    expect(quotePerWholeToken("111857553000000000", UNKNOWN_GENERATION)).toBeNull();
    expect(quotePerWholeTokenNumber("111857553000000000", UNKNOWN_GENERATION, 18)).toBeNull();
  });

  it("survives a zero price without dividing by anything", () => {
    expect(quotePerWholeToken(0n, 2)).toBe(0n);
    expect(quotePerWholeTokenNumber(0n, 2, 6)).toBe(0);
  });

  /**
   * The truncation that took every gold market to zero, and the reason the number path does not
   * go through the bigint one.
   *
   * `quotePerWholeToken` answers in raw quote units and divides as an integer, so a whole token
   * worth less than one raw unit of a six-decimal quote is `0n` — correct in raw units, useless as
   * a price. `quotePerWholeTokenNumber` does both divisions in a single step and keeps the
   * fraction, which is the whole difference between a market that renders and one that reads
   * "0.00" with nothing thrown.
   */
  it("keeps a sub-raw-unit price rather than truncating it to zero", () => {
    // A generation-2 coin worth a ten-billionth of a troy ounce: below one raw unit of XAUt0.
    const tiny = 10n ** 14n;

    expect(quotePerWholeToken(tiny, 2)).toBe(0n);
    expect(quotePerWholeTokenNumber(tiny, 2, 6)).toBeGreaterThan(0);
    expect(quotePerWholeTokenNumber(tiny, 2, 6)).toBeCloseTo(1e-10, 18);
  });
});
