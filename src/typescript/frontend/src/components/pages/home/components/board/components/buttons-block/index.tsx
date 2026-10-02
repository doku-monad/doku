"use client";

import { PixelArrow } from "components/svg";
import { cn } from "lib/utils/class-name";
import React from "react";

/**
 * Pagination, as one rail.
 *
 * ## What was here
 *
 * Four circular icon buttons and a `4 / 12` between them: first, previous, next, last, each a 40px
 * sand pill with a Lucide chevron in it. Nothing about it was wrong and nothing about it was
 * *this product* — it is the pagination widget from a component library, floating unattached under
 * a grid of machined cards, saying "page" in the most generic available way.
 *
 * ## What it is now
 *
 * A single machined rail, wide and thin, with three cells divided by seams: **PREV**, the page
 * meter, **NEXT**. The same tray-and-tab construction as the tape's head plate, the pair rail and
 * the footer's cells, so the control belongs to the page it ends.
 *
 * The middle cell is the part worth arguing for. It is a **segmented meter** — one cell per page,
 * the current one lit in the brand hue, every cell a button that jumps straight to its page — which
 * is the same instrument the market card draws its bonding curve with. It does three jobs a `4 / 12`
 * does not: it shows how much board there is at a glance, it shows where in it you are as a
 * *position* rather than as arithmetic, and it turns "go to page 9" from four clicks into one.
 *
 * Past a dozen pages the meter would be a row of slivers nobody can hit, so it gives up and the
 * cell falls back to the readout with first/last keys either side of it. A control that degrades
 * into a different control is better than one that stays the same shape and stops working.
 *
 * The arrows are the pixel arrow the hero's actions carry, mirrored for `prev` — the same glyph on
 * the same grid as the mono type beside it, rather than a third icon family imported for one row.
 */

type ButtonsBlockProps = {
  value: number;
  numPages: number;
  onChange: (page: number) => void;
  className?: string;
};

/** Above this many pages the segmented meter becomes unhittable and the readout takes over. */
const MAX_SEGMENTS = 12;

/**
 * One end of the rail.
 *
 * Wide and thin — the two controls a thumb actually aims at get the width, and the label is a word
 * rather than a glyph because "PREV" is unambiguous at a glance and a lone chevron is a shape you
 * have to interpret. The label hides below `sm`, where the rail is 320px and the arrow alone is
 * the honest fit.
 */
const RailKey = ({
  onClick,
  disabled,
  label,
  direction,
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
  direction: "prev" | "next";
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-label={`${label} page`}
    className={cn(
      /* `doku-tap` because below `sm` the label is hidden and this becomes a 36px box with one
         arrow glyph in it — the primary way through the board, at under tap size, on exactly the
         width where it is the only way through. */
      "doku-pager-key doku-tap group/key flex h-9 shrink-0 items-center gap-2.5 rounded-[9px] px-3.5 sm:px-5",
      "font-numeric text-[11px] uppercase leading-none tracking-[0.12em] text-mute",
      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku",
      disabled && "pointer-events-none opacity-35"
    )}
  >
    {direction === "prev" && (
      <PixelArrow
        aria-hidden
        className="shrink-0 -scale-x-100 transition-transform duration-200 ease-out group-hover/key:-translate-x-[3px] motion-reduce:transition-none motion-reduce:group-hover/key:translate-x-0"
      />
    )}
    <span className="hidden sm:inline">{label}</span>
    {direction === "next" && (
      <PixelArrow
        aria-hidden
        className="shrink-0 transition-transform duration-200 ease-out group-hover/key:translate-x-[3px] motion-reduce:transition-none motion-reduce:group-hover/key:translate-x-0"
      />
    )}
  </button>
);

/**
 * The meter: one cell per page.
 *
 * Cells rather than a bar with a thumb, for the reason the card's curve is cells — a rounded bar
 * sliding in a track is the most generic component on the web, and a row of lit segments reads as
 * an instrument and rhymes with the pixel face everything here is set in.
 *
 * Each cell is a real button with its own accessible name, so this is navigation for a screen
 * reader and a keyboard as well as a picture of where you are.
 */
const PageMeter = ({
  value,
  numPages,
  onChange,
}: {
  value: number;
  numPages: number;
  onChange: (page: number) => void;
}) => (
  <div className="flex min-w-0 flex-1 items-center justify-center gap-[3px] px-2.5">
    {Array.from({ length: numPages }, (_, i) => {
      const page = i + 1;
      const current = page === value;
      return (
        <button
          key={page}
          type="button"
          onClick={() => onChange(page)}
          aria-label={`Page ${page}`}
          aria-current={current ? "page" : undefined}
          title={`Page ${page}`}
          data-current={current}
          className="doku-pager-cell h-[18px] min-w-[10px] max-w-[26px] flex-1 rounded-[2px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku"
        />
      );
    })}
  </div>
);

export const ButtonsBlock = ({ value, numPages, onChange, className }: ButtonsBlockProps) => {
  /* One page is not a thing to page through. The old control rendered `1 / 1` with four dead keys
     around it, which is a control that exists to tell you it cannot be used — and on a new
     deployment, where the board is one page for a while, it was the last thing on the page. */
  if (numPages <= 1) return null;

  const atStart = value <= 1;
  const atEnd = value >= numPages;
  const metered = numPages > 1 && numPages <= MAX_SEGMENTS;

  return (
    <nav
      aria-label="Pagination"
      /* `w-full` matters: the grid's container is an `align-items: center` column, which shrinks a
         block child to its content — so without this the rail was as wide as the words inside it
         and the "wide, thin" shape it is built around collapsed on a short board. */
      className={cn("flex w-full justify-center", className)}
      /* `aria-live` on the wrapper rather than on the readout: with the meter rendered there is no
         readout, and the announcement has to survive either shape of the control. */
    >
      <div className="doku-pager flex w-full max-w-[520px] items-center rounded-doku-xl p-[3px]">
        <RailKey
          direction="prev"
          label="Prev"
          disabled={atStart}
          onClick={() => !atStart && onChange(value - 1)}
        />

        <span aria-hidden className="doku-pager-seam h-6 w-px shrink-0" />

        {metered ? (
          <PageMeter value={value} numPages={numPages} onChange={onChange} />
        ) : (
          /* The fallback for a long board: the figures, with keys to either end. `tabular-nums`
             so the digits do not shuffle the seams sideways as the page count changes. */
          <div className="flex min-w-0 flex-1 items-center justify-center gap-2 px-2">
            <button
              type="button"
              onClick={() => onChange(1)}
              disabled={atStart}
              aria-label="First page"
              className="doku-pager-end doku-tap h-7 shrink-0 rounded-[7px] px-2 font-numeric text-[11px] uppercase leading-none tracking-[0.1em] text-mute focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku disabled:pointer-events-none disabled:opacity-35"
            >
              First
            </button>
            <span className="whitespace-nowrap font-numeric text-[12px] uppercase leading-none tracking-[0.1em] tabular-nums text-ash">
              <span className="text-mute">Page </span>
              {value}
              <span className="text-mute"> / {numPages}</span>
            </span>
            <button
              type="button"
              onClick={() => onChange(numPages)}
              disabled={atEnd}
              aria-label="Last page"
              className="doku-pager-end doku-tap h-7 shrink-0 rounded-[7px] px-2 font-numeric text-[11px] uppercase leading-none tracking-[0.1em] text-mute focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku disabled:pointer-events-none disabled:opacity-35"
            >
              Last
            </button>
          </div>
        )}

        <span aria-hidden className="doku-pager-seam h-6 w-px shrink-0" />

        <RailKey
          direction="next"
          label="Next"
          disabled={atEnd}
          onClick={() => !atEnd && onChange(value + 1)}
        />
      </div>

      {/* The page, stated once, for anything that cannot see the meter. */}
      <span className="sr-only" aria-live="polite">
        Page {value} of {numPages}
      </span>
    </nav>
  );
};

export default ButtonsBlock;
