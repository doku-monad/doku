"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { AssetIcon } from "@/components/ui/asset-icon";
import { displaySymbol, displaySymbolText } from "@/lib/assets/display-symbol";
import {
  QUOTE_ASSET_KIND_LABELS,
  QUOTE_ASSET_KIND_ORDER,
  type QuoteAsset,
  type QuoteAssetKind,
} from "@/lib/assets/quote-assets";

/**
 * What the coin trades against.
 *
 * The step that makes this a general launchpad rather than a memecoin factory: the pair is a
 * decision the launcher makes, and it changes what the coin *is*. A coin quoted in a stablecoin
 * has a dollar price; the same coin quoted in a tokenized equity is a bet on a ratio.
 *
 * ## Why this stopped being five rows of chips
 *
 * The previous build drew every asset at once, grouped by kind, one row per group with the group's
 * name in a 124px gutter beside it. It was honest and it did not scale: the layout's only answer to
 * a longer registry was more vertical pixels, and the `stock` group was already one asset away from
 * wrapping — the sixth equity would have added another 64px to the step. Thirteen assets came to
 * roughly 360px on the first and most consequential choice on the page.
 *
 * So the kinds became a filter instead of five headings. One category is on screen at a time, in a
 * grid two rows deep that scrolls inside a fixed box — which means **the step is the same height at
 * thirteen assets as it is at forty**, and the 124px gutter that used to hold a label now holds
 * keys. It is shorter than what it replaced and it stops growing.
 *
 * ## Live first, always
 *
 * Within a category the pressable assets sort to the front. Before, the two live options were
 * scattered across rows one and two of a five-row control — the launcher's eye had to find them.
 * It also makes the fixed box safe: the selected asset is always live, so it is always in the first
 * row and never hidden below the scroll.
 *
 * ## Only a live pair is selectable, and that is deliberate
 *
 * `status` is `registered && enabled` read off the on-chain quote registry, and `DokuFactory.launch`
 * reverts `QuoteNotEnabled()` for anything else. The choice is between a form that says what it can
 * do and a form that accepts a name, a ticker, two images and a dev buy and then fails in the
 * wallet with a custom error. The unavailable assets are still drawn — they are the roadmap, and
 * hiding them would answer "what can I pair against" with less than the registry knows.
 *
 * They are `aria-disabled`, not `disabled`, and that is the fix to a real defect. A `disabled`
 * button is removed from the tab order and given `pointer-events: none` by `global.css`, so the one
 * key whose reason a launcher does not already know was the one key nobody could ever read the
 * reason for — the previous build put it in a `title` on a wrapper span, which reaches a pointer
 * and nothing else. `aria-disabled` keeps the key focusable, so the reason is announced.
 *
 * ## The list arrives, it is not imported
 *
 * `assets` is a prop rather than a module constant because the registry is fetched from the chain.
 * The bench owns the query and the filtering; this component renders whatever it was handed.
 *
 * ## Tiles in a bed, not chips on a panel
 *
 * The keys were 56px strips: a 22px mark in a 36px well, a ticker, a name, and a 6px dot in the
 * corner that was the only statement of whether the key could be pressed. They were the flattest
 * object on the page, the marks were too small to recognise, and the dot meant nothing to anybody
 * who had not read this file.
 *
 * Now the picker is one instrument. The categories and the keys share a recessed bed, so the keys
 * stand proud of something rather than sitting on the same panel as everything else, and each key
 * is a tile built around its mark.
 *
 * ## Material, not light
 *
 * The first pass of this lit everything: each asset's colour pooled behind its mark, a brand glow
 * cast under the chosen tile, a lit ring round its socket. It photographed well and read as a
 * template — light is the cheapest way to say "premium", and ten glowing tiles say it ten times.
 * What is left is what a made object has: a face, a hairline, a short shadow, and a recess.
 *
 *   - **The mark, at 42px, in a socket.** It is what a launcher recognises first, so it is the
 *     largest thing on the tile, and the round recess is what makes it a coin set into a key rather
 *     than an image pasted on one.
 *   - **One line across: mark, words, state.** The tile was a 124px card with the mark in its top
 *     corner and two lines of type at its foot, which left a band of nothing across the middle of
 *     every tile — and at two rows the bed was 270px, the tallest thing in the form. Laid across,
 *     the mark sets the tile's height and the type sits beside it, centred on it; the tile is 68px
 *     and holds nothing it does not use. The mark did not shrink to pay for it.
 *   - **The state at the end of the line.** A price used to sit there and was dropped — a launch
 *     form is not a ticker tape — and the end of the line is where the tile now says whether it is
 *     chosen, can be chosen, or cannot.
 *   - **Available is raised, unavailable is sunk.** A pair the factory would refuse is not a key
 *     with a badge on it: it is a plate pressed into the bed, its coin in greyscale and its words
 *     cut into the surface, with `Soon` set where a live tile carries its radio. It was an amber dot
 *     inside a pill in the top corner, which was a colour code nobody was given the key to, sitting
 *     where the eye goes first. Depth says "you cannot press this" before any word does.
 */

/**
 * One tile's height: the 48px socket and 10px above and below it. Keep in step with
 * `auto-rows-[68px]` on the grid.
 */
const TILE_H = 68;

/** The space between tiles, both ways. Keep in step with `gap-2` on the grid. */
const TILE_GAP = 8;

/**
 * The window's padding on every side — room for a tile's focus ring and its cast shadow, inside
 * the clip. Keep in step with `p-1.5` on the window and `scroll-padding` on `.doku-pair-window`.
 */
const WINDOW_PAD = 6;

/**
 * One row of keys, top edge to top edge: a tile plus the gap under it.
 *
 * The window is a whole number of these less the trailing gap, so whatever is left to scroll is
 * always a whole number of them — which is what lets the wheel move in rows and never leave a key
 * cut in half.
 */
const ROW_PITCH = TILE_H + TILE_GAP;

/** A window exactly `rows` tall, with the padding above and below. */
const windowHeight = (rows: number) => TILE_H * rows + TILE_GAP * (rows - 1) + WINDOW_PAD * 2;

/**
 * The window, by width. Exported for `LaunchBenchSkeleton`.
 *
 * Two rows wherever the grid has two or three columns. On a phone the tiles are one column — a
 * tile laid across needs the width — and two rows of one column is two assets, which is a peephole
 * rather than a picker, so the phone window is three rows. The breakpoint is `.doku-pair-window`'s.
 */
export const WINDOW_H = windowHeight(2);
export const WINDOW_H_PHONE = windowHeight(3);

/** Live first, then the ones the chain knows about, then the rest. Stable within each band. */
const STATUS_RANK: Record<QuoteAsset["status"], number> = { live: 0, listed: 1, soon: 2 };

type Tab = "all" | QuoteAssetKind;

export const PairSelect = ({
  assets,
  value,
  onChange,
}: {
  /** The registry, as fetched and already filtered for what may be offered. */
  assets: readonly QuoteAsset[];
  value: QuoteAsset | null;
  onChange: (asset: QuoteAsset) => void;
}) => {
  const [tab, setTab] = useState<Tab>("all");
  const gridRef = useRef<HTMLDivElement>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const stepRef = useRef<HTMLDivElement>(null);
  /* The same question for the category rail, per side. `.doku-chiprow` paints its fade
     unconditionally, which on a desktop where every tab fits just dims the last one for ever —
     the hero rail wraps the same mask in a media query for exactly this reason. Driven by scroll
     position instead, so the fade appears on the side that actually has more and nowhere else. */
  const railRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  /* Only the categories that actually have something in them. An empty tab is a promise the
     registry cannot keep, and the set changes as assets are listed. */
  const tabs = useMemo(() => {
    const present = QUOTE_ASSET_KIND_ORDER.filter((k) => assets.some((a) => a.kind === k));
    return [
      { key: "all" as const, label: "All", count: assets.length },
      ...present.map((k) => ({
        key: k,
        label: QUOTE_ASSET_KIND_LABELS[k],
        count: assets.filter((a) => a.kind === k).length,
      })),
    ];
  }, [assets]);

  const shown = useMemo(() => {
    const inTab = tab === "all" ? assets : assets.filter((a) => a.kind === tab);
    return [...inTab].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
  }, [assets, tab]);

  /*
   * Roving tabindex.
   *
   * A radio group is ONE tab stop; the arrows move within it. The previous build was a row of
   * toggle buttons with `aria-pressed`, which announces "pressed / not pressed" on a control where
   * exactly one option is true — and left eleven keys unreachable because they were `disabled`.
   */
  const focusIndex = Math.max(
    0,
    shown.findIndex((a) => a.id === value?.id)
  );

  /*
   * The wheel moves the keys a row at a time, from anywhere in this step.
   *
   * ## Why a row at a time, and not by the delta
   *
   * The first version added `deltaY` to `scrollTop`, which is the obvious thing and was broken in
   * a way that only a trackpad could show. The window snaps to the row pitch; assigning `scrollTop`
   * is a scroll operation, so the browser re-snapped it straight back. A wheel notch of 300px
   * cleared the snap threshold and worked. Eighteen pixels of a trackpad did not: the box returned
   * to where it was, and because the handler had already called `preventDefault` the page did not
   * move either. Twelve gentle gestures, 216 pixels, and nothing on the screen moved at all.
   *
   * Moving by exactly one pitch lands exactly on a snap position, so the snap agrees with the
   * handler instead of undoing it, and it makes the control predictable in a way free scrolling
   * cannot be: there are two resting places in a 64px range, and a gesture goes to the other one.
   * No amount of scrolling can leave a key cut in half.
   *
   * ## The lock
   *
   * One flick of a trackpad is thirty wheel events. Without a lock that is thirty rows, and the
   * list would shoot to the end on the gentlest touch. The lock holds for the length of the
   * animation, and while it holds the gesture is still swallowed — a row arriving and then the
   * page lurching underneath it is worse than a beat of nothing.
   *
   * ## It hands the gesture back at both ends
   *
   * When the keys cannot move any further in the direction asked for, nothing is prevented and the
   * page scrolls as it would have. Passing this step on the way down the page therefore costs one
   * gesture, once — and never traps anybody.
   *
   * Native and not `onWheel`, because React registers wheel handlers at the root as passive, and a
   * passive listener cannot call `preventDefault`.
   */
  useEffect(() => {
    const step = stepRef.current;
    if (!step) return;
    let until = 0;

    const onWheel = (e: WheelEvent) => {
      const box = windowRef.current;
      if (!box) return;
      /* A sideways gesture belongs to the category rail, and a nudge under 4px is a hand resting
         on a trackpad rather than somebody asking for the next row. */
      if (Math.abs(e.deltaY) < 4 || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;

      const limit = box.scrollHeight - box.clientHeight;
      if (limit <= 0) return;

      if (performance.now() < until) {
        e.preventDefault();
        return;
      }

      const row = Math.round(box.scrollTop / ROW_PITCH);
      const next = Math.max(0, Math.min((row + Math.sign(e.deltaY)) * ROW_PITCH, limit));
      if (next === box.scrollTop) return;

      e.preventDefault();
      until = performance.now() + 260;
      box.scrollTo({
        top: next,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
    };

    step.addEventListener("wheel", onWheel, { passive: false });
    return () => step.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const measure = () => {
      const max = el.scrollWidth - el.clientWidth;
      /* A few pixels of tolerance, not one. Momentum scrolling lands on fractional offsets and a
         1px threshold flips on and off across the boundary, which is visible as a flickering cue. */
      const left = el.scrollLeft > 4;
      const right = el.scrollLeft < max - 4;
      /* Bail when nothing changed. A scroll fires dozens of events per swipe and this used to
         build a fresh object for every one of them, so the rail re-rendered continuously while
         the finger was down — the other half of the flicker. */
      setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [tabs.length]);

  /* Scroll the rail by most of a screenful. Paired with the edge cue below: the cue says there is
     more, and pressing it goes there — a fade alone tells you something exists and gives you no way
     to reach it but a swipe you have to guess at. */
  const nudgeRail = (dir: 1 | -1) => {
    const el = railRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.round(el.clientWidth * 0.72), behavior: "smooth" });
  };

  const moveFocus = (from: number, delta: number) => {
    if (shown.length === 0) return;
    const next = (from + delta + shown.length) % shown.length;
    const keys = gridRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    keys?.[next]?.focus();
  };

  return (
    /*
      The bed: one recess holding the categories and the keys, so the picker is a single object.

      It used to be two — a segmented tray, and under it a grid of keys straight on the panel — and
      the keys, the most consequential control on the page, were the only part with nothing under
      them. In the bed they stand proud of a surface, which is the whole of what depth is.
    */
    <div ref={stepRef} className="doku-pair-bed flex flex-col rounded-[22px] p-1.5">
      <div className="flex items-center gap-3 px-0.5 pb-1.5 pt-0.5">
        {/*
          The categories, as a filter rather than as five headings.

          `.doku-seg-key` is the house segmented key — the same object the chart's range switch and
          the wallet's tabs are cut from, and `AssetRegistry` runs a rail of them over this exact
          registry. The bed is the well they sit in, so the rail brings no tray of its own.
        */}
        <div className="relative min-w-0 flex-1">
          <div
            ref={railRef}
            role="tablist"
            aria-label="Asset category"
            /*
              `no-scrollbar`, and it was the bug.
              -------------------------------------------------------------------------------------
              `.doku-chiprow` only paints the edge mask — it does NOT hide the bar, and the two other
              rails in this product (`PairFilter`, `PairRail`) both pair it with `no-scrollbar` for
              that reason. Without it a 14px horizontal scrollbar sat under the categories on every
              phone, inside a control that is 40px tall.
            */
            className="no-scrollbar -mx-0.5 flex items-center overflow-x-auto px-0.5"
            style={
              edges.left || edges.right
                ? {
                    maskImage: `linear-gradient(90deg, ${edges.left ? "transparent 0%, #000 7%" : "#000 0%"}, ${edges.right ? "#000 93%, transparent 100%" : "#000 100%"})`,
                    WebkitMaskImage: `linear-gradient(90deg, ${edges.left ? "transparent 0%, #000 7%" : "#000 0%"}, ${edges.right ? "#000 93%, transparent 100%" : "#000 100%"})`,
                  }
                : undefined
            }
          >
            {/* `w-max`, not `min-w-0`: the row is as wide as its own keys and scrolls as one. */}
            <div className="flex w-max items-center gap-1">
              {tabs.map((t) => {
                const on = tab === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    data-active={on}
                    onClick={() => setTab(t.key)}
                    className="doku-seg-key inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[12px] px-3.5 font-ui text-[13px] font-semibold leading-none"
                  >
                    {t.label}
                    {/* The count as a plate, not as dimmed type beside the word — the same recess
                        the board's pair chips mount theirs in, so `Stocks 5` cannot read as one
                        string. */}
                    <span
                      className={`rounded-full px-1.5 py-0.5 font-numeric text-[11px] font-medium leading-none tabular-nums ${
                        on ? "bg-[var(--film-3)] text-ash" : "bg-[var(--film-1)] text-mute"
                      }`}
                    >
                      {t.count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/*
            The edge cue.

            A mask alone is a hint, and a hint that only exists while you are already looking at the
            right edge. This is a control: it appears exactly when there is something past the edge,
            it points at it, and pressing it goes there. It floats over the rail rather than sitting
            in it, so it costs the categories no width on the phone rail where the whole problem
            lives.

            `aria-hidden` and out of the tab order on purpose — every category is already reachable
            by Tab and by the arrow keys, so this is a pointer convenience, not a second control.
          */}
          {(["left", "right"] as const).map((side) =>
            edges[side] ? (
              <button
                key={side}
                type="button"
                aria-hidden
                tabIndex={-1}
                onClick={() => nudgeRail(side === "right" ? 1 : -1)}
                /*
                  Centred with `inset-y-0 my-auto`, NOT with `top-1/2 -translate-y-1/2`.

                  The app's global press affordance is `button:active { transform: translateY(1px) }`
                  — one property, so it REPLACES a transform rather than composing with it. A cue
                  centred by `-translate-y-1/2` threw its centring away on pointer-down and fell half
                  its own height. Auto margins centre without touching `transform`.
                */
                className={`doku-rail-cue absolute inset-y-0 my-auto grid h-7 w-7 place-items-center rounded-full text-mute ${
                  side === "right" ? "right-0" : "left-0"
                }`}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={side === "left" ? "rotate-180" : ""}
                >
                  <path d="m9 6 6 6-6 6" />
                </svg>
              </button>
            ) : null
          )}
        </div>
      </div>

      {/*
        The keys, in a window that is always a whole number of rows tall.

        ## The height is a constant, and that is the point

        Two rows, the gap between them, and the padding above and below: `WINDOW_H` — three rows on a
        phone, where the grid is one column — for every category, whatever the registry holds. Pressing a category swaps nine
        keys for four and this box does not move a pixel, so nothing below it moves either — and a
        control that resizes while you browse it is a control you stop browsing.

        ## Whole rows, never a sliver

        Content is `TILE_H·n + TILE_GAP·(n − 1)`, so a window of exactly two rows leaves a scroll
        distance that is always a multiple of the row pitch. Every resting position is two complete
        rows. Snapping holds it at one, and nothing is ever half-shown at either edge.

        ## No fade, and no scrollbar either

        A fade answers "is there more?" by making the more unreadable. A scrollbar is chrome on a
        control that is already a grid of chrome, and the category counts above already say it —
        `All 10` over six visible keys is the same sentence. What replaces both is the wheel
        working from anywhere in the bed; see the effect above.

        ## The padding is for the focus ring and the cast shadow

        A tile carries its focus outline four pixels outside itself and a short shadow under its
        foot, and the window clips. The padding puts the clip outside both.
      */}
      <div
        ref={windowRef}
        className="doku-pair-window overflow-y-auto rounded-[16px] p-1.5"
        style={
          {
            "--pair-window-h": `${WINDOW_H}px`,
            "--pair-window-h-phone": `${WINDOW_H_PHONE}px`,
          } as React.CSSProperties
        }
      >
        <div
          ref={gridRef}
          role="radiogroup"
          aria-label="Trading pair"
          /* Columns are set by `.doku-pair-grid`, not by utilities: the count has to fall from three
             to two where the bench grows its rail at `lg`, and rise again at a width this theme has
             no screen for. */
          className="doku-pair-grid grid auto-rows-[68px] content-start gap-2"
        >
          {shown.map((asset, i) => {
            const selected = value?.id === asset.id;
            const live = asset.status === "live";
            const { base, suffix } = displaySymbol(asset);
            const why = live
              ? `${asset.name} — ${asset.blurb}`
              : asset.status === "listed"
                ? `${asset.name} — deployed on Monad, but not enabled on the launchpad yet`
                : `${asset.name} — not on the launchpad yet`;

            return (
              <button
                /* Keyed on the tab as well, so switching category brings the tiles in rather than
                   swapping their contents under a still frame. See `.doku-pair-tile`'s entrance. */
                key={`${tab}:${asset.id}`}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-disabled={!live}
                aria-label={`${displaySymbolText(asset)} — ${why}`}
                /* One tab stop for the whole group; the arrows move inside it. */
                tabIndex={i === focusIndex ? 0 : -1}
                title={why}
                data-selected={selected}
                data-status={asset.status}
                onClick={() => live && onChange(asset)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                    e.preventDefault();
                    moveFocus(i, 1);
                  } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                    e.preventDefault();
                    moveFocus(i, -1);
                  } else if (e.key === " " || e.key === "Enter") {
                    e.preventDefault();
                    if (live) onChange(asset);
                  }
                }}
                /* A small stagger, capped: the eye reads a row arriving, not ten separate events. */
                style={{ animationDelay: `${Math.min(i, 7) * 22}ms` }}
                className={[
                  "doku-pair-tile relative flex min-w-0 items-center gap-3 rounded-[16px] py-2.5 pl-2.5 pr-3.5 text-left",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku",
                  live ? "cursor-pointer" : "cursor-not-allowed",
                ].join(" ")}
              >
                {/* The socket: a round recess the coin is set into. 48px round a 42px coin — a 3px
                    ring, enough to read as a setting without spending the tile's height on it. */}
                <span className="doku-pair-socket grid h-12 w-12 shrink-0 place-items-center rounded-full">
                  <AssetIcon asset={asset} size={42} className="doku-pair-coin rounded-full" />
                </span>

                {/*
                  Two lines, because a ticker is not a name.

                  Six of the assets are tokenized equities, and `NVDAx` over a monogram is the whole
                  of what a key says when a mark is blocked. The company's name underneath is what
                  makes the list findable without a search box.
                */}
                <span className="doku-pair-words flex min-w-0 flex-1 flex-col gap-1.5">
                  <span
                    className={`truncate font-numeric text-[15.5px] font-semibold leading-none tracking-[0.01em] ${
                      live ? "text-ink" : "text-mute"
                    }`}
                  >
                    {base}
                    {/*
                      The tokenized-equity marker, kept but set a step down.

                      `TSLAx` is a derivative that tracks Tesla, not Tesla stock, and dropping the
                      `x` names an asset that does not exist. Muting it reads as TSLA at a glance
                      and stays true on inspection.
                    */}
                    {suffix && (
                      <span className="text-[0.78em] font-medium opacity-50">{suffix}</span>
                    )}
                  </span>
                  <span className="truncate font-ui text-[12px] leading-none text-mute">
                    {asset.name}
                  </span>
                </span>

                {/*
                  The state slot. One place on every tile, three answers.

                  A tick when chosen: a rim is a comparison — you know it is chosen because the others
                  are not — and with one category on screen there may be two tiles to compare
                  against, so the tile states it itself. An empty radio when it can be chosen. And for
                  a pair the factory would refuse, the word, cut into the surface like the rest of that
                  tile's type rather than floated over it in a badge. `listed` and `soon` read the same
                  here, because to a launcher both mean "not today"; the tile's `title` keeps the
                  difference.
                */}
                {selected ? (
                  <span
                    aria-hidden
                    className="doku-pair-check grid h-5 w-5 shrink-0 place-items-center rounded-full"
                  >
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M5 12.5 10 17.5 19 7" />
                    </svg>
                  </span>
                ) : live ? (
                  <span aria-hidden className="doku-pair-radio h-5 w-5 shrink-0 rounded-full" />
                ) : (
                  <span
                    aria-hidden
                    className="doku-pair-soon shrink-0 font-ui text-[12px] font-medium leading-none text-mute"
                  >
                    Soon
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default PairSelect;
