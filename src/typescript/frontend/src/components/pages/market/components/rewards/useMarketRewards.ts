"use client";

import { useQuery } from "@tanstack/react-query";

import type { MarketRewards } from "@/lib/api/markets";

/**
 * This market's fee ledger, as the service actually recorded it.
 *
 * Every figure here is a sum over fee EVENTS — what was routed, what was collected, what was
 * funded into the reward vault, what was paid out of it, and how many tokens were burned. The
 * module used to derive all of that from `volume × 0.7%`, which is right only while every market
 * charges the same fee, none of it is a creator tax, and no market has graduated onto a hook with
 * a different levy. All three are false on generation 2.
 *
 * `null` while it loads, and on failure. A rewards panel that invents a number when its endpoint
 * is down is worse than one that says nothing — this is a page about somebody else's money.
 */
export function useMarketRewards(marketAddress: string): {
  rewards: MarketRewards | null;
  isLoading: boolean;
} {
  const { data, isLoading } = useQuery({
    queryKey: ["market-rewards", marketAddress],
    // The ledger moves with every trade and every claim, so a figure fetched once is a stale one.
    refetchInterval: 20_000,
    staleTime: 10_000,
    queryFn: async (): Promise<MarketRewards> => {
      const res = await fetch(`/api/markets/${marketAddress}/rewards`);
      if (!res.ok) throw new Error(`rewards: ${res.status}`);
      return (await res.json()) as MarketRewards;
    },
  });

  return { rewards: data ?? null, isLoading };
}
