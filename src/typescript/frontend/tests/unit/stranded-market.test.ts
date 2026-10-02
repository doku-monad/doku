/**
 * @jest-environment node
 */

/**
 * The market that filled and never graduated.
 *
 * Graduation runs inside the buy that fills the curve, behind a wrapper that swallows any failure
 * so the buyer's own trade survives. A buy carrying an ordinary gas limit into a transaction that
 * also has to create a pool starves it — and the market is then filled, closed for good, and has no
 * pool. The panel used to read a closed curve as proof the pool existed, quote one that had never
 * been initialised, and grey the button with no explanation.
 */
import { canSubmitTrade, chooseVenue, isStranded } from "../../src/lib/chain/venue";
import { willLikelyFill } from "../../src/lib/chain/writes";

describe("telling a graduated market from a stranded one", () => {
  it("is the pool once the indexer has seen it, whatever else is unknown", () => {
    expect(chooseVenue({ poolAddress: "0xpool", readyToGraduate: undefined })).toEqual({
      venue: "pool",
      known: true,
    });
  });

  it("is the curve while the curve is still open", () => {
    expect(chooseVenue({ poolAddress: null, readyToGraduate: false })).toEqual({
      venue: "curve",
      known: true,
    });
  });

  it("waits rather than guessing while the curve read is in flight", () => {
    expect(chooseVenue({ poolAddress: null, readyToGraduate: undefined }).known).toBe(false);
  });

  /** The regression: a closed curve is NOT proof of a pool, and must not be read as one. */
  it("does not call a closed curve a pool until the graduation says so", () => {
    const v = chooseVenue({ poolAddress: null, readyToGraduate: true, graduated: undefined });
    expect(v.known).toBe(false);
  });

  it("is the pool when the graduation confirms it", () => {
    expect(chooseVenue({ poolAddress: null, readyToGraduate: true, graduated: true })).toEqual({
      venue: "pool",
      known: true,
    });
  });

  it("is STRANDED when the curve is closed and the graduation never happened", () => {
    const v = chooseVenue({ poolAddress: null, readyToGraduate: true, graduated: false });
    expect(v).toEqual({ venue: "stranded", known: true });
    expect(isStranded(v.venue, v.known)).toBe(true);
  });

  it("is not stranded while the answer is still unknown", () => {
    const v = chooseVenue({ poolAddress: null, readyToGraduate: true, graduated: undefined });
    expect(isStranded(v.venue, v.known)).toBe(false);
  });

  it("refuses a trade on a stranded market, because there is no venue", () => {
    expect(
      canSubmitTrade({
        inputAmount: 10n ** 18n,
        outputAmount: 0n,
        quoteKnown: true,
        venueKnown: true,
        sufficientBalance: true,
      })
    ).toBe(false);
  });
});

describe("carrying the graduation gas on the buy that will need it", () => {
  const mon = (n: number) => BigInt(n) * 10n ** 18n;

  it("flags a buy that fills the curve on its own", () => {
    expect(willLikelyFill(mon(100), mon(99))).toBe(true);
  });

  /**
   * THE CASE THE OLD 5% MARGIN MISSED, and the whole reason the margin moved.
   *
   * Two buys land in the same block. Together they fill the curve; alone, each is only half of what
   * remains, so under a 5% margin NEITHER was flagged — and whichever the block ordered last
   * carried an ordinary limit into the transaction that had to graduate.
   */
  it("flags each of two buys that only fill the curve together", () => {
    const remaining = mon(6000);
    const each = mon(3100);
    expect(willLikelyFill(each, remaining)).toBe(true);
    // Under the margin this replaced, neither was:
    const oldMarginSaidYes = ((each * 9_900n) / 10_000n) * 10_000n >= remaining * 9_500n;
    expect(oldMarginSaidYes).toBe(false);
  });

  it("flags each of four buys that only fill it between them", () => {
    expect(willLikelyFill(mon(2500), mon(10_000))).toBe(true);
  });

  it("leaves an ordinary buy far from the end alone", () => {
    expect(willLikelyFill(mon(100), mon(10_000))).toBe(false);
  });

  it("says no once there is nothing left to fill", () => {
    expect(willLikelyFill(mon(100), 0n)).toBe(false);
  });
});
