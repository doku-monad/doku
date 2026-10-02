/**
 * The read path to the DOKU indexer.
 *
 * Deliberately thin — it exists to make failure loud. A helper that swallows errors turns a broken
 * indexer into an empty market list, which reads as "no markets yet" and gets diagnosed as a
 * product problem long before anyone checks a log.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type QueryValue = string | number | boolean | undefined;

export interface ApiClient {
  get<T>(path: string, query?: Record<string, QueryValue>): Promise<T>;
}

/**
 * @param baseUrl the indexer's origin, with or without a trailing slash
 * @param fetchImpl injected so tests exercise this code rather than a mock of it
 */
/** How long one indexer call may take before it is a failure rather than a wait. */
export const INDEXER_TIMEOUT_MS = Number(process.env.DOKU_INDEXER_TIMEOUT_MS ?? 8_000);

/** Whether a failure is the kind a second attempt can fix: the request never got an answer. */
const isTransient = (e: unknown): boolean =>
  e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError" || e.name === "TypeError");

export function createApiClient(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  opts: { timeoutMs?: number; retries?: number } = {}
): ApiClient {
  const base = baseUrl.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? INDEXER_TIMEOUT_MS;
  const retries = opts.retries ?? 1;

  return {
    async get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query ?? {})) {
        // Only `undefined` is absence. `0`, `false` and `""` are answers, and dropping them is how
        // a limit of zero silently becomes the default page size.
        if (value !== undefined) params.set(key, String(value));
      }
      const qs = params.toString();
      const url = `${base}${path}${qs ? `?${qs}` : ""}`;

      // `no-store`, always. On the server this opts out of Next's Data Cache, which otherwise
      // keeps an indexer answer for the route's `revalidate` window (2 s): a `router.refresh()`
      // fired 1 s after a swap re-rendered the board from the answer that predated it, and the
      // trade appeared on the NEXT refresh. The indexer is ~5 ms away over the private network;
      // caching it buys nothing and costs exactly the freshness a trading board is for.
      /*
       * Bounded, and retried once. Without a signal a call waits on undici's default, which is
       * minutes: a hung indexer (or a Railway private-network stall) then hangs every server render
       * and every API route that reads it, the worker pool fills with waiting renders, and the site
       * is down while the indexer is merely slow. Eight seconds is longer than any healthy answer
       * and shorter than a visitor's patience; a request that never got an answer is tried once
       * more, an answer that was an error is not.
       */
      let response: Response;
      for (let attempt = 0; ; attempt += 1) {
        try {
          response = await fetchImpl(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
          break;
        } catch (e) {
          if (attempt < retries && isTransient(e)) continue;
          throw e;
        }
      }
      if (!response.ok) {
        throw new ApiError(`${response.status} from ${path}`, response.status, path);
      }

      // A proxy or a gateway in front of the indexer answers with HTML on a bad day, and does it
      // with a 200. Parsing that as JSON throws somewhere unhelpful; checking here names the
      // actual problem.
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("json")) {
        throw new ApiError(`expected JSON from ${path}, got ${contentType || "no content-type"}`,
          response.status, path);
      }

      return (await response.json()) as T;
    },
  };
}
