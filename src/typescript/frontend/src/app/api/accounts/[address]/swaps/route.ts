import { type NextRequest, NextResponse } from "next/server";

import { dummyAccountSwaps, previewEnabled } from "@/lib/dev/dummy-markets";
import { getAccountSwaps } from "@/lib/queries/doku";

type Swaps = Awaited<ReturnType<typeof getAccountSwaps>>["swaps"];

const wire = (swaps: Swaps, nextCursor: string | null) =>
  NextResponse.json({
    items: swaps.map((s) => ({
      ...s,
      swap: {
        ...s.swap,
        quoteVolume: s.swap.quoteVolume.toString(),
        baseVolume: s.swap.baseVolume.toString(),
        price: s.swap.price.toString(),
        fee: s.swap.fee.toString(),
        tax: s.swap.tax.toString(),
        quoteRaised: s.swap.quoteRaised.toString(),
        /* Null when the feed could not say which generation the row came from — carried through as
           null rather than dropped, because the client renders no price at all in that case and a
           missing key would look like a zero.

           This field is why the route returned 502 for every account with a trade: it was added to
           `SwapModel` after this serializer was written, `JSON.stringify` refuses a bigint outright,
           and the catch below turned the throw into "upstream unavailable" — so the portfolio's
           activity tab was empty and the indexer looked like the thing at fault. */
        priceQuote: s.swap.priceQuote?.toString() ?? null,
      },
      block: { ...s.block, number: s.block.number.toString() },
    })),
    nextCursor,
  });

/** Every trade an account has made, across markets. */
export async function GET(request: NextRequest, { params }: { params: { address: string } }) {
  const { searchParams } = request.nextUrl;
  const limit = Math.min(Number(searchParams.get("limit") ?? 100), 500);
  const cursor = searchParams.get("cursor") ?? undefined;

  // The fixture is one page and says so — a `nextCursor` it cannot honour would send the P&L walk
  // round the loop six times for the same rows and report the totals as truncated.
  const preview = () => wire(dummyAccountSwaps(Date.now()), null);

  try {
    const { swaps, nextCursor } = await getAccountSwaps(params.address, { limit, cursor });
    if (swaps.length === 0 && !cursor && previewEnabled) return preview();
    return wire(swaps, nextCursor);
  } catch (e) {
    if (previewEnabled) return preview();
    console.error("account swaps route failed", e);
    return NextResponse.json({ error: "upstream unavailable" }, { status: 502 });
  }
}
