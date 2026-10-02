"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ComponentProps, useCallback, useRef } from "react";

/**
 * A link that loads the next route when somebody looks like they want it, not when it scrolls past.
 *
 * ## What this replaces
 *
 * `next/link` prefetches by default: every link in the viewport fetches its route's RSC payload,
 * and for a statically rendered route its JavaScript chunks too. That is a good default for a
 * document site and an expensive one here.
 *
 * Measured on `/explore` before this existed: `app/launch/page-*.js` — the **heaviest route in the
 * product at 391 kB** — was fetched on `/explore`, `/assets`, `/stats` and `/wallet`, because
 * `CreateButton`, the footer and `BottomNav` all link to `/launch` and all three are on every page.
 * Alongside it the hero rail fired twelve `?_rsc=` requests, one per market it lists. Thirteen-plus
 * requests, on the critical path, for pages nobody had asked for yet.
 *
 * ## Why intent rather than nothing
 *
 * Turning prefetch off outright makes the first click slower — the payload starts downloading when
 * the navigation does. Priming on `pointerenter` / `focus` / `touchstart` buys back essentially all
 * of it: the gap between "pointer arrives on a control" and "pointer presses it" is a few hundred
 * milliseconds, which on a warm connection is most of a prefetch. A keyboard user gets it on focus,
 * and a touch user on the first touch of the tap.
 *
 * ## It primes once
 *
 * `router.prefetch` is cheap after the first call but not free, and a pointer crossing a row of
 * cards fires `pointerenter` on every one. The ref latches so each link asks at most once per
 * mount; Next's own router cache handles the rest.
 *
 * Use it for links to *heavy* routes and for lists of them. An ordinary nav link to a small page is
 * better left as a plain `next/link` — the default is right far more often than it is wrong, and
 * this is the exception rather than the new house style.
 */
export const IntentLink = ({
  href,
  onPointerEnter,
  onFocus,
  onTouchStart,
  children,
  ...rest
}: ComponentProps<typeof Link>) => {
  const router = useRouter();
  const primed = useRef(false);

  const prime = useCallback(() => {
    if (primed.current) return;
    primed.current = true;
    try {
      router.prefetch(typeof href === "string" ? href : href.toString());
    } catch {
      /* A malformed href, or a router that is mid-navigation. The click still works — it just
         pays full price, which is exactly what happens without this component at all. */
    }
  }, [href, router]);

  return (
    <Link
      href={href}
      /* The whole point. Everything else here exists to give the bytes back on intent. */
      prefetch={false}
      onPointerEnter={(e) => {
        prime();
        onPointerEnter?.(e);
      }}
      onFocus={(e) => {
        prime();
        onFocus?.(e);
      }}
      onTouchStart={(e) => {
        prime();
        onTouchStart?.(e);
      }}
      {...rest}
    >
      {children}
    </Link>
  );
};

export default IntentLink;
