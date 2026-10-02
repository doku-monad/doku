import translations from "../../../public/locales/en-US.json";
import type { TranslationKey } from "./types";

/**
 * Looks up a translated string.
 *
 * Defined once at module scope, not rebuilt per call. It used to be constructed inside
 * `translationFunction`, which handed every caller a brand-new function identity on every render —
 * so any `useCallback` or `useMemo` listing `t` as a dependency was invalidated on every render.
 * In `SwapButton`, where such a callback is stored in parent state, that became an infinite update
 * loop that took the whole market page down with "Maximum update depth exceeded".
 *
 * It is a pure lookup over a static JSON file. There was never a reason for it to be per-call.
 */
const t = (s: TranslationKey): string => (s in translations ? translations[s] : s);

const translation = { t } as const;

/**
 * @returns a translated string, not a function.
 */
export const translationFunction = (): { t: (s: TranslationKey) => string } => translation;
