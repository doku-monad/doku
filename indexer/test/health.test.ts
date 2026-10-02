import { beforeAll, describe, expect, it } from "vitest";

import { createApi } from "../src/app/index.js";
import type { Database } from "../src/db/index.js";
import type { Db } from "../src/db/legacy.js";
import { memoryDatabase } from "./helpers.js";

/**
 * The endpoint a platform restarts the service on.
 *
 * `/status` reports lag but always answers 200, which makes it a dashboard and not a health
 * check: an indexer whose ingest loop has died keeps serving its last known block forever, and
 * every probe passes while the data silently ages. The distinction matters because that failure
 * is the one this service actually has.
 *
 * `/ready` is deliberately a different question: it says whether the database answers, so a
 * platform stops routing to a process that cannot serve yet without restarting one that is merely
 * a little behind.
 */
describe("health", () => {
  let database: Database;
  let db: Db;

  beforeAll(async () => {
    database = await memoryDatabase();
    db = database.legacy;
  }, 120_000);

  const health = async (api: ReturnType<typeof createApi>) => {
    const res = await api.request("http://x/health");
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("is healthy when the indexer has ingested recently", async () => {
    await db.query("UPDATE indexer_status SET updated_at = NOW() WHERE id = 1");
    const { status, body } = await health(createApi(database));
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
  });

  /**
   * The failure worth catching: the loop stopped, the API is still up, and every row it serves is
   * from before it stopped.
   */
  it("is unhealthy when the indexer has gone quiet", async () => {
    await db.query("UPDATE indexer_status SET updated_at = NOW() - INTERVAL '30 minutes'");
    const { status, body } = await health(createApi(database));
    expect(status).toBe(503);
    expect(body.status).toBe("stale");
  });

  /**
   * A probe that cannot reach the database has to fail. Answering 200 from a process whose
   * database is gone is the exact reassurance a health check exists to withhold.
   */
  it("is unhealthy when the database cannot be reached", async () => {
    const unreachable = new Error("connection terminated");
    const broken = {
      prisma: {
        $queryRaw: () => Promise.reject(unreachable),
        $executeRaw: () => Promise.reject(unreachable),
      },
      ping: () => Promise.resolve(false),
    } as unknown as Database;
    const { status } = await health(createApi(broken));
    expect(status).toBe(503);
  });

  /** Readiness answers a different question from health, and has to answer it separately. */
  it("is not ready when the database cannot be reached", async () => {
    const broken = { prisma: {}, ping: () => Promise.resolve(false) } as unknown as Database;
    const res = await createApi(broken).request("http://x/ready");
    expect(res.status).toBe(503);
  });

  it("is ready when the database answers", async () => {
    const res = await createApi(database).request("http://x/ready");
    expect(res.status).toBe(200);
    expect((await res.json() as { database: boolean }).database).toBe(true);
  });
});
