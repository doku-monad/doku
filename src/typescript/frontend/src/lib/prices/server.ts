import "server-only";

import { isFresh, type PriceQuote, readPriceAt } from "./mon-usd";

/**
 * Fetches and caches the MON/USD rate.
 *
 * Cached in module scope rather than per request: a price feed does not need to be hit once per
 * page view, and a rate limit reached at peak traffic would take USD off the site exactly when
 * most people are looking at it.
 *
 * Configuration:
 *   MON_USD_PRICE_URL   the endpoint to fetch. Unset means no USD anywhere, deliberately.
 *   MON_USD_PRICE_PATH  dot path to the number. Defaults to CoinGecko's shape.
 */

const URL_ENV = process.env.MON_USD_PRICE_URL;
const PATH_ENV = process.env.MON_USD_PRICE_PATH ?? "monad.usd";

/** How often to refetch. Well inside `MAX_PRICE_AGE_MS`, so a single failure is not visible. */
const REFRESH_MS = 60_000;

let cached: PriceQuote | null = null;
let inFlight: Promise<PriceQuote | null> | null = null;

async function fetchQuote(): Promise<PriceQuote | null> {
  if (!URL_ENV) return null;
  try {
    const response = await fetch(URL_ENV, {
      // Next would otherwise cache this indefinitely as part of the page it was rendered for.
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;

    const usd = readPriceAt(await response.json(), PATH_ENV);
    return usd === null ? null : { usd, fetchedAt: Date.now() };
  } catch {
    // Network failures are expected and survivable: the previous quote stands until it ages out.
    return null;
  }
}

/**
 * The current rate, or null when there is none worth using.
 *
 * A failed refresh keeps the previous quote rather than dropping to null immediately — a single
 * timeout should not flip the whole site out of USD — but only until that quote ages past
 * `MAX_PRICE_AGE_MS`, after which it is treated as absent.
 */
export async function getMonUsdPrice(): Promise<PriceQuote | null> {
  if (!URL_ENV) return null;

  const now = Date.now();
  if (cached && now - cached.fetchedAt < REFRESH_MS) return cached;

  // One refresh at a time. Without this, a burst of requests after the cache expires all miss and
  // all hit the upstream — the stampede that gets an API key rate-limited.
  inFlight ??= fetchQuote().finally(() => {
    inFlight = null;
  });

  const fresh = await inFlight;
  if (fresh) cached = fresh;
  return isFresh(cached, Date.now()) ? cached : null;
}
