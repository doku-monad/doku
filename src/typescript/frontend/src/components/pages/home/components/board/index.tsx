"use client";

import type { ExplorePageProps } from "app/explore/ExplorePage";
import { AnimatePresence, motion } from "framer-motion";
import { MARKETS_PER_PAGE } from "lib/queries/sorting/const";
import { constructURLForHomePage } from "lib/queries/sorting/query-params";
import { useRouter } from "next/navigation";

import useEvent from "@/hooks/use-event";
import { LIVE_FEED_URL } from "@/lib/chain/wagmi";
import { useBoardRefresh } from "@/lib/hooks/doku/use-board-refresh";
import { useRefreshExplore } from "@/lib/hooks/doku/use-explore";
import { useLiveFeed } from "@/lib/hooks/doku/use-live-feed";
import { SortMarketsBy } from "@/sdk/sorting";

import { ClientGrid } from "./ClientGrid";
import BoardSearch from "./components/BoardSearch";
import { ButtonsBlock } from "./components/buttons-block";
import LiveStatus from "./components/LiveStatus";
import PairFilter from "./components/PairFilter";
import SortKey from "./components/SortKey";
import EmptyGrid from "./EmptyGrid";
import { useGridRowLength } from "./hooks/use-grid-items-per-line";

/*
 * The board's slice of the page's props.
 *
 * The omit list carried `"stats" | "priceFeed" | "meleeData"` — three keys that do not exist on
 * `ExplorePageProps` and have not for some time, so they omitted nothing. Dropped.
 *
 * `boardFailed` arrives as plain `failed`: from in here there is only one read that matters, and a
 * component should not have to know it was named for the half of the page it belongs to.
 */
interface BoardProps
  extends Omit<
    ExplorePageProps,
    "movers" | "rail" | "children" | "boardFailed" | "leaderboardFailed"
  > {
  /** Whether the market read failed, as opposed to returning nothing. See `EmptyGrid`. */
  failed?: boolean;
}

/**
 * The board: every coin trading on DOKU, with the controls that narrow it.
 *
 * Filtering state lives entirely in the URL. That is not incidental — the filtered board is the
 * thing people send each other, and a control whose state is only in React produces a link that
 * shows the sender something different from the recipient. Every control here pushes a route and
 * reads its value back from props.
 */
const Board = (props: BoardProps) => {
  const router = useRouter();

  /*
   * Derived directly, not through `useMemo`.
   *
   * This whole block sat inside `useMemo(..., [props])`. The dependency was the props OBJECT, which
   * is a new reference on every render of the parent — so the memo missed every single time while
   * still paying for the dependency compare and the allocation. What it guards is one `??`, one
   * `Math.ceil` and a reduce over a handful of pair counts, which is cheaper than the check.
   */
  const { markets, page, sort, pages, query, pair, pairCounts, numMarkets, acrossPairs } = (() => {
    const { markets, page, sortBy: sort, pair, pairCounts } = props;
    /*
     * The true count, and the floor kept local to the arithmetic that needs it.
     *
     * `Math.max(props.numMarkets, 1)` exists so an empty board still has one page rather than
     * zero. It was assigned to `numMarkets` itself, so the floored value also reached the
     * readout — and an empty board announced "1 markets": a number nobody has and a plural
     * nothing agrees with. The floor belongs to `pages`, which is the only thing that wanted it.
     */
    const numMarkets = Number.isFinite(props.numMarkets) ? props.numMarkets : 0;
    /*
     * At least one page, always, and never `NaN`.
     *
     * `total` is typed `number` but arrives off the wire, and the note in `explore/page.tsx`
     * records a contract that does not carry one at all — so `undefined` reaching here is a real
     * shape, not a defensive fiction. It used to flow through as `NaN`, which `ButtonsBlock`
     * happened to survive because `NaN <= 1` is false: the pager rendered, over a page count
     * nobody could read. Both halves are wrong; this one is wrong in the direction of showing a
     * control that works.
     */
    const pages = Math.max(1, Math.ceil(Math.max(numMarkets, 1) / MARKETS_PER_PAGE));
    const query = props.query ?? "";
    /*
     * What the "All" chip counts.
     *
     * `numMarkets` is the size of the board as filtered, so with a pair selected it is that
     * pair's count — and putting it on the All chip made every chip in the row read the same
     * number as the selected one. The service counts `pairCounts` over the current search MINUS
     * the pair predicate precisely so the chips say what clicking them would find, and their sum
     * is therefore the honest "every pair" figure.
     */
    const acrossPairs = Object.values(pairCounts).reduce((n, c) => n + c, 0);
    return { markets, page, sort, pages, query, pair, pairCounts, numMarkets, acrossPairs };
  })();

  const pushURL = useEvent(
    (args?: { page?: number; sort?: SortMarketsBy; q?: string; pair?: string | undefined }) => {
      const newURL = constructURLForHomePage({
        page: args?.page ?? page,
        sort: args?.sort ?? sort,
        q: args?.q ?? query,
        // `undefined` is a real value for this one — it means "all pairs" — so the caller's intent
        // cannot be recovered with `??`, which would read a deliberate clear as "leave it alone".
        pair: args && "pair" in args ? args.pair : pair,
      });

      router.push(newURL.toString(), { scroll: false });
    }
  );

  const handlePageChange = (page: number) => {
    const newPage = Math.min(Math.max(1, page), pages);
    pushURL({ page: newPage });
  };

  const handleSortChange = (newSort: SortMarketsBy) => {
    pushURL({ sort: newSort });
  };

  // Both of these reset to page one. Staying on page 4 of a board that just became six results
  // long shows an empty grid and a pager that disagrees with it.
  const handleSearchChange = (q: string) => pushURL({ page: 1, q });
  const handlePairChange = (next: string | undefined) => pushURL({ page: 1, pair: next });

  /**
   * One subscription for the whole table.
   *
   * The badge wants to know the socket is alive; the grid wants the trades themselves, so a card
   * can pulse as one lands on it. Subscribing in both places would open two sockets carrying
   * identical traffic.
   */
  // The rows come from `/api/explore` (`useExplore`); this is what makes them move. A socket
  // event re-asks within ~1.2 s (coalesced), and a visible tab re-asks every 15 s regardless.
  // The schedule is the one that used to drive `router.refresh()` when the rows were server props.
  const refresher = useBoardRefresh(useRefreshExplore());
  const { flashes } = useLiveFeed(LIVE_FEED_URL, refresher.onEvent);

  const rowLength = useGridRowLength();

  return (
    <>
      {/* Pagination lives below the grid only. The duplicate above it sat between the hero and the
          toolbar, where there was nothing yet to page through. */}
      {/* One element where there were three nested flex boxes — see `.doku-board-grid`. */}
      <div className="flex w-full max-w-full flex-col items-center border-t border-solid border-line">
        {/*
              Two rows, not four.

              The first names the thing and orders it; the second narrows it. They were one row
              once, and at four controls it became a strip of unrelated widgets — a sort pill next
              to a search field next to a live badge, none of which are the same kind of verb.
              Splitting them puts "what am I looking at" above "which part of it", which is the
              order somebody reads a board in.

              On a phone those two rows had become **four**: the heading and the sort control each
              took a line (`#emoji-grid-header` was `flex-direction: column` below 768px), then the
              chips, then the search field. About 200px of an 844px screen, spent on controls,
              above the first coin — and the last of the four was a full-width text input that most
              visitors never touch. Both halves are fixed here rather than in the stylesheet: the
              heading's readout is one compact plate, the sort key drops its `SORT` label and shows
              a short form of the value, and the search collapses to a key at the end of the chip
              row that slides open over it (see `BoardSearch`). Two rows at every width, ~90px on a
              phone, and nothing was removed to get there.

              The header used to be a `motion.div` keyed on `rowLength` with an `exit` transition
              and no `AnimatePresence` above it — so the exit never ran, and the key remounted the
              toolbar (and re-fired the indexer status query inside it) every time the grid changed
              column count. A plain element does everything that one did.

              `id="emoji-grid-header"` stays: the hero's "browse the board" action scrolls to it,
              and `scroll-margin-top` in `global.css` is what keeps the sticky bar off it.
            */}
        <div
          id="emoji-grid-header"
          className="flex h-[42px] w-full shrink-0 items-center justify-between gap-3 sm:h-[var(--toolbar-h)]"
        >
          <LiveStatus numMarkets={numMarkets} />
          <SortKey value={sort ?? SortMarketsBy.MarketCap} onChange={handleSortChange} />
        </div>

        {/*
              The narrowing row: the pair chips and the search field, sharing one line at every
              width.

              It used to carry `doku-board-row`, which is the RunnerBoard's *list row* — a hover
              fill, an accent inset rim and an `:active` fill (`global.css`, "A row"). The toolbar
              wore it only to be matched by a pair of `:has()` rules that hid the chips behind the
              open search; what it got with them was a filter bar that lit up and shifted under the
              pointer as though it were a row you could click. Both the class and those rules are
              gone — the search no longer covers anything, so there is nothing to hide.

              No `relative` and no right-hand gutter either. Both were the search field's: it was
              absolutely placed against this box below `sm` so that opening it covered the chips.
              It is an ordinary item on the line now. See `BoardSearch`.
            */}
        <div className="flex w-full items-center gap-2 border-t border-solid border-line pt-3 sm:justify-between sm:gap-4 sm:pt-3.5">
          {/* The tray takes what the field leaves on a phone and shrink-wraps from `sm` up. Its
                  own scroller is what absorbs the difference. */}
          <PairFilter
            className="min-w-0 flex-1 sm:flex-none"
            active={pair}
            counts={pairCounts}
            total={acrossPairs}
            onChange={handlePairChange}
          />
          <BoardSearch value={query} onChange={handleSearchChange} />
        </div>

        {/* Each version of the grid must wait for the other to fully exit animate out before appearing.
                This provides a smooth transition from grids of varying row lengths. */}
        {markets.length > 0 ? (
          <>
            <AnimatePresence mode="wait">
              <motion.div
                className="relative mt-5 h-full w-full"
                id="emoji-grid"
                key={rowLength}
                style={{
                  // The grid fills the content rail; only the column count varies, and the
                  // tracks divide the available width between them. Pinning a pixel width here
                  // is what left the grid narrower than the header and toolbar.
                  "--grid-cols": rowLength,
                  width: "100%",
                }}
                exit={{
                  opacity: 0,
                  transition: {
                    duration: 0.35,
                    type: "just",
                  },
                }}
              >
                <div className="doku-board-grid">
                  <ClientGrid markets={markets} page={page} sortBy={sort} flashes={flashes} />
                </div>
              </motion.div>
            </AnimatePresence>
          </>
        ) : (
          <EmptyGrid
            searched={query}
            failed={props.failed}
            /* So the empty panel can name the asset rather than claiming the whole board is
                   empty — which, with a pair selected, is false. */
            pair={pair}
            /* Only when there is somewhere to go back TO. `ButtonsBlock` refuses to draw
                   itself at one page — correctly, it is not a thing to page through — so on a
                   board that has shrunk under this page the way out has to live here. */
            onFirstPage={page > 1 ? () => handlePageChange(1) : undefined}
          />
        )}

        {/*
              The pager, outside the branch that draws the grid.

              It was inside it, so it existed only when there was something to page through — and
              the one state that most needs a way out is the one with nothing in it. Land on
              `?page=99`, or sit on page 4 of a board that shrank under a new search, and there was
              an empty grid, no pager, and no route back but the address bar.

              Held back on a failed read: there is no list to be on page two of, and offering to
              page through an outage is furniture.

              A page BEYOND the end is not solved here. `ButtonsBlock` returns null at one page —
              it is not a control that can represent "you are on page 3 of 1", and inflating
              `numPages` to reach would draw two cells with nothing behind them. That way out is
              `EmptyGrid`'s, above.
            */}
        {pages > 1 && !props.failed && (
          <ButtonsBlock
            className="mt-[30px]"
            value={page}
            onChange={handlePageChange}
            numPages={pages}
          />
        )}
      </div>
    </>
  );
};

export default Board;
