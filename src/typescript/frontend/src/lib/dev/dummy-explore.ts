import type { HotMover, RailItem } from "components/pages/home/components/hero/types";
import { MARKETS_PER_PAGE } from "lib/queries/sorting/const";

import { quoteAmountNumber } from "@/lib/chain/quote-scale";
import { dummyDrawdown, dummyMarkets, dummySpark } from "@/lib/dev/dummy-markets";
import type { MarketModel } from "@/lib/models";
import { queryToNeedle } from "@/lib/queries/explore/needle";
import { railOf } from "@/lib/queries/explore/rail";
import {
  type ExploreParams,
  HOT_MOVERS,
  RAIL_ITEMS,
  SPARK_BUCKETS,
} from "@/lib/queries/explore/types";
import { identityFor } from "@/lib/token-identity";
import { SortMarketsBy } from "@/sdk/sorting";

/**
 * The board's preview fixture, run through the board's own controls.
 *
 * This was the `preview` branch of `app/explore/page.tsx`. It now runs in the browser — loaded on
 * demand by `useExplore` only when `/api/explore` says `preview: true`, so it costs the production
 * bundle nothing — because the fixture's models carry `bigint`s and cannot be sent as JSON.
 *
 * The fixture is sorted and sliced here rather than by the service, for the obvious reason: there
 * is no service. That is the only client-side ordering left on this route. Not because filtering
 * fourteen rows is worth doing, but because a preview whose sort pill, pair chips and search box
 * are inert is a preview of half the component. Every one of them is SQL on the real path; this is
 * the only place a client-side board survives, and it survives exactly as far as the fixture.
 */
export interface DummyExplore {
  markets: MarketModel[];
  numMarkets: number;
  page: number;
  pairCounts: Record<string, number>;
  movers: HotMover[];
  rail: RailItem[];
}

export function dummyExplore({ page, sortBy, q, pair }: ExploreParams, now: number): DummyExplore {
  const needle = q ? queryToNeedle(q) : undefined;
  const all = dummyMarkets(now);
  const searched = needle
    ? all.filter((m) => {
        const identity = identityFor(m.market);
        return (
          identity.name.toLowerCase().includes(needle) ||
          identity.ticker.toLowerCase().includes(needle) ||
          m.market.symbol.includes(needle) ||
          m.market.marketAddress.toLowerCase().includes(needle)
        );
      })
    : all;

  const pairCounts: Record<string, number> = {};
  for (const m of searched) {
    const id = identityFor(m.market).quote.id;
    pairCounts[id] = (pairCounts[id] ?? 0) + 1;
  }

  const markets = (
    pair ? searched.filter((m) => identityFor(m.market).quote.id === pair) : searched
  )
    .slice()
    .sort((a, b) => {
      switch (sortBy) {
        case SortMarketsBy.BumpOrder:
        case SortMarketsBy.Newest:
          return b.market.launchedAt.getTime() - a.market.launchedAt.getTime();
        case SortMarketsBy.DailyVolume:
          return Number(b.state.volume24h - a.state.volume24h);
        default:
          return Number(b.state.marketCap - a.state.marketCap);
      }
    });

  const start = (page - 1) * MARKETS_PER_PAGE;

  const movers: HotMover[] = markets.slice(0, HOT_MOVERS).map((m, i) => {
    const identity = identityFor(m.market);
    const spark = dummySpark(m.market.marketAddress, dummyDrawdown(i), SPARK_BUCKETS);
    const first = spark[0];
    const last = spark[spark.length - 1];
    return {
      address: m.market.marketAddress,
      tokenAddress: m.market.tokenAddress,
      name: identity.name,
      ticker: identity.ticker,
      logo: identity.logo,
      marketCap: quoteAmountNumber(m.state.marketCap, m.market.quote.decimals),
      marketCapUsd: m.state.marketCapUsd,
      quoteSymbol: m.market.quote.symbol,
      lastSwapAt: now - (i + 1) * 7 * 60_000,
      changePct: ((last - first) / first) * 100,
      spark,
      volume24h: quoteAmountNumber(m.state.volume24h, m.market.quote.decimals),
      volume24hUsd: null,
    };
  });

  /* The tape is the latest coins whatever the grid is filtered or sorted by — as on the real path. */
  const rail: RailItem[] = all
    .slice()
    .sort((a, b) => b.market.launchedAt.getTime() - a.market.launchedAt.getTime())
    .slice(0, RAIL_ITEMS)
    .map(railOf);

  return {
    markets: markets.slice(start, start + MARKETS_PER_PAGE),
    numMarkets: markets.length,
    page,
    pairCounts,
    movers,
    rail,
  };
}
