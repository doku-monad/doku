"use client";

import { useQuery } from "@tanstack/react-query";

import { fetchQuoteAssets, type QuoteAsset } from "@/lib/assets/quote-assets";

/**
 * The quote-asset registry, in a client component.
 *
 * Four surfaces need it — the board's pair chips, the launch form's pair picker, the hero rail and
 * the footer's chain badge — and without one hook they would be four fetches with four cache keys
 * and four chances to disagree about what gold is.
 *
 * `staleTime` is generous because the registry moves on an admin transaction, not on a trade. An
 * eager refetch here is a request per tab per focus for a list that changes monthly.
 *
 * Callers get `[]` while it loads and while it is failing, and those are not the same thing:
 * `isPending` and `isError` are both on the result, and a surface that must tell them apart reads
 * them rather than counting the rows.
 */
/** One frozen empty list, so a caller memoising on `assets` does not bust on every render. */
const NONE: QuoteAsset[] = [];

export const useQuoteAssets = () => {
  const query = useQuery({
    queryKey: ["quote-assets"],
    staleTime: 5 * 60_000,
    queryFn: () => fetchQuoteAssets(),
  });

  const assets: QuoteAsset[] = query.data ?? NONE;
  return { ...query, assets };
};

export default useQuoteAssets;
