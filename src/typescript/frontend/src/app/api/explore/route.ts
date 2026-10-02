import { type NextRequest, NextResponse } from "next/server";

import { createShortMemo } from "@/lib/api/short-memo";
import { loadExplore } from "@/lib/queries/explore/load";
import { exploreQueryString, parseExploreParams } from "@/lib/queries/explore/params";
import type { ExplorePayload } from "@/lib/queries/explore/types";

/**
 * Everything `/explore` draws, in one answer.
 *
 * The page is a static shell (see `app/explore/page.tsx`); this is its data. The body is the
 * server component's old props, assembled by the same code (`loadExplore`), sent as JSON. It is
 * answered per request — the route reads its query string, which is what an API route is for —
 * with one short memo in front so a burst of identical asks after a live-feed event costs the
 * indexer one round trip rather than one per open tab. The memo is shorter than the board's
 * debounce, so nothing served from it can predate the event that caused the ask.
 *
 * The edge policy for this path is in `lib/api/cache-policy`, next to the other block-paced
 * routes it now sits beside.
 */

/** Below `DEBOUNCE_MS` (400) — `tests/unit/short-memo.test.ts` holds it there. */
const MEMO_MS = 300;
const memo = createShortMemo<ExplorePayload>(MEMO_MS);

export async function GET(request: NextRequest) {
  const params = parseExploreParams(request.nextUrl.searchParams);
  try {
    const payload = await memo(exploreQueryString(params), () => loadExplore(params));
    return NextResponse.json(payload);
  } catch (e) {
    // `loadExplore` catches both indexer reads into flags; reaching here means something else
    // threw — a bug, not an outage — and a 502 tells the client to keep the board it has.
    console.error("explore route failed", e);
    return NextResponse.json({ error: "upstream unavailable" }, { status: 502 });
  }
}
