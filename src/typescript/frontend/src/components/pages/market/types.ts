import type { HolderModel, MarketModel, SwapModel } from "@/lib/models";

/**
 * Everything the market page renders from.
 *
 * Previously this carried a `MarketMetadataModel`, a `Types["MarketView"]` read straight off an
 * Aptos resource, and Aptos-shaped balance rows. All three are gone: there is no on-chain resource
 * to read a view struct from, and balances come from the indexer, which counts them from transfer
 * logs.
 */
export interface MarketPageData {
  market: MarketModel;
  swaps: SwapModel[];
  holders: HolderModel[];
}

export interface MarketProps {
  data: MarketPageData;
}

export interface MainInfoProps {
  market: MarketModel;
}

export interface GridProps {
  data: MarketPageData;
  market: MarketModel;
}

export interface TradeHistoryProps {
  data: MarketPageData;
}

export interface SwapComponentProps {
  market: MarketModel;
  /** Rendered while the first swap count loads, so the panel does not jump. */
  initNumSwaps: number;
}
