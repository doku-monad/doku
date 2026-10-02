import { formatCompact } from "lib/utils/format-compact";

/**
 * A market cap as the hero states it: dollars where the quote is priced, and the quote's own units
 * under its own ticker where it is not — the rule `capFigure` in `lib/market-cap` applies to the
 * cards, for figures that arrive here already as numbers.
 *
 * Both the tape and the runner board print through this. They used to print the bare quote figure,
 * so a bitcoin-quoted market read `0.0412` one row above a MON-quoted `123.5K`, with nothing to say
 * the two were in different units.
 */
export const capText = (quoteUnits: number, usd: number | null, unit: string | null): string =>
  usd !== null ? `$${formatCompact(usd)}` : `${formatCompact(quoteUnits)}${unit ? ` ${unit}` : ""}`;
