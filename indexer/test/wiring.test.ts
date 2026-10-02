import { beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app/index.js";
import { memoryDatabase, seedMarket } from "./helpers.js";

/**
 * Every generation-2 route group, at both prefixes.
 *
 * The unprefixed paths are what the frontend already calls and must keep working; `/api/v1` is the
 * versioned surface new callers should use. They are the same handlers over the same services, so
 * the check is not "both answer" but "both answer identically" — a group mounted at one prefix and
 * forgotten at the other is the failure this catches, and it is invisible until a caller picks the
 * prefix nobody wired.
 */
describe("gen-2 route mounting", () => {
  let api: ReturnType<typeof createApi>;
  beforeAll(async () => {
    const d = await memoryDatabase();
    await seedMarket(d.legacy, "0xm", "0xt");
    api = createApi(d);
  });
  it.each([
    "/markets?sort=marketCap",
    "/markets/0xm/rewards",
    "/accounts/0xa/launches",
    "/creators/0xa",
    "/quotes",
    "/leaderboard",
    "/search?q=x",
    "/uploads/nope",
  ])("serves %s at both the root and /api/v1", async (path) => {
    const root = await api.request(`http://x${path}`);
    const versioned = await api.request(`http://x/api/v1${path}`);
    // `/uploads/nope` is a deliberate 404 — an unknown cid — so it is the one path whose status is
    // allowed to be 404 at both prefixes. Every other group must be mounted.
    if (path !== "/uploads/nope") expect(root.status).not.toBe(404);
    expect(versioned.status).toBe(root.status);
    expect(await versioned.text()).toBe(await root.text());
  });
});
