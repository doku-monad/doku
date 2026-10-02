/**
 * @jest-environment node
 */
import {
  buyQuoteOnCurve,
  curvePriceImpactPct,
  sellQuoteOnCurve,
} from "../../src/lib/chain/price-impact";

/**
 * The curve these figures are measured against: a market at its launch reserves.
 *
 * `BondingCurve` starts at `(BASE_VIRTUAL_CEILING, quoteTarget * 0.4)`, so a 305,900 MON raise
 * opens on 1,088,888,889.2 tokens against 122,360 MON. Spot is the ratio, and every expectation
 * below is what a constant-product walk from those two reserves actually produces — not a figure
 * this file rounded into agreement with the code it tests.
 */
const FRESH_SPOT = 122_360 / 1_088_888_889.2;
const MON = 18;
const TOKEN = 18;

const impactOfBuy = (
  quoteIn: bigint,
  q: { baseOut: bigint; fee: bigint; antiSniperTax: bigint; creatorTax?: bigint; refund?: bigint }
) =>
  curvePriceImpactPct({
    quoteOnCurve: buyQuoteOnCurve(quoteIn, {
      fee: q.fee,
      antiSniperTax: q.antiSniperTax,
      creatorTax: q.creatorTax ?? 0n,
      refund: q.refund ?? 0n,
    }),
    baseOnCurve: q.baseOut,
    quoteDecimals: MON,
    baseDecimals: TOKEN,
    spotPrice: FRESH_SPOT,
  });

/** What the receipt used to print: the whole amount typed, over the tokens received. */
const impactAllIn = (quoteIn: bigint, baseOut: bigint) =>
  curvePriceImpactPct({
    quoteOnCurve: quoteIn,
    baseOnCurve: baseOut,
    quoteDecimals: MON,
    baseDecimals: TOKEN,
    spotPrice: FRESH_SPOT,
  });

describe("price impact on the curve", () => {
  /**
   * The bug, as it was measured on a live market four seconds after launch.
   *
   * `quoteBuy(1 MON)` answered with 4,464.2141 tokens, a 0.01 MON fee and a 0.488367 MON launch
   * tax — a 4,933 bps rate on the 0.99 MON that clears the fee. Only 0.501633 MON was ever spent
   * on the buyer's own tokens, and the panel divided the whole MON by them.
   */
  describe("the live one MON buy that read +99.35%", () => {
    const QUOTE_IN = 1_000_000_000_000_000_000n;
    const BASE_OUT = 4_464_214_100_000_000_000_000n;
    const FEE = 10_000_000_000_000_000n;
    const LAUNCH_TAX = 488_367_000_000_000_000n;

    it("counts only the 0.501633 MON that bought the buyer's tokens", () => {
      expect(
        buyQuoteOnCurve(QUOTE_IN, {
          fee: FEE,
          antiSniperTax: LAUNCH_TAX,
          creatorTax: 0n,
          refund: 0n,
        })
      ).toBe(501_633_000_000_000_000n);
    });

    it("reproduces the figure that was wrong, so the fix is against a real number", () => {
      expect(impactAllIn(QUOTE_IN, BASE_OUT)).toBeCloseTo(99.34, 1);
    });

    /**
     * Within a twentieth of a percent of nothing, which is the whole claim: one MON against a
     * 305,900 MON raise cannot move a constant-product curve further than that. The sign is not
     * asserted — the measured `baseOut` and the launch reserves are snapshots a few seconds apart,
     * and at this size that gap is larger than the impact itself.
     */
    it("reports essentially no impact, because the curve barely moved", () => {
      // NaN for an absent figure, so "no answer" fails this rather than passing as a zero.
      const impact =
        impactOfBuy(QUOTE_IN, { baseOut: BASE_OUT, fee: FEE, antiSniperTax: LAUNCH_TAX }) ??
        Number.NaN;
      expect(Math.abs(impact)).toBeLessThan(0.05);
    });
  });

  /**
   * The same trade walked forward from the launch reserves rather than read off the chain, so the
   * quote and the spot price are the same instant and the SIGN means something. A buy pushes the
   * price up; the fix must keep that, or it has replaced one wrong number with a prettier one.
   */
  it("still reports a buy as pushing the price up, once quote and spot are the same instant", () => {
    const impact = impactOfBuy(1_000_000_000_000_000_000n, {
      baseOut: 4_464_007_851_393_671_477_159n,
      fee: 10_000_000_000_000_000n,
      antiSniperTax: 488_367_000_000_000_000n,
    });
    expect(impact).toBeGreaterThan(0);
    expect(impact).toBeCloseTo(0.0012, 4);
  });

  /**
   * The other half of the claim. A fix that subtracts deductions until every trade reads zero is
   * no better than the figure it replaced — worse, because it hides the size that would hurt.
   */
  describe("a 50,000 MON buy, which genuinely does move the curve", () => {
    const QUOTE_IN = 50_000_000_000_000_000_000_000n;
    const FEE = 500_000_000_000_000_000_000n;

    it("reports a large impact after the launch window closes", () => {
      // No launch tax left to strip, so the fix moves this figure only by the 1% fee: 41.87 → 40.45.
      const q = { baseOut: 313_627_371_205_632_491_562_900_034n, fee: FEE, antiSniperTax: 0n };
      expect(impactAllIn(QUOTE_IN, q.baseOut)).toBeCloseTo(41.873, 2);
      expect(impactOfBuy(QUOTE_IN, q)).toBeCloseTo(40.454, 2);
    });

    /**
     * Sixteen percent of the raise, bought four seconds in. The launch tax burns 24,418 MON of it
     * against the curve before the buyer's own 25,081 MON lands, so the price they get really is
     * 68% above spot — and that is the number they need. The old +235.87% was that impact with the
     * tax counted a second time on top.
     */
    it("keeps a genuinely brutal impact brutal inside the launch window", () => {
      const q = {
        baseOut: 132_477_562_616_035_865_084_948_756n,
        fee: FEE,
        antiSniperTax: 24_418_350_000_000_000_000_000n,
      };
      expect(impactAllIn(QUOTE_IN, q.baseOut)).toBeCloseTo(235.87, 1);
      expect(impactOfBuy(QUOTE_IN, q)).toBeCloseTo(68.484, 2);
    });
  });

  /**
   * The sell side had the same defect, quieter and with the opposite sign: `quoteSell` takes the
   * fee and the creator tax off the gross, so the panel compared post-levy proceeds to spot and
   * charged the fee to price impact on every sell, however small.
   */
  describe("sells", () => {
    const impactOfSell = (
      baseIn: bigint,
      p: { quoteOut: bigint; fee: bigint; creatorTax?: bigint }
    ) =>
      curvePriceImpactPct({
        quoteOnCurve: sellQuoteOnCurve({
          quoteOut: p.quoteOut,
          fee: p.fee,
          creatorTax: p.creatorTax ?? 0n,
        }),
        baseOnCurve: baseIn,
        quoteDecimals: MON,
        baseDecimals: TOKEN,
        spotPrice: FRESH_SPOT,
      });

    it("adds the levies back to reach the gross the curve actually paid out", () => {
      expect(
        sellQuoteOnCurve({
          quoteOut: 1_112_466_926_006_301_228n,
          fee: 11_237_039_656_629_305n,
          creatorTax: 0n,
        })
      ).toBe(1_123_703_965_662_930_533n);
    });

    it("no longer charges the fee to a dust-sized sell", () => {
      const p = { quoteOut: 1_112_466_926_006_301_228n, fee: 11_237_039_656_629_305n };
      const baseIn = 10_000_000_000_000_000_000_000n;
      // Ten thousand tokens is a millionth of this raise and used to read the 1% fee as impact.
      expect(
        curvePriceImpactPct({
          quoteOnCurve: p.quoteOut,
          baseOnCurve: baseIn,
          quoteDecimals: MON,
          baseDecimals: TOKEN,
          spotPrice: FRESH_SPOT,
        })
      ).toBeCloseTo(-1.0009, 3);
      expect(impactOfSell(baseIn, p)).toBeCloseTo(-0.0009, 3);
    });

    it("keeps a hundred-million-token sell negative and large", () => {
      const impact = impactOfSell(100_000_000_000_000_000_000_000_000n, {
        quoteOut: 10_189_042_987_987_913_984_451n,
        fee: 102_919_626_141_292_060_449n,
      });
      expect(impact).toBeCloseTo(-8.4112, 3);
    });
  });

  /**
   * The refund is money handed back, so it cannot have moved anything. Counting it would report
   * the largest impact in a market's life on the buy that fills it — the one trade nobody should
   * be frightened off.
   */
  it("ignores the refund on a buy that overshoots the raise", () => {
    // 10 MON offered into a curve that needed 1: the refunded 9 unwinds its own fee and tax too.
    expect(
      buyQuoteOnCurve(10_000_000_000_000_000_000n, {
        fee: 10_000_000_000_000_000n,
        antiSniperTax: 488_367_000_000_000_000n,
        creatorTax: 0n,
        refund: 9_000_000_000_000_000_000n,
      })
    ).toBe(501_633_000_000_000_000n);
  });

  /** The creator's tax is a deduction like any other, and markets set it as high as ten percent. */
  it("strips the creator's tax as well", () => {
    expect(
      buyQuoteOnCurve(1_000_000_000_000_000_000n, {
        fee: 10_000_000_000_000_000n,
        antiSniperTax: 0n,
        creatorTax: 100_000_000_000_000_000n,
        refund: 0n,
      })
    ).toBe(890_000_000_000_000_000n);
  });

  /**
   * Each side by its OWN decimals. A six-decimal quote against an eighteen-decimal token is where
   * a shared exponent stops cancelling, and the failure renders as an ordinary-looking number.
   */
  it("prices a six-decimal quote without the 1e12 that cancels only on MON", () => {
    // 1 USDC on the curve for 1,000 tokens is 0.001 USDC a token — exactly spot, so no impact.
    expect(
      curvePriceImpactPct({
        quoteOnCurve: 1_000_000n,
        baseOnCurve: 1_000_000_000_000_000_000_000n,
        quoteDecimals: 6,
        baseDecimals: 18,
        spotPrice: 0.001,
      })
    ).toBeCloseTo(0, 9);
  });

  describe("when there is no figure to give", () => {
    const leg = { quoteDecimals: MON, baseDecimals: TOKEN, spotPrice: FRESH_SPOT };

    it("gives nothing rather than zero for an unquoted trade", () => {
      expect(curvePriceImpactPct({ ...leg, quoteOnCurve: 0n, baseOnCurve: 0n })).toBeNull();
      expect(curvePriceImpactPct({ ...leg, quoteOnCurve: 1n, baseOnCurve: 0n })).toBeNull();
    });

    it("gives nothing for a market with no price to compare against", () => {
      const traded = {
        quoteOnCurve: 1_000_000_000_000_000_000n,
        baseOnCurve: 1_000_000_000_000_000_000n,
      };
      expect(curvePriceImpactPct({ ...leg, ...traded, spotPrice: 0 })).toBeNull();
      expect(curvePriceImpactPct({ ...leg, ...traded, spotPrice: Number.NaN })).toBeNull();
    });

    /** A buy whose deductions exceed it is a quote paired with the wrong amount, not a free trade. */
    it("floors an impossible split at nothing rather than inventing a negative leg", () => {
      expect(
        buyQuoteOnCurve(1_000_000_000_000_000_000n, {
          fee: 10_000_000_000_000_000n,
          antiSniperTax: 0n,
          creatorTax: 0n,
          refund: 2_000_000_000_000_000_000n,
        })
      ).toBe(0n);
    });
  });
});
