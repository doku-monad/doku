import { type NextRequest, NextResponse } from "next/server";

import { ApiError } from "@/lib/api/client";
import { fetchUpload } from "@/lib/api/markets";
import { indexer } from "@/lib/api/server";

/**
 * One row of the image reference ledger.
 *
 * Read-only. The write side — `POST /uploads`, which registers a pinned image — needs
 * `UPLOADS_TOKEN` and belongs to the upload route that does the pinning (task F4); a public proxy
 * that forwarded a bearer token would let anyone unpin a launch's artwork.
 *
 * A cid the ledger has never seen is a 404 and not an error: a launch form asking whether an image
 * is already recorded gets "no" rather than a failure.
 */
export async function GET(_request: NextRequest, { params }: { params: { cid: string } }) {
  try {
    return NextResponse.json(await fetchUpload(indexer, params.cid));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    console.error("upload route failed", e);
    return NextResponse.json({ error: "upstream unavailable" }, { status: 502 });
  }
}
