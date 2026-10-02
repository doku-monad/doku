import type { Queryable } from "../db/transaction.js";
import type { UploadRowDb } from "../types/api.js";

/** What the frontend's upload route registers after it has pinned the bytes. */
export interface UploadInput {
  cid: string;
  sha256: string;
  bytes: number;
  mime: string;
  width: number | null;
  height: number | null;
}

/**
 * How long an unreferenced upload is kept before it counts as an orphan: `INTERVAL '24 hours'`,
 * written out in both queries below.
 *
 * A launch is a two-step affair — the image is pinned first, the transaction is signed afterwards —
 * and the gap between them is a human one. Twenty-four hours is far longer than any of them and far
 * shorter than paying to pin an image nobody ever launched. It is a SQL literal rather than an
 * interpolated constant because a tagged template would bind it as a parameter, and `INTERVAL $1`
 * is not something Postgres will parse.
 */

/**
 * The reference ledger for launch imagery.
 *
 * The indexer owns this table and nothing else about an upload, because the indexer is the only
 * process that sees `MetadataSet` — which is the only evidence that a cid was ever pointed at by a
 * market. The bytes, the pinning and the CDN belong to the frontend's route.
 */
export class UploadRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Registers a cid, or confirms one already registered.
   *
   * Idempotent on `cid`, which a content-addressed identifier makes safe: the same cid is the same
   * bytes, so a retried POST is not a second image. `xmax = 0` distinguishes the insert from the
   * update so the controller can answer 201 or 200 — the upload route retries, and a retry that
   * answered 201 would tell it it had just created something it created an hour ago.
   */
  async upsert(u: UploadInput): Promise<"inserted" | "existing"> {
    const r = await this.db.$queryRaw<{ inserted: boolean }[]>`
      INSERT INTO uploads (cid, sha256, bytes, mime, width, height)
      VALUES (${u.cid}, ${u.sha256}, ${u.bytes}, ${u.mime}, ${u.width}, ${u.height})
      ON CONFLICT (cid) DO UPDATE SET sha256 = EXCLUDED.sha256
      RETURNING (xmax = 0) AS inserted`;
    return r[0]?.inserted ? "inserted" : "existing";
  }

  async find(cid: string): Promise<UploadRowDb | undefined> {
    const r = await this.db.$queryRaw<UploadRowDb[]>`
      SELECT cid, sha256, bytes::int AS bytes, mime, width::int AS width, height::int AS height,
             uploaded_at, referenced_by, referenced_at, pinned,
             (referenced_by IS NULL AND uploaded_at < NOW() - INTERVAL '24 hours') AS orphaned
        FROM uploads WHERE cid = ${cid}`;
    return r[0];
  }

  /**
   * The orphan set, oldest first, so the GC can walk it in the order things expired.
   *
   * `TRUE AS orphaned` rather than the predicate again: every row this query returns satisfies it
   * by construction, and repeating the expression is one more place for the two definitions to
   * drift apart.
   */
  async orphans(limit: number): Promise<UploadRowDb[]> {
    return this.db.$queryRaw<UploadRowDb[]>`
      SELECT cid, sha256, bytes::int AS bytes, mime, width::int AS width, height::int AS height,
             uploaded_at, referenced_by, referenced_at, pinned, TRUE AS orphaned
        FROM uploads
       WHERE referenced_by IS NULL AND uploaded_at < NOW() - INTERVAL '24 hours'
       ORDER BY uploaded_at ASC
       LIMIT ${limit}`;
  }

  /**
   * Deletes only when unreferenced. Returns what happened so the controller can pick 204/404/409.
   *
   * The reference check is the whole point of the table: a referenced cid is an image a market on
   * chain points at, and the market cannot be edited to point elsewhere. Unpinning it would break a
   * launch someone paid for, so the answer is 409 and not a delete.
   */
  async remove(cid: string): Promise<"deleted" | "missing" | "referenced"> {
    const row = await this.find(cid);
    if (!row) return "missing";
    if (row.referenced_by) return "referenced";
    await this.db.$executeRaw`DELETE FROM uploads WHERE cid = ${cid}`;
    return "deleted";
  }
}
