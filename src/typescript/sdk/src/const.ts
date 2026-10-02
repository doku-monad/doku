/**
 * Chain-agnostic constants.
 *
 * Everything Aptos-specific has been removed: module addresses, the network name, an API key, the
 * integrator fee, and the market reserve constants. They required six environment variables at
 * *import* time, which meant anything that touched this file — including a test that only wanted a
 * regex — failed to load without a full Aptos configuration.
 *
 * What remains is the vocabulary the interface still speaks: chart periods and symbol limits.
 */

import Big from "big.js";

export const VERCEL = process.env.VERCEL === "1";

export enum Period {
  Period1M = "period_1m",
  Period5M = "period_5m",
  Period15M = "period_15m",
  Period30M = "period_30m",
  Period1H = "period_1h",
  Period4H = "period_4h",
  Period1D = "period_1d",
}

/// As defined in the Move module, not in the database; i.e., numbers, not enum strings.
/**
 * Note that a period boundary, a candlestick resolution, a period, and a candlestick time frame
 * are all referred to interchangeably throughout this codebase.
 */
export enum PeriodDuration {
  PERIOD_15S = 15000000,
  PERIOD_1M = 60000000,
  PERIOD_5M = 300000000,
  PERIOD_15M = 900000000,
  PERIOD_30M = 1800000000,
  PERIOD_1H = 3600000000,
  PERIOD_4H = 14400000000,
  PERIOD_1D = 86400000000,
}

export const periodEnumToRawDuration = (period: Period): PeriodDuration => {
  if (period === Period.Period1M) return PeriodDuration.PERIOD_1M;
  if (period === Period.Period5M) return PeriodDuration.PERIOD_5M;
  if (period === Period.Period15M) return PeriodDuration.PERIOD_15M;
  if (period === Period.Period30M) return PeriodDuration.PERIOD_30M;
  if (period === Period.Period1H) return PeriodDuration.PERIOD_1H;
  if (period === Period.Period4H) return PeriodDuration.PERIOD_4H;
  if (period === Period.Period1D) return PeriodDuration.PERIOD_1D;
  throw new Error(`Invalid period: ${period}`);
};

export const rawPeriodToEnum = (num: bigint): Period => {
  if (num === BigInt(PeriodDuration.PERIOD_1M)) return Period.Period1M;
  if (num === BigInt(PeriodDuration.PERIOD_5M)) return Period.Period5M;
  if (num === BigInt(PeriodDuration.PERIOD_15M)) return Period.Period15M;
  if (num === BigInt(PeriodDuration.PERIOD_30M)) return Period.Period30M;
  if (num === BigInt(PeriodDuration.PERIOD_1H)) return Period.Period1H;
  if (num === BigInt(PeriodDuration.PERIOD_4H)) return Period.Period4H;
  if (num === BigInt(PeriodDuration.PERIOD_1D)) return Period.Period1D;
  throw new Error(`Invalid period: ${num}`);
};

/**
 * Decimals for MON and every launched token.
 *
 * Eighteen, not the eight this held for Aptos octas. A stale eight here would render every amount
 * ten orders of magnitude too large while still looking like a number.
 */
export const DECIMALS = 18;

// The number of decimals at which exponential notation is used for positive Big.js numbers.
export const NUM_DECIMALS_BEFORE_SCIENTIFIC_NOTATION = 1000;
Big.PE = NUM_DECIMALS_BEFORE_SCIENTIFIC_NOTATION;

// Emoji sequence length constraints.
export const MAX_NUM_CHAT_EMOJIS = 100;
export const MAX_SYMBOL_LENGTH = 10;

// non-registrants can trade. Note that this period is ended early once the registrant makes a
// single trade.

/**
 * A helper function to convert from an untyped number to a PeriodDuration enum value.
 */
export const toPeriodDuration = (num: number | bigint): PeriodDuration => {
  if (Number(num) === PeriodDuration.PERIOD_15S) return PeriodDuration.PERIOD_15S;
  if (Number(num) === PeriodDuration.PERIOD_1M) return PeriodDuration.PERIOD_1M;
  if (Number(num) === PeriodDuration.PERIOD_5M) return PeriodDuration.PERIOD_5M;
  if (Number(num) === PeriodDuration.PERIOD_15M) return PeriodDuration.PERIOD_15M;
  if (Number(num) === PeriodDuration.PERIOD_30M) return PeriodDuration.PERIOD_30M;
  if (Number(num) === PeriodDuration.PERIOD_1H) return PeriodDuration.PERIOD_1H;
  if (Number(num) === PeriodDuration.PERIOD_4H) return PeriodDuration.PERIOD_4H;
  if (Number(num) === PeriodDuration.PERIOD_1D) return PeriodDuration.PERIOD_1D;
  throw new Error(`Invalid candlestick period duration: ${num}`);
};

