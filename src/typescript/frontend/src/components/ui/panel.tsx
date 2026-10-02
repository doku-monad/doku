"use client";

import { cn } from "lib/utils/class-name";
import type React from "react";

/**
 * The glass surface every module in the app sits on.
 *
 * One component rather than a repeated class string, because a page is many panels and hand-copied
 * shadow stacks drift within a week — one ends up a pixel lighter than the rest and the page stops
 * looking machined.
 *
 * ## The construction
 *
 * Two layers, and only two: a hairline **rim** floating 3px proud of the surface, and the
 * translucent **bezel** inside it carrying the card's own edge — a hairline, a lit lip along the
 * top and a shaded line along the foot. That is the top bar's construction minus its
 * opaque tray — the tray is what makes the dock read as metal, and it is exactly what a panel on
 * this page must not have, because the hero's coloured bloom and the drifting emoji field both
 * pass underneath and blurring them is what ties a module to the page rather than stacking a grey
 * rectangle on it.
 *
 * The rim is the detail that does the most work and costs the least. A single hairline drawn *on*
 * a surface reads as a border; the same hairline floating a few pixels off it reads as a machined
 * edge catching light, and it is the one cue every premium surface in this product shares.
 *
 * ## Why the edges are shadows, not borders
 *
 * A border participates in layout, so a 1px border on a panel that also has padding makes the
 * panel 2px wider than a borderless one beside it — and this page puts bordered and unbordered
 * panels in the same grid row. Inset shadows are painted, not laid out, so every panel aligns
 * exactly whatever edge treatment it carries.
 *
 * ## The blur
 *
 * `saturate` alongside it, deliberately. A backdrop blur alone greys whatever is behind it, which
 * is how frosted glass turns into fog — the emoji's colour is the page's only warmth and blurring
 * it without restoring saturation throws it away. This is the difference between glass and a grey
 * sheet, and it is one property.
 */
export function Panel({
  children,
  className,
  padded = true,
  /** Adds a coloured rim — used by the module that owns the page's primary action. */
  accent,
  /**
   * Drops the floating rim.
   *
   * For a panel nested inside another one, where a second proud edge 3px outside the first reads
   * as a rendering artifact rather than as depth.
   */
  flush,
  /**
   * Classes for the surface itself rather than the wrapper.
   *
   * A panel in a grid row is stretched to its tallest sibling, and its *content* has to be told to
   * take that height or it sits at its natural size with the difference showing as dead space at
   * the bottom — which is what the price chart did beside the taller swap column. `flex flex-col`
   * here plus `flex-1` on the child is the whole fix, and it has to land on this element because
   * this is the one the wrapper's height reaches.
   */
  bodyClassName,
  as: Tag = "div",
}: {
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
  accent?: string;
  flush?: boolean;
  bodyClassName?: string;
  as?: "div" | "section" | "aside";
}) {
  return (
    <Tag className={cn("relative", className)}>
      {!flush && (
        <span
          aria-hidden
          className="pointer-events-none absolute -inset-[3px] rounded-[23px] border border-solid transition-colors duration-300"
          style={{
            /* `--film-2`, the value the market card's rim is drawn at. It was `--film-1`, half that,
               so a panel and a card sitting in the same column carried visibly different edges —
               and on paper, where `--film-1` is 4.5% ink, the rim did not survive at all. */
            borderColor: accent ? `rgba(${accent},0.20)` : "var(--film-2)",
          }}
        />
      )}

      <div
        className={cn(
          "relative h-full rounded-[20px] backdrop-blur-2xl backdrop-saturate-150",
          padded && "p-4 sm:p-5",
          bodyClassName
        )}
        style={{
          /* `--mat-panel-bg` rather than a literal: this was a dark translucent gradient, which is
             the correct pane on a near-black stage and a grey slab on paper. Each theme states its
             own — see `global.css`. */
          background: "var(--mat-panel-bg)",
          /*
           * The card's edge, on every panel in the app.
           *
           * This was a 7%-ink hairline with a lit top and no foot, while the market card — the most
           * looked-at object in the product — carries a 16% hairline, a lit lip *and* a shaded line
           * along its bottom. Two edges drawn by two different hands, on surfaces that sit in the
           * same column. Three lines, not one, is what makes a surface read as a raised face rather
           * than as a rectangle with a stroke around it; see `.doku-edge` in `global.css`.
           */
          boxShadow: accent
            ? `inset 0 0 0 1px rgba(${accent},0.20), inset 0 1px 0 var(--mat-bezel-edge), inset 0 -1px 0 var(--shade-2), var(--elev-1)`
            : "inset 0 0 0 1px var(--film-4), inset 0 1px 0 var(--mat-bezel-edge), inset 0 -1px 0 var(--shade-2), var(--elev-1)",
        }}
      >
        {children}
      </div>
    </Tag>
  );
}

/**
 * A panel's header row: an eyebrow on the left, whatever the module needs on the right.
 *
 * The eyebrow is the pixel face at tracking, which is the label voice used on every card in the
 * grid — the same word set the same way in both places is most of what makes two pages read as one
 * product. It is `text-mute` rather than `text-mute`: a section label nobody can read is not
 * subtle, it is just dim, and `--faint` on this canvas sits under 3:1.
 */
export function PanelHeader({
  title,
  right,
  className,
  /** A hairline under the row, for panels whose header genuinely separates from their body. */
  divided,
}: {
  title: string;
  right?: React.ReactNode;
  className?: string;
  divided?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-h-[28px] items-center justify-between gap-3",
        divided ? "-mx-5 mb-5 border-b border-[var(--film-2)] px-5 pb-4 sm:-mx-6 sm:px-6" : "mb-5",
        className
      )}
    >
      <span className="font-numeric text-[11px] uppercase leading-none tracking-[0.1em] text-mute">
        {title}
      </span>
      {right}
    </div>
  );
}

export default Panel;
