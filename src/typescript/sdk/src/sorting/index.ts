/**
 * Sort and order vocabulary shared by the market list and the tables.
 *
 * Lifted out of the deleted `indexer-v2` layer, which also carried Aptos row types and a PostgREST
 * client. These enums describe what a user asked for, not where the data came from.
 */

export enum SortMarketsBy {
  MarketCap = "market_cap",
  BumpOrder = "bump",
  DailyVolume = "daily_vol",
  AllTimeVolume = "all_time_vol",
  /** Launch order, newest first. */
  Newest = "newest",
  Price = "price",
  Apr = "apr",
  Tvl = "tvl",
}

export type OrderByStrings = "asc" | "desc";

/**
 * What the market list sorts by when nothing is asked for.
 *
 * Market cap — the biggest coins first. The board opened on bump order for a while (most recently
 * traded first, on the theory that every coin opens at the same price so a cap-sorted board reads
 * as a fixed list), but the front page is where a visitor sizes up the launchpad, and the coins
 * that have actually attracted money are the ones that answer that. Bump order is still one click
 * away in the sort pill.
 */
export const DEFAULT_SORT_BY = SortMarketsBy.MarketCap;

export const toOrderBy = (s: string): OrderByStrings => (s === "asc" ? "asc" : "desc");
