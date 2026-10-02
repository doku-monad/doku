"use client";

import { useQuery } from "@tanstack/react-query";

import { type Generation, UNKNOWN_GENERATION } from "@/lib/chain/quote-scale";
import type { IdentityInput } from "@/lib/token-identity";

/**
 * The market list, fetched once and shared.
 *
 * Two places need it for different reasons — the command palette searches it, and the portfolio
 * uses it to turn a position's token address into a coin — and they were one inline query away
 * from becoming two, with different fields and different cache keys.
 */
export interface MarketListItem {
  marketAddress: string;
  tokenAddress: string;
  poolAddress: string | null;
  symbol: string;
  /** The chain's name for the market. Usually the symbol repeated; see `lib/token-identity`. */
  name: string;
  graduated: boolean;
  /**
   * RAW, at this market's own GENERATION scale. Parsed from the string the route sends.
   *
   * Not a figure and not one divide away from being one: it needs `generation` as well as
   * `quoteDecimals`. Read it with `lib/price-figure`, never with an eighteen-decimal conversion.
   */
  lastPrice: bigint;
  /**
   * Which generation stored `lastPrice` — 1 for `quote * 1e18 / base`, 2 for `quote * 1e36 /
   * base`.
   *
   * `UNKNOWN_GENERATION` where the row did not say, which is a response cached before the route
   * sent this column. That renders an em dash for a few seconds rather than a number off by a
   * factor of a quintillion, which is the whole doctrine of `lib/chain/quote-scale`: the wrong
   * price looks exactly like a right one.
   */
  generation: Generation;
  /** RAW quote units. Needs `quoteDecimals` to become a figure — see `lib/market-cap`. */
  marketCap: bigint;
  volume24h: bigint;
  /**
   * The market's quote asset, without which a cap is a number with no unit.
   *
   * The palette formatted `marketCap` at eighteen decimals and labelled it MON, because this row
   * carried nothing else. On a pairs launchpad that is wrong for every market not quoted in MON:
   * a 2,938 USDC cap printed as 0.
   */
  quoteDecimals: number;
  quoteSymbol: string;
  /** Dollars, or null where the quote asset has no price. Null is a gap, never "worth nothing". */
  marketCapUsd: number | null;
  /**
   * The launcher's square artwork, or null where the coin has none.
   *
   * Null is the answer for every generation-1 market and it is a real one: `CoinMark` draws the
   * ticker's monogram for it. What must never reach an `<img src>` is `undefined`, which is what a
   * row cached before this column existed carries — see `marketListItemFromRow`.
   */
  logoUri: string | null;
}

/** The row as it arrives: the three figures are strings on the wire. */
export type MarketListRow = Omit<MarketListItem, "lastPrice" | "marketCap" | "volume24h"> & {
  lastPrice: string;
  marketCap: string;
  volume24h: string;
};

/**
 * `BigInt()` throws on `undefined`, which is what a stale cached response from before these
 * fields existed would supply, so each falls back to zero rather than taking down the palette.
 */
const big = (value: string | undefined) => (value === undefined ? 0n : BigInt(value));

/**
 * One wire row as the app's own shape.
 *
 * Exported and separate from the query so it can be tested without a React tree, and so the
 * defaults below are asserted rather than assumed. Every one of them answers the same question:
 * what a row cached by TanStack Query BEFORE a column existed should parse to. The cache outlives
 * a deploy, so this is a real state and not a hypothetical one.
 */
export const marketListItemFromRow = (m: MarketListRow): MarketListItem => ({
  ...m,
  lastPrice: big(m.lastPrice),
  marketCap: big(m.marketCap),
  volume24h: big(m.volume24h),
  // A cached response from before these existed would leave the cap unitless; eighteen and
  // MON are what such a row always meant, and are right for the markets that predate them.
  quoteDecimals: m.quoteDecimals ?? 18,
  quoteSymbol: m.quoteSymbol ?? "MON",
  // The one default that is NOT a best guess. Eighteen and MON are what a row cached before those
  // columns existed always meant; a generation is not recoverable that way, and assuming the older
  // one is the mistake that put a quintillion on the palette's price in the first place.
  generation: m.generation ?? UNKNOWN_GENERATION,
  marketCapUsd: m.marketCapUsd ?? null,
  // `undefined` would be rendered as the string "undefined" by an `<img src>`; null is "no logo",
  // which is what `CoinMark` and `identityFor` both expect and both have an answer for.
  logoUri: m.logoUri ?? null,
});

/**
 * One row as `identityFor` wants to be asked.
 *
 * The list row is FLAT — `logoUri` sits beside `marketCap` — while a market model nests the
 * launcher's columns under `metadata`, and `identityFor` reads the nested shape because that is
 * what every other surface hands it. Without this adapter a caller passes the flat row, the
 * resolver looks for `metadata.logoUri`, finds nothing, and every result draws its fallback while
 * the logo it needed sat one key away. One resolver, one input shape, one place that bridges them.
 *
 * The six columns this row does not carry are `null` rather than omitted, which is the honest
 * value: `/api/markets` does not send them, so nothing here knows whether the coin has a website.
 */
export const identityInputFor = (m: MarketListItem): IdentityInput => ({
  ...m,
  // A market row's `generation` is a plain number; this row's can be `UNKNOWN_GENERATION`, which
  // is a statement about the PRICE and about nothing a name or a logo is resolved from. Absent
  // rather than null, so the shape stays the one every other caller hands the resolver.
  generation: m.generation ?? undefined,
  metadata: {
    ticker: null,
    logoUri: m.logoUri,
    bannerUri: null,
    description: null,
    website: null,
    x: null,
    telegram: null,
  },
});

export function useMarketList() {
  return useQuery({
    queryKey: ["market-list"],
    staleTime: 30_000,
    queryFn: async (): Promise<MarketListItem[]> => {
      const res = await fetch("/api/markets?limit=500");
      if (!res.ok) throw new Error(`markets: ${res.status}`);
      const body = (await res.json()) as { items: MarketListRow[] };
      return body.items.map(marketListItemFromRow);
    },
  });
}
