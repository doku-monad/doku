import { Hono } from "hono";

import type { Database } from "../db/index.js";
import type { StatusService } from "../services/index.js";

/**
 * The three probes, which answer different questions and are not interchangeable.
 *
 * `/status`  a dashboard. Always 200, reports lag as data.
 * `/health`  liveness. 503 when the ingest loop has gone quiet, because that is this service's
 *            actual failure: the API keeps serving while the data ages.
 * `/ready`   readiness. 503 until the database answers, so a platform does not route traffic to a
 *            process that cannot serve it yet. Deliberately *not* the same as health — a pod that
 *            is briefly stale should stop receiving traffic, not be restarted.
 */
export function healthRoutes(status: StatusService, database: Database): Hono {
  const routes = new Hono();

  routes.get("/status", async (c) => c.json(await status.read()));

  routes.get("/health", async (c) => {
    const { report, healthy } = await status.health();
    return c.json(report, healthy ? 200 : 503);
  });

  routes.get("/ready", async (c) => {
    const reachable = await database.ping();
    return c.json({ status: reachable ? "ready" : "unavailable", database: reachable }, reachable ? 200 : 503);
  });

  return routes;
}
