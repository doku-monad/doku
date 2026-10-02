import { type Context, Hono } from "hono";

import type { UploadService } from "../services/upload.service.js";

/**
 * The upload reference ledger.
 *
 * Reads are public and writes are not. A cid is not a secret — it is derived from bytes anyone with
 * the image can compute — and the answer to a read is a boolean and two sizes, so guarding it would
 * protect nothing while making the frontend's collector carry a credential to ask a question. The
 * writes decide whether an image stays pinned, so they carry the bearer token.
 *
 * Without `UPLOADS_TOKEN` configured every write answers 403 rather than defaulting to open: a
 * deployment that forgot the token would otherwise let anyone unpin a launch's imagery.
 */
export function uploadRoutes(service: UploadService, token: string | undefined): Hono {
  const routes = new Hono();

  const authorised = (c: Context): boolean =>
    token !== undefined && c.req.header("authorization") === `Bearer ${token}`;

  routes.get("/:cid", async (c) => {
    const u = await service.find(c.req.param("cid"));
    return u ? c.json(u) : c.json({ error: "not found" }, 404);
  });

  routes.get("/", async (c) => {
    if (!authorised(c)) return c.json({ error: "forbidden" }, 403);
    return c.json({ items: await service.orphans(c.req.query("limit")) });
  });

  routes.post("/", async (c) => {
    if (!authorised(c)) return c.json({ error: "forbidden" }, 403);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const result = await service.register(body);
    if ("error" in result) return c.json(result, 400);
    return c.json(result.row, result.status === "inserted" ? 201 : 200);
  });

  routes.delete("/:cid", async (c) => {
    if (!authorised(c)) return c.json({ error: "forbidden" }, 403);
    const r = await service.remove(c.req.param("cid"));
    return r === "deleted"
      ? c.body(null, 204)
      : r === "missing"
        ? c.json({ error: "not found" }, 404)
        : c.json({ error: "referenced" }, 409);
  });

  return routes;
}
