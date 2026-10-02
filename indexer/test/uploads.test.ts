import { beforeEach, describe, expect, it } from "vitest";
import { createApi } from "../src/app/index.js";
import type { Db } from "../src/db/legacy.js";
import { memoryDatabase } from "./helpers.js";

const TOKEN = "s3cret";
describe("uploads ledger", () => {
  let api: ReturnType<typeof createApi>;
  let db: Db;
  const call = async (method: string, path: string, body?: unknown, auth = true) => {
    const res = await api.request(`http://x${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}),
      },
    });
    return {
      status: res.status,
      body: res.status === 204 ? null : ((await res.json()) as Record<string, unknown>),
    };
  };
  // Real CIDv1 identifiers are dozens of characters long; the service's floor is ten, so the
  // fixtures are the length a pinning service would actually hand back rather than the four-letter
  // stand-ins that would quietly exercise a laxer validator than production has.
  const upload = {
    cid: "bafybeigdyrone",
    sha256: "ab".repeat(32),
    bytes: 12345,
    mime: "image/webp",
    width: 512,
    height: 512,
  };

  beforeEach(async () => {
    const database = await memoryDatabase();
    db = database.legacy;
    api = createApi(database, { uploadsToken: TOKEN });
  });

  it("registers an upload idempotently and reads it back", async () => {
    expect((await call("POST", "/uploads", upload)).status).toBe(201);
    expect((await call("POST", "/uploads", upload)).status).toBe(200);
    const { status, body } = await call("GET", "/uploads/bafybeigdyrone", undefined, false);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      cid: "bafybeigdyrone",
      bytes: 12345,
      mime: "image/webp",
      width: 512,
      height: 512,
      referencedBy: null,
      pinned: true,
      orphaned: false,
    });
  });

  it("404s an unknown cid and 400s a malformed body", async () => {
    expect((await call("GET", "/uploads/nope", undefined, false)).status).toBe(404);
    expect((await call("POST", "/uploads", { cid: "x" })).status).toBe(400);
  });

  it("refuses writes without the token", async () => {
    expect((await call("POST", "/uploads", upload, false)).status).toBe(403);
    expect((await call("DELETE", "/uploads/bafybeigdyrone", undefined, false)).status).toBe(403);
    const noToken = createApi(await memoryDatabase());
    const res = await noToken.request("http://x/uploads", {
      method: "POST",
      body: JSON.stringify(upload),
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(403);
  });

  it("reports orphans after 24 h and lists them oldest first", async () => {
    await call("POST", "/uploads", upload);
    await call("POST", "/uploads", { ...upload, cid: "bafybeigdyrtwo" });
    await db.query("UPDATE uploads SET uploaded_at = NOW() - INTERVAL '25 hours' WHERE cid = 'bafybeigdyrone'");
    await db.query(
      "UPDATE uploads SET uploaded_at = NOW() - INTERVAL '30 hours', referenced_by = '0xm' WHERE cid = 'bafybeigdyrtwo'",
    );
    expect((await call("GET", "/uploads/bafybeigdyrone", undefined, false)).body!.orphaned).toBe(true);
    expect((await call("GET", "/uploads/bafybeigdyrtwo", undefined, false)).body!.orphaned).toBe(false);
    const list = await call("GET", "/uploads?orphaned=true");
    expect((list.body!.items as { cid: string }[]).map((i) => i.cid)).toEqual(["bafybeigdyrone"]);
  });

  it("deletes an orphan and refuses to delete a referenced upload", async () => {
    await call("POST", "/uploads", upload);
    expect((await call("DELETE", "/uploads/bafybeigdyrone")).status).toBe(204);
    expect((await call("GET", "/uploads/bafybeigdyrone", undefined, false)).status).toBe(404);
    await call("POST", "/uploads", { ...upload, cid: "bafybeigdyrref" });
    await db.query("UPDATE uploads SET referenced_by = '0xm' WHERE cid = 'bafybeigdyrref'");
    expect((await call("DELETE", "/uploads/bafybeigdyrref")).status).toBe(409);
  });
});
