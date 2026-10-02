"use client";

import { useQuery } from "@tanstack/react-query";

import type { HolderModel, MarketModel, SwapModel } from "@/lib/models";

/**
 * Keeps a market page current.
 *
 * Polling, not a websocket. The previous implementation subscribed to an Aptos-specific broker
 * service; the DOKU indexer has no socket, and adding one to serve a page that is already
 * re-rendering on a two-second revalidate would be infrastructure bought for very little. If the
 * feel turns out to want sub-second updates, this hook is the single place that changes.
 *
 * Server-rendered data seeds the cache, so the first paint has no spinner and the poll only ever
 * replaces content that is already on screen.
 */

const POLL_MS = 4_000;

type SerializedSwap = Omit<SwapModel, "swap" | "block"> & {
  swap: Record<keyof SwapModel["swap"], string | boolean | null | undefined>;
  block: { number: string; txHash: string; time: string };
};

const reviveSwap = (s: SerializedSwap): SwapModel => ({
  id: s.id,
  market: s.market,
  swap: {
    trader: s.swap.trader as string,
    isSell: s.swap.isSell as boolean,
    venue: (s.swap.venue as SwapModel["swap"]["venue"]) ?? "curve",
    quoteVolume: BigInt(s.swap.quoteVolume as string),
    quoteRaised: BigInt(s.swap.quoteRaised as string),
    baseVolume: BigInt(s.swap.baseVolume as string),
    price: BigInt(s.swap.price as string),
    // The route sends the resolved price beside the raw one; `null` when it could not resolve the
    // market's generation. Revived rather than recomputed — this hook has no market row to ask.
    priceQuote:
      s.swap.priceQuote === null || s.swap.priceQuote === undefined
        ? null
        : BigInt(s.swap.priceQuote as string),
    fee: BigInt(s.swap.fee as string),
    tax: BigInt(s.swap.tax as string),
  },
  block: {
    number: BigInt(s.block.number),
    txHash: s.block.txHash,
    time: new Date(s.block.time),
  },
});

export function useLiveSwaps(marketAddress: string, initial: SwapModel[]) {
  return useQuery({
    queryKey: ["swaps", marketAddress],
    initialData: initial,
    // The server rendered `initial` moments ago; without this the first poll fired on mount and
    // re-fetched what was already on screen.
    staleTime: POLL_MS,
    refetchInterval: POLL_MS,
    queryFn: async (): Promise<SwapModel[]> => {
      const res = await fetch(`/api/markets/${marketAddress}/swaps?limit=50`);
      if (!res.ok) throw new Error(`swaps: ${res.status}`);
      const body = (await res.json()) as { items: SerializedSwap[] };
      return body.items.map(reviveSwap);
    },
  });
}

/** One trader's history on a market, filtered server-side so the list is actually complete. */
export function useTraderSwaps(marketAddress: string, trader: string | undefined) {
  return useQuery({
    queryKey: ["swaps", marketAddress, trader],
    enabled: Boolean(trader),
    refetchInterval: POLL_MS,
    queryFn: async (): Promise<SwapModel[]> => {
      const res = await fetch(
        `/api/markets/${marketAddress}/swaps?limit=100&trader=${trader}`,
      );
      if (!res.ok) throw new Error(`swaps: ${res.status}`);
      const body = (await res.json()) as { items: SerializedSwap[] };
      return body.items.map(reviveSwap);
    },
  });
}

export function useLiveHolders(marketAddress: string, initial: HolderModel[]) {
  return useQuery({
    queryKey: ["holders", marketAddress],
    initialData: initial,
    // Holders move far more slowly than trades, and the list is a bigger response.
    staleTime: POLL_MS * 5,
    refetchInterval: POLL_MS * 5,
    queryFn: async (): Promise<HolderModel[]> => {
      const res = await fetch(`/api/markets/${marketAddress}/holders?limit=50`);
      if (!res.ok) throw new Error(`holders: ${res.status}`);
      const body = (await res.json()) as {
        items: { holder: string; balance: string; share?: string; label?: HolderModel["label"] }[];
      };
      // `share` and `label` are the endpoint's, carried through rather than recomputed: the
      // browser cannot work out circulating supply, because it does not know which addresses the
      // service excludes from it.
      return body.items.map((h) => ({
        holder: h.holder,
        balance: BigInt(h.balance),
        share: h.share === undefined ? 0 : Number(h.share),
        label: h.label ?? null,
      }));
    },
  });
}

/**
 * Curve state, derived from the trades already being polled.
 *
 * Deliberately not a second request. Every swap carries the post-trade `quoteRaised`, which is the
 * whole reason the contract emits it — so the newest swap already says where the curve stands, and
 * asking the indexer again would be a round trip for a number we were just handed.
 */
export function deriveLiveState(market: MarketModel, swaps: SwapModel[]): MarketModel {
  // Newest first, matching the API's ordering.
  const latest = swaps[0];
  if (!latest) return market;

  const quoteRaised = latest.swap.quoteRaised;
  return {
    ...market,
    state: {
      ...market.state,
      quoteRaised,
      lastPrice: latest.swap.price,
      progress:
        market.state.quoteTarget > 0n
          ? Math.min(1, Number((quoteRaised * 10_000n) / market.state.quoteTarget) / 10_000)
          : 0,
    },
  };
}
