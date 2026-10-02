import { type NextRequest, NextResponse } from "next/server";

import { fetchMarketPositions } from "@/lib/api/markets";
import { indexer } from "@/lib/api/server";

/** Liquidity positions in one market's graduated pool. */
export async function GET(request: NextRequest, { params }: { params: { address: string } }) {
  const limit = Math.min(Number(request.nextUrl.searchParams.get("limit") ?? 50), 200);

  try {
    return NextResponse.json(await fetchMarketPositions(indexer, params.address, limit));
  } catch (e) {
    console.error("market positions route failed", e);
    return NextResponse.json({ error: "upstream unavailable" }, { status: 502 });
  }
}
