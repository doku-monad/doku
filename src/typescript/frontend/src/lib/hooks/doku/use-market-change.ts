"use client";

import { useQueries } from "@tanstack/react-query";

/**
 * The 24-hour price change for a handful of markets.
 *
 * The indexer has no change column — `market_cap`, `volume_24h` and `last_price` are the figures a
 * market row carries — so the only honest source is the candlesticks the chart already reads.
 * That is a request per market, which is why this is deliberately *not* wired into the grid or the
 * tape: `app/explore/page.tsx` says as much where it declines to decorate the ticker with one.
 *
 * Here the cost is bounded and paid for. The palette shows at most eight rows, the requests only
 * fire for the rows actually on screen, and the ten-minute cache means reopening the palette — or
 * typing a query that narrows to markets already seen — costs nothing at all. Twenty-five hourly
 * buckets is the smallest window that spans a full day, so each response is a couple of dozen
 * rows rather than the ninety-six the hero pulls for its sparklines.
 *
 * `null` means "not known", never "flat": a market with one bucket has no change to report, and
 * printing `0.0%` for it would be inventing a number.
 */
const PERIOD_SECS = 3600;
const BUCKETS = 25;

interface CandleResponse {
  bucketStart: string;
  close: number;
}

const fetchChange = async (marketAddress: string): Promise<number | null> => {
  const params = new URLSearchParams({
    market: marketAddress,
    period: String(PERIOD_SECS),
    limit: String(BUCKETS),
  });
  const res = await fetch(`/api/candlesticks?${params.toString()}`);
  if (!res.ok) throw new Error(`candlesticks: ${res.status}`);
  const rows = (await res.json()) as CandleResponse[];

  // Oldest first. The indexer answers newest-first, and a change read in that order gives every
  // rising market a fall.
  const closes = rows
    .slice()
    .sort((a, b) => new Date(a.bucketStart).getTime() - new Date(b.bucketStart).getTime())
    .map((r) => r.close)
    .filter((c) => Number.isFinite(c) && c > 0);

  const first = closes.at(0);
  const last = closes.at(-1);
  return closes.length > 1 && first && last ? ((last - first) / first) * 100 : null;
};

/** Keyed by market address; a market still loading or without enough history is absent. */
export function useMarketChanges(addresses: string[]): Record<string, number | null> {
  const results = useQueries({
    queries: addresses.map((address) => ({
      queryKey: ["market-change", address],
      staleTime: 600_000,
      gcTime: 900_000,
      retry: false,
      queryFn: () => fetchChange(address),
    })),
  });

  const out: Record<string, number | null> = {};
  addresses.forEach((address, i) => {
    const r = results[i];
    if (r?.isSuccess) out[address] = r.data;
  });
  return out;
}
