import { type NextRequest, NextResponse } from "next/server";

import { fetchCreator } from "@/lib/api/markets";
import { indexer } from "@/lib/api/server";

/**
 * What one creator is owed, per quote asset.
 *
 * Forwarded as it arrives, and the shape matters: `claimable` and `earnedLifetime` are ARRAYS, one
 * entry per quote asset, and they must never be summed. A creator paid in USDC and in MON has two
 * balances, and adding them is adding dollars to a token count.
 */
export async function GET(_request: NextRequest, { params }: { params: { address: string } }) {
  try {
    return NextResponse.json(await fetchCreator(indexer, params.address));
  } catch (e) {
    console.error("creator route failed", e);
    return NextResponse.json({ error: "upstream unavailable" }, { status: 502 });
  }
}
