import "server-only";

import { IS_ALLOWLIST_ENABLED } from "./env";

// Not exported: doing so would pollute the Edge Runtime namespace with node-only functions. Only
// validated here.
if (!process.env.HASH_SEED || process.env.HASH_SEED.length < 8) {
  throw new Error("Environment variable HASH_SEED must be set and at least 8 characters.");
}

if (IS_ALLOWLIST_ENABLED && typeof process.env.ALLOWLISTER3K_URL === "undefined") {
  throw new Error("Allowlist is enabled but no allowlist provider is set.");
}

/**
 * `||`, not `??`, and the difference took a production outage to find.
 *
 * `??` falls back only on `null` and `undefined`. An **empty string** passes straight through to
 * `JSON.parse`, which throws `Unexpected end of JSON input` — and because this module is pulled
 * into the middleware bundle, that throw happens while the edge sandbox is evaluating it. The
 * sandbox then retries, the retry hits a half-initialised context and reports
 * `Cannot redefine property: __import_unsupported`, and that second error is the one that fills
 * the log. Every page 500s; the container reports itself healthy throughout.
 *
 * An unset variable reaches an edge bundle as `""` rather than as `undefined`, so this is the
 * normal case, not an edge case.
 */
export const GEOBLOCKED: { countries: string[]; regions: string[] } = JSON.parse(
  process.env.GEOBLOCKED || '{"countries":[],"regions":[]}'
);
export const GEOBLOCKING_ENABLED = GEOBLOCKED.countries.length > 0 || GEOBLOCKED.regions.length > 0;

export const ALLOWLISTER3K_URL: string | undefined = process.env.ALLOWLISTER3K_URL;
export const PRE_LAUNCH_TEASER: boolean = process.env.PRE_LAUNCH_TEASER === "true";

export const MAINTENANCE_MODE: boolean = process.env.MAINTENANCE_MODE === "true";

export const RATE_LIMITER = (() => {
  const { KV_REST_API_URL, KV_REST_API_TOKEN } = process.env;
  const enabled = process.env.RATE_LIMITING_ENABLED === "true";
  if (enabled) {
    if (!KV_REST_API_URL || !KV_REST_API_TOKEN) {
      throw new Error("Rate limiting is enabled but there was no URL/token provided for KV.");
    }
    return {
      enabled: true,
      api: {
        url: KV_REST_API_URL,
        token: KV_REST_API_TOKEN,
      },
    } as const;
  }
  return {
    enabled: false,
    api: {
      url: undefined,
      token: undefined,
    },
  } as const;
})();
