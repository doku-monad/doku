import { NextResponse } from "next/server";

import { dummyQuoteAssets, previewEnabled } from "@/lib/dev/dummy-markets";
import { fetchQuotes } from "@/lib/queries/doku";

/**
 * The quote-asset registry, for the browser.
 *
 * A proxy rather than a direct call from the client, for the same reason every other `/api/**`
 * route here is one: `DOKU_INDEXER_URL` may be a private network address, and a client bundle that
 * knew it would both leak it into the page and fail to reach it.
 *
 * ## Answered at request time, and cached in the client instead
 *
 * `revalidate = 60` was here first, which was wrong in a way nothing reports: a `GET` that never
 * touches `request` is run ONCE during the build and served as a file afterwards, and a numeric
 * revalidate on a handler Next has already decided is static does not save it. The registry would
 * have frozen at whatever the indexer said on the day of the deploy — so a newly enabled asset
 * would never appear, and the failure would look like the admin transaction not having landed.
 *
 * The caching that was wanted belongs in the client anyway. `useQuoteAssets` holds this for five
 * minutes, so a board render costs nothing and an asset enabled by an admin shows up on the next
 * fetch rather than on the next deploy. See `tests/unit/route-freshness.test.ts`, which is the
 * gate that caught this.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const items = await fetchQuotes();
    /* The fixture only ever fills a hole — the same rule the board and the portfolio follow. A real
       registry is returned untouched, including a real empty one. */
    if (items.length === 0 && previewEnabled)
      return NextResponse.json({ items: dummyQuoteAssets() });
    return NextResponse.json({ items });
  } catch (e) {
    /*
     * With `DOKU_CARD_PREVIEW` set, an outage answers with the fixture instead.
     *
     * Every other preview surface degrades gracefully with the indexer down and the launch bench
     * did not: it reads this route for the assets a coin can be priced against, so it sat on
     * "Reading the quote registry" and the one page nobody can design without a backend was the
     * launch page. See `/launch-preview`.
     */
    if (previewEnabled) return NextResponse.json({ items: dummyQuoteAssets() });
    // Deliberately not an empty list. An empty registry renders as "there is nothing to pair
    // against", which is a statement about the product; this is an outage, and a client that
    // cannot tell them apart draws the wrong thing with total confidence.
    console.error("quotes route failed", e);
    return NextResponse.json({ error: "upstream unavailable" }, { status: 502 });
  }
}
