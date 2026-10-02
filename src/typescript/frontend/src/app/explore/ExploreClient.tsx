"use client";

import ExploreSkeleton from "components/pages/home/ExploreSkeleton";
import { useSearchParams } from "next/navigation";
import { useMemo } from "react";

import { useExplore } from "@/lib/hooks/doku/use-explore";
import { parseExploreParams } from "@/lib/queries/explore/params";

import ExplorePageComponent from "./ExplorePage";

/**
 * The board, from the browser's side of the line.
 *
 * `app/explore/page.tsx` is a static shell: no request is read on the server and nothing is
 * fetched there, so the HTML is prerendered once and served from cache (and from Cloudflare) to
 * everyone. This component is where the URL is read and the data asked for — the same URL parse
 * the server component did and the same data the server component fetched, moved across.
 *
 * `useSearchParams` is what makes the URL the source of truth for the filters, as it always was
 * (see `Board`). In a static route it also marks this subtree as client-rendered, which is why
 * the page wraps it in `<Suspense>` with the skeleton: that is the HTML a visitor gets, and the
 * board fills it in on arrival.
 */
export default function ExploreClient() {
  const searchParams = useSearchParams();
  const params = useMemo(() => parseExploreParams(searchParams), [searchParams]);
  const { data, isError } = useExplore(params);

  if (data === undefined) {
    if (isError) {
      /*
       * The first answer failed and there is no previous one to keep showing. This is the state
       * the server rendered when both of its reads failed: an empty hero and an empty grid, each
       * saying the read failed rather than that there is nothing — see `ExplorePageProps`.
       */
      return (
        <ExplorePageComponent
          markets={[]}
          numMarkets={0}
          page={params.page}
          sortBy={params.sortBy}
          query={params.q}
          pair={params.pair}
          pairCounts={{}}
          movers={[]}
          rail={[]}
          boardFailed
          leaderboardFailed
        />
      );
    }
    return <ExploreSkeleton />;
  }

  /*
   * Everything from one answer, including the params it was fetched for. While the next page or
   * sort is loading `data` is the previous answer (`keepPreviousData`), and drawing its rows under
   * the NEW page number would show page 1's coins beneath a pager pointing at page 2.
   */
  return (
    <ExplorePageComponent
      markets={data.markets}
      numMarkets={data.numMarkets}
      page={data.page}
      sortBy={data.params.sortBy}
      query={data.params.q}
      pair={data.params.pair}
      pairCounts={data.pairCounts}
      movers={data.movers}
      rail={data.rail}
      pairs={data.pairs}
      preview={data.preview}
      boardFailed={data.boardFailed}
      leaderboardFailed={data.leaderboardFailed}
    />
  );
}
