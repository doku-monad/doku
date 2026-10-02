"use client";

import { useDokuWallet } from "context/wallet-context/DokuWalletProvider";

import { useTraderSwaps } from "@/lib/hooks/doku/use-market-live";
import { identityFor } from "@/lib/token-identity";

import type { TradeHistoryProps } from "../../types";
import TradeFeed from "../trade-history/TradeFeed";

/**
 * The connected wallet's trades on this market.
 *
 * ## Why this is the same component as the global feed
 *
 * It used to be an `EcTable` — a bordered grid with sticky headers and its own cell components —
 * sitting one tab away from a feed of soft-edged rows. Two tabs in one deck, showing the same
 * events about the same market, in two visual languages: switching between them read as navigating
 * to a different product rather than as filtering a list. They are now one row language, and the
 * only difference between the tabs is which trades are in them, which is the only difference there
 * has ever actually been.
 *
 * The data path is untouched. `useTraderSwaps` still filters server-side over the whole history —
 * narrowing the page already on screen would show an empty list to anyone whose last trade has
 * scrolled past it — and the rows are the same `SwapModel`s the global feed renders.
 *
 * ## The three empty states are three different facts
 *
 * No wallet, not loaded yet, and nothing traded are not the same answer, and a single "No trade
 * history" for all three tells someone who has not connected that they have never traded this
 * market. Each says what is actually true.
 */
export const PersonalTradeHistory = (props: TradeHistoryProps) => {
  const { address } = useDokuWallet();
  const query = useTraderSwaps(props.data.market.market.marketAddress, address);

  const emptyLabel = !address
    ? "Connect a wallet to see your trades"
    : query.isLoading
      ? "Loading your trades…"
      : "You have not traded this market";

  return (
    <TradeFeed
      swaps={query.data ?? []}
      ticker={identityFor(props.data.market.market).ticker}
      quoteDecimals={props.data.market.market.quote.decimals}
      quoteSymbol={props.data.market.market.quote.symbol ?? "MON"}
      emptyLabel={emptyLabel}
    />
  );
};
