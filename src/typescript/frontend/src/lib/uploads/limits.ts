/**
 * What an anonymous upload is allowed to cost.
 *
 * `/api/uploads/image` is the only route in this app that does real work for a caller who has
 * proved nothing: a `sharp` decode and a write to object storage. It cannot ask for a credential
 * either — an image must exist at an addressable URL BEFORE the launch that references it is
 * signed, so the caller is by definition somebody who has not yet done anything on chain.
 *
 * That leaves the cost of the request as the only lever, and these are the two numbers that pull
 * it. They live here rather than in the route because a route file imports `sharp` and the AWS
 * signer, which jest cannot load — logic that cannot be tested where it sits is logic nobody checks.
 */

/**
 * The pixel ceiling, stated rather than inherited from `sharp`'s 268-megapixel default.
 *
 * A SMALL FILE IS NOT A SMALL IMAGE. An SVG is text, so `<svg width="20000" height="20000">` is 123
 * bytes on the wire and 400 million pixels after rasterisation — and this pipeline rasterises SVG
 * at 384 DPI, multiplying the nominal size by a further 5.3. Measured against the real pipeline,
 * 119 bytes of SVG costs 31ms of CPU: an amplification of roughly a quarter of a million to one.
 *
 * 64 megapixels is above anything a phone produces and far below what a hostile vector reaches.
 * Both target shapes are under a megapixel, so nothing legitimate notices.
 */
export const MAX_INPUT_PIXELS = 64 * 1024 * 1024;

/**
 * Uploads per address per minute.
 *
 * A launch needs two — a logo and a banner — so ten is five launches a minute from one address,
 * which no launcher reaches and which bounds an attacker to about half a percent of a core.
 */
export const UPLOADS_PER_MINUTE = 10;

export const WINDOW_MS = 60_000;

/** Above this many tracked addresses, the quiet ones are pruned. See `overLimit`. */
const MAX_TRACKED = 5_000;

/**
 * The bucket, as a pure function of state passed in — which is what makes it testable at all.
 *
 * In-process, and that is sufficient only because the web service is a single instance. If it is
 * ever scaled out this becomes a per-instance limit and the real one has to move to Redis; the
 * app already has an Upstash limiter in `middleware.ts`, disabled because `RATE_LIMITING_ENABLED`
 * has never been set on this deployment.
 */
export function overLimitForTest(state: Map<string, number[]>, ip: string, now: number): boolean {
  const recent = (state.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  state.set(ip, recent);
  // A flood of DISTINCT addresses must not grow the map without bound: that is the same denial of
  // service arriving through the defence rather than around it.
  if (state.size > MAX_TRACKED) {
    for (const [key, times] of state) {
      if (times.every((t) => now - t >= WINDOW_MS)) state.delete(key);
    }
  }
  return recent.length > UPLOADS_PER_MINUTE;
}

const live = new Map<string, number[]>();

/** The route's entry point: the same rule, against process-wide state. */
export const overLimit = (ip: string): boolean => overLimitForTest(live, ip, Date.now());

/** Cloudflare and Railway both sit in front of this, so the socket address is theirs, not the caller's. */
export const callerOf = (request: Request): string =>
  request.headers.get("cf-connecting-ip") ??
  request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
  "unknown";
