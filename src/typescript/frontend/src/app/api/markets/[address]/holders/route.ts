import { type NextRequest, NextResponse } from "next/server";

import { getHolders } from "@/lib/queries/doku";

/** Top holders for a market, excluding the curve and the graduated pool. */
export async function GET(
  request: NextRequest,
  { params }: { params: { address: string } },
) {
  const { searchParams } = request.nextUrl;
  const limit = Math.min(Number(searchParams.get("limit") ?? 100), 500);
  const cursor = searchParams.get("cursor") ?? undefined;

  try {
    const { holders, nextCursor } = await getHolders(params.address, { limit, cursor });
    return NextResponse.json({
      // `share` and `label` come from the endpoint and travel through unchanged. They used to be
      // dropped here and recomputed in the browser from a balance and a supply, which gives a
      // different answer because the browser does not know which addresses are excluded from
      // circulating.
      items: holders.map((h) => ({ ...h, balance: h.balance.toString() })),
      nextCursor,
    });
  } catch (e) {
    console.error("holders route failed", e);
    return NextResponse.json({ error: "upstream unavailable" }, { status: 502 });
  }
}
