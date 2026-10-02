import { Hono } from "hono";

import type {
  CandlestickService,
  HolderService,
  MarketService,
  SwapService,
} from "../services/index.js";
import { BadRequestError, RetiredMarketError, UnsupportedPeriodError } from "../services/index.js";

/**
 * What a retired market answers, on the market and on its ledger.
 *
 * 410 Gone and not 404, because the two say different things to the only audience that matters — a
 * person holding the address of a generation-2 market. 404 means "no such market", which is false
 * and is read as a typo: the market is there, it is quoting, and the next place they look will sell
 * them into it. 410 means it was here and is permanently gone, which is exactly what happened.
 *
 * It is not 200-with-a-warning either. A tradeable-looking payload needs every client to notice a
 * flag, and a client that does not notice renders a buy button over a market whose entire raise
 * anyone can freeze.
 *
 * The body names the generation and says the retirement was deliberate, so the answer can be
 * checked rather than merely obeyed.
 */
function gone(err: RetiredMarketError): {
  error: string;
  market: string;
  generation: number | null;
  detail: string;
} {
  return {
    error: "retired",
    market: err.market,
    generation: err.generation,
    detail:
      "This market belongs to a retired DOKU generation and is no longer served. Its contracts " +
      "are immutable and still live, so it can still be traded directly on chain — it is not " +
      "safe to, which is why it was retired.",
  };
}

/**
 * Markets, and everything hanging off one.
 *
 * A controller does three things and no more: read the request, call a service, choose a status
 * code. No SQL, no clamping, no address normalisation — those belong to the layers below, where
 * they can be tested without an HTTP request.
 */
export function marketRoutes(services: {
  markets: MarketService;
  swaps: SwapService;
  holders: HolderService;
  candlesticks: CandlestickService;
}): Hono {
  const routes = new Hono();

  /**
   * Two contracts on one path, chosen by whether a cursor was sent.
   *
   * With a cursor it answers exactly as it always has -- address-ordered, `{ items, nextCursor }` --
   * because the frontend's `pageThrough` and several suites walk it that way. Without one it is the
   * board's page: sorted, filtered and counted by the database.
   */
  routes.get("/", async (c) => {
    const q = c.req.query();
    if (q.cursor !== undefined) return c.json(await services.markets.list(q.limit, q.cursor));
    try {
      return c.json(await services.markets.listPaged(q));
    } catch (err) {
      // A sort or a routing name the service does not know is the caller's mistake. Anything else
      // is the server's and must keep its 500.
      if (err instanceof BadRequestError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  routes.get("/:address", async (c) => {
    try {
      const market = await services.markets.find(c.req.param("address"));
      return market ? c.json(market) : c.json({ error: "not found" }, 404);
    } catch (err) {
      if (err instanceof RetiredMarketError) return c.json(gone(err), 410);
      throw err;
    }
  });

  /**
   * The fee ledger behind the rewards module.
   *
   * Answers for a generation-1 market too, with zeros: "this market has earned nothing to route" is
   * a fact about it, not a missing resource, and a 404 here would read as a broken page.
   */
  routes.get("/:address/rewards", async (c) => {
    try {
      const rewards = await services.markets.rewards(c.req.param("address"));
      return rewards ? c.json(rewards) : c.json({ error: "not found" }, 404);
    } catch (err) {
      if (err instanceof RetiredMarketError) return c.json(gone(err), 410);
      throw err;
    }
  });

  routes.get("/:address/swaps", async (c) =>
    c.json(
      await services.swaps.listForMarket(
        c.req.param("address"),
        c.req.query("limit"),
        c.req.query("cursor"),
        c.req.query("trader"),
      ),
    ),
  );

  routes.get("/:address/holders", async (c) =>
    c.json(
      await services.holders.listForMarket(
        c.req.param("address"),
        c.req.query("limit"),
        c.req.query("cursor"),
      ),
    ),
  );

  routes.get("/:address/candlesticks", async (c) => {
    try {
      return c.json(
        await services.candlesticks.listForMarket(
          c.req.param("address"),
          c.req.query("period"),
          c.req.query("limit"),
        ),
      );
    } catch (err) {
      // A period the indexer does not write is the caller's mistake, not the server's.
      if (err instanceof UnsupportedPeriodError) {
        return c.json({ error: "unsupported period", supported: err.supported }, 400);
      }
      throw err;
    }
  });

  return routes;
}
