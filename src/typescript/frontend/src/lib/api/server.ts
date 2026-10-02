import "server-only";

import { withHiddenMarkets } from "@/lib/markets/hidden-markets";

import { createApiClient } from "./client";

/**
 * The indexer client for server components and route handlers.
 *
 * `server-only` is load-bearing rather than decorative: the indexer URL may point at a private
 * network address, and a client bundle importing this would leak it into the page and then fail
 * to reach it from a browser — a confusing failure that looks like the indexer being down.
 */
const url = process.env.DOKU_INDEXER_URL;
if (!url) {
  throw new Error("DOKU_INDEXER_URL is not set");
}

/** Every server read goes through here, so hidden markets are removed once — see `hidden-markets`. */
export const indexer = withHiddenMarkets(createApiClient(url));
