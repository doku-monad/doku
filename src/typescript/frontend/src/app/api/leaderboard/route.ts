import { type NextRequest, NextResponse } from "next/server";

import { fetchLeaderboard, type LeaderboardWindow } from "@/lib/api/markets";
import { indexer } from "@/lib/api/server";

const WINDOWS = new Set<LeaderboardWindow>(["1h", "24h", "7d"]);

/**
 * The hero's four lists in one request.
 *
 * The alternative the page does today is a fan-out: the whole market list, sorted four ways in the
 * browser, plus two requests per showcased market. This is one call, ordered by the database.
 *
 * Answered per request. `revalidate = 15` was here and was inert: this handler reads `request` for
 * its window, which opts the route out of caching entirely, so the number described a cache that
 * could never exist. The service's own rollup runs at fifteen seconds and the client's query cache
 * is where a TTL belongs.
 */

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("window") ?? "24h";
  const window = WINDOWS.has(raw as LeaderboardWindow) ? (raw as LeaderboardWindow) : "24h";

  try {
    return NextResponse.json(await fetchLeaderboard(indexer, window));
  } catch (e) {
    console.error("leaderboard route failed", e);
    return NextResponse.json({ error: "upstream unavailable" }, { status: 502 });
  }
}
