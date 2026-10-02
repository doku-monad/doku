"use client";

import { cn } from "lib/utils/class-name";
import Link from "next/link";
import React, { useEffect, useRef, useState } from "react";

/**
 * Cult UI's `gradient-button-group`, adapted into a navigation dock.
 *
 * The look is theirs: a recessed tray, a raised bezel sitting in it, and — on the active item — a
 * layered inset (dark well, spinning conic ring, thin channel, raised face) that reads like a
 * machined button pressed into metal. Those layers are rendered on whichever item is active; see
 * `GradientButtonGroup` below for why none of it slides.
 *
 * What is not theirs is everything about it being a nav. Upstream ships a demo: four hardcoded
 * items, icon-only 76px squares, active state in local `useState`, `<button>` elements, and a
 * light/dark toggle wired to `next-themes`. None of that survives contact with a real menu, so:
 *
 *   - items are a prop, and they render as `<Link>` — a nav that cannot be middle-clicked, opened
 *     in a new tab or crawled is not a nav
 *   - the active item comes from the route, not from internal state
 *   - `next-themes` is gone; this app has one theme, and adding a theme package to read a constant
 *     would be silly. The theme toggle goes with it
 *   - 76px icon squares become label pills at a height that fits a 72px top bar
 *
 * The conic ring is upstream's own teal/lime, stop for stop. It is rendered *static* rather than
 * turning: this bar is chrome that sits on every route, and a permanently rotating gradient in the
 * corner of every page is motion nobody asked for. `ConicRing` still supports the spin — drop the
 * `paused` prop to restore upstream's rotation.
 *
 * `animate-gold-spin` is *not* shipped with the registry item — it is a Tailwind v4 `@utility` in
 * Cult UI's own stylesheet. This project is on Tailwind 3, so the keyframe is declared in
 * `tailwind.config.js` instead; without it the ring renders but never turns.
 */

export type GradientNavItem = {
  label: string;
  /** Also the React key, so it has to be unique even for an item with no destination. */
  href: string;
  active?: boolean;
  /** Rendered as a non-navigable label with a badge — for destinations that do not exist yet. */
  soon?: boolean;
  /** Opens in a new tab. Set for absolute URLs. */
  external?: boolean;
  /**
   * Renders a `<button>` instead of a link.
   *
   * One entry needs this: "Portfolio" has no destination until a wallet is connected, and it opens
   * the wallet modal instead. Hiding it until then would make the whole dock change width on
   * connect, and the row of items would reflow around the gap for
   * no reason the user can see.
   */
  onClick?: () => void;
  icon?: React.ReactNode;
  /**
   * Renders a dropdown instead of a link — see {@link DockMenuItem}.
   *
   * The bar has room for about five labels before the nav stops being scannable, and this product
   * has more destinations than that. The ones that lose the argument are the references — Stats,
   * Docs — which are looked up rather than traded on, so they go behind one control that carries
   * the active state of whichever of them you are standing on.
   */
  menu?: GradientNavMenuEntry[];
};

export type GradientNavMenuEntry = {
  label: string;
  href: string;
  /** One line under the label, so a menu row says what it is rather than only what it is called. */
  note?: string;
  active?: boolean;
  soon?: boolean;
  external?: boolean;
  /**
   * The row's mark.
   *
   * A menu of two lines of text is a list; a menu whose rows each carry a mark in a well is the
   * same object as everything else in this product, where a quote asset, a coin and a venue all
   * sit in one. It is supplied by the caller because the glyph belongs with the copy — the header
   * already owns both — rather than being chosen in here from the label.
   */
  icon?: React.ReactNode;
};

/**
 * Ring colourways for {@link ConicRing}.
 *
 * `brand` is Cult UI's own gradient, copied stop for stop from
 * `apps/www/registry/default/ui/gradient-button-group.tsx` in `nolly-studio/cult-ui`. It had been
 * retuned to this app's four accents; the retune was the single visible difference between this
 * dock and the component it is adapted from, so it is gone. Everything else in the assembly —
 * tray, rim, bezel, well, channel, the shadow stacks — already matched upstream verbatim.
 *
 * `iris` *is* that retune, kept because the market card's window edge uses it and looks right in
 * the palette. Two colourways for two surfaces, rather than one compromise for both.
 *
 * `danger` has no upstream equivalent. It marks the wallet button while no wallet is attached,
 * which is app state upstream's demo has no concept of.
 */
const DOCK_RINGS = {
  /*
   * A ring of one colour, made with the same machinery as the spectra.
   *
   * A conic gradient is bright on one arc and dark on the opposite one, which is exactly what makes
   * `brand` read as light catching a machined edge — and exactly what made the wallet key's rim
   * look like a border that had failed to draw: cyan down the left, yellow across the top, gone on
   * the right. That is right for an accent and wrong for the rim of a control whose *label* is the
   * thing being read, because the eye goes to the brightest arc rather than to the word.
   *
   * Two stops of the same value is a conic with no sweep in it: even at every angle, and still the
   * same component, geometry and animation hook as the others rather than a second mechanism.
   */
  steady:
    "conic-gradient(from 220deg, rgb(var(--doku-rgb) / 0.36) 0%, rgb(var(--doku-rgb) / 0.36) 100%)",
  brand:
    "conic-gradient(from 220deg, #6FF7CC 0%, #44EBCF 16%, #ADFA1F 33%, #C8FF5A 50%, #89F5A0 66%, #37D8C5 82%, #6FF7CC 100%)",
  iris: "conic-gradient(from 220deg, var(--doku) 0%, var(--doku-ink) 18%, var(--halo) 38%, #9D95FF 56%, #FEC5FB 72%, var(--doku) 100%)",
  danger:
    "conic-gradient(from 220deg, var(--loss) 0%, var(--loss-ink) 20%, var(--warn) 42%, var(--warn-ink) 60%, #C62D34 80%, var(--loss) 100%)",
} as const;

export type DockRingTone = keyof typeof DOCK_RINGS;

/**
 * The turning conic ring, as one component every surface shares.
 *
 * ## The bug this exists to kill
 *
 * Each place that wanted this used to inline its own copy — `inset-[-60%]` in the dock, and
 * `inset-[-70%]` on the market card's window. Percentage insets resolve *left/right against the
 * container's width and top/bottom against its height*, so on a wide, short control the spinning
 * layer came out wide and short too. The Connect button measured 98×44 with a 207.8×90.5 spinner.
 *
 * A rotating rectangle only covers its container at every angle if its **short side is at least
 * the container's diagonal**. That button's diagonal is 107.4px and the spinner's short side was
 * 90.5px, so a quarter-turn later the narrow dimension was sweeping across a 98px-wide box and the
 * left and right edges went dark. The glow appeared to sit on the top and bottom only, and because
 * every control had a different width, every control failed at a different angle — which is why
 * the ones in the nav looked like unrelated elements rather than one effect.
 *
 * ## The fix
 *
 * The layer is a **square**, centred, sized to `150%` of the container's width with a floor of
 * `min-w`. Square means rotation cannot change which dimension faces which edge; 150% clears the
 * diagonal for anything up to about 1.1× as tall as it is wide, and the floor covers the reverse
 * case, so `side ≥ 1.5 × max(w, h) ≥ √2 × max(w, h) ≥ diagonal` always holds.
 *
 * `paused` keeps it still until something asks for it — a grid of forty turning rings is a
 * screensaver, one is a response.
 */
export function ConicRing({
  tone = "brand",
  className,
  paused,
  minSide = 66,
}: {
  tone?: DockRingTone;
  /** Applied to the clipping band, not the spinner — this is where the radius lives. */
  className?: string;
  /** Renders the ring but holds it still; a `group-hover` utility can start it. */
  paused?: string;
  /** Floor for the square's side, in px. Default 66 = 1.5 × the dock's 44px control height. */
  minSide?: number;
}) {
  return (
    <span aria-hidden className={cn("absolute overflow-hidden", className)}>
      <span
        className={cn(
          "animate-conic-spin absolute left-1/2 top-1/2 aspect-square w-[150%] origin-center will-change-transform",
          paused
        )}
        style={{ background: DOCK_RINGS[tone], minWidth: minSide }}
      />
    </span>
  );
}

/**
 * The active nav item's treatment, on its own.
 *
 * The dock's selected item is four layers — a well pressed into the bezel, a spinning conic ring, a
 * dark channel, and a raised face. That construction is what marks "this one" inside the bar, and
 * the wallet button wants exactly the same language: it is a dock control, and it is the one that
 * matters most.
 *
 * Shared with the nav items by construction rather than by any animation binding: both simply
 * draw the same four layers wherever they are needed, so nothing here can chase a control
 * across the bar when the route changes.
 */
/**
 * The soft halo behind a {@link DockFace}, per tone.
 *
 * Through the triplets rather than as literals. These were `rgba(10,228,72,0.30)` and
 * `rgba(255,77,94,0.30)` — which are the *dark* theme's `--doku-rgb` and `--loss-rgb` copied out by
 * hand, so the glow behind the connect button and the connected wallet pill kept the near-neon
 * green of the dark stage on Lite, where the brand green is the darker `0 160 106`. A halo is the
 * one part of a control that is pure colour, so being a theme behind shows on it first.
 */
const DOCK_HALOS = {
  brand: "rgb(var(--doku-rgb) / 0.3)",
  danger: "rgb(var(--loss-rgb) / 0.3)",
} as const;

export function DockFace({
  children,
  tone = "brand",
  className,
  faceClassName,
  glow,
}: {
  children: React.ReactNode;
  tone?: DockRingTone;
  className?: string;
  faceClassName?: string;
  /**
   * Adds a soft halo *outside* the control.
   *
   * The ring is clipped to a 2px band by design — it is an edge, not a light source — so on its
   * own it can never spill past the button. Anything that should read as a control that *glows*
   * needs a second, unclipped layer, which is what this is. Nothing between here and the dock's
   * bezel sets `overflow: hidden`, so it radiates on all four sides.
   */
  glow?: boolean;
}) {
  return (
    <span
      /*
       * The horizontal padding is what makes the ring a ring.
       *
       * The face below is the only in-flow child, so it sets this span's width — and it was inset
       * vertically but not horizontally, so it sat flush against both ends and covered the ring
       * there. The lit band survived on the top and bottom edges only, which read as a border
       * someone had forgotten to finish. It is done here rather than with a percentage width on the
       * face: the width of a shrink-to-fit flex parent is derived *from* that child, and a
       * percentage on it resolves against a containing block the child itself defines.
       *
       * ## The ring is the control's own edge
       *
       * The assembly is 44px, and it used to *paint* 32 of them: the ring sat two pixels in, the
       * channel four and the plate six, leaving a near-black well round the outside that is
       * invisible on a near-black bar. So beside `+ Create` — a solid 44px key — this read as a
       * small button floating in a gap, and the one control in the bar that is asking for
       * something was the one that looked smallest.
       *
       * The ring moves out to `inset-0`: it is the object's edge now rather than a band floating
       * inside one, the channel is a one-pixel hairline at 2px, and the plate is 38 — so the
       * painted object is the full 44px, exactly the footprint the search field, the theme key
       * and Create already fill.
       */
      className={cn(
        "relative flex h-11 items-center justify-center rounded-[14px] px-[3px]",
        className
      )}
    >
      {/*
        First in the DOM, and deliberately *without* a negative z-index.

        `-z-10` was the obvious way to put this behind the button's own layers and it would have
        hidden the glow completely: this span sits inside the dock's `relative z-10` wrapper, which
        is a stacking context, so a negative index resolves against *that* and paints the halo
        underneath the dock's bezel rather than underneath the button. Painting order does the same
        job for free — every layer below is a later sibling, so they cover the halo where they
        overlap it and only the spill past the button's edge survives.
      */}
      {glow && (
        <span
          aria-hidden
          className="pointer-events-none absolute -inset-2 rounded-[20px] blur-lg"
          style={{ background: DOCK_HALOS[tone] }}
        />
      )}

      <span
        aria-hidden
        className="absolute inset-0 rounded-[14px]"
        style={{
          background: "var(--mat-well-bg)",
          boxShadow:
            "inset 0 2px 6px var(--shade-5), inset 0 0 4px var(--shade-3), 0 1px 0 var(--film-1)",
        }}
      />
      <ConicRing
        tone={tone}
        className="inset-0 rounded-[14px]"
        paused="[animation-play-state:paused]"
      />
      <span
        aria-hidden
        className="absolute inset-[2px] rounded-[12px]"
        style={{
          background: "var(--mat-channel-bg)",
          boxShadow: "inset 0 1px 3px var(--shade-5), inset 0 0 2px var(--shade-3)",
        }}
      />
      {/* The hairline the active nav item carries, so the two faces are the same object. Without
          it the wallet button's face met its channel with no edge at all. */}
      <span
        className={cn(
          "relative z-10 flex h-[calc(100%-6px)] items-center justify-center gap-2 rounded-[10px] border border-solid border-[var(--film-3)] px-3.5",
          faceClassName
        )}
        style={{ background: "var(--mat-bezel-bg)" }}
      >
        {children}
      </span>
    </span>
  );
}

/**
 * The layers one nav item is made of, on their own.
 *
 * Extracted so the `More` dropdown's trigger is *literally* the same object as a nav link rather
 * than a second implementation that resembles one. A menu button drawn from its own copy of these
 * four layers is a menu button that drifts the first time any of them is tuned.
 */
function DockItemLayers({
  item,
  isActive,
  /** A menu trigger's chevron points up while its panel is open. */
  open,
}: {
  item: GradientNavItem;
  isActive: boolean;
  open?: boolean;
}) {
  return (
    <>
      {isActive && (
        <>
          {/* The well the face is pressed into. */}
          <span
            aria-hidden
            className="absolute inset-0 rounded-[14px]"
            style={{
              background: "var(--mat-well-bg)",
              boxShadow:
                "inset 0 2px 6px var(--shade-5), inset 0 0 4px var(--shade-3), 0 1px 0 var(--film-1)",
            }}
          />

          {/* The same ring component the wallet button uses — one geometry, so every
              lit control in the bar turns identically instead of each clipping at its
              own width. */}
          <ConicRing className="inset-0 rounded-[14px]" paused="[animation-play-state:paused]" />

          {/* The dark channel between ring and face. */}
          <span
            aria-hidden
            className="absolute inset-[2px] rounded-[12px]"
            style={{
              background: "var(--mat-channel-bg)",
              boxShadow: "inset 0 1px 3px var(--shade-5), inset 0 0 2px var(--shade-3)",
            }}
          />

          {/*
            The raised face — a layer, not the label's own box.

            It used to be the label span itself, switching from `h-full w-full` to
            `h-[calc(100%-12px)] w-[calc(100%-12px)]` on activation. That span is the
            only in-flow child, so it is what sizes the pill, and a percentage width on
            a shrink-to-fit parent resolves against a containing block that same child
            defines: the pill came out 2px wider when active than when not. Every route
            change nudged each item to the right of the selected one sideways — small
            enough to look like a rendering artifact, consistent enough to be one.

            Drawn as an absolute layer, the active treatment costs no layout at all, so
            an item is the same size whichever route you are on.
          */}
          <span
            aria-hidden
            className="absolute inset-[3px] rounded-[10px] border border-solid border-[var(--film-3)]"
            style={{ background: "var(--mat-bezel-bg)" }}
          />
        </>
      )}

      {/* `px-3` until `lg`, 3.5 above it. Between `md` and `lg` the bar is carrying four labels, a
          search key, a theme key, a 160px wallet and the create key inside 768px — sixteen pixels
          across the nav is the margin that keeps it from touching the rail's edge, and it is
          invisible at a width where the labels are the only thing being read anyway. */}
      <span className="relative z-10 flex h-full w-full items-center justify-center gap-1.5 rounded-[8px] px-3 lg:px-3.5">
        {item.icon && <span className="relative z-10 shrink-0">{item.icon}</span>}
        <span className="relative z-10 whitespace-nowrap">{item.label}</span>
        {item.menu && (
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            className={cn(
              "relative z-10 -mr-0.5 shrink-0 opacity-70 transition-transform duration-200 ease-out",
              open && "rotate-180"
            )}
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        )}
      </span>
    </>
  );
}

/**
 * A nav item that opens a menu instead of going somewhere — the bar's `More`.
 *
 * ## Why the bar needed one
 *
 * Five labels is about where a horizontal nav stops being scannable and starts being a list you
 * read. This product has more destinations than that, and two of them — Stats and Docs — are
 * references rather than places you work: you open them once and go back. Behind one control they
 * cost the bar a single 76px slot instead of two of its widest, and the row that is left is four
 * things a trader actually moves between.
 *
 * ## It is the same object as a link
 *
 * The trigger renders `DockItemLayers`, so it is a nav item in every material sense — same shell,
 * same hover, same four machined layers when it is lit — with a chevron after the label. It lights
 * when you are standing on any of its entries, which is the part a menu usually gets wrong: a nav
 * that shows nothing selected while you are on `/stats` is a nav that has lost you.
 *
 * ## Click, not hover
 *
 * A hover-opened panel fires on every pointer crossing the bar on its way somewhere else, which is
 * why hover menus always end up needing grace timers to be usable. This one opens when asked,
 * closes on outside press, on Escape, and on navigation — and it is absolutely positioned, so the
 * bar's layout is identical open and closed.
 */
function DockMenuItem({
  item,
  shellClass,
  isActive,
}: {
  item: GradientNavItem;
  shellClass: string;
  isActive: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative flex items-center">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={shellClass}
      >
        <DockItemLayers item={item} isActive={isActive} open={open} />
      </button>

      {open && (
        /*
          Anchored to the trigger's centre and hung below the dock's own rim.
          `mt-4` clears the bezel's 6px of padding and the rim floating 4px outside it, so the panel
          reads as a second object under the bar rather than as something growing out of its edge.
        */
        <div
          role="menu"
          className="doku-popover absolute left-1/2 top-full z-50 mt-4 w-[272px] -translate-x-1/2 rounded-[18px] p-2"
        >
          {/* The tail. A 8px square rotated 45° with the panel's own hairline on its two upper
              edges — which is the only way to draw a pointer that shares a border with its panel
              rather than sitting in front of it. */}
          <span
            aria-hidden
            className="doku-popover-tail absolute -top-[5px] left-1/2 h-[10px] w-[10px] -translate-x-1/2 rotate-45 rounded-[2px]"
          />

          {item.menu?.map((entry) => {
            /*
              A row is a mark, two lines and a state.

              It was a 13.5px label with an 11px note under it in a 32px box, and two of them ran
              together into a single grey block — the panel read as a tooltip that happened to be
              clickable. The mark in a well is what makes a row an object: it gives the eye a fixed
              left edge to run down, it is the same mount every other list in this product uses, and
              it is where the row's state shows — lit for the page you are on, dim for a
              destination that does not exist yet.
            */
            const label = (
              <>
                <span
                  aria-hidden
                  className={cn(
                    "doku-well grid h-9 w-9 shrink-0 place-items-center rounded-doku-lg transition-colors duration-150",
                    entry.soon ? "text-mute" : entry.active ? "text-doku-ink" : "text-ash"
                  )}
                >
                  {entry.icon}
                </span>

                <span className="flex min-w-0 flex-col gap-1">
                  <span className="truncate font-ui text-[14px] font-semibold capitalize leading-none">
                    {entry.label}
                  </span>
                  {entry.note && (
                    <span className="truncate font-ui text-[12px] leading-none text-mute">
                      {entry.note}
                    </span>
                  )}
                </span>
                {entry.soon ? (
                  /* The same pill the launch bench marks an optional step with, so "not yet" is one
                     object in this product rather than one per surface. */
                  <span className="ml-auto shrink-0 rounded-doku-pill border border-solid border-line bg-[var(--film-2)] px-2 py-1 font-numeric text-[11px] uppercase leading-none tracking-[0.08em] text-mute">
                    Soon
                  </span>
                ) : (
                  /* An arrow that leans in under the pointer — the affordance every other row in
                     this app uses, rather than a row that only changes colour. */
                  <span
                    aria-hidden
                    className="ml-auto shrink-0 text-mute transition-transform duration-200 group-hover/row:translate-x-[3px] motion-reduce:transition-none"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M5 12h13M12.5 5.5 19 12l-6.5 6.5" />
                    </svg>
                  </span>
                )}
              </>
            );

            const row = cn(
              "group/row relative flex w-full items-center gap-3 rounded-[13px] px-2.5 py-2.5 text-left",
              "transition-[background-color,box-shadow,color] duration-150",
              entry.soon
                ? "cursor-default text-mute"
                : entry.active
                  ? /* Standing on it: the brand's own three lines, the treatment every selected
                       surface in this product carries — see `.doku-edge`. */
                    "bg-doku/10 text-ink shadow-[inset_0_0_0_1px_rgb(var(--doku-rgb)/0.35),inset_0_1px_0_rgb(var(--doku-rgb)/0.25)]"
                  : "text-ash hover:bg-[var(--film-2)] hover:text-ink",
              "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-doku"
            );

            /* Same rule as the nav row itself: a destination that does not exist is not a link. */
            if (entry.soon) {
              return (
                <span key={entry.href} aria-disabled className={row}>
                  {label}
                </span>
              );
            }

            return (
              <Link
                key={entry.href}
                href={entry.href}
                role="menuitem"
                target={entry.external ? "_blank" : undefined}
                rel={entry.external ? "noopener noreferrer" : undefined}
                aria-current={entry.active ? "page" : undefined}
                onClick={() => setOpen(false)}
                className={row}
              >
                {label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * A recessed vertical rule, for separating a slot from the nav items.
 *
 * Two hairlines rather than one — a dark line with a lit one beside it — so it reads as a seam
 * pressed into the bezel rather than a border drawn on top of it.
 */
function DockSeam() {
  return (
    <span
      aria-hidden
      className="mx-1.5 h-6 w-px shrink-0 bg-[var(--film-4)] shadow-[1px_0_0_0_var(--film-2)]"
    />
  );
}

/**
 * The nav dock.
 *
 * ## Why nothing here animates its position any more
 *
 * The selected item used to be four layers sharing `layoutId`s with every other item, so changing
 * route slid the whole assembly — well, ring, channel and face — across the bar on a spring. It
 * demoed well and lived badly. A spring settles by overshooting, so the indicator arrived past its
 * target and came back; the face's hairline was drawn on a delay to avoid being animated mid-flight
 * and instead read as a flicker; and every non-active face sat at `scale: 0.985`, which is a
 * fractional transform on text and therefore a permanently slightly-blurred label that snapped
 * sharp on activation. Three separate sources of jitter, all in service of one slide.
 *
 * The active treatment is now simply *rendered on the active item*. Colour and opacity still
 * transition — those cost nothing and cannot shift layout — but no geometry moves, nothing
 * overshoots, and no text is scaled. Changing route repaints one item.
 *
 * The conic ring still turns, because a continuous rotation inside a clipped 2px band is not a
 * transition: it never starts, never lands, and never moves the thing it is inside.
 */
export function GradientButtonGroup({
  items,
  className,
  leading,
  trailing,
  fluid,
}: {
  items: GradientNavItem[];
  className?: string;
  /**
   * Fill the container instead of shrinking to the width of the controls.
   *
   * The dock was `inline-flex`, so it was exactly as wide as its own contents — 951px at a 1500px
   * viewport, against a 1192px content rail. Three surfaces on the page, three different widths and
   * three different left edges, which is the kind of thing nobody points at and everybody feels.
   *
   * Fluid, the bar spans the same rail as the grid and the footer, the nav floats in the middle of
   * it, and the brand and the wallet cluster sit over the first and last columns of the board.
   * Everything below it lines up.
   */
  fluid?: boolean;
  /**
   * Content docked to the left of the nav items, inside the same bezel — the brand lockup.
   *
   * A slot rather than something the component draws itself: this is a Cult UI surface treatment,
   * not a header, and it should not know what a brand is.
   */
  leading?: React.ReactNode;
  /** Content docked to the right — search, wallet. */
  trailing?: React.ReactNode;
}) {
  return (
    <div className={cn("relative flex items-center", fluid ? "w-full" : "inline-flex", className)}>
      {/* The recessed tray the bezel sits down into. */}
      <div
        aria-hidden
        className="absolute inset-0 z-0 rounded-[22px]"
        style={{
          background: "var(--mat-tray-bg)",
          boxShadow:
            "inset 0 2px 8px var(--shade-3), inset 0 1px 2px var(--shade-1), 0 1px 0 var(--film-1)",
        }}
      />

      <div className={cn("relative z-10 flex", fluid && "w-full")}>
        {/* The rim, floating 4px proud of the bezel.

            23px, not 22: the bezel is 19 and the rim sits 4px outside it, so 19 + 4 is the radius at
            which the two curves stay parallel through the corner. And a hair of light along the
            inside of its top edge, so the outer of the bar's two borders catches the same light as
            the bezel's own lit lip — one object with a rim, rather than two concentric strokes.

            `border-solid` is stated rather than inherited from Tailwind's preflight. A vendor
            stylesheet imported after it once set `border: 0` on every `div`, and `border-style:
            none` makes the USED width zero whatever sets it — so this rim drew nothing, and the bar
            had the bezel's own `border-top` and no bottom and no sides. That import is scoped to
            its own route now (see `app/cult/page.tsx`); saying `solid` here means the dock's rim
            cannot be switched off again by a stylesheet it has never heard of. */}
        <div
          aria-hidden
          className="absolute -inset-[4px] rounded-[23px] border border-solid border-[var(--film-2)]"
          style={{ boxShadow: "inset 0 1px 0 var(--film-3)" }}
        />

        <div
          className={cn(
            "relative flex items-center rounded-[19px] p-1.5",
            fluid ? "w-full" : "inline-flex"
          )}
          style={{
            background: "var(--mat-bezel-bg)",
            borderTop: "1px solid var(--film-3)",
          }}
        >
          {leading && (
            <>
              <span className="flex shrink-0 items-center pl-3 pr-2">{leading}</span>
              <DockSeam />
            </>
          )}

          {/* The nav is its own landmark; the brand and wallet slots sit outside it deliberately,
              since neither is primary navigation and a screen reader should not hear them as such. */}
          <nav
            aria-label="Primary"
            className={cn("flex items-center gap-1.5", fluid ? "mx-auto" : "inline-flex")}
          >
            {items.map((item) => {
              const isActive = Boolean(item.active);

              /*
               * Hover is a colour change and a background dim — nothing that occupies space.
               *
               * The dim is painted on the shell rather than on an inserted layer, so an item that
               * is hovered is the same size as an item that is not, to the pixel. Inactive items
               * carry the rounded footprint at rest with a transparent fill, which is what stops
               * the first hover of a session from looking like a box being created.
               */
              const shell = cn(
                "group/nav relative flex h-11 items-center justify-center rounded-[14px] px-1 font-ui text-[14px] font-medium capitalize transition-colors duration-200 ease-out",
                isActive
                  ? "text-ink"
                  : "bg-transparent text-mute hover:bg-[var(--film-1)] hover:text-ink"
              );

              /* A menu, not a destination. Rendered whole by `DockMenuItem` — including its own
                 trigger, which is this same shell with the same layers inside it. */
              if (item.menu) {
                return (
                  <DockMenuItem
                    key={item.href}
                    item={item}
                    shellClass={shell}
                    isActive={isActive}
                  />
                );
              }

              /* A destination that does not exist is a span, not a disabled link: there is nothing to
               navigate to, so it should not be focusable or announced as a link. */
              if (item.soon) {
                return (
                  <span
                    key={item.href}
                    aria-disabled
                    className={cn(shell, "cursor-default text-mute")}
                  >
                    <span className="relative z-10 flex items-center gap-1.5 px-3.5">
                      {item.label}
                      <span className="rounded-full bg-ink/10 px-1.5 py-0.5 font-numeric text-[11px] uppercase tracking-[0.08em]">
                        Soon
                      </span>
                    </span>
                  </span>
                );
              }

              const layers = <DockItemLayers item={item} isActive={isActive} />;

              if (item.onClick) {
                return (
                  <button
                    key={item.href}
                    type="button"
                    onClick={item.onClick}
                    // Announced the same way the `<Link>` branch below announces it. "Portfolio"
                    // switches between the two on connect, and without this the current page
                    // stopped being current to a screen reader for half the wallet states.
                    aria-current={isActive ? "page" : undefined}
                    className={shell}
                  >
                    {layers}
                  </button>
                );
              }

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  target={item.external ? "_blank" : undefined}
                  rel={item.external ? "noopener noreferrer" : undefined}
                  aria-current={isActive ? "page" : undefined}
                  className={shell}
                >
                  {layers}
                </Link>
              );
            })}
          </nav>

          {trailing && (
            <>
              <DockSeam />
              <span className="flex shrink-0 items-center gap-2 pl-2 pr-1">{trailing}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default GradientButtonGroup;
