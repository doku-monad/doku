import { safeParsePageWithDefault } from "lib/routes/home-page-params";

import { DEFAULT_SORT_BY, type OrderByStrings, type SortMarketsBy } from "@/sdk/sorting";

import { type SortByPageQueryParams, toMarketDataSortByHomePage } from "./types";

export type HomePageSearchParams = {
  page: string | undefined;
  sort: SortByPageQueryParams | undefined;
  order: OrderByStrings | undefined;
  bonding: boolean | undefined;
  /**
   * The board's search box.
   *
   * Free text now — a name, a ticker, or a contract address. It carried hex-encoded emoji bytes
   * when the only thing a market had was an emoji symbol, and links in that form still work: see
   * `queryToNeedle` in the explore page, which decodes a leading `0x` back to its glyphs before
   * matching. Breaking every shared link to a filtered board would be a poor trade for a tidier
   * parameter.
   */
  q: string | undefined;
  /** The quote asset the board is filtered to, by registry id. Absent means all pairs. */
  pair: string | undefined;
};

export const constructURLForHomePage = ({
  page,
  sort,
  q,
  pair,
}: {
  page?: number;
  sort?: SortMarketsBy;
  q?: string;
  pair?: string;
}) => {
  const newURL = new URL(location.href);
  newURL.searchParams.delete("page");
  newURL.searchParams.delete("sort");
  newURL.searchParams.delete("q");
  newURL.searchParams.delete("pair");

  const safePage = safeParsePageWithDefault(page);
  if (safePage !== 1) {
    newURL.searchParams.set("page", safePage.toString());
  }
  const query = q?.trim();
  if (query) {
    newURL.searchParams.set("q", query);
  }
  if (pair) {
    newURL.searchParams.set("pair", pair);
  }
  const newSort = toMarketDataSortByHomePage(sort);
  if (newSort !== DEFAULT_SORT_BY) {
    newURL.searchParams.set("sort", newSort);
  }

  return newURL;
};
