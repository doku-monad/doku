"use client";

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HotMover, RailItem } from "components/pages/home/components/hero/types";
import { useCallback } from "react";

import type { QuoteAsset } from "@/lib/assets/quote-assets";
import type { MarketModel } from "@/lib/models";
import { exploreQueryString } from "@/lib/queries/explore/params";
import type { ExploreParams, ExplorePayload } from "@/lib/queries/explore/types";
import { toMarketModelsSkippingBad } from "@/lib/queries/market-list";

import { MIN_GAP_MS } from "./board-refresh";

/** The query key's root. Invalidating it refetches every board currently on screen. */
export const EXPLORE_QUERY_KEY = "explore" as const;

/**
 * What the board renders: the payload with its rows turned back into models, and the params it
 * was fetched for, so one query entry is one consistent picture of the board.
 */
export interface ExploreView {
  params: ExploreParams;
  markets: MarketModel[];
  numMarkets: number;
  page: number;
  pairCounts: Record<string, number>;
  movers: HotMover[];
  rail: RailItem[];
  /** The quote registry, for the hero's headline and pair rail. See `ExplorePayload.pairs`. */
  pairs: QuoteAsset[];
  boardFailed: boolean;
  leaderboardFailed: boolean;
  preview: boolean;
}

async function fetchExplore(params: ExploreParams): Promise<ExploreView> {
  const res = await fetch(`/api/explore?${exploreQueryString(params)}`);
  if (!res.ok) throw new Error(`explore: ${res.status}`);
  const payload = (await res.json()) as ExplorePayload;

  if (payload.preview) {
    // The fixture, loaded only now: it is a development surface, and the chunk never ships to a
    // visitor whose indexer answered. See `lib/dev/dummy-explore`.
    const { dummyExplore } = await import("@/lib/dev/dummy-explore");
    const fixture = dummyExplore(params, Date.now());
    return {
      params,
      ...fixture,
      pairs: payload.pairs ?? [],
      boardFailed: payload.boardFailed,
      leaderboardFailed: payload.leaderboardFailed,
      preview: true,
    };
  }

  return {
    params,
    // The same conversion the server did, on the same rows: a malformed row is dropped and
    // reported, not allowed to take the board with it.
    markets: toMarketModelsSkippingBad(payload.board.items),
    numMarkets: payload.board.total,
    page: payload.board.page,
    pairCounts: payload.board.pairCounts,
    movers: payload.movers,
    rail: payload.rail,
    pairs: payload.pairs ?? [],
    boardFailed: payload.boardFailed,
    leaderboardFailed: payload.leaderboardFailed,
    preview: false,
  };
}

/**
 * The board, fetched from the browser.
 *
 * Until 2026-09-18 the rows were server props and "refresh" meant `router.refresh()` — a full
 * server render of the page per viewer per event, which is what made `/explore` the slowest route
 * on the site under load. The page is a static shell now; this is where its data comes from, and
 * `useBoardRefresh` invalidates this key on the same schedule it used to re-render the page on.
 *
 * `keepPreviousData`: flipping the sort or turning a page keeps the current grid on screen until
 * the next one has arrived, which is what a server-rendered transition did too. A fetch that
 * fails after the first success leaves the last good board up rather than blanking it, exactly
 * as a failed `router.refresh()` left the last good props in place.
 */
export function useExplore(params: ExploreParams) {
  return useQuery({
    queryKey: [
      EXPLORE_QUERY_KEY,
      params.page,
      params.sortBy,
      params.orderBy,
      params.q ?? "",
      params.pair ?? "",
    ],
    queryFn: () => fetchExplore(params),
    placeholderData: keepPreviousData,
    // The refresher owns the cadence (poll, event, visibility); TanStack's own focus refetch
    // would double it. The floor is the refresher's own minimum gap, so a board remounted within
    // it — a back navigation — is served from cache rather than fetched twice.
    staleTime: MIN_GAP_MS,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

/** The refresh `useBoardRefresh` fires: re-ask for every board on screen. */
export function useRefreshExplore(): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: [EXPLORE_QUERY_KEY] });
  }, [queryClient]);
}
