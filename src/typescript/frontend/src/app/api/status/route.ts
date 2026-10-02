import { NextResponse } from "next/server";

import { getIndexerStatus } from "@/lib/queries/doku";

/**
 * Never prerendered.
 *
 * This answers with live state — the indexer's lag and head, or the MON/USD rate — and Next will
 * happily treat a handler that reads no request as static, evaluate it once at build time, and
 * serve that snapshot for the life of the deployment. The failure is silent and looks like a
 * working endpoint reporting a number that never changes.
 */
export const dynamic = "force-dynamic";


/** Indexer health, for the live indicator. Never throws — staleness is not an outage. */
export async function GET() {
  const status = await getIndexerStatus();
  return NextResponse.json(
    status.reachable
      ? {
          reachable: true,
          lastBlock: status.lastBlock.toString(),
          chainHead: status.chainHead.toString(),
          lagBlocks: status.lagBlocks,
          lagSeconds: status.lagSeconds,
        }
      : { reachable: false },
  );
}
