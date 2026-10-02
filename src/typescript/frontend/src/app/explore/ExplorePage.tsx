import Board from "components/pages/home/components/board";
import ExploreHero from "components/pages/home/components/hero/ExploreHero";
import type { HotMover, RailItem } from "components/pages/home/components/hero/types";
import type { MarketDataSortByHomePage } from "lib/queries/sorting/types";

import PreviewBanner from "@/components/dev/PreviewBanner";
import PageFrame from "@/components/layout/PageFrame";
import type { QuoteAsset } from "@/lib/assets/quote-assets";
import type { MarketModel } from "@/lib/models";

export interface ExplorePageProps {
  markets: MarketModel[];
  numMarkets: number;
  page: number;
  sortBy: MarketDataSortByHomePage;
  /** The board's free-text search: a name, a ticker, or an address. */
  query?: string;
  /** The quote asset the board is filtered to, by registry id. */
  pair?: string;
  /** How many markets each quote asset has, over the current search. Keyed by registry id. */
  pairCounts: Record<string, number>;
  children?: React.ReactNode;
  /** The hero leaderboard: the four markets with the most volume in the last 24 hours. */
  movers: HotMover[];
  /** The full-bleed tape under the hero: the largest markets, by cap. */
  rail: RailItem[];
  /** The quote registry, for the hero's headline and pair rail. Absent or empty, it reads its own. */
  pairs?: QuoteAsset[];
  /**
   * Whether every market on this page is fabricated.
   *
   * True on `/card-preview`, and on `/explore` when the indexer returned nothing *and*
   * `DOKU_CARD_PREVIEW` is set — see `lib/dev/dummy-markets.ts`. It only ever changes what the
   * banner says; the page below it is the real page either way, which is the point of looking at
   * it. Anywhere the flag is missing this is `false` and the fixture never loads.
   */
  preview?: boolean;
  /**
   * Whether the read behind each half of this page FAILED, as opposed to returning nothing.
   *
   * `explore/page.tsx` catches both into empty results so one dead endpoint cannot take the route
   * down. Without these flags an outage and an empty chain rendered identically, and the board
   * announced "No markets yet" on a 500 — a statement about the protocol made from a network
   * error. Two flags rather than one because the two requests fail independently: the board can
   * load while the leaderboard does not.
   */
  boardFailed?: boolean;
  leaderboardFailed?: boolean;
}

/*
 * Not `async`. It never awaited anything, and it is rendered by `ExploreClient` — a client
 * component — as well as by `/card-preview`, and an async component cannot be rendered on the
 * client side of the boundary.
 */
export default function ExplorePage({
  markets,
  numMarkets,
  page,
  sortBy,
  query,
  pair,
  pairCounts,
  children,
  movers,
  rail,
  pairs = [],
  preview,
  boardFailed,
  leaderboardFailed,
}: ExplorePageProps) {
  /*
   * Two frames, not one.
   *
   * Every other route sits inside the single panel `PageFrame` wraps around it in `providers.tsx`.
   * This route is the one with two genuinely different jobs stacked on it — the pitch and the
   * 24-hour leaderboard, then the full market grid — and running one continuous ground under both
   * made them read as one long undifferentiated column.
   *
   * `doku-split` opts this route out of the global frame (see `global.css`) and the two sections
   * below carry their own, so each has its own tray, rim and lit edge. The dissolve rule is scoped
   * with `>` precisely so it clears the outer frame without also clearing these.
   */
  return (
    <div className="doku-split relative">
      {preview && (
        <div className="px-1">
          <PreviewBanner />
        </div>
      )}

      {/* `pb-4 sm:pb-6` evens the frame up. `PageFrame`'s default is `pb-7 pt-4 sm:pb-12 sm:pt-6` —
          a page margin, which is right for the long grid below but wrong here: the hero's own panel
          ends where its content does, so the frame was left holding 48px of empty ground under it
          against 24px above and 19px either side. Matched to the top. */}
      <PageFrame className="mb-4 pb-4 sm:pb-6">
        <ExploreHero movers={movers} rail={rail} pairs={pairs} failed={leaderboardFailed} />
        {children}
      </PageFrame>

      <PageFrame>
        <Board
          markets={markets}
          numMarkets={numMarkets}
          page={page}
          sortBy={sortBy}
          query={query}
          pair={pair}
          pairCounts={pairCounts}
          failed={boardFailed}
        />
      </PageFrame>
    </div>
  );
}
