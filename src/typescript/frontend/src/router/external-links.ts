/**
 * Destinations that are not this app.
 *
 * ## `docs` is a PLACEHOLDER and does not resolve
 *
 * `docs.DOKU` is not a hostname. It has been this string since the fork, and both surfaces that
 * reference it — the header's `MORE_LINKS` and the footer's `LEARN` column — mark the entry `soon`
 * and render it INERT for exactly that reason. The value is kept rather than emptied so that the
 * shape of the eventual link is visible, and so that publishing docs is a one-line change here
 * rather than an archaeology exercise.
 *
 * **If you make this a real URL, drop `soon: true` in BOTH places** — `components/header/constants.ts`
 * and `components/footer/index.tsx`. Neither will start working on its own, and a live docs site
 * that nothing links to is the failure this note exists to prevent.
 */
export const EXTERNAL_LINKS = {
  docs: "https://docs.DOKU/category/--start-here",
} as const;
