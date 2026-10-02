import type { UploadInput, UploadRepository } from "../repositories/upload.repository.js";
import type { UploadRowDb, UploadWire } from "../types/api.js";

/**
 * The largest re-encoded file the ledger will record: 8 MB.
 *
 * The upload route bounds its INPUT at 2 MB, but it re-encodes what it accepts, and a re-encode can
 * grow — a small heavily-compressed JPEG becomes a larger lossless WebP. Bounding the ledger at the
 * input limit would reject rows for files that were pinned successfully, leaving them unrecorded
 * and therefore invisible to the collector that is supposed to reclaim them.
 */
const MAX_BYTES = 2 * 1024 * 1024 * 4;

/** What the route is allowed to have produced. Anything else is not an image this site serves. */
const MIME = new Set(["image/webp", "image/png", "image/jpeg"]);

const CID = /^[A-Za-z0-9]{10,128}$/;
const SHA256 = /^[0-9a-fA-F]{64}$/;

/** How many orphans one listing may return. The GC pages; it does not need the whole table. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const positiveInt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : undefined;

/**
 * Validation and shaping for the upload reference ledger.
 *
 * Validation is here rather than in the controller because it is a statement about what an upload
 * IS, not about HTTP: a cid that is not a cid is the same mistake whether it arrives over a route
 * or from a script. The controller only turns the verdict into a status code.
 */
export class UploadService {
  constructor(private readonly uploads: UploadRepository) {}

  async find(cid: string): Promise<UploadWire | undefined> {
    const row = await this.uploads.find(cid);
    return row ? wire(row) : undefined;
  }

  async orphans(limitRaw: string | undefined): Promise<UploadWire[]> {
    const parsed = Number(limitRaw);
    const limit =
      limitRaw === undefined || !Number.isSafeInteger(parsed) || parsed <= 0
        ? DEFAULT_LIMIT
        : Math.min(parsed, MAX_LIMIT);
    return (await this.uploads.orphans(limit)).map(wire);
  }

  /**
   * Registers a pinned upload.
   *
   * Returns the row it wrote rather than an acknowledgement: the caller has just learned the
   * ledger's view of this cid — including whether anything already references it — without a second
   * request, and a GC that reads what it wrote cannot act on a stale copy of it.
   */
  async register(
    body: unknown,
  ): Promise<{ error: string } | { status: "inserted" | "existing"; row: UploadWire }> {
    const input = parse(body);
    if ("error" in input) return input;
    const status = await this.uploads.upsert(input);
    const row = await this.uploads.find(input.cid);
    // Unreachable in practice: the upsert has just committed the row. If it is somehow gone, say so
    // rather than answering 201 over nothing.
    if (!row) return { error: "upload vanished after insert" };
    return { status, row: wire(row) };
  }

  async remove(cid: string): Promise<"deleted" | "missing" | "referenced"> {
    return this.uploads.remove(cid);
  }
}

function parse(body: unknown): UploadInput | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "body must be an object" };
  const b = body as Record<string, unknown>;
  if (typeof b.cid !== "string" || !CID.test(b.cid)) return { error: "cid is not a cid" };
  if (typeof b.sha256 !== "string" || !SHA256.test(b.sha256)) {
    return { error: "sha256 is not 64 hex characters" };
  }
  const bytes = positiveInt(b.bytes);
  if (bytes === undefined || bytes > MAX_BYTES) return { error: "bytes is not a plausible size" };
  if (typeof b.mime !== "string" || !MIME.has(b.mime)) return { error: "mime is not an image type" };
  // Dimensions are optional — an SVG-ish or otherwise unmeasurable file still deserves a ledger row
  // — but a present one has to be a real pixel count, not zero and not a float.
  const width = b.width === null || b.width === undefined ? null : positiveInt(b.width);
  const height = b.height === null || b.height === undefined ? null : positiveInt(b.height);
  if (width === undefined || height === undefined) return { error: "width/height are not pixels" };
  return { cid: b.cid, sha256: b.sha256.toLowerCase(), bytes, mime: b.mime, width, height };
}

const wire = (r: UploadRowDb): UploadWire => ({
  cid: r.cid,
  sha256: r.sha256,
  bytes: r.bytes,
  mime: r.mime,
  width: r.width,
  height: r.height,
  uploadedAt: new Date(r.uploaded_at).toISOString(),
  referencedBy: r.referenced_by,
  referencedAt: r.referenced_at ? new Date(r.referenced_at).toISOString() : null,
  pinned: r.pinned,
  orphaned: r.orphaned,
});
