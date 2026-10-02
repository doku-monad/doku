/**
 * The anti-sniper buy tax, as the factory holds it.
 *
 * `DokuFactory.taxTerms` is a launch parameter the protocol's Safe can change, snapshotted into
 * each curve at launch. The rate falls from `startBps` to zero along one of three axes
 * (`TaxMath.Mode`): the CLOCK, over `window` seconds; the raise's PROGRESS; or the larger of the
 * two. It is charged on buys only, spent on the curve, and the tokens it buys are burned.
 */
export interface AntiSniperTerms {
  startBps: number;
  /** Seconds. Zero disables the clock (`TaxMath._clock`). */
  window: number;
  /** 0 CLOCK, 1 PROGRESS, 2 MAX. */
  mode: number;
}

const pct = (bps: number): string => `${Number((bps / 100).toFixed(2))}%`;

const span = (seconds: number): string => {
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds >= 120 && seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
};

/** One line for the launch summary. `undefined` is "not read yet", and is said as that. */
export function antiSniperLabel(terms: AntiSniperTerms | undefined): string {
  if (!terms) return "Reading…";
  const { startBps, window, mode } = terms;
  const clock = window > 0;
  if (startBps === 0 || (mode === 0 && !clock)) return "None";
  const fall = `${pct(startBps)} → 0%`;
  const tail = "buys only, burned";
  if (mode === 0) return `${fall} over ${span(window)}, ${tail}`;
  if (mode === 1 || !clock) return `${fall} as the curve fills, ${tail}`;
  return `${fall} over ${span(window)} or as the curve fills, whichever is higher, ${tail}`;
}
