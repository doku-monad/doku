import type { SlimMarketRow } from "../api/types";

/**
 * Turning the `/market/<slug>` path segment into a market's addresses.
 *
 * Generation 1 could DERIVE this. Its factory salted a market's clones with the symbol key, so an
 * emoji determined an address and the page could render the instant a launch confirmed, before the
 * indexer had seen anything. Generation 2 salts on the CREATOR and a nonce, so a ticker determines
 * nothing: two people may launch $MOON, and neither address is a function of the name.
 *
 * So a non-address slug is a LOOKUP now, and the lookup can legitimately fail or be ambiguous.
 * Both are answered here rather than guessed at, because the alternative — picking the first row a
 * search returned — hands a shared link to whichever $MOON the sort happened to favour.
 */

/** What a slug resolved to, or why it did not. */
export type SlugResolution =
  | { kind: "address"; curve: `0x${string}` }
  | { kind: "ticker"; curve: `0x${string}`; token: `0x${string}`; row: SlimMarketRow }
  | { kind: "ambiguous"; matches: SlimMarketRow[] }
  | { kind: "not-found" };

/** A ticker is 2 to 12 of `[A-Za-z0-9]`, which is what `DokuFactory._validate` enforces. */
const TICKER = /^[A-Za-z0-9]{2,12}$/;

export function isTickerSlug(slug: string): boolean {
  return TICKER.test(slug);
}

/**
 * Resolve a slug against rows a search returned.
 *
 * Split from the fetch so the decision is testable without a network: what makes this correct is
 * the matching, not the request.
 *
 * Matching is on the EXACT ticker, case-insensitively, never on a prefix. A search for "MON"
 * returns "MONKE" too, and resolving to it would send anyone who typed one market's name to a
 * different market — a wrong page that looks like a right one.
 */
export function resolveFromRows(slug: string, rows: SlimMarketRow[]): SlugResolution {
  const wanted = slug.toLowerCase();
  const matches = rows.filter((r) => (r.ticker ?? r.symbol ?? "").toLowerCase() === wanted);
  if (matches.length === 0) return { kind: "not-found" };
  if (matches.length > 1) return { kind: "ambiguous", matches };
  const only = matches[0]!;
  return {
    kind: "ticker",
    curve: only.marketAddress.toLowerCase() as `0x${string}`,
    // The page is keyed by the token (see `lib/market-path`); the curve rides along for callers
    // that key data on it.
    token: only.tokenAddress.toLowerCase() as `0x${string}`,
    row: only,
  };
}
