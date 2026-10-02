import { NextResponse } from "next/server";

import { getMonUsdPrice } from "@/lib/prices/server";

/**
 * Never prerendered.
 *
 * This answers with live state — the indexer's lag and head, or the MON/USD rate — and Next will
 * happily treat a handler that reads no request as static, evaluate it once at build time, and
 * serve that snapshot for the life of the deployment. The failure is silent and looks like a
 * working endpoint reporting a number that never changes.
 */
export const dynamic = "force-dynamic";


/** The MON/USD rate, or `{ usd: null }` when none is configured or the last one has aged out. */
export async function GET() {
  const quote = await getMonUsdPrice();
  return NextResponse.json(
    quote ? { usd: quote.usd, fetchedAt: quote.fetchedAt } : { usd: null },
  );
}
