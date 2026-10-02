import { type NextRequest, NextResponse } from "next/server";

import { searchMarkets } from "@/lib/api/markets";
import { indexer } from "@/lib/api/server";

/**
 * The command palette, searched in SQL.
 *
 * The palette filters five hundred client-side rows today, which is both a page of data nobody
 * looks at and a search that silently stops at the five-hundredth market.
 *
 * An empty needle answers an empty list without touching the indexer: a palette that has just been
 * opened has typed nothing, and returning every market for that is a table scan and a wall of
 * results nobody asked for.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const q = searchParams.get("q")?.trim() ?? "";
  const limit = Math.min(Number(searchParams.get("limit") ?? 20), 50);

  if (!q) return NextResponse.json({ items: [] });

  try {
    return NextResponse.json(await searchMarkets(indexer, q, limit));
  } catch (e) {
    console.error("search route failed", e);
    return NextResponse.json({ error: "upstream unavailable" }, { status: 502 });
  }
}
