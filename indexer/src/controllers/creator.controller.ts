import { Hono } from "hono";

import type { CreatorService } from "../services/index.js";

/**
 * What one address earns as a creator.
 *
 * Always 200, never 404: an address with no launches and no balances is a real answer — "you have
 * earned nothing" — and a 404 there would render as a broken page rather than as an empty one.
 */
export function creatorRoutes(services: { creators: CreatorService }): Hono {
  const routes = new Hono();

  routes.get("/:address", async (c) => c.json(await services.creators.read(c.req.param("address"))));

  return routes;
}
