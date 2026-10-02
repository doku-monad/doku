import type { HotMover, RailItem } from "components/pages/home/components/hero/types";
import type { MarketDataSortByHomePage } from "lib/queries/sorting/types";

import type { MarketRow } from "@/lib/api/markets";
import type { QuoteAsset } from "@/lib/assets/quote-assets";

/**
 * The board's URL state, parsed. What `/api/explore` is asked for and what the query is keyed by.
 */
export interface ExploreParams {
  page: number;
  sortBy: MarketDataSortByHomePage;
  orderBy: "asc" | "desc";
  q?: string;
  pair?: string;
}

/**
 * Everything `/explore` draws, as one JSON document.
 *
 * This is the shape the page's server component used to hand its client components as props. It
 * is now the body of `/api/explore`, which the page fetches from the browser — the page itself is
 * a static shell — so it has to survive `JSON.stringify`. `HotMover` and `RailItem` already do
 * (they were flattened for the RSC boundary for the same reason); the board rows are shipped as
 * the indexer's own wire rows, which are all strings and numbers, and turned into `MarketModel`s
 * (with their `bigint`s) by `toMarketModelsSkippingBad` on the client, exactly as the server did.
 */
export interface ExplorePayload {
  board: {
    items: MarketRow[];
    /** The size of the FILTERED set, not of the table. What the pager divides. */
    total: number;
    page: number;
    /** How many markets each quote asset has, over the current search. Keyed by registry id. */
    pairCounts: Record<string, number>;
  };
  movers: HotMover[];
  rail: RailItem[];
  /**
   * The quote registry, for the hero's headline and pair rail — so they name the live pairs on
   * their first render instead of a placeholder the browser then retypes. Empty if that read
   * failed; the hero then reads the registry itself. See `usePairCycle`.
   */
  pairs: QuoteAsset[];
  /** Whether each half FAILED, as opposed to returning nothing. See `ExplorePageProps`. */
  boardFailed: boolean;
  leaderboardFailed: boolean;
  /**
   * The indexer returned nothing and `DOKU_CARD_PREVIEW` is set on the server. The client then
   * loads the fixture — the server cannot ship it, its models carry `bigint`s — see
   * `lib/dev/dummy-explore`.
   */
  preview: boolean;
}

/** The hero's four rows. */
export const HOT_MOVERS = 4;

/**
 * The sparkline's window: 96 fifteen-minute buckets, which is exactly 24 hours.
 *
 * 900 is one of the five periods the indexer buckets to (`app/api/candlesticks/route.ts`), and the
 * same one `LivelineChart` uses for its `1D` range — so the hero's trace and the market page's chart
 * are drawn from identical data rather than from two different resamplings of it.
 */
export const SPARK_PERIOD_SECS = 900;
export const SPARK_BUCKETS = 96;

/** How many coins the tape carries before it repeats. */
export const RAIL_ITEMS = 14;

/** The window the hero's figures and its "+4.2%" column are measured over. */
export const HERO_WINDOW = "24h" as const;
