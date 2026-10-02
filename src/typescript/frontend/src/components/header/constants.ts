import FEATURE_FLAGS from "lib/feature-flags";
import { EXTERNAL_LINKS } from "router/external-links";
import { ROUTES } from "router/routes";

/**
 * The dock's primary destinations.
 *
 * ## What is *not* here any more
 *
 * **Launch.** It sat in the middle of the row, styled exactly like the four links either side of
 * it — the one entry that is not a destination but the product's whole purpose, dressed as a nav
 * item. It is now `+ Create`, a filled key at the far right of the bar, past the wallet: the
 * pattern every product with a create action converged on, and the only position in the bar where
 * a control can be visibly primary without shouting over the navigation.
 *
 * **Stats and Docs.** Neither is a place a trader goes during a session; both are references you
 * open once. They moved under `MORE_LINKS`, which keeps them one click away without spending two
 * of the bar's five visible slots on them — and it is what let `Docs`, a `soon` placeholder, stop
 * occupying more width than any real destination in the row.
 */
export const NAVIGATE_LINKS = [
  /*
   * The market grid, named for what you do on it.
   *
   * It was "Board" — the object, on the argument that a trader looks for the board. In a bar that
   * now also carries `+ Create`, the pair reads as a verb and a noun rather than as two places, and
   * "Explore" is also what the route is called (`/explore`) and what the phone's tab bar has always
   * said. Three names for one destination was one too many.
   */
  { title: "explore", path: ROUTES.explore } as const,
  /*
   * The quote-asset registry.
   *
   * A launchpad where the pair is a choice needs a place that lists the choices — what you can
   * launch against, what it tracks, and whether it is live yet. Without it "paired with" is a
   * claim in the hero copy with nothing behind it.
   */
  { title: "assets", path: ROUTES.assets } as const,
  { title: "pools", path: ROUTES.pools } as const,
  { title: "cult", path: ROUTES.cult } as const,
].filter(({ title }) => {
  if (title === "cult") return FEATURE_FLAGS.Cult;
  // `/pools` answers 404 while the flag is off — see `middleware.ts`. A nav entry to it is a nav
  // entry to a 404.
  if (title === "pools") return FEATURE_FLAGS.Liquidity;
  return true;
});

/**
 * The reference shelf, behind one `More` control.
 *
 * Two entries, and the grouping is the point: these are the things you look up, not the things you
 * trade on. A menu also gives `Docs` somewhere honest to sit while it is still unpublished — as a
 * row with a `Soon` badge it costs the bar nothing, where in the row itself it was the widest item
 * in the nav and inert.
 */
export const MORE_LINKS = [
  // Locked behind `FEATURE_FLAGS.Stats`. The row stays — a menu that silently loses an entry is
  // one people go looking for — and carries the same `Soon` badge the route's own screen says.
  { title: "stats", path: ROUTES.stats, soon: !FEATURE_FLAGS.Stats } as const,
  // Docs aren't published yet. Kept in the menu — its absence would be more confusing than a
  // labelled placeholder — but inert, and marked so nobody clicks it expecting a site.
  { title: "docs", path: EXTERNAL_LINKS.docs, soon: true } as const,
];

/*
 * There is no mobile drawer any more, and so no `DRAWER_LINKS`.
 *
 * The array used to be `NAVIGATE_LINKS` minus the tab-bar entries, plus `stats` spliced in — which
 * on a default build resolved to one inert `soon` row and one route nobody was looking for. The
 * sheet it fed is gone along with the hamburger that opened it: navigation is the floating dock,
 * account actions are a popover on the wallet chip, and Stats, Docs and the terms live in the
 * footer, where a phone user already expects secondary links.
 */
