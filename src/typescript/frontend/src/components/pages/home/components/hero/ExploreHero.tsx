"use client";

import { PixelArrow } from "components/svg";
import { useReducedMotion } from "framer-motion";
import Link from "next/link";
import type { CSSProperties } from "react";
import { ROUTES } from "router/routes";

import { IntentLink } from "@/components/ui/intent-link";
import type { QuoteAsset } from "@/lib/assets/quote-assets";

import { usePairCycle } from "./pair-cycle";
import { PairedWith } from "./PairedWith";
import PairRail from "./PairRail";
import RunnerBoard from "./RunnerBoard";
import TickerRail from "./TickerRail";
import type { HotMover, RailItem } from "./types";

/**
 * The explore hero.
 *
 * ## The shape, and why it is not the usual one
 *
 * The obvious hero for a product like this — and the one this was, twice — is a 45/55 split with a
 * headline on the left and a frosted glass card on the right. It is the default a design tool hands
 * you, every SaaS site since 2021 has shipped it, and it has two structural problems here: a card
 * tall enough to hold a chart makes the hero tall, and a deck showing one market at a time uses a
 * panel wide enough for four.
 *
 * What replaced it is an **instrument**. The right column is a board — four runners at once, each
 * symbol mounted in a well, ranked and figured in columns — and beneath the whole composition runs
 * a full-bleed **tape**, an exchange ticker of live markets. Neither is borrowed from another
 * product's homepage; both are the shapes this thing genuinely is. A venue that trades emoji
 * symbols should look like a venue.
 *
 * The board is built from the same tray, rim and bezel as the market cards below it, and that is
 * load-bearing rather than tidy: it was a green-rimmed HUD with a laser sweeping down it for one
 * pass, and a fold that does not look like the page under it is a fold that looks pasted on.
 *
 * The tape is also what breaks the box. Every other element on this page sits on a 1240px rail; the
 * tape runs edge to edge, so the fold stops reading as a stack of centred cards and starts reading
 * as a screen with a status band across it.
 *
 * ## Height is a feature
 *
 * Against 457 for the card version and ~560 for the one before that. The market grid — the reason
 * anyone is on this route — sits above the fold at 900px, and the board shows four markets in less
 * vertical space than one card showed one. Density bought the height back.
 *
 * The left column had reached a floor at 257px against the board's 256, and the pair rail is what
 * bought the room to add anything to it: the **stat strip went**. Three counts of what has already
 * been launched, on a fold whose entire job is to explain what *can* be — it was the least
 * load-bearing block here, it is the whole of `/stats` in miniature, and the row of assets that
 * replaced it argues the actual claim. The two columns come out level again.
 *
 * ## The badge went
 *
 * A pill above the headline reading "N markets live on Monad". It was the eyebrow every SaaS hero
 * ships, it pushed the claim down by 38px, and the fold already says both halves of it louder: the
 * tape across the foot is markets, live, moving, and the runner board beside it is four of them
 * with their figures. A label announcing what the two live instruments underneath it are showing is
 * a caption on a photograph of the thing itself.
 *
 * ## The claim and the rail are one instrument
 *
 * The headline types through the pairs a coin can be launched against today, one at a time, and the
 * rail shows all of them at once, lit on whichever the headline is currently saying. Both read the
 * registry through `usePairCycle`, seeded with the server's own read so the first paint is already
 * right, and hovering a chip pins the cycle to it — so the animation is also a control. See
 * `pair-cycle.ts`.
 *
 * ## The actions
 *
 * Both carry a pixel arrow, and both arrows say where the control actually goes — right, off the
 * page, for the launch route; down, into the grid, for the anchor that scrolls to it. The glyph is
 * on the same grid as the pixel type beside it, which is the only reason it can sit that close to
 * it without reading as an icon from somewhere else.
 *
 * The primary sits in Cult UI's `ConicRing` — the same band the top bar's active item and the
 * market cards use — held still at rest and turning under the pointer. It is the one control on
 * the fold that should look powered.
 *
 * ## The entrance is CSS, and that is a performance decision
 *
 * Every stage of it used to be a `motion.div` with `initial={{ opacity: 0 }}`, which writes
 * `opacity: 0` into the server's HTML and waits for hydration to undo it. The whole fold — claim,
 * rail, actions, board, tape — therefore arrived complete and invisible, and stayed invisible until
 * ~290 kB of route JavaScript had parsed: 1.44s to 4.93s on a mid-range phone, and an LCP of 6.4s
 * that was really a measurement of hydration. It is all `.doku-rise` now; see the keyframes in
 * `global.css` for the full account.
 *
 * ## Reduced motion
 *
 * The entrance is switched off by a media query rather than by a hook, so it is settled before the
 * first frame instead of after mount. The tape pauses, the headline stops typing (it holds the first
 * pair, fully typed) and the header's pulse dot stops. The layout, the
 * hierarchy and the data all survive; nothing travels. The rail is unaffected — it is a row of
 * links that happens to light one of them.
 */

/**
 * One stage of the entrance, in the order the eye takes them.
 *
 * The animation itself is `.doku-rise` in `global.css` — this only says *when*, because the
 * stagger is a property of the composition and belongs where the elements are. See the note over
 * the keyframes for why none of this is `framer-motion` any more.
 */
const rise = (step: number, override?: { from?: string; dur?: string }): CSSProperties =>
  ({
    "--rise-delay": `${(0.05 + step * 0.07).toFixed(2)}s`,
    ...(override?.from ? { "--rise-from": override.from } : {}),
    ...(override?.dur ? { "--rise-dur": override.dur } : {}),
  }) as CSSProperties;

export function ExploreHero({
  movers,
  rail,
  pairs,
  failed,
}: {
  movers: HotMover[];
  rail: RailItem[];
  /** The quote registry as the server read it — empty if that read failed. See `usePairCycle`. */
  pairs: QuoteAsset[];
  /**
   * Whether the leaderboard read FAILED, rather than coming back empty.
   *
   * Without it the runner board said "No market has traded in the last 24 hours" on an outage —
   * a statement about the chain made from a network error — and the tape simply vanished. Both are
   * claims this page is not entitled to make from a 500.
   */
  failed?: boolean;
}) {
  const reduced = useReducedMotion();

  /* The claim and the rail under it are one instrument, so they share one cycle. See
     `pair-cycle.ts` for why this is held here rather than inside either of them. */
  const cycle = usePairCycle(!!reduced, pairs);

  return (
    <section className="relative isolate overflow-hidden rounded-[22px]">
      {/*
        The ground.

        Three WebGL canvases used to churn behind this — a warp, a dither and a shaft of god rays,
        in green, violet and teal. What is here instead is the page frame's own face, left visible,
        with a fine cream dot lattice and one soft wash off the top edge over it. See
        `.doku-hero-ground` in `global.css` for why an aurora was the wrong ground for a surface
        whose every other panel is machined out of trays and bezels.
      */}
      <div className="doku-hero-ground pointer-events-none absolute inset-0 -z-10" aria-hidden />

      <div className="relative z-10 grid grid-cols-1 items-center gap-5 px-4 pb-2.5 pt-5 sm:gap-7 sm:px-6 sm:pt-6 lg:grid-cols-[46fr_54fr] lg:gap-9 lg:pb-3 lg:pt-7">
        {/* ==================== Left: the claim ==================== */}
        <div className="flex flex-col items-start">
          {/*
            The claim.

            "Paired with ___" is the whole repositioning. This was an emoji launchpad and the
            headline said so; it is a launchpad where the *pair* is the choice — the chain's own
            asset, a stablecoin, a major, gold — and the accent lands on the word that changed. That
            word names the live pairs rather than gesturing at them.
          */}
          <h1 className="font-pixel text-[clamp(1.9rem,3.85vw,3rem)] font-medium uppercase leading-[1.02] tracking-[0.02em] text-ink">
            <span className="doku-rise-mask block pb-[0.12em]" style={rise(0)}>
              <span className="doku-rise block" style={rise(0)}>
                Launch coins
              </span>
            </span>
            {/* Held on one line from `sm` up, so the column sizes to the claim. It used to be
                held open by the pair rail's width instead: with seven chips the rail was wider
                than the sentence, and when it shrank to the live pairs the word dropped onto a
                line of its own. Below `sm` the word does take its own line — with its mark,
                which reads as intended at that width rather than as a wrap. */}
            <span className="doku-rise-mask block pb-[0.12em]" style={rise(1)}>
              <span className="doku-rise block sm:whitespace-nowrap" style={rise(1)}>
                {/* The claim takes the brand green; the full stop stays cream. Colouring the
                    punctuation too makes the sentence read as a logo rather than as a sentence.

                    The last word types itself through the assets a coin can be paired against
                    right now — MON, USDC, gold — each with its mark. See `PairedWith`. */}
                <span className="text-ink">paired with </span>
                <PairedWith reduced={!!reduced} cycle={cycle} />
              </span>
            </span>
          </h1>

          {/*
            The supporting paragraph is gone.

            It read "Name the coin, choose what it trades against, sign once. The market is live on
            Monad in a single transaction — and it stays there for good." Every clause of it is true
            and every clause of it is answered by something the reader can already see: the rail
            below names what you choose between, the primary action says what you do, and the tape
            across the foot is markets, live, on Monad. A paragraph that restates the instruments
            around it is a caption, and captions on a fold this dense are the part people scroll
            past to reach the grid.

            What it bought back is 60px of the left column — which is why the rail and the actions
            now sit level with the runner board's own rows rather than below them.
          */}

          {/* The live pairs themselves, as marks. The headline names one at a time; this shows the
              range at a glance, hovering a chip holds the headline on it, and clicking one opens
              the launch form with that pair chosen. See `PairRail`. */}
          <div className="doku-rise mt-5 w-full sm:mt-6" style={rise(2)}>
            <PairRail cycle={cycle} />
          </div>

          <div
            className="doku-rise mt-4 flex w-full flex-col gap-2.5 sm:mt-5 sm:w-auto sm:flex-row sm:items-center sm:gap-3"
            style={rise(3)}
          >
            {/*
              No conic ring around this one any more.

              `DOCK_RINGS.brand` is Cult UI's mint-cyan-lime sweep, and it is right where it is used
              elsewhere — the bar's active item and the market card's window, both dark surfaces
              where a spectrum band reads as light catching an edge. Around `.doku-cta` it does not:
              that key is a solid brand fill now, so the ring wrapped a green button in a halo of a
              different palette and, because a conic is bright on one arc and dark on the opposite
              one, the 1.5px band was cyan on the left, yellow at the top and gone on the right. A
              rim that changes colour and brightness around the perimeter does not read as a rim —
              it reads as a border that failed to draw, which is exactly how it was reported.

              The filled key already carries its own edge and foot in `--mat-cta-edge` and
              `--mat-cta-shadow`, which is what every other `.doku-cta` in the product shows. Same
              class, same object, same appearance.
            */}
            <IntentLink
              href={ROUTES.launch}
              className="doku-cta-shell group relative inline-flex h-[43px] rounded-[14px]"
            >
              <span className="doku-cta relative z-10 inline-flex h-full w-full items-center justify-center gap-2.5 overflow-hidden rounded-[14px] px-6 font-numeric text-[12px] uppercase tracking-[0.09em]">
                <span aria-hidden className="doku-cta-sheen" />
                <span className="relative z-10">Launch a coin</span>
                <PixelArrow
                  aria-hidden
                  className="relative z-10 shrink-0 transition-transform duration-200 ease-out group-hover:translate-x-[3px] motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
                />
              </span>
            </IntentLink>

            {/*
              The second action goes to the registry, not down the page.

              It was an anchor into the grid below, which is a control that scrolls you to
              something already visible. The question a launcher actually has at this point is
              "paired with *what*" — the headline just made that claim — and `/assets` is the page
              that answers it.
            */}
            <Link
              href={ROUTES.assets}
              className="doku-ghost group inline-flex h-[43px] items-center justify-center gap-2.5 rounded-[14px] px-6 font-numeric text-[12px] uppercase tracking-[0.09em] text-mute"
            >
              Browse assets
              <PixelArrow
                aria-hidden
                className="shrink-0 transition-transform duration-200 ease-out group-hover:translate-x-[3px] motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
              />
            </Link>
          </div>
        </div>

        {/* ==================== Right: the instrument ====================

            Hidden below `lg`, where it is not a right-hand column at all.

            The hero is a two-column grid from `lg` up and a single stack below it, so on a phone the
            runner board is not *beside* the headline — it is four more rows underneath it, and it
            pushed the first market card to 1,115px down the document. On an 844px screen that is a
            full screen and a half of hero before a single coin, on the page whose entire job is
            showing coins.

            It is also a duplicate at that width: every market it lists is in the grid a scroll
            below, the tape under it is already carrying live prices, and the four routes it offers
            are four taps in a bar that is permanently on screen. Nothing is lost by leaving it to
            the width that has a column to put it in.
           ============================================================ */}
        <div
          className="doku-rise hidden lg:block"
          style={
            { ...rise(0, { from: "10px", dur: "0.7s" }), "--rise-delay": "0.16s" } as CSSProperties
          }
        >
          <RunnerBoard movers={movers} failed={failed} />
        </div>
      </div>

      {/*
        The tape, full-bleed.

        Outside the padded grid above so it can run to the section's own edges — that edge-to-edge
        band is the thing that stops this reading as another boxed hero.
      */}
      <div
        className="doku-rise relative z-10"
        style={
          {
            "--rise-delay": "0.34s",
            "--rise-dur": "0.6s",
            "--rise-from": "0px",
          } as CSSProperties
        }
      >
        <TickerRail items={rail} failed={failed} />
      </div>
    </section>
  );
}

export default ExploreHero;
