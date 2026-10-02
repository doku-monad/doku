import type { MarketDataSortByHomePage } from "lib/queries/sorting/types";

import type { MarketModel } from "@/lib/models";
import type { TradeFlash } from "@/lib/trade-flash";

export type TableCardProps = {
  index: number;
  market: MarketModel;
  prevIndex?: number;
  /** Set for a few seconds after a trade lands on this market, so the card can pulse. */
  flash?: TradeFlash;
};

export type GridLayoutInformation = {
  rowLength: number;
  pageOffset: number;
  sortBy: MarketDataSortByHomePage;
  runInitialAnimation?: boolean;
};
