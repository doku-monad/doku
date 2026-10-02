import { type ApiClient, ApiError, type QueryValue } from "@/lib/api/client";

/**
 * Markets the site does not show, anywhere.
 *
 * Frontend only, by decision: the market still exists on chain, still trades there, and the indexer
 * still serves it to anybody who asks it directly. This hides it from every page of this site —
 * board, rails, search, account pages, and its own market page, which answers 404.
 *
 * Applied once, to the indexer client every server read goes through (`lib/api/server.ts`), rather
 * than page by page. A market that is hidden on the board but still found by search, or still
 * listed on a holder's portfolio, is not hidden.
 */
export const HIDDEN_MARKETS: readonly { market: string; token: string; label: string }[] = [
  {
    label: "DOKU",
    market: "0xc079b2e6d4422f90e505003a955b275eb0c78b75",
    token: "0x3247a77c792878aeb8f90acda8fde95b962c7ae9",
  },
];

const HIDDEN: ReadonlySet<string> = new Set(HIDDEN_MARKETS.flatMap((h) => [h.market, h.token]));

/** Whether an address is a hidden market or a hidden market's token. */
export const isHiddenAddress = (address: unknown): boolean =>
  typeof address === "string" && HIDDEN.has(address.toLowerCase());

/** The fields a row names its market or token by, across every shape the indexer returns. */
const ADDRESS_KEYS = ["market_address", "marketAddress", "token_address", "tokenAddress", "market", "token", "address"];

const namesHidden = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  ADDRESS_KEYS.some((k) => isHiddenAddress((value as Record<string, unknown>)[k]));

/** A copy of `value` with every array element that names a hidden market removed, at any depth. */
export function scrubHidden(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((v) => !namesHidden(v)).map(scrubHidden);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubHidden(v);
    return out;
  }
  return value;
}

/** `/markets/<hidden>` and everything under it. */
const hiddenMarketPath = (path: string): boolean => {
  const m = /^\/markets\/(0x[0-9a-fA-F]{40})(?:\/|$)/.exec(path);
  return m !== null && isHiddenAddress(m[1]);
};

type BoardPage = { items: unknown[]; total: number; pairCounts: Record<string, number> };
type ProbeRow = { market_address: string; token_address: string; name?: string; ticker?: string; symbol?: string; quote_asset?: string };

const isBoardPage = (v: unknown): v is BoardPage =>
  typeof v === "object" &&
  v !== null &&
  Array.isArray((v as BoardPage).items) &&
  typeof (v as BoardPage).total === "number" &&
  typeof (v as BoardPage).pairCounts === "object";

/**
 * Whether the board's search would have found this row — the indexer's own rule, mirrored.
 *
 * `ILIKE %q%` on name, ticker and symbol; and when the needle starts with `0x`, a prefix match on
 * the market and token addresses. See `where()` in the indexer's market repository.
 */
const searchFinds = (q: string | undefined, row: ProbeRow): boolean => {
  if (!q) return true;
  const needle = q.toLowerCase();
  if ([row.name, row.ticker, row.symbol].some((f) => typeof f === "string" && f.toLowerCase().includes(needle))) return true;
  return needle.startsWith("0x") && [row.market_address, row.token_address].some((a) => a.toLowerCase().startsWith(needle));
};

/**
 * Take a hidden market out of the board's `total` and `pairCounts`.
 *
 * Both are counted by the indexer over the whole filtered set, not the page, so dropping the row
 * from `items` alone leaves them one too high — and wrong on every page, not just the one the row
 * was on. Whether the hidden market is in the set is asked of the indexer itself: the same status
 * and routing, the search swapped for the market's address, and no pair. That answer names the
 * pair it counts under; the board's own search is then checked against the row by the indexer's
 * rule. A probe that fails leaves the counts as they were rather than failing the board.
 */
async function correctCounts(api: ApiClient, query: Record<string, QueryValue>, page: BoardPage): Promise<void> {
  for (const h of HIDDEN_MARKETS) {
    let probe: unknown;
    try {
      const q: Record<string, QueryValue> = { q: h.market, limit: 1 };
      if (query.status !== undefined) q.status = query.status;
      if (query.routing !== undefined) q.routing = query.routing;
      probe = await api.get("/markets", q);
    } catch {
      continue;
    }
    if (!isBoardPage(probe)) continue;
    const row = probe.items.find((r) => isHiddenAddress((r as ProbeRow).market_address)) as ProbeRow | undefined;
    if (!row) continue; // status or routing already excludes it
    if (!searchFinds(typeof query.q === "string" ? query.q : undefined, row)) continue;

    const pairKey = Object.keys(probe.pairCounts).find((k) => (probe as BoardPage).pairCounts[k]! > 0);
    if (pairKey !== undefined && (page.pairCounts[pairKey] ?? 0) > 0) page.pairCounts[pairKey] -= 1;

    const pair = typeof query.pair === "string" ? query.pair.toLowerCase() : undefined;
    const inPair = !pair || pair === pairKey?.toLowerCase() || pair === row.quote_asset?.toLowerCase();
    if (inPair && page.total > 0) page.total -= 1;
  }
}

/** The indexer client, with hidden markets removed from every answer. */
export function withHiddenMarkets(api: ApiClient): ApiClient {
  if (HIDDEN_MARKETS.length === 0) return api;
  return {
    async get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
      if (hiddenMarketPath(path)) throw new ApiError("market not found", 404, path);
      const answer = await api.get<unknown>(path, query);
      const scrubbed = scrubHidden(answer);
      // The page form of `/markets` only: the cursor form carries no counts.
      if (path === "/markets" && !(query && "cursor" in query) && isBoardPage(scrubbed)) {
        await correctCounts(api, query ?? {}, scrubbed);
      }
      return scrubbed as T;
    },
  };
}
