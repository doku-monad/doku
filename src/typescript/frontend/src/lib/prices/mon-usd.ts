/**
 * The MON/USD rate.
 *
 * Optional by design. With no source configured there is no USD anywhere in the app, which is the
 * correct behaviour for a deployment that has not wired one up — a dollar figure derived from a
 * price nobody provided is invented, and it looks exactly as authoritative as a real one.
 *
 * Kept free of `server-only` so the pure parts are testable and reusable; the fetching wrapper
 * that reads configuration lives in `server.ts`.
 */

/**
 * How old a quote may be before it is treated as absent.
 *
 * A stale price is worse than no price: the number still renders, still looks live, and is wrong
 * by however much the market has moved. Past this the app shows MON instead, which is always true.
 */
export const MAX_PRICE_AGE_MS = 10 * 60 * 1000;

export interface PriceQuote {
  usd: number;
  fetchedAt: number;
}

/**
 * Reads a number out of a JSON body at a dot path.
 *
 * Configurable because price APIs disagree about shape — CoinGecko nests under a coin id, others
 * return a bare object. A path is one line of configuration; auto-detecting the shape is a guess
 * that fails silently the day a provider changes.
 */
export function readPriceAt(body: unknown, path: string): number | null {
  const parts = path.split(".").filter(Boolean);
  let cursor: unknown = body;
  for (const part of parts) {
    if (typeof cursor !== "object" || cursor === null) return null;
    cursor = (cursor as Record<string, unknown>)[part];
  }

  const value = typeof cursor === "string" ? Number(cursor) : cursor;
  // Rejects NaN, Infinity, negatives and zero. A zero rate would make every USD figure zero, which
  // renders perfectly and is nonsense.
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

/** Whether a quote is still usable. A missing quote and an old one are the same answer: no USD. */
export function isFresh(quote: PriceQuote | null, now: number): quote is PriceQuote {
  return quote !== null && now - quote.fetchedAt <= MAX_PRICE_AGE_MS;
}

/** Converts a MON amount to USD, or null when there is no usable rate. */
export function toUsd(mon: number, quote: PriceQuote | null, now: number): number | null {
  if (!isFresh(quote, now)) return null;
  return mon * quote.usd;
}
