/**
 * What `Cache-Control` a GET under `/api/**` should carry.
 *
 * Measured before this existed (2026-09-12, from India against the us-west2 origin): every `/api`
 * response took ~500 ms and none carried a cache header, so a market page fired five of them after
 * hydration, the board fired two on every visit, and a back-navigation paid for all of them again.
 * The handlers themselves answer in single-digit milliseconds — the cost is the round trip, and the
 * only way to not pay a round trip is to not make it. Two audiences read this header:
 *
 *   - the browser (`max-age`): a second page in the same tab reuses the quotes list and the market
 *     list instead of refetching them, and TanStack's own `staleTime` decides when to ask again;
 *   - the CDN (`s-maxage`, `stale-while-revalidate`): Cloudflare fronts doku.family and, once a
 *     cache rule marks `/api/*` eligible, serves these from the edge nearest the visitor — ~50 ms
 *     instead of ~500. Without that rule the header is inert at the edge and still right for the
 *     browser, so it is safe to ship ahead of the rule.
 *
 * The TTLs are deliberately short for anything that moves with a block (~1 s on Monad): two
 * seconds fresh, ten stale-while-revalidating, so a swap is never more than a couple of seconds
 * behind and a burst of visitors shares one origin fetch. What only an admin transaction changes
 * (the quote registry, the MON price feed) gets a minute. Per-account data is `private`: it is
 * public chain data, but a shared cache keyed only by URL must not hand one wallet's page to the
 * next visitor's back button.
 *
 * Only GET. Uploads, images and the allowlist are left alone — they set their own or must not be
 * cached at all.
 */
/*
 * Block-paced data: the browser always revalidates (`max-age=0`), the edge shares one origin fetch
 * per second, and a stale copy may be served for at most two more seconds while it refreshes. The
 * first version of this header was 2 s fresh + 10 s stale-while-revalidate, and it made a trade
 * look up to twelve seconds late on the very page that exists to show it. The edge still absorbs a
 * burst of visitors; it just no longer decides what "now" means.
 */
const BLOCK_PACED = "public, max-age=0, s-maxage=1, stale-while-revalidate=2";
const ADMIN_PACED = "public, max-age=60, s-maxage=60, stale-while-revalidate=600";
const STATUS_PACED = "public, max-age=5, s-maxage=5, stale-while-revalidate=15";
const PRIVATE = "private, max-age=2";

const ADMIN_PACED_PATHS = new Set(["/api/quotes", "/api/quote-prices", "/api/price"]);
const BLOCK_PACED_PREFIXES = ["/api/markets", "/api/candlesticks", "/api/leaderboard", "/api/search", "/api/creators", "/api/explore"];

export function cacheControlFor(pathname: string, method: string): string | undefined {
  if (method.toUpperCase() !== "GET") return undefined;
  const path = pathname.replace(/\/+$/, "") || "/";
  if (!path.startsWith("/api/")) return undefined;
  if (ADMIN_PACED_PATHS.has(path)) return ADMIN_PACED;
  if (path === "/api/status") return STATUS_PACED;
  if (path.startsWith("/api/accounts/")) return PRIVATE;
  if (BLOCK_PACED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return BLOCK_PACED;
  return undefined;
}
