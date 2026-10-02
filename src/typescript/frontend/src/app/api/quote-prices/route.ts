import { NextResponse } from "next/server";

import { buildPriceDocument, COIN_IDS, pricedCount } from "@/lib/prices/quote-prices";

/**
 * Never prerendered. A price served from the build is a number that never changes, and nothing
 * about the response says so.
 */
export const dynamic = "force-dynamic";

/**
 * The USD price document for every registered quote asset, for the indexer's `PRICE_SOURCE_URL`.
 *
 * It lives here rather than in the indexer because the upstream shape is a detail of one vendor:
 * the indexer asks for a flat `{ key: usd }` table and stays ignorant of who produced it. Swapping
 * feeds is then this file alone.
 */

const UPSTREAM =
  process.env.QUOTE_PRICE_SOURCE_URL ??
  `https://api.coingecko.com/api/v3/simple/price?ids=${COIN_IDS.join(",")}&vs_currencies=usd`;

/** Refetched at most this often, however many callers ask. */
const REFRESH_MS = 60_000;

/**
 * The last document that priced anything, kept across a failed refresh.
 *
 * A feed that blips should not empty the board's dollar column. It is served with the age it
 * actually has, so a caller can tell a fresh answer from a held one; the indexer keeps its previous
 * values when the document is empty either way.
 */
interface PriceDocument {
  prices: Record<string, number>;
  fetchedAt: number;
}

let cached: PriceDocument | null = null;
let inFlight: Promise<PriceDocument | null> | null = null;

async function refresh(): Promise<PriceDocument | null> {
  try {
    const response = await fetch(UPSTREAM, {
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    const prices = buildPriceDocument(await response.json());
    return pricedCount(prices) > 0 ? { prices, fetchedAt: Date.now() } : null;
  } catch {
    // Expected and survivable. The held document stands.
    return null;
  }
}

export async function GET() {
  const now = Date.now();
  if (!cached || now - cached.fetchedAt >= REFRESH_MS) {
    // One refresh at a time, or a burst after expiry all miss and all hit the upstream at once.
    inFlight ??= refresh().finally(() => {
      inFlight = null;
    });
    const fresh = await inFlight;
    if (fresh) cached = fresh;
  }

  if (!cached) {
    // 503, not an empty 200. An empty document and a dead upstream are the same thing to a reader,
    // and only one of them should look like a working endpoint.
    return NextResponse.json({ prices: {}, error: "no price source" }, { status: 503 });
  }

  return NextResponse.json(
    {
      prices: cached.prices,
      fetchedAt: cached.fetchedAt,
      ageSeconds: Math.round((Date.now() - cached.fetchedAt) / 1000),
      priced: pricedCount(cached.prices),
    },
    { headers: { "cache-control": "public, max-age=30" } }
  );
}
