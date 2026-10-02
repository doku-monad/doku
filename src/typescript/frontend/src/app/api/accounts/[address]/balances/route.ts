import { type NextRequest, NextResponse } from "next/server";

import { dummyPortfolio, previewEnabled } from "@/lib/dev/dummy-markets";
import { getPortfolio } from "@/lib/queries/doku";

/** An account's holdings, joined to the markets they belong to. */
export async function GET(request: NextRequest, { params }: { params: { address: string } }) {
  const limit = Math.min(Number(request.nextUrl.searchParams.get("limit") ?? 100), 500);

  const wire = (positions: Awaited<ReturnType<typeof getPortfolio>>) =>
    NextResponse.json({ items: positions.map((p) => ({ ...p, balance: p.balance.toString() })) });

  try {
    const positions = await getPortfolio(params.address, limit);
    // Same rule the board follows: the fixture only ever fills a hole. A real answer, including a
    // real empty one from a wallet that holds nothing, is returned untouched.
    if (positions.length === 0 && previewEnabled) return wire(dummyPortfolio());
    return wire(positions);
  } catch (e) {
    if (previewEnabled) return wire(dummyPortfolio());
    console.error("portfolio route failed", e);
    return NextResponse.json({ error: "upstream unavailable" }, { status: 502 });
  }
}
