import { canSubmitTrade, chooseVenue } from "../../src/lib/chain/venue";

const POOL = "0x188d586ddcf52439676ca21a244753fa19f9ea8e";

/**
 * The two reverts a live market produced, as tests.
 *
 * Both were signed transactions that could not have succeeded: the button was lit, the receipt
 * showed zeros, and the chain refused. Nothing in the app was checking the one flag the contract
 * checks.
 */
describe("trade venue", () => {
  it("uses the curve while the market is still bonding", () => {
    expect(chooseVenue({ poolAddress: null, readyToGraduate: false })).toEqual({
      venue: "curve",
      known: true,
    });
  });

  it("uses the pool once the indexer has seen the graduation", () => {
    expect(chooseVenue({ poolAddress: POOL, readyToGraduate: false })).toEqual({
      venue: "pool",
      known: true,
    });
  });

  /**
   * The window that produced the second revert.
   *
   * Graduation is atomic on chain, so this state does not exist there — but the indexer reports
   * the fill and the pool from two different logs, so it exists in the app for as long as the
   * second one takes to arrive. The market page showed "GRADUATING", 100% of the curve, and a
   * live Buy button that called a curve whose first statement is `revert CurveClosed()`.
   *
   * The venue is still the pool. What changed is the confidence: a closed curve was read as proof
   * that a pool exists, and it is not. `graduate()` is a separate transaction that somebody has to
   * pay for, and when the buy that filled the curve ran out of gas before it, nobody has. So a
   * closed curve with the graduation read still in flight is a pool we have not confirmed —
   * `known: false`, which holds the button rather than pointing it at an address that may be zero.
   */
  it("does not call a pool confirmed on the strength of a closed curve alone", () => {
    expect(chooseVenue({ poolAddress: null, readyToGraduate: true })).toEqual({
      venue: "pool",
      known: false,
    });
  });

  /** Once the graduation read lands saying yes, the pool is real and the button can act. */
  it("confirms the pool when the graduation contract says the market graduated", () => {
    expect(chooseVenue({ poolAddress: null, readyToGraduate: true, graduated: true })).toEqual({
      venue: "pool",
      known: true,
    });
  });

  /**
   * The state this whole change exists for: the curve is full, the pool was never created, and
   * every venue is a revert until somebody calls `graduate()`.
   */
  it("names a filled-but-ungraduated market stranded rather than pointing at a pool", () => {
    expect(chooseVenue({ poolAddress: null, readyToGraduate: true, graduated: false })).toEqual({
      venue: "stranded",
      known: true,
    });
  });

  /** "Not read yet" is not "still bonding", and collapsing the two is how the window came back. */
  it("does not claim to know the venue while the curve read is in flight", () => {
    expect(chooseVenue({ poolAddress: null, readyToGraduate: undefined })).toEqual({
      venue: "curve",
      known: false,
    });
  });

  it("trusts the indexer's pool even before the curve read lands", () => {
    expect(chooseVenue({ poolAddress: POOL, readyToGraduate: undefined })).toEqual({
      venue: "pool",
      known: true,
    });
  });
});

describe("submitting a trade", () => {
  const ok = {
    inputAmount: 10n ** 18n,
    outputAmount: 8_824_514n * 10n ** 18n,
    quoteKnown: true,
    venueKnown: true,
    sufficientBalance: true,
  };

  it("allows a quoted trade with a real output", () => {
    expect(canSubmitTrade(ok)).toBe(true);
  });

  /**
   * The closed curve quotes `(0, 0, 0, everything)`. The panel rendered that faithfully — "you
   * receive 0", "refunded 1.000000 MON" — and kept the button enabled, because it tested whether
   * a quote EXISTED rather than whether it was worth anything, and a quote of zero is an object.
   */
  it("refuses a trade the venue quoted at zero", () => {
    expect(canSubmitTrade({ ...ok, outputAmount: 0n })).toBe(false);
  });

  it("refuses while the venue is still unknown", () => {
    expect(canSubmitTrade({ ...ok, venueKnown: false })).toBe(false);
  });

  it("refuses while the quote is still unknown", () => {
    expect(canSubmitTrade({ ...ok, quoteKnown: false })).toBe(false);
  });

  it("refuses an empty input", () => {
    expect(canSubmitTrade({ ...ok, inputAmount: 0n })).toBe(false);
  });

  it("refuses when the balance does not cover it", () => {
    expect(canSubmitTrade({ ...ok, sufficientBalance: false })).toBe(false);
  });
});
