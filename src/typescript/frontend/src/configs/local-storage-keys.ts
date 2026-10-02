import { parseJSON, stringifyJSON } from "utils/json";

/** Defined here now; it used to live in the deleted TradingView config. */
const MS_IN_ONE_DAY = 24 * 60 * 60 * 1000;

/**
 * The key prefix, written out rather than read from `package.json`.
 *
 * It was `${packages.name}_…`, which made a storage key — a wire format that outlives every
 * build — derive from a build file: renaming the package would have silently orphaned every
 * visitor's stored theme and settings.
 *
 * The string is exactly what that expression produced, so stored data carries over untouched.
 *
 * Note this does NOT keep `package.json` out of the client bundle, as an earlier version of this
 * note claimed: `lib/env.ts` still imports it for `VERSION`, and the footer is a client component.
 * Getting the manifest out of the bundle is a separate change and this is not it.
 */
const KEY_PREFIX = "@doku/frontend";

const LOCAL_STORAGE_KEYS = {
  theme: `${KEY_PREFIX}_theme`,
  language: `${KEY_PREFIX}_language`,
  geoblocking: `${KEY_PREFIX}_geoblocking`,
  settings: `${KEY_PREFIX}_settings`,
};

/**
 * The breaking version of each cached shape, as a plain integer.
 *
 * This was a `SemVer` per key and a `satisfies(version, "~2")` check, which pulled the whole
 * `semver` package (~24 kB minified) into every route to answer "is the major still 2". The cache
 * only ever cared about the major — `~N` is exactly "same major" — so the comparison is `===`.
 *
 * Written values stay semver-shaped (`"2.0.0"`) so a build carrying this change reads caches
 * written by the build before it, and vice versa.
 */
const LOCAL_STORAGE_MAJOR: {
  [Property in keyof typeof LOCAL_STORAGE_KEYS]: number;
} = {
  theme: 1,
  language: 1,
  geoblocking: 2,
  settings: 1,
};

/** The major of a stored `"2.0.0"`, or `NaN` for anything that is not a version. */
const majorOf = (version: string | undefined) => Number.parseInt(version ?? "1.0.0", 10);

/**
 * Every read and write of `localStorage`, behind one guard.
 *
 * `localStorage` is not merely absent in some browsers — the property ACCESS THROWS. Safari in
 * private browsing, Firefox with `dom.storage.enabled` off, Brave's strict shields, Chrome with
 * "block all cookies", and several in-app webviews all raise `SecurityError` on the first touch.
 *
 * That mattered here more than anywhere else in the app: `readLocalStorageCache` is called during
 * the first render of `UserSettingsProvider`, which wraps every route — so the throw escaped
 * render and the entire product rendered "Application error: a client-side exception has
 * occurred" for those visitors. The `try` in the reader started one line too late, after the
 * `getItem` that was doing the throwing, and the writer had no `try` at all.
 *
 * The theme bootstrap in `lib/theme/bootstrap.ts` already wraps its storage read for exactly this
 * reason; this is the same guard, applied to the module every route goes through.
 */
const safeGetItem = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const safeSetItem = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* Storage is unavailable or full. A cache that cannot be written is not an error. */
  }
};

const safeRemoveItem = (key: string) => {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* As above. */
  }
};

export const LOCAL_STORAGE_CACHE_TIME: {
  [Property in keyof typeof LOCAL_STORAGE_KEYS]: number;
} = {
  theme: Infinity,
  language: Infinity,
  geoblocking: MS_IN_ONE_DAY,
  settings: Infinity,
};

type LocalStorageCache<T> = {
  expiry: number;
  data: T | null;
  version: string | undefined;
};

export function readLocalStorageCache<T>(key: keyof typeof LOCAL_STORAGE_KEYS): T | null {
  if (typeof window === "undefined") return null;

  const str = safeGetItem(LOCAL_STORAGE_KEYS[key]);
  if (str === null) {
    return null;
  }
  try {
    const cache = parseJSON<LocalStorageCache<T>>(str);
    const wanted = LOCAL_STORAGE_MAJOR[key];
    // Check for no breaking changes.
    if (majorOf(cache.version) !== wanted) {
      console.warn(
        `${key} cache is version ${cache.version} but this build reads major ${wanted}. Purging...`
      );
      /*
       * `removeItem`, not `delete`.
       *
       * `Storage` has no `delete` method, so this line threw a `TypeError` — which the `catch`
       * below swallowed. The entry was therefore never purged: the warning above it fired on
       * every single read, for the life of that browser profile, while the stale cache stayed
       * exactly where it was.
       */
      safeRemoveItem(LOCAL_STORAGE_KEYS[key]);
      return null;
    }
    // Check for staleness.
    if (!cache.expiry || new Date(cache.expiry) > new Date()) {
      return cache.data;
    }
  } catch (e) {
    return null;
  }
  return null;
}

export function writeLocalStorageCache<T>(key: keyof typeof LOCAL_STORAGE_KEYS, data: T) {
  const cache: LocalStorageCache<T> = {
    expiry: new Date().getTime() + LOCAL_STORAGE_CACHE_TIME[key],
    data,
    /* Semver-shaped on the way out, major-compared on the way in — see `LOCAL_STORAGE_MAJOR`. */
    version: `${LOCAL_STORAGE_MAJOR[key]}.0.0`,
  };
  safeSetItem(LOCAL_STORAGE_KEYS[key], stringifyJSON<LocalStorageCache<T>>(cache));
}
