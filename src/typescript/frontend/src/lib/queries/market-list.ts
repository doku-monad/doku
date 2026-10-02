import type { MarketRow } from "@/lib/api/markets";
import { type MarketModel, toMarketModel } from "@/lib/models";

/**
 * Turns rows into models, dropping any single row that cannot be parsed.
 *
 * A bare `.map` means one malformed market takes the whole list with it. That is not theoretical:
 * `BigInt` rejects any string with a decimal point, a SQL cast in the wrong place rendered a
 * never-traded market's cap as "0.0000…0", and the home page fell back to its empty state — eleven
 * good markets replaced by "no markets yet", which reads as the protocol being empty rather than
 * as a bug.
 *
 * Dropping a row is a real loss, so it is reported rather than swallowed. The alternative to both
 * is showing nothing at all, which loses every row instead of one.
 */
export function toMarketModelsSkippingBad(rows: MarketRow[]): MarketModel[] {
  const models: MarketModel[] = [];
  for (const row of rows) {
    try {
      models.push(toMarketModel(row));
    } catch (error) {
      console.warn(
        `[doku] dropping market ${row?.market_address ?? "(no address)"}: could not parse its row`,
        error,
      );
    }
  }
  return models;
}
