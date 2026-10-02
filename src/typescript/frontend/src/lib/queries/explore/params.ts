import type { HomePageSearchParams } from "lib/queries/sorting/query-params";
import { toHomePageParamsWithDefault } from "lib/routes/home-page-params";

import type { ExploreParams } from "./types";

/** Anything with `URLSearchParams.get`: the request's on the server, `useSearchParams()`'s in the browser. */
interface ParamSource {
  get(name: string): string | null;
}

/**
 * The board's URL, parsed the one way it has always been parsed.
 *
 * `toHomePageParamsWithDefault` did this for the server component's `searchParams` prop; the same
 * function now runs on the request in `/api/explore` and on `useSearchParams()` in the browser, so
 * a link that meant "page 3, by volume, gold only" means it in both places. Anything it rejects —
 * a page of `abc`, a pair id with a slash in it — falls to the same default it always did.
 */
export function parseExploreParams(source: ParamSource): ExploreParams {
  const raw: HomePageSearchParams = {
    page: source.get("page") ?? undefined,
    sort: (source.get("sort") ?? undefined) as HomePageSearchParams["sort"],
    order: (source.get("order") ?? undefined) as HomePageSearchParams["order"],
    bonding: undefined,
    q: source.get("q") ?? undefined,
    pair: source.get("pair") ?? undefined,
  };
  const { page, sortBy, orderBy, q, pair } = toHomePageParamsWithDefault(raw);
  return { page, sortBy, orderBy, q, pair };
}

/**
 * The canonical query string for a parsed set of params.
 *
 * Built from the PARSED values, never from the URL as typed, so `?page=abc`, `?page=1` and no
 * `page` at all are one request, one memo key and one query-cache entry.
 */
export function exploreQueryString(params: ExploreParams): string {
  const qs = new URLSearchParams();
  if (params.page !== 1) qs.set("page", String(params.page));
  qs.set("sort", params.sortBy);
  if (params.orderBy !== "desc") qs.set("order", params.orderBy);
  if (params.q) qs.set("q", params.q);
  if (params.pair) qs.set("pair", params.pair);
  return qs.toString();
}
