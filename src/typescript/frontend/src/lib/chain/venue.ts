/**
 * Which venue a trade goes to, and why the indexer does not get to decide.
 *
 * A DOKU market has exactly two trading venues in its life: the bonding curve until it fills, and
 * the Uniswap v4 pool afterwards. The switch between them is not gradual — `BondingCurve.buy`
 * opens with `if (readyToGraduate) revert CurveClosed()`, so the instant the curve fills, every
 * further curve buy reverts.
 *
 * The app used to decide this from `market.state.poolAddress`, which comes from the INDEXER. That
 * is a different clock. Graduation is atomic on chain — the buy that fills the curve also creates
 * the pool, in the same transaction — but the indexer learns about the fill and about the pool
 * from two different log records, so between them it reports a market that is 100% full with no
 * pool. In that window the panel offered a curve buy on a closed curve: quoted zero, showed the
 * whole input as a refund, kept the button lit, and reverted on every click.
 *
 * So the venue is read from the curve itself. `readyToGraduate` is the same flag the revert is
 * guarded on, which makes the UI's question and the contract's answer literally the same boolean
 * rather than two things that are supposed to agree.
 */

/**
 * Where a trade goes — and the third state, which is nowhere.
 *
 * `stranded` is a market that FILLED and never graduated: the curve is closed for good, the pool
 * was never created, and there is nothing to trade on until somebody graduates it. It is not a
 * theoretical state. Graduation runs inside the buy that fills the curve, and that inner call is
 * deliberately wrapped so it can never take the buyer's own trade down with it — so when the buy
 * carries an ordinary gas limit into a transaction that also has to graduate, the graduation is
 * starved, the failure is swallowed, and the market lands here.
 *
 * Before this existed the app read a closed curve as proof the pool had been created, because the
 * same transaction normally does both. It then quoted a pool that was never initialised, got
 * nothing back, and greyed the button with no explanation — the one state a holder cannot act on
 * presented as though the page were still loading.
 */
export type Venue = "curve" | "pool" | "stranded";

export interface VenueInput {
  /** From the indexer. Present once it has seen the `Graduated` log. */
  poolAddress: string | null;
  /**
   * From the curve, read on chain. `undefined` while in flight — the read is not instant, and
   * treating "not yet known" as "not closed" is what reintroduces the window.
   */
  readyToGraduate: boolean | undefined;
  /**
   * `DokuGraduation.graduated(curve)`, read on chain. `undefined` while in flight.
   *
   * This is the signal that separates "graduated" from "stranded", and it has to come from the
   * GRADUATION contract rather than from the curve: a closed curve says only that the raise is
   * complete, which is exactly as true of a market whose pool was created as of one whose pool
   * never was.
   */
  graduated?: boolean | undefined;
}

/**
 * The venue, and whether we actually know it yet.
 *
 * `known` is the part worth having. The honest answer during the on-chain read is "not yet", and
 * a caller that cannot distinguish that from "curve" will send the first click of a page load to
 * whichever venue the default happened to be.
 *
 * Either signal alone is sufficient to mean graduated, and they are OR-ed rather than AND-ed: the
 * indexer having seen the pool is proof the curve closed, and the curve saying it is closed is
 * proof the pool was created, because the same transaction does both. Requiring both would put
 * the indexer back in the decision.
 */
export function chooseVenue(input: VenueInput): { venue: Venue; known: boolean } {
  // The indexer having seen the pool is proof it exists, and the strongest signal available.
  if (input.poolAddress !== null) return { venue: "pool", known: true };
  if (input.readyToGraduate === undefined) return { venue: "curve", known: false };
  if (!input.readyToGraduate) return { venue: "curve", known: true };

  /*
   * The curve is closed. Whether that means "graduated" or "stranded" is a different question, and
   * the honest answer while the graduation contract is still being read is that we do not know.
   *
   * `undefined` therefore reports `known: false` rather than guessing "pool". Guessing pool is what
   * the app used to do, and on a stranded market it produced a quote against a pool that had never
   * been initialised — a receipt full of zeros and a dead button.
   */
  if (input.graduated === undefined) return { venue: "pool", known: false };
  return input.graduated
    ? { venue: "pool", known: true }
    : { venue: "stranded", known: true };
}

/**
 * Whether a quoted trade can be submitted at all.
 *
 * A zero output is not a small trade, it is a trade the venue will refuse — the closed curve
 * quotes `(0, 0, 0, everything)` by construction, and the pool quoter returns zero for an amount
 * too small to move a tick. The panel showed those zeros on the receipt and left the button lit
 * anyway, so the only way to discover it was to sign and pay gas for the revert.
 */
export function canSubmitTrade(input: {
  inputAmount: bigint;
  outputAmount: bigint;
  quoteKnown: boolean;
  venueKnown: boolean;
  sufficientBalance: boolean;
}): boolean {
  if (input.inputAmount <= 0n) return false;
  if (!input.quoteKnown || !input.venueKnown) return false;
  if (input.outputAmount <= 0n) return false;
  return input.sufficientBalance;
}

/**
 * Whether this market is filled, closed, and waiting for somebody to graduate it.
 *
 * Separate from `chooseVenue` because the panel needs the answer in a place where a venue is not
 * what it is asking: it decides whether to render the trade fields at all, or the one action that
 * is actually available — finishing the graduation the filling buy could not.
 */
export const isStranded = (venue: Venue, known: boolean): boolean => venue === "stranded" && known;
