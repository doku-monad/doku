"use client";

import { Panel } from "components/ui/panel";
import { cn } from "lib/utils/class-name";
import { type ReactNode, useId, useState } from "react";

/**
 * One numbered step on the bench.
 *
 * The form used to be a single undifferentiated column: picker, then two definition rows, then
 * three link fields, then five mechanics rows, then a button — twelve controls with nothing saying
 * which of them you had to touch and which were optional or purely informational. Splitting it into
 * named steps is the whole point: some are *required*, some are not, and the last is not a step at
 * all but the terms you are agreeing to by pressing the button.
 *
 * ## Why it is a `Panel` now
 *
 * It was a `TextureCardStyled` — a surface used nowhere else in the product. The market page, the
 * pools page and the home grid are all built from the same three layers (a rim floating proud, a
 * translucent bezel, a lit top edge), and this page was the one route that looked like it had been
 * designed by someone who had not seen the others. Nothing here draws its own box any more; it
 * borrows the one every other module already sits in.
 *
 * The index plate is set in the pixel face at a size that reads as stamped metal, which is where
 * the numbering does its work — you can find "where was I" from across the screen.
 *
 * ## No subtitle
 *
 * Each header carried a sentence explaining what the step was for. Five of them, above five titles
 * that already say it: "Identity" over "The name, ticker and images your coin trades under". The
 * people using this deploy contracts; the copy told them nothing the labels underneath did not, and
 * it pushed the first field of every step a line and a half further down the page.
 */
export function StepCard({
  index,
  title,
  optional,
  collapsible,
  defaultOpen = false,
  children,
  className,
}: {
  index: string;
  title: string;
  optional?: boolean;
  /**
   * Renders the step closed, behind its own header.
   *
   * For a step most launches will skip. An optional revenue decision that is *open* by default is
   * one every launcher has to read and dismiss; closed, it is there for whoever wants it and
   * costs everybody else one line. Only ever use this where the step's default is also a complete
   * answer — a collapsed step hiding a required field is a trap.
   */
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const shown = !collapsible || open;

  /*
   * The header is a band, not a line of text.
   *
   * Five panels stacked in a two-column grid all looked alike, and a step's number and title read
   * as the first line of its content rather than as a heading over it. It bleeds to the panel's
   * edges with a tinted ground and a hairline under it — so each box in the grid is visibly a
   * *box with a head*, and the eye can find "where does step 4 start" without reading anything.
   *
   * The negative margins are the panel's own padding, given back. Keep them in step with
   * `Panel`'s `p-4 sm:p-5` or the band will sit inset from the edge it is meant to meet.
   */
  const header = (
    <div className="-mx-4 -mt-4 flex items-center gap-2.5 rounded-t-[20px] border-b border-line bg-[var(--film-1)] px-4 pb-3.5 pt-4 sm:-mx-5 sm:-mt-5 sm:px-5 sm:pt-[18px]">
      {/* The index plate. A filled brand chip rather than a recessed grey one: it was a 16%-ink
            well with dark-green type on it, which on paper is two low-contrast values stacked and
            unreadable at 10px. */}
      <span
        aria-hidden
        className="grid h-7 w-7 shrink-0 place-items-center rounded-doku-lg bg-doku font-numeric text-[12px] font-semibold leading-none tracking-[0.04em]"
        style={{ color: "var(--mat-cta-ink)" }}
      >
        {index}
      </span>

      <h2 className="min-w-0 truncate font-ui text-[17px] uppercase leading-none tracking-[0.06em] text-ink">
        {title}
      </h2>

      {optional && (
        <span className="ml-auto shrink-0 rounded-doku-pill border border-line bg-[var(--film-2)] px-2.5 py-1.5 font-numeric text-[11.5px] font-semibold uppercase leading-none tracking-[0.08em] text-ash">
          Optional
        </span>
      )}

      {/* A drawn chevron rather than the `▸` character. That glyph is a *text* triangle: its
            weight, size and vertical centring come from whichever font happens to resolve it, so it
            sat a pixel low against the pixel-face heading and rendered noticeably heavier on
            Windows than on macOS. This one is on the same 1.8-weight grid as every other icon in
            the form and takes `currentColor`, so it follows the hover state with the title. */}
      {collapsible && (
        <span
          aria-hidden
          className={cn(
            "inline-flex shrink-0 text-mute transition-transform duration-200",
            optional ? "ml-1.5" : "ml-auto",
            open && "rotate-90"
          )}
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
            <path d="M9 5.5 15.5 12 9 18.5" />
          </svg>
        </span>
      )}
    </div>
  );

  return (
    <Panel className={cn("w-full", className)}>
      <div className="flex flex-col gap-5">
        {collapsible ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={bodyId}
            className="w-full text-left transition-colors hover:brightness-[1.03]"
          >
            {header}
          </button>
        ) : (
          header
        )}

        {shown && (
          <div id={bodyId} className="px-0.5 pb-0.5">
            {children}
          </div>
        )}
      </div>
    </Panel>
  );
}

export default StepCard;
