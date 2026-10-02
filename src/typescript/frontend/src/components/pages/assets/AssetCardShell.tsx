"use client";

import { cn } from "lib/utils/class-name";
import type { ReactNode } from "react";

/**
 * The card shell, taken from the board's own card rather than invented.
 *
 * ## Why this file exists
 *
 * The registry's cards were assembled out of `.doku-token-*` classes at the radii the *token
 * masthead* uses — 19 for the tray, 22 for the rim, 16 for the bezel. That is a real construction
 * in this product, and it is the wrong one: the masthead is a page-scale object, and these are
 * cards. Set beside `/explore` the borders did not line up, the corners were a different curve and
 * the rim was a different colour, so the two pages read as two products.
 *
 * Every value below is `components/ui/coin-card.tsx` — the board card — at card scale. **That file
 * is the source of truth.** If it changes, this changes with it.
 *
 * ## The five layers, and the two details that make them read as metal
 *
 *   0. **The cast shadow**, its own layer, fading in on hover. It cannot live on the tray: that
 *      element's `box-shadow` is doing three inset jobs already. Large and very soft — a tight dark
 *      shadow on this canvas looks like a border rather than depth.
 *   1. **The tray** the whole thing is pressed into.
 *   2. **The rim**, floating 3px proud of the tray. A hairline drawn *on* a surface is a border;
 *      the same hairline floating off it is a machined edge catching light.
 *   3. **The bezel**, which clips everything inside it.
 *   4. **The edge**, drawn *over* the bezel's children at `z-20` — because the bezel's children
 *      paint grounds to all four corners, and a border on the bezel itself would be painted under
 *      them and vanish along most of the card's height.
 *
 * **Concentric radii: 14, 15, 17.** Not one number three times. The bezel is 14 and the rim floats
 * 3px outside it, so 17 is the only radius at which the two curves stay parallel — at 18 they
 * converge through the corner and the gap pinches, which is the exact tell that a "double border"
 * is two borders rather than one object with a rim.
 *
 * **A lit top lip and a shaded foot.** One flat hairline all the way round is what a *drawn*
 * rectangle looks like. Light along the inside of the top edge and shade along the foot is what a
 * machined one looks like under a light source above it.
 */

/** Layer 1. */
const TRAY = {
  background: "var(--mat-tray-bg)",
  boxShadow: "var(--mat-tray-shadow)",
} as const;

/** Layer 3. */
const BEZEL = {
  background: "var(--mat-bezel-bg)",
  borderTop: "1px solid var(--mat-bezel-edge)",
} as const;

/** Layer 4 — the lip and the foot together, which is this product's grammar for a raised surface. */
const EDGE = {
  borderColor: "var(--film-4)",
  boxShadow: "inset 0 1px 0 var(--film-3), inset 0 -1px 0 var(--shade-2)",
} as const;

export const AssetCardShell = ({
  live = false,
  title,
  className,
  children,
}: {
  /**
   * Tint the rim with the brand.
   *
   * The board card does the same thing with the coin's own hue under the pointer — a second rim at
   * the same offset and radius, laid over the first. Here it is permanent rather than on hover,
   * because it is stating a fact about the asset rather than answering a pointer.
   */
  live?: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
}) => (
  <div
    title={title}
    /*
     * The card does not move.
     *
     * The board card lifts 4px on hover, and copying that here was wrong: the board is a grid of
     * things you click *whole*, so the card is the target and the lift is its answer. A registry
     * card is not a target — it is a container with two or three separate controls in it — so
     * lifting the container on every pointer pass made a ten-cell grid ripple as the mouse crossed
     * it, with nothing being pointed *at*. Motion belongs on the thing that responds to the press.
     *
     * So: the keys inside animate, the card holds still. The shadow layer stays because it is what
     * gives the object its weight at rest; it simply no longer fades in and out.
     */
    className={cn("group/asset relative h-full", className)}
  >
    <span aria-hidden className="absolute inset-0 rounded-[15px]" style={TRAY} />

    <span
      aria-hidden
      className="pointer-events-none absolute -inset-[3px] rounded-[17px] border border-solid border-[var(--film-2)]"
      style={{ boxShadow: "inset 0 1px 0 var(--film-4)" }}
    />
    {live && (
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-[3px] rounded-[17px] border border-solid border-doku/45"
      />
    )}

    <div className="relative flex h-full flex-col overflow-hidden rounded-[14px]" style={BEZEL}>
      {children}

      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 z-20 rounded-[14px] border border-solid"
        style={EDGE}
      />
    </div>
  </div>
);

export default AssetCardShell;
