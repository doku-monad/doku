import { type NextRequest, NextResponse } from "next/server";

import { fetchMarketRewards } from "@/lib/api/markets";
import { indexer } from "@/lib/api/server";

/**
 * A market's fee ledger, for the rewards module.
 *
 * A straight proxy: every figure is already a raw-unit string in the market's quote asset, so
 * there is nothing to convert and re-shaping a payload that is only being forwarded is a place for
 * a rename to hide a bug.
 *
 * The service answers for a generation-1 market too, with zeros — "this market has earned nothing
 * to route" is a fact about it, not a missing resource, and a 404 here would read as a broken page.
 * Note that a BUYBACK market's `pending` is "0" by construction rather than by subtraction: do not
 * render a claim button from it.
 */
export async function GET(_request: NextRequest, { params }: { params: { address: string } }) {
  try {
    return NextResponse.json(await fetchMarketRewards(indexer, params.address));
  } catch (e) {
    console.error("rewards route failed", e);
    return NextResponse.json({ error: "upstream unavailable" }, { status: 502 });
  }
}
