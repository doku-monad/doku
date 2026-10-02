import { Hono } from "hono";

import { BadRequestError } from "../services/index.js";
import type { MarketService } from "../services/index.js";

/**
 * The two whole-site reads: the hero's leaderboard and the command palette's search.
 *
 * Mounted at the root rather than under `/markets` because neither is about one market — they rank
 * and find across all of them — and nesting them would make `/markets/leaderboard` collide with
 * `/markets/:address` the day someone deploys a market at that name.
 */
export function searchRoutes(services: { markets: MarketService }): Hono {
  const routes = new Hono();

  routes.get("/leaderboard", async (c) => {
    try {
      return c.json(await services.markets.leaderboard(c.req.query("window")));
    } catch (err) {
      // A window the service has no interval for is the caller's mistake. It must never reach the
      // repository: the interval is spliced into SQL, and the whitelist is what makes that safe.
      if (err instanceof BadRequestError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  routes.get("/search", async (c) =>
    c.json(await services.markets.search(c.req.query("q"), c.req.query("limit"))),
  );

  return routes;
}
