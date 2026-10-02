import { type NextRequest, NextResponse } from "next/server";

import { fetchPositions } from "@/lib/api/markets";
import { indexer } from "@/lib/api/server";

/** The liquidity positions an account holds, for the portfolio's pools tab. */
export async function GET(request: NextRequest, { params }: { params: { address: string } }) {
  const limit = Math.min(Number(request.nextUrl.searchParams.get("limit") ?? 50), 200);

  try {
    return NextResponse.json(await fetchPositions(indexer, params.address, limit));
  } catch (e) {
    console.error("account positions route failed", e);
    return NextResponse.json({ error: "upstream unavailable" }, { status: 502 });
  }
}
