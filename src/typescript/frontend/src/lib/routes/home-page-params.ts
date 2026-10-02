import type { HomePageSearchParams } from "lib/queries/sorting/query-params";
import { toMarketDataSortByHomePage } from "lib/queries/sorting/types";

import { toOrderBy } from "@/sdk/sorting";

export interface HomePageParams {
  params?: {};
  searchParams?: HomePageSearchParams;
}

/**
 * The `?page=` parameter, or 1.
 *
 * This ran `Schemas["PositiveInteger"].safeParse` from the SDK — a four-stage zod pipeline
 * (`number | string | bigint` → coerce → finite → safe → int → positive) reached from
 * `query-params.ts`, which the board imports, which put **zod on the client** to read one integer
 * out of a query string.
 *
 * The four conditions that pipeline enforced are each one comparison, and they are all still here:
 * a number (after `Number()`, so `"3"` passes and `"3abc"` does not), finite, a safe integer, and
 * greater than zero. Anything else — an array from a repeated `?page=`, an object, `undefined`, a
 * float, `Infinity`, `1e21` — falls to the default, which is what the schema did too.
 */
export const safeParsePageWithDefault = (pageInput: unknown): number => {
  const n =
    typeof pageInput === "number"
      ? pageInput
      : typeof pageInput === "bigint"
        ? Number(pageInput)
        : /* A string has to round-trip, which is what the schema's `refine` asked for: `"3"` is a
             page number, `"03"`, `"3.0"` and `" 3"` are not. Kept exactly, so a URL that used to
             fall back to page 1 still does. */
          typeof pageInput === "string" && Number(pageInput).toString() === pageInput
          ? Number(pageInput)
          : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : 1;
};

/**
 * Normalises the board's search box.
 *
 * A bare `0x` — what the old emoji-bytes encoding produced for an empty picker — and whitespace
 * both mean "no search", and both used to reach the filter as a value, so a cleared box left the
 * board filtered to nothing.
 */
export const normalizeQuery = (q?: string | null) => {
  const trimmed = q?.trim();
  return !trimmed || trimmed === "0x" ? undefined : trimmed;
};

export const toHomePageParamsWithDefault = (searchParams: HomePageSearchParams | undefined) => {
  const {
    page: pageInput,
    sort,
    order = "desc",
    bonding: inBondingCurve,
    q: rawQuery,
    pair: rawPair,
  } = searchParams ?? {};

  // Ensure the filter is a home-page-only filter.
  const sortBy = toMarketDataSortByHomePage(sort);
  const page = safeParsePageWithDefault(pageInput);
  const orderBy = toOrderBy(order);
  const q = normalizeQuery(rawQuery);
  // The pair id is passed through, shape-checked and not membership-checked.
  //
  // It used to be resolved against `QUOTE_ASSETS`, a module constant — a synchronous lookup that
  // is gone now that the registry is fetched from the chain, and that this function (which parses
  // search params, and must stay synchronous) cannot await. The server already filters on this
  // value and answers an unknown id with an empty set, which is the same outcome the lookup
  // produced; what is checked here is only that it LOOKS like a registry id, so a hand-edited
  // `?pair=` cannot put anything else into a query string.
  const pair = rawPair && /^[a-z0-9-]{1,32}$/.test(rawPair) ? rawPair : undefined;

  return {
    page,
    sortBy,
    orderBy,
    inBondingCurve,
    q,
    pair,
  };
};
