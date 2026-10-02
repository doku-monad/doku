import { expandRoutes } from "./utils";

const _ = "";

/**
 * Every route the app serves.
 *
 * `tests/unit/validate-routes.test.ts` asserts each of these has a matching file, which is what
 * caught the entries left behind when the arena, dev and Aptos-specific API routes were removed.
 */
const expanded = expandRoutes({
  api: {
    accounts: _,
    allowlist: _,
    candlesticks: _,
    markets: _,
    status: _,
  },
  assets: _,
  cult: _,
  explore: _,
  launch: _,
  "launching-soon": _,
  maintenance: _,
  market: _,
  "not-found": _,
  pools: _,
  stats: _,
  verify: _,
  wallet: _,
} as const);

// Manually add the root API route to `ROUTES` — the types are awkward to get right through
// `expandRoutes`.
export const ROUTES = {
  ...expanded,
  api: {
    ...expanded.api,
    ".": "/api",
  },
} as const;
