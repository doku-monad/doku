"use client";

import { useDokuWallet } from "context/wallet-context/DokuWalletProvider";
import { useWalletModal } from "context/wallet-context/WalletModalContext";
import { motion, useReducedMotion } from "framer-motion";
import FEATURE_FLAGS from "lib/feature-flags";
import { cn } from "lib/utils/class-name";
import type { ReactNode } from "react";
import { ROUTES } from "router/routes";

import { IntentLink } from "@/components/ui/intent-link";
import { isRouteActive, useActivePathname } from "@/lib/hooks/use-active-pathname";

/**
 * The mobile tab bar.
 *
 * ## Why the app needed one
 *
 * Navigation lived in a horizontally scrolling rail of pills under the top bar — five destinations
 * in a 390px-wide strip, of which four fitted. So the primary navigation of a trading app sat in
 * the *hardest* place on a phone to reach (the top edge, where a thumb has to leave the grip), and
 * one of its five entries was reachable only by a swipe with no scrollbar to advertise it.
 *
 * A tab bar fixes both at once. It is in the thumb arc, every destination is visible without
 * scrolling, and it is the pattern every person using this app already knows.
 *
 * ## The safe area is not optional
 *
 * `env(safe-area-inset-bottom)` is what keeps the dock off the iPhone home indicator and above
 * Android's gesture pill. Without it the bar renders *under* the system's own furniture, which is
 * both untappable and the single most recognisable tell of a web app pretending to be native. It
 * requires `viewport-fit=cover` on the viewport meta to be anything but zero — see `layout.tsx`.
 *
 * ## What this is now, and what it was
 *
 * It was a full-width slab: a 62px bar stretched to 440px with three cells in it, each an icon
 * over an 11px label, and the one you were standing on marked by a rectangle of brand green. Three
 * separate things made it read as a first draft.
 *
 *   1. **It was a strip, not an object.** Stretched across the screen, its three cells sat 90px
 *      apart with nothing between them — a row of icons floating in a long box. Every other
 *      permanent surface in this product shrink-wraps what it holds.
 *   2. **The labels were doing nothing.** "Explore", "Launch", "Portfolio" under three marks that
 *      already say those words, at 11px, on the one surface in the product with the least room.
 *      They set the bar's height (62px of a 844px screen) and bought nothing for it.
 *   3. **The indicator was colour, not light.** A green-filled tile behind the active glyph is the
 *      one move this design system does not make anywhere else: here a selected thing is a *key
 *      that has been lifted and lit*, not a shape that has been filled in.
 *
 * So: a **key rail**. It is as wide as the keys it holds and centred, 52px tall instead of 62, and
 * it is built out of the same five layers as the desktop dock and the market card —
 *
 *   1. `doku-dock-shell` — the tray, pressed in, carrying the two shadows that do the floating: a
 *      tight contact shadow so the rail sits *on* the page, a wide ambient one so it sits *above*
 *      it. Two shadows at different spreads is the whole trick; one is a smudge.
 *   2. `doku-dock-rim` — a hairline ring standing 3px proud of the tray with a lit upper edge.
 *   3. `doku-dock` — the bezel the keys are set into, with its own lit top lip and shaded foot.
 *   4. `doku-dock-seam` — the join between one key and the next: a dark line with a light one
 *      beside it, the same seam the pair tray and the bar's utility cluster carry. It is what makes
 *      three keys read as one milled part rather than as three buttons that happen to touch.
 *   5. `doku-dock-active` — the key that is lifted: a machined face with a brand-lit rim, a spark
 *      of light across its top edge, a pool of brand light under the glyph, and a lamp at its foot.
 *
 * ## Why the indicator is a shared `layoutId`
 *
 * One element that moves between keys, rather than three that fade in and out. Framer resolves it
 * to a transform on a single node, so the slide runs on the compositor at 60fps and cannot cause
 * layout — and it reads as *one* key being lifted as the last one drops, which is the thing a
 * cross-fade cannot imitate.
 */

/**
 * One geometry for every tab glyph, and every glyph is drawn twice.
 *
 * A hairline outline carries the shape; a filled accent inside it carries the state. That is what
 * "duotone" buys on a 22px mark: the outline stays legible at any weight of ink, and the fill gives
 * the active key something to light up that is not simply the whole glyph turning green. The
 * accents are the parts of each object that would *actually* be lit — a compass needle, a rocket's
 * window, the clasp on a wallet.
 *
 * 22px on a 24 viewBox at 1.7 stroke. Stroke weight is the thing to keep fixed: mixing 1.6 and 2.0
 * across three marks is the most common way a hand-drawn tab bar ends up looking assembled rather
 * than drawn.
 */
const Icon = ({ children }: { children: ReactNode }) => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {children}
  </svg>
);

type Tab = {
  key: string;
  label: string;
  /** Absent for Portfolio until a wallet is attached — see the note below. */
  href?: string;
  /** The route the indicator lights on. Usually `href`, but Portfolio's href carries an address. */
  match: string;
  icon: ReactNode;
  onClick?: () => void;
};

export function BottomNav() {
  const pathname = useActivePathname();
  const { address } = useDokuWallet();
  const { openWalletModal } = useWalletModal();
  const reduced = useReducedMotion();

  /**
   * Portfolio is a link once there is an address and a button before that.
   *
   * Its destination is `/wallet/<address>`, which is not knowable until a wallet is connected. It
   * keeps its place in the rail either way — a rail that grows a key on connect makes the whole row
   * re-flow under the thumb that just tapped it — and with no address it opens the wallet modal,
   * which is the step you would have to take anyway.
   */
  const tabs: Tab[] = [
    {
      key: "explore",
      label: "Explore",
      href: ROUTES.explore,
      match: ROUTES.explore,
      icon: (
        /* A compass, not a house. The route is a list of markets you look through; a roof is the
           mark for 'the page you start from', which is a page this app no longer has. The needle is
           the lit part — it is the only thing on a compass that moves, and at 22px a filled diamond
           reads as a needle where two hairline triangles read as a smudge. */
        <Icon>
          <circle cx="12" cy="12" r="8.6" />
          <path
            className="doku-dock-accent"
            d="M15.7 8.3 13.05 13.05 8.3 15.7 10.95 10.95Z"
            stroke="none"
          />
        </Icon>
      ),
    },
    /* `/pools` is behind `FEATURE_FLAGS.Liquidity` and answers 404 while it is off — see
       `middleware.ts`. A permanent key to it is a permanent key to a 404. */
    ...(FEATURE_FLAGS.Liquidity
      ? [
          {
            key: "pools",
            label: "Pools",
            href: ROUTES.pools,
            match: ROUTES.pools,
            icon: (
              <Icon>
                <path d="M3.2 14.8c2.2 0 2.2 2 4.4 2s2.2-2 4.4-2 2.2 2 4.4 2 2.2-2 4.4-2" />
                <path d="M3.2 9.4c2.2 0 2.2 2 4.4 2s2.2-2 4.4-2 2.2 2 4.4 2 2.2-2 4.4-2" />
                <path className="doku-dock-accent" d="M3.2 19.4h17.6" stroke="none" />
              </Icon>
            ),
          },
        ]
      : []),
    {
      key: "launch",
      label: "Launch",
      href: ROUTES.launch,
      match: ROUTES.launch,
      icon: (
        /* A capsule with a window and two fins, rather than the outline of a rocket with a flame
           coming out of it. The window is the accent: on the lit key it is the one bright point in
           the mark, which is how a porthole behaves. */
        <Icon>
          <path d="M12 2.9c2.25 2.1 3.55 4.95 3.55 7.95v3.3l-1.5 1.5h-4.1l-1.5-1.5v-3.3c0-3 1.3-5.85 3.55-7.95Z" />
          <path d="M8.45 11.5 6.2 14v3.15l2.25-1.6M15.55 11.5 17.8 14v3.15l-2.25-1.6" />
          <path d="M10.6 18.4h2.8" />
          <circle className="doku-dock-accent" cx="12" cy="9.3" r="1.6" stroke="none" />
        </Icon>
      ),
    },
    {
      key: "portfolio",
      label: "Portfolio",
      href: address ? `${ROUTES.wallet}/${address}` : undefined,
      match: ROUTES.wallet,
      onClick: address ? undefined : openWalletModal,
      /* A wallet with a card slot and a clasp, rather than a plain rounded rectangle with a dash in
         it — at 22px the old mark was indistinguishable from the generic "card" glyph the search
         and menu buttons already use, so two different things in the same chrome looked the same.
         The clasp is the accent. */
      icon: (
        <Icon>
          <path d="M3.6 8.5A2.5 2.5 0 0 1 6.1 6h10.2a2 2 0 0 1 2 2v.5" />
          <path d="M3.6 8.5v7.9A2.6 2.6 0 0 0 6.2 19h11.2a2.6 2.6 0 0 0 2.6-2.6v-5.2a2.6 2.6 0 0 0-2.6-2.6H6.1" />
          <circle className="doku-dock-accent" cx="16.2" cy="13.8" r="1.35" stroke="none" />
        </Icon>
      ),
    },
  ];

  return (
    /*
     * Floating, shrink-wrapped, and clear of every edge.
     *
     * The bar used to be full-bleed — `inset-x-0 bottom-0`, its own background running edge to edge
     * and behind the home indicator, deliberately imitating system chrome. That is the right call
     * for an app that *is* the OS shell and the wrong one here: every other surface in this product
     * is an object on a canvas with a rim and a shadow, and one component pretending to be part of
     * the phone made the whole bottom of the page read as a different piece of software. Then it
     * was a detached pill capped at 440px, which is the same mistake at a smaller scale: a 366px
     * box holding 180px of keys is still a strip.
     *
     * The positioning is on the wrapper and the surface is on the rail inside it, because the two
     * want different things — the wrapper needs the device safe-area inset so the rail clears the
     * home indicator, and the rail needs the radius, the glass and the shadow that make it an
     * object. One element cannot do both without the shadow being clipped by the inset.
     */
    /*
      `pointer-events-none` on the wrapper, `auto` on the rail it centres.

      This `<nav>` spans the full viewport at `z-40`, while the rail inside it is about 190px wide.
      Everything either side of those 190px is transparent and hit-testable, sitting over the bottom
      of the page: anything that scrolled under it — a trade key, a table row link, the pager —
      painted normally, hovered normally, and had its tap swallowed by a bar that was not there.
      `coin-card.tsx`'s `Band` uses the same pair of classes for the same reason.
    */
    <nav
      aria-label="Primary"
      className="doku-dock-wrap pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 md:hidden"
    >
      <div className="doku-dock-shell pointer-events-auto relative rounded-[19px] p-[3px]">
        <span
          aria-hidden
          className="doku-dock-rim pointer-events-none absolute -inset-[3px] rounded-[22px]"
        />

        {/*
          `list-none` is load-bearing, not tidiness.

          This project's global stylesheet carries no list reset, so a bare `<ul>` renders the
          browser's default `disc` markers — and they inherit `--ink`, the page's cream. On the dock
          that painted bright dots along the top edge of the rail, above the icons, looking for all
          the world like a rendering fault. They survived every attempt to find them in the DOM
          because a list marker is not an element: it has no box, `elementFromPoint` walks straight
          past it, and it does not appear in `querySelectorAll`.

          The footer hit the same trap and carries the same fix. Worth knowing before adding the
          next `<ul>` to this app.
        */}
        <ul className="doku-dock relative flex list-none items-stretch rounded-[16px] p-[3px]">
          {tabs.map((tab, i) => {
            const active = isRouteActive(pathname, tab.match);

            const inner = (
              <>
                {active && (
                  <motion.span
                    aria-hidden
                    layoutId="bottom-nav-indicator"
                    className="doku-dock-active absolute inset-0 rounded-[12px]"
                    transition={
                      reduced
                        ? { duration: 0 }
                        : { type: "spring", stiffness: 520, damping: 40, mass: 0.8 }
                    }
                  >
                    {/* The spark: a hairline of brand light across the key's top edge, brightest at
                        its centre. It is the detail that reads as a lit surface rather than a
                        tinted one, and it travels with the indicator because it is inside it. */}
                    <span className="doku-dock-spark" />
                    {/* The lamp at the foot: the key's own light pooling on the bezel below it.
                        Same reasoning as the spark, from the other end — light falls off downward
                        from a source, so a key lit only along its top edge looks printed. */}
                    <span className="doku-dock-foot" />
                  </motion.span>
                )}
                {/* The lit mark is the brightest ink in the rail; the brand is carried by the
                    accent inside it and by the lamp at the key's foot. `text-doku-ink` — the pale
                    green meant for type sitting ON brand — was what made the active glyph read as
                    a green icon on a green tile: two greens, neither of them signal. */}
                <span
                  className={cn("doku-dock-tile relative z-10", active ? "text-ink" : "text-mute")}
                >
                  {tab.icon}
                </span>
              </>
            );

            /*
             * 40px tall, 56 wide, and the target is bigger than both.
             *
             * A phone's touch surface is about 9mm across and every mis-tap in a tab bar navigates
             * somewhere you did not ask to go, so the painted key keeps the proportion a 52px rail
             * needs while `.doku-dock-hit` expands the *target* to clear 48px in both directions.
             * The pair chips solve the same problem the same way.
             *
             * `active:scale` is on the contents rather than on the cell, so the press feedback does
             * not shrink the target while the finger is on it.
             */
            const shell = cn(
              "doku-dock-hit relative flex h-10 w-14 items-center justify-center rounded-[12px]",
              "transition-transform duration-150 ease-out active:scale-[0.92]",
              "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-doku"
            );

            return (
              <li key={tab.key} className="flex items-stretch">
                {/* The join between one key and the next. Not on the first, which has the bezel's
                    own edge to its left. */}
                {i > 0 && <span aria-hidden className="doku-dock-seam my-1.5 w-px shrink-0" />}
                {tab.href ? (
                  /* Intent rather than sight: one of these keys is `/launch`, the heaviest route in
                     the product, and the rail is on every page at phone width. A touch primes it
                     before the tap completes. See `IntentLink`. */
                  <IntentLink
                    href={tab.href}
                    aria-label={tab.label}
                    aria-current={active ? "page" : undefined}
                    className={shell}
                  >
                    {inner}
                  </IntentLink>
                ) : (
                  <button
                    type="button"
                    onClick={tab.onClick}
                    aria-label={tab.label}
                    aria-current={active ? "page" : undefined}
                    className={shell}
                  >
                    {inner}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}

export default BottomNav;
