import ExploreSkeleton from "components/pages/home/ExploreSkeleton";
import { SITE_DESCRIPTION } from "configs/meta";
import generateMetadataHelper from "lib/utils/generate-metadata-helper";
import { Suspense } from "react";

import ExploreClient from "./ExploreClient";

/*
 * The board's own title.
 *
 * It had none, so it fell through to the layout's `title.default` and every tab of it read
 * `Doku | A Launchpad on Monad` — identical to the maintenance screen, the preview routes and a
 * 404. A tab title is a wayfinding label first: with four of this site open, the one thing it has
 * to do is tell them apart.
 */
/*
 * The site's own sentence, not this page's.
 *
 * `/` redirects here, so this route *is* the landing card: the description a crawler indexes for
 * the bare domain and the one that renders under a link pasted into a chat. A page-specific line
 * about sorting and filtering is the right copy for a page somebody navigated to on purpose and
 * the wrong copy for the first thing anyone reads about DOKU.
 *
 * Kept in step with `DEFAULT_DESCRIPTION` in `configs/meta.ts`, which is where it is written down
 * and where the character budget is explained.
 */
export const metadata = generateMetadataHelper({
  title: "Explore coins",
  description: SITE_DESCRIPTION,
});

/**
 * The board's shell. Static on purpose, and it must stay that way.
 *
 * ## What this page used to be
 *
 * A server component that read `searchParams`, fetched the board and the leaderboard from the
 * indexer with `no-store`, drew four sparklines, and handed the lot to the client as props. Every
 * one of those is a reason Next cannot cache the render: the page was `ƒ (Dynamic)`, rendered from
 * scratch for every visitor and again for every `router.refresh()` the live feed triggered — one
 * full server render, plus two to six indexer round trips, per viewer per event. The load test
 * measured that at ten to twenty-five renders a second per instance, with the page's own
 * `revalidate = 2` inert the whole time, because a dynamic route has nothing to revalidate.
 *
 * ## What it is now
 *
 * Nothing here touches the request. The HTML — the frame, the metadata, the skeleton — is
 * prerendered at build and served from cache; `ExploreClient` reads the URL and fetches
 * `/api/explore` from the browser, on the same poll-and-live-feed schedule that used to re-render
 * this page (`useBoardRefresh`). The data is exactly as fresh as it was: the API route runs the
 * same loader (`lib/queries/explore/load.ts`) with the same `no-store` reads, and nothing in
 * between holds an answer for longer than the board's own debounce (`lib/api/short-memo`).
 *
 * ## Keeping it static
 *
 * No `searchParams`, no `headers()`, no `cookies()`, no fetch — in this file OR in the root
 * layout. `next build` lists this route with `○`; a `ƒ` is a regression, whatever else the build
 * says. The `<Suspense>` boundary is load-bearing too: `useSearchParams` inside a static route
 * renders its subtree on the client, and the boundary is what lets the rest of the page be HTML.
 */
export default function Explore() {
  return (
    <Suspense fallback={<ExploreSkeleton />}>
      <ExploreClient />
    </Suspense>
  );
}
