import { DEFAULT_MAX_SLIPPAGE } from "../const";
import { clampSlippageBps, MAX_UI_SLIPPAGE_BPS, MIN_SLIPPAGE_BPS } from "../lib/chain/slippage";

export { MAX_UI_SLIPPAGE_BPS, MIN_SLIPPAGE_BPS };

export type MaxSlippageMode = "auto" | "custom";
const LOCALSTORAGE_MAX_SLIPPAGE_KEY = "maxSlippage";
const LOCALSTORAGE_MAX_SLIPPAGE_MODE_KEY = "maxSlippageMode";

/**
 * Clamped on the way IN as well as on the way out.
 *
 * This used to accept anything up to 10,000 bps, which is how storage came to hold a 100%
 * tolerance in the first place. A stored value is read back on every visit for as long as the
 * browser keeps it, so the store is the one reader whose leniency outlives the build that had it.
 */
/**
 * Storage, guarded — the same guard `configs/local-storage-keys.ts` carries, for the same reason.
 *
 * Touching `localStorage` THROWS (rather than returning null) in Safari private browsing, with
 * "block all cookies" set, under Brave's strict shields and in several in-app webviews. These
 * functions are called from the render path of the market and launch pages — `getMaxSlippageSettings()`
 * is the eager argument to a `useState` — so an unguarded read took both pages down with a
 * client-side exception for those visitors.
 */
const read = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* A preference that cannot be stored is not an error; the session keeps its value in state. */
  }
};

export const setMaxSlippage = (value: bigint) => {
  write(LOCALSTORAGE_MAX_SLIPPAGE_KEY, clampSlippageBps(value).toString());
};

export const setMaxSlippageMode = (mode: MaxSlippageMode) => {
  if (mode !== "auto" && mode !== "custom") return;
  write(LOCALSTORAGE_MAX_SLIPPAGE_MODE_KEY, mode);
  if (mode === "auto") {
    setMaxSlippage(DEFAULT_MAX_SLIPPAGE);
  }
};

export const getMaxSlippageSettings = () => {
  if (typeof window === "undefined") {
    return {
      mode: "auto" as MaxSlippageMode,
      maxSlippage: DEFAULT_MAX_SLIPPAGE,
    };
  }

  /*
   * A read, and only a read.
   *
   * This used to call `setMaxSlippageMode("auto")` when nothing was stored — a `localStorage.setItem`
   * performed *during render*, since the only caller is a `useState` initialiser. React may run a
   * render twice or throw its result away, so a write from here is a side effect at exactly the
   * moment side effects are not allowed, and it wrote the default back on every first visit for no
   * benefit: an absent mode already means "auto", which is what the branch below returns.
   */
  const maxSlippageModeFromLocalStorage =
    (read(LOCALSTORAGE_MAX_SLIPPAGE_MODE_KEY) as MaxSlippageMode | null) ?? "auto";
  if (maxSlippageModeFromLocalStorage === "auto") {
    return {
      mode: "auto" as MaxSlippageMode,
      maxSlippage: DEFAULT_MAX_SLIPPAGE,
    };
  } else {
    /*
     * Never trusted, never thrown on. `BigInt("5.5")` throws, and this runs while the market page
     * renders — so a stray value here used to take the whole page down rather than the setting
     * back to a default. And a value above the control's ceiling — writable by an older build,
     * unreachable from this one — showed in the box as a number the app would never sign.
     */
    const stored = read(LOCALSTORAGE_MAX_SLIPPAGE_KEY);
    return {
      mode: "custom" as MaxSlippageMode,
      maxSlippage: stored === null ? DEFAULT_MAX_SLIPPAGE : clampSlippageBps(stored),
    };
  }
};
