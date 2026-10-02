"use client";

import { cn } from "lib/utils/class-name";

import { CoinMark } from "@/components/ui/coin-mark";
import { IntentLink } from "@/components/ui/intent-link";
import { useTicker } from "@/lib/hooks/use-ticker";
import { marketPath } from "@/lib/market-path";

import { capText } from "./cap-text";
import Sparkline from "./Sparkline";
import type { HotMover } from "./types";

/**
 * The runner board — the 24-hour leaderboard, built out of the same parts as everything else here.
 *
 * ## What this replaces, and why the last version was wrong
 *
 * A pane of glass with a green rim, four corner brackets and a laser sweeping down it on a loop. It
 * was reaching for "instrument", and the problem was never the ambition — it is that the product
 * already *has* an instrument language and this was not it. Look at what surrounds this component:
 * `CoinCard` in the grid below, the dock above, the market page it links into. Every one of them is
 * built from layers of material — a recessed tray, a hairline rim floating proud of it, a bezel with
 * a lit top edge, and a well pressed into that bezel for whatever has to read as a display.
 *
 * ## Why it needed another pass
 *
 * Because it had two of those layers and printed everything else flat on top of them. The rows sat
 * directly on the bezel, the marks were bare tiles, the figures were three columns of type with
 * nothing separating them, and the whole thing came out as a list with a border around it — which
 * is exactly the "cheap template" read. A board is not a list. What is added here is *structure*,
 * and every piece of it is load-bearing:
 *
 *   - **The screen.** The rows now print on a well pressed into the bezel, not on the bezel itself.
 *     That is one more material step, it is the same construction the card uses for its display
 *     window, and it is what makes the difference between a panel with text on it and an instrument
 *     with a readout in it. The title bar stays outside on the bezel — a chassis label above a
 *     screen, which is how the object is actually organised.
 *   - **The mounts.** Each mark sits in a 30px well, the card's display window shrunk down. This
 *     component's own docblock had claimed that for months while the code rendered a bare tile.
 *   - **The column rule.** A seam between the name block and the figures, so the numbers read as a
 *     column of figures rather than as the end of a sentence. It is the one thing that makes a
 *     dense row scannable, and it is why the header labels now sit *over* something.
 *   - **The rank plates.** Machined tabs, always visible rather than appearing above `mobile-lg`,
 *     with the leader's plate in the brand hue. A leaderboard whose first row looks like its fourth
 *     is not ranking anything.
 *   - **The delta chips.** The same tinted pill the market card uses, for the same reason: a signed
 *     percentage set as coloured text competes with the figure beside it, and a chip is a different
 *     *shape* the eye finds before it reads.
 *
 * Green keeps its taxonomy throughout — the live dot, a rising figure, and the rim of the row under
 * the pointer. Nothing else on the board is coloured.
 *
 * ## Why rows and not cards
 *
 * Four rows at 46px shows four markets in less vertical space than the stacked-card deck this began
 * as used for one. Density is what the container is *for*; the layers are how it stops being
 * anonymous while it does it.
 *
 * ## Motion
 *
 * There is none, by design. The board is a leaderboard, and the honest signal that it is live is
 * the relative age in the `Last` column ticking over, not a beam — nor a pulsing lamp, which the
 * header carried until it was taken out for saying the same thing louder.
 */

const ROW_H = 46;

/** How often the "last swap" age recomputes. Rendered in minutes; ten seconds is plenty. */
const AGE_TICK_MS = 10_000;

/**
 * The numeric columns, as one track definition shared by the header and every row.
 *
 * A single constant rather than the same two strings written twice, because the failure mode when
 * they drift is that the column headings stop sitting over their figures — which is subtle enough
 * to survive a review and obvious enough to make the board look broken.
 *
 * Two tracks below `sm`, three above it. `Last` is the column that goes, and it goes because at
 * 390px the row has about 280px to spend: three figures, a rank plate, a 30px well and a ticker do
 * not fit in that, and what breaks first is the ticker — `$ALIENMONSTER` truncating to `$AL…` while
 * a relative timestamp sits beside it in full. The name of the market is not the part to cut. The
 * two cells that carry `Last` are `hidden sm:block`, so below the breakpoint they leave the flow
 * entirely and `Mcap` and `24h` land on the two remaining tracks.
 */
const FIGURES = "grid-cols-[58px_62px] gap-2.5 sm:grid-cols-[72px_38px_62px]";

/** The column headings and the row figures share one register, so they line up as a table. */
const COL_LABEL =
  "text-right font-numeric text-[11px] uppercase leading-none tracking-[0.11em] text-mute";

/** A join between two panels: one dark line, one lit line under it. Never a single hairline. */
const Seam = ({ className }: { className?: string }) => (
  <span aria-hidden className={cn("doku-board-seam block w-full", className)} />
);

function ageFrom(ms: number, now: number): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h`;
  return `${Math.floor(h / 24)}d`;
}

export function RunnerBoard({ movers, failed }: { movers: HotMover[]; failed?: boolean }) {
  /* Client-seeded, so the server pass and the first client pass agree. `0` renders "—" for one
     frame, which is cheaper than a hydration mismatch on every row. `useTicker` also stops the
     clock while the tab is hidden, which the inline interval this replaced did not. */
  const now = useTicker(AGE_TICK_MS);

  return (
    /* 1. The tray. Everything below is pressed into it. */
    <div className="doku-board relative rounded-[15px] p-[3px]">
      {/* 2. The rim, floating proud of the tray's edge. */}
      <span
        aria-hidden
        className="doku-board-rim pointer-events-none absolute -inset-[3px] rounded-[18px]"
      />

      {/* 3. The bezel — the chassis. It carries the label bar and holds the screen. */}
      <div className="doku-board-face relative overflow-hidden rounded-[13px] p-[5px]">
        {/* ---- The title bar, on the chassis rather than on the screen -------------------------- */}
        <div className="flex items-center justify-between px-2 pb-2 pt-1">
          {/* The title in the headline's pixel face, as the coin tape's head sets "Coins" — the
              two instruments on this fold are named the same way. The pulsing lamp that sat in
              front of it went: a blinking green dot is the stock "live" signifier, and the ages
              ticking over in the `Last` column already say this board is live. */}
          <span className="font-pixel text-[14px] uppercase leading-none tracking-[0.06em] text-ink">
            Top runners
          </span>
          {/* The window the board is reporting on, as a machined tab rather than as loose type —
              it is a setting, not a heading, and the plate is how this product says so. */}
          <span
            className="doku-board-plate rounded-[5px] px-1.5 py-1 font-numeric text-[11px] uppercase leading-none tracking-[0.1em] text-mute"
            title="Ranked by volume over the last 24 hours"
          >
            24h vol
          </span>
        </div>

        {/*
          ---- The screen ----

          A well pressed into the chassis, with the rows printing on it. This is the layer the board
          was missing: without it the list sat on the same surface as its own title, so the panel had
          a frame and a label and nothing between them — the shape of a card, not of an instrument.
        */}
        <div className="doku-board-screen relative overflow-hidden rounded-[9px] px-1.5 pb-1.5">
          {/*
            The column headers.

            Present because this is a board and a board is read in columns — without them the three
            figures on each row are just numbers in a line. The smallest type in the product, in the
            same register the card uses for "Market cap": a label you read once and stop seeing.
          */}
          <div className="grid grid-cols-[1fr_auto] items-center gap-3 px-1.5 pb-1.5 pt-2">
            <span className="font-numeric text-[11px] uppercase leading-none tracking-[0.11em] text-mute">
              Market
            </span>
            <span className={cn("grid", FIGURES)}>
              <span className={COL_LABEL}>Mcap</span>
              <span className={cn(COL_LABEL, "hidden sm:block")}>Last</span>
              <span className={COL_LABEL}>24h vol</span>
            </span>
          </div>

          <Seam />

          {movers.length === 0 ? (
            <p
              className="grid place-items-center px-2 text-center font-ui text-[14px] text-mute"
              style={{ height: ROW_H * 4 }}
            >
              {/* Two different sentences, because they are two different facts. "Nothing traded"
                  is a statement about the chain; a failed leaderboard request is a statement about
                  this page, and saying the first when the second happened is the board inventing
                  a quiet day out of an outage. */}
              {failed
                ? "The leaderboard didn't load — try again in a moment."
                : "No market has traded in the last 24 hours."}
            </p>
          ) : (
            <ul className="list-none">
              {movers.slice(0, 4).map((m, i) => {
                // Still the sparkline's colour: the trace is a price, and rises or falls.
                const up = m.changePct === null || m.changePct >= 0;
                return (
                  <li key={m.address}>
                    {/* A seam between rows, but not above the first — the header already laid one
                        down, and two seams 2px apart is a printing error, not a divider. */}
                    {i > 0 && <Seam />}

                    <IntentLink
                      href={marketPath(m.tokenAddress)}
                      className="doku-board-row group/row grid grid-cols-[1fr_auto] items-center gap-2.5 rounded-[7px] px-1.5"
                      style={{ height: ROW_H }}
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        {/* The rank plate. Zero-padded so 1 and 4 occupy the same width and the
                            plates line up down the column, exactly as they do on the cards. The
                            leader's is struck in the brand hue — a leaderboard whose first row is
                            indistinguishable from its fourth is not ranking anything. */}
                        <span
                          aria-hidden
                          className={cn(
                            "hidden shrink-0 rounded-[4px] px-1 py-0.5 font-numeric text-[11px] leading-none tracking-[0.1em] mobile-lg:block",
                            i === 0
                              ? "doku-board-plate--lead text-doku-ink"
                              : "doku-board-plate text-mute"
                          )}
                        >
                          {String(i + 1).padStart(2, "0")}
                        </span>

                        {/* The mark, mounted rather than placed: a 30px well pressed into the
                            screen, which is the card's display window at row scale. A tile dropped
                            on a list is a favicon; the same tile in a well is the coin. */}
                        <span className="doku-board-well grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[9px]">
                          <CoinMark
                            logo={m.logo}
                            ticker={m.ticker}
                            name={m.name}
                            size={28}
                            className="!rounded-[7px] !border-0"
                          />
                        </span>

                        {/* Name over ticker. The name is what a person recognises; the ticker is
                            what they search for. Both fit at this width, and showing only the
                            ticker was a holdover from when a coin had no name to show. */}
                        <span className="flex min-w-0 flex-col gap-1">
                          <span className="truncate font-numeric text-[12px] uppercase leading-none tracking-[0.04em] text-ink">
                            {m.name}
                          </span>
                          <span className="truncate font-numeric text-[11px] leading-none text-mute">
                            ${m.ticker}
                          </span>
                        </span>

                        {/* The trace sits between the name and the figures — the eye crosses it on
                            the way to the number it explains. Hidden where the row is too narrow to
                            give it a width worth reading. */}
                        <Sparkline
                          values={m.spark}
                          positive={up}
                          className="ml-auto hidden h-[20px] w-[52px] shrink-0 sm:block"
                        />
                      </span>

                      {/* The column rule. One seam, vertical, between what the market *is* and what
                          it is *doing* — which is what turns four rows of mixed type into a table
                          and is the reason the headings above have something to sit over. */}
                      {/* `h-full` so the column rule below has the row's height to run down. The
                          span is a centred grid item, so without it the box is only as tall as the
                          figures inside it and the rule came out 3px long. */}
                      <span className={cn("relative grid h-full items-center", FIGURES)}>
                        <span
                          aria-hidden
                          className="doku-board-rule absolute inset-y-[9px] -ml-[9px] w-px"
                        />
                        <span className="truncate text-right font-numeric text-[12.5px] font-medium leading-none tabular-nums text-ink">
                          {capText(m.marketCap, m.marketCapUsd, m.quoteSymbol)}
                        </span>
                        <span className="hidden text-right font-numeric text-[11px] leading-none text-mute sm:block">
                          {m.lastSwapAt && now ? ageFrom(m.lastSwapAt, now) : "—"}
                        </span>
                        {/*
                          The figure the list is ranked by. It was the 24-hour price change as a
                          tinted chip, which is null on any market younger than a day — and on a
                          launchpad most of the board is younger than a day, so the column under
                          the "24h vol" tab read as four dashes. Set like the market cap beside it:
                          dollars when the quote is priced, else the quote figure with its symbol.
                        */}
                        <span className="truncate text-right font-numeric text-[12.5px] font-medium leading-none tabular-nums text-ink">
                          {capText(m.volume24h, m.volume24hUsd, m.quoteSymbol)}
                        </span>
                      </span>
                    </IntentLink>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export default RunnerBoard;
