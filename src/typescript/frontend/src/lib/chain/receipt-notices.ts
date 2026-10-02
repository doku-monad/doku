/**
 * The two charges worth a sentence under a swap.
 *
 * The receipt is `You receive`, the floor and the slippage, on purpose: a row of machinery nobody
 * can act on is noise. These two are not machinery. The anti-sniper tax is up to half of a buy in
 * a market's first seconds and is avoided entirely by waiting; the quote has always computed it
 * and the panel never showed it. A creator tax is a stranger's charge of up to 10% on every buy
 * AND sell. Both are already inside `You receive` — the sentence says why the figure is what it is.
 */
export interface ReceiptNotices {
  /** The anti-sniper tax as a percentage of what reaches the curve, or `null` when there is none. */
  antiSniperPct: number | null;
  creatorTaxPct: number | null;
}

export function receiptNotices(input: {
  isSell: boolean;
  /** `quoteBuy`'s `antiSniperTax`, raw quote units. Always zero on a sell and on a pool quote. */
  antiSniperTax: bigint;
  /** What the curve is handed, raw quote units: the same input the quote was asked about. */
  curveInput: bigint;
  creatorFeePct: number;
}): ReceiptNotices {
  let antiSniperPct: number | null = null;
  if (!input.isSell && input.antiSniperTax > 0n && input.curveInput > 0n) {
    const bps100 = Number((input.antiSniperTax * 1_000_000n) / input.curveInput) / 10_000;
    // Present and tiny is still present: a tax that rounds to 0.00% would read as no tax.
    antiSniperPct = Math.max(0.01, Number(bps100.toFixed(2)));
  }
  return { antiSniperPct, creatorTaxPct: input.creatorFeePct > 0 ? input.creatorFeePct : null };
}
