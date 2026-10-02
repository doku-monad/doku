import { Hono } from "hono";

import type {
  HolderService,
  MarketService,
  PositionService,
  SwapService,
} from "../services/index.js";

/** One account's holdings, trades, liquidity and launches, across every market. */
export function accountRoutes(services: {
  holders: HolderService;
  swaps: SwapService;
  positions: PositionService;
  markets: MarketService;
}): Hono {
  const routes = new Hono();

  /**
   * What this address launched.
   *
   * Lives under `/accounts` rather than `/creators` because that is where the interface already
   * asks for it, and because "what did this address launch" is a question about an account. What it
   * has EARNED as a creator is a different question with a different key — the recipient columns,
   * which come apart from `creator` the moment one is transferred — and that is `/creators/:a`.
   */
  routes.get("/:address/launches", async (c) =>
    c.json(await services.markets.launches(c.req.param("address"))),
  );

  routes.get("/:address/balances", async (c) =>
    c.json(await services.holders.listForAccount(c.req.param("address"), c.req.query("limit"))),
  );

  routes.get("/:address/swaps", async (c) =>
    c.json(
      await services.swaps.listForAccount(
        c.req.param("address"),
        c.req.query("limit"),
        c.req.query("cursor"),
      ),
    ),
  );

  /**
   * Liquidity positions.
   *
   * Served from the index rather than read from the chain because the chain cannot answer it:
   * v4's PositionManager is not ERC-721Enumerable, and on Monad it is the canonical manager shared
   * by every v4 protocol, so there is no id range small enough to walk.
   */
  routes.get("/:address/positions", async (c) =>
    c.json(await services.positions.listForAccount(c.req.param("address"), c.req.query("limit"))),
  );

  return routes;
}
