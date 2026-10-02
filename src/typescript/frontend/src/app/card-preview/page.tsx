import ExplorePage from "app/explore/ExplorePage";
import generateMetadataHelper from "lib/utils/generate-metadata-helper";
import { notFound } from "next/navigation";

import { dummyMarkets, previewEnabled } from "@/lib/dev/dummy-markets";
import { SortMarketsBy } from "@/sdk/sorting";

/*
 * An internal preview route, and it gets a title for the same reason the public ones do: these are
 * opened four at a time beside the pages they mirror, and four tabs reading
 * `Doku | A Launchpad on Monad` are four tabs nobody can tell apart.
 */
export const metadata = generateMetadataHelper({
  title: "Coin card preview",
  description: "The board's card in each of its states.",
});

/**
 * The card grid, on fabricated data.
 *
 * A development surface for looking at the market card in situ — the real `ExplorePage`, the real
 * grid, the real page frame, the real bar and footer — without an indexer running. The card is the
 * most design-heavy thing in the product and the hardest to judge one at a time; this is the only
 * way to see forty of them respond to a pointer while the backend is down.
 *
 * `notFound()` unless `DOKU_CARD_PREVIEW=true` is set. That opt-in replaces a `NODE_ENV` check
 * that a production build silently folded away, shipping this page — see the post-mortem in
 * `lib/dev/dummy-markets.ts`. The route renders numbers that are not true on a surface where every
 * other number is, and "it is only reachable if you know the URL" is not a control.
 */
export const dynamic = "force-dynamic";

export default function CardPreviewPage() {
  if (!previewEnabled) notFound();

  // Passed in rather than read inside the builder, so the server render and the hydrating client
  // render compute identical ages instead of tripping a hydration mismatch on the age column.
  const markets = dummyMarkets(Date.now());

  return (
    <>
      {/*
        Unmissable, and above the grid rather than beside it.

        A screenshot of this page will end up in a pull request or a chat sooner or later, and it
        has to be self-evidently fake in the screenshot, not only to whoever typed the URL.
      */}
      <div
        className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[12px] px-4 py-3"
        style={{
          background: "linear-gradient(180deg, rgba(255,135,9,0.16) 0%, rgba(255,135,9,0.05) 100%)",
          boxShadow: "inset 0 0 0 1px rgba(255,135,9,0.30)",
        }}
      >
        <span className="font-numeric text-[11px] uppercase tracking-[0.1em] text-warn-ink">
          Preview data
        </span>
        <span className="font-ui text-[14px] text-ash">
          Every market on this page is fabricated, including the prices. Gated behind
          DOKU_CARD_PREVIEW; without it this route is a 404.
        </span>
      </div>

      <ExplorePage
        markets={markets}
        numMarkets={markets.length}
        page={1}
        sortBy={SortMarketsBy.MarketCap}
        /* The hero leaderboard takes real 24-hour figures and a candlestick series per row, and
           this route has neither — it fabricates markets to look at the card treatment. An empty
           list is the honest input: the hero renders its own "no trades in the last 24 hours"
           state rather than four rows of invented volume beside a banner promising fabrication. */
        movers={[]}
        rail={[]}
        // Counted from the fixture rather than left empty, so the chips agree with the grid — a
        // preview whose "MON 0" chip sits above twelve MON markets is a preview that teaches you
        // the wrong thing about the control.
        pairCounts={{ mon: markets.length }}
      />
    </>
  );
}
