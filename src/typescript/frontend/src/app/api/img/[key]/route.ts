import { type NextRequest, NextResponse } from "next/server";

import { getObject, readStoreConfig } from "@/lib/uploads/bucket";

/**
 * Serves a launch's artwork out of the object store.
 *
 * The FALLBACK path. Where the store publishes a public domain — R2 with `R2_PUBLIC_BASE_URL` —
 * the on-chain URL points straight at it and this route is never asked, which is the point of
 * preferring R2. It stays because a private bucket has no other way to be read, and because every
 * image uploaded before a public domain existed still resolves through here forever.
 *
 * This URL is written ON CHAIN, inside the market's `logoURI`, so it is permanent in a way an
 * ordinary route is not: it will be fetched by this site, by anything indexing the chain, and by
 * whatever renders a token list long after. Two consequences follow.
 *
 * The key never changes meaning. It is the first half of the SHA-256 of the exact bytes served, so
 * a given URL can only ever return one image and a cache may hold it forever. That is what the
 * immutable cache header below asserts, and it is true by construction rather than by policy.
 *
 * And the response is always `image/webp`. Everything reaching the store went through the upload
 * route's re-encode, so there is nothing else to serve — and pinning the type here means a stored
 * object cannot talk a browser into treating it as a document. Serving an SVG from our own origin
 * would be a stored cross-site scripting hole; serving one as WebP is a broken image, which is the
 * correct way for that to fail.
 */

/** Not prerendered: the object store is state, and a build-time snapshot of it is a stale image. */
export const dynamic = "force-dynamic";

/** Hex only, and the length the upload route produces. A key outside that shape never existed. */
const KEY = /^[0-9a-f]{32}\.webp$/;

export async function GET(_request: NextRequest, { params }: { params: { key: string } }) {
  const store = readStoreConfig();
  if (!store) {
    // A deployment with no store has no images to serve, which is a 404 and not a fault.
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (!KEY.test(params.key)) {
    /*
     * Refused on shape, before the store is asked.
     *
     * The key becomes a path in a signed request, so anything outside this alphabet is either a
     * mistake or an attempt to address something else in the bucket. Answering 404 rather than 400
     * tells a probe nothing about which keys exist.
     */
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let object: Awaited<ReturnType<typeof getObject>>;
  try {
    object = await getObject(store, params.key);
  } catch (e) {
    // Logged rather than swallowed: a store that is refusing reads looks identical, from the
    // outside, to a launch whose artwork was never uploaded.
    console.error(`image ${params.key} could not be read`, e);
    return NextResponse.json({ error: "upstream unavailable" }, { status: 502 });
  }

  if (!object) return NextResponse.json({ error: "not found" }, { status: 404 });

  return new NextResponse(object.body, {
    headers: {
      "content-type": "image/webp",
      "cache-control": "public, max-age=31536000, immutable",
      // The bytes are an image and nothing else; this stops a browser from deciding otherwise.
      "x-content-type-options": "nosniff",
      "content-length": String(object.body.byteLength),
    },
  });
}
