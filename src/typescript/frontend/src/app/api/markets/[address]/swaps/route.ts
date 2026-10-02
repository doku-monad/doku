import { type NextRequest, NextResponse } from "next/server";

import { getMarketScale, getSwaps } from "@/lib/queries/doku";

/** The trade feed for a market, cursor-paginated. */
export async function GET(
  request: NextRequest,
  { params }: { params: { address: string } },
) {
  const { searchParams } = request.nextUrl;
  const limit = Math.min(Number(searchParams.get("limit") ?? 50), 500);
  const cursor = searchParams.get("cursor") ?? undefined;
  const trader = searchParams.get("trader") ?? undefined;

  try {
    // A swap row holds a price and no generation. This feed is one market's, so its scale is the
    // market's — asked for rather than assumed.
    const scale = await getMarketScale(params.address);
    const { swaps, nextCursor } = await getSwaps(params.address, scale, { limit, cursor, trader });
    return NextResponse.json({
      // Every amount is a bigint. Stringified rather than converted, because these are 18-decimal
      // base units and a Number would silently round them.
      items: swaps.map((s) => ({
        ...s,
        swap: {
          ...s.swap,
          quoteVolume: s.swap.quoteVolume.toString(),
          baseVolume: s.swap.baseVolume.toString(),
          price: s.swap.price.toString(),
          priceQuote: s.swap.priceQuote?.toString() ?? null,
          quoteRaised: s.swap.quoteRaised.toString(),
          fee: s.swap.fee.toString(),
          tax: s.swap.tax.toString(),
        },
        block: { ...s.block, number: s.block.number.toString() },
      })),
      nextCursor,
    });
  } catch (e) {
    console.error("swaps route failed", e);
    return NextResponse.json({ error: "upstream unavailable" }, { status: 502 });
  }
}
