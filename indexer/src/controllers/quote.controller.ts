import { Hono } from "hono";

import type { QuoteService } from "../services/index.js";

/**
 * What a market can be priced in.
 *
 * A whole-table read with no parameters: the registry is a dozen curated rows, and every consumer
 * — the pair chips, `/assets`, the launch form's selector — wants all of them.
 */
export function quoteRoutes(services: { quotes: QuoteService }): Hono {
  const routes = new Hono();

  routes.get("/", async (c) => c.json(await services.quotes.list()));

  return routes;
}
