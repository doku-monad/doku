import { NextResponse } from "next/server";

/**
 * The platform healthcheck. Railway switches traffic to a new container only once this answers,
 * so a deploy whose process is up but not yet serving no longer takes the site down for the gap.
 * It reports the process, not the indexer: a down indexer is a degraded site, not a dead one,
 * and the pages say so themselves.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
