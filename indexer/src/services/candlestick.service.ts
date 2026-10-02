import { PERIODS } from "../indexer/processing/derive.js";
import type { CandlestickRepository } from "../repositories/index.js";
import type { CandlestickRow } from "../types/api.js";
import { clampLimit, normalizeAddress } from "./pagination.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const DEFAULT_PERIOD = 3600;

/** Thrown for a period the indexer does not write, so the controller can answer 400 rather than 500. */
export class UnsupportedPeriodError extends Error {
  readonly supported = PERIODS;
  constructor(period: number) {
    super(`unsupported period: ${period}`);
    this.name = "UnsupportedPeriodError";
  }
}

export class CandlestickService {
  constructor(private readonly candles: CandlestickRepository) {}

  /**
   * Periods are validated against what the indexer actually writes. An unsupported period would
   * otherwise return an empty array, which a chart renders as "this market has never traded".
   */
  async listForMarket(
    market: string,
    rawPeriod?: string,
    rawLimit?: string,
  ): Promise<{ items: CandlestickRow[] }> {
    const period = Number(rawPeriod ?? DEFAULT_PERIOD);
    if (!PERIODS.includes(period as (typeof PERIODS)[number])) {
      throw new UnsupportedPeriodError(period);
    }
    const limit = clampLimit(rawLimit, DEFAULT_LIMIT, MAX_LIMIT);
    const rows = await this.candles.listForMarket(normalizeAddress(market), period, limit);
    // Read newest-first so the LIMIT takes the most recent buckets; returned oldest-first because
    // that is the order a chart draws.
    return { items: rows.reverse() };
  }
}
