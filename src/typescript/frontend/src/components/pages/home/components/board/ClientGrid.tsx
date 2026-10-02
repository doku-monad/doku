"use client";

import type { ExplorePageProps } from "app/explore/ExplorePage";
import { MARKETS_PER_PAGE } from "lib/queries/sorting/const";
import type { MarketDataSortByHomePage } from "lib/queries/sorting/types";
import { useEffect, useRef } from "react";

import type { TradeFlashes } from "@/lib/trade-flash";

import TableCard from "../table-card/TableCard";
import { useGridRowLength } from "./hooks/use-grid-items-per-line";

export const ClientGrid = ({
  markets,
  page,
  sortBy,
  flashes = {},
}: {
  markets: ExplorePageProps["markets"];
  page: number;
  sortBy: MarketDataSortByHomePage;
  /** Markets that just traded, and which way. */
  flashes?: TradeFlashes;
}) => {
  const rowLength = useGridRowLength();

  const initialRender = useRef(true);

  useEffect(() => {
    initialRender.current = false;

    return () => {
      initialRender.current = true;
    };
  }, []);

  return (
    <>
      {markets.map((market, i) => (
        <TableCard
          key={market.market.marketAddress}
          index={i}
          pageOffset={(page - 1) * MARKETS_PER_PAGE}
          market={market}
          rowLength={rowLength}
          prevIndex={i}
          runInitialAnimation={true}
          sortBy={sortBy}
          flash={flashes[market.market.marketAddress]}
          data-testid="market-grid-item"
        />
      ))}
    </>
  );
};
