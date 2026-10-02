"use client";

import { BrandDisc } from "components/brand/BrandMark";
import { PixelArrow } from "components/svg";
import { cn } from "lib/utils/class-name";
import Link from "next/link";
import React from "react";

import { useCopyFlag } from "@/lib/hooks/use-copy-flag";

/**
 * The page you get when there is nothing to show: a thrown error, a 404, maintenance, a route that
 * isn't open yet.
 *
 * ## Why it is an instrument now
 *
 * It was the brand disc floating in an empty frame, a centred heading, a paragraph, and two
 * controls from nowhere else in the product: a dark pill with a green outline and a bare text link.
 * On a site whose every surface is machined — trays, rims, bezels, recessed screens, keys — it read
 * as the one page nobody had designed, and it is the page people land on when something has already
 * gone wrong.
 *
 * So it is the runner board's construction, as a panel:
 *
 *   1. **The chassis bar** — the disc, the state in the board's mono label, and a status plate
 *      (`ERR`, `404`, `503`) on the machined tab the board uses for its window, struck in the
 *      state's hue. The plate is what tells you at a glance whether this is a failure or a
 *      destination that does not exist.
 *   2. **The screen** — a recess carrying the heading in the hero's pixel display face, the
 *      explanation, and, for a failure, the reference: the one handle on a specific error once it is
 *      in production, now copyable rather than read off the screen and retyped.
 *   3. **The keys** — the hero's own: the lit `doku-cta` with its sheen for the way forward, the
 *      `doku-ghost` for the way back, pixel arrows on the ones that go somewhere.
 *
 * Laid on the hero's dot lattice, fading out from the panel, so the page has a ground rather than
 * a void around it.
 */
export type StatusAction = {
  label: string;
  /** A link out, or a handler — `onClick` wins if both are given. */
  href?: string;
  onClick?: () => void;
  variant?: "primary" | "secondary";
};

/** What the status plate is struck in. A failure, a warning, or a plain destination. */
export type StatusTone = "error" | "warn" | "neutral";

/** One action, as the hero draws its two: a lit key forward, a ghost key back. */
const StatusKey = ({ action }: { action: StatusAction }) => {
  const arrow = !action.onClick && (
    <PixelArrow
      aria-hidden
      className="relative z-10 shrink-0 transition-transform duration-200 ease-out group-hover:translate-x-[3px] motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
    />
  );

  if (action.variant === "secondary") {
    const className =
      "doku-ghost group inline-flex h-[43px] items-center justify-center gap-2.5 rounded-[14px] px-6 font-numeric text-[12px] uppercase tracking-[0.09em] text-mute";
    return action.onClick ? (
      <button type="button" onClick={action.onClick} className={className}>
        {action.label}
      </button>
    ) : (
      <Link href={action.href ?? "/"} className={className}>
        {action.label}
        {arrow}
      </Link>
    );
  }

  const face = (
    <span className="doku-cta relative z-10 inline-flex h-full w-full items-center justify-center gap-2.5 overflow-hidden rounded-[14px] px-6 font-numeric text-[12px] uppercase tracking-[0.09em]">
      <span aria-hidden className="doku-cta-sheen" />
      <span className="relative z-10">{action.label}</span>
      {arrow}
    </span>
  );
  const shell = "doku-cta-shell group relative inline-flex h-[43px] rounded-[14px]";

  return action.onClick ? (
    <button type="button" onClick={action.onClick} className={shell}>
      {face}
    </button>
  ) : (
    <Link href={action.href ?? "/"} className={shell}>
      {face}
    </Link>
  );
};

/**
 * The failure's reference, on a seam under the explanation, with a key that copies it.
 *
 * A digest is only useful to whoever it is sent to, and nobody retypes nine digits correctly. The
 * key confirms for as long as it takes to read "Copied", then goes back.
 */
const Reference = ({ value }: { value: string }) => {
  /* A denied clipboard leaves `copied` false: the reference is still on screen to be selected by
     hand. */
  const { copied, copy } = useCopyFlag(1600);

  return (
    <>
      <span aria-hidden className="doku-board-seam mt-6 block w-full" />
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="font-numeric text-[11px] uppercase leading-none tracking-[0.12em] text-mute">
          Reference
        </span>
        <code className="select-all font-numeric text-[12.5px] leading-none tabular-nums text-ink">
          {value}
        </code>
        <button
          type="button"
          onClick={() => void copy(value)}
          className="doku-ghost inline-flex h-7 items-center rounded-[8px] px-2.5 font-numeric text-[11px] uppercase leading-none tracking-[0.1em] text-mute"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </>
  );
};

export const StatusPage = ({
  eyebrow,
  title,
  code,
  tone = "neutral",
  reference,
  children,
  actions = [],
  className,
}: React.PropsWithChildren<{
  eyebrow: string;
  title: string;
  /** The status plate: `ERR`, `404`, `503`, `Soon`. */
  code?: string;
  tone?: StatusTone;
  /** A failure's digest — shown on the screen with a copy key. */
  reference?: string;
  actions?: StatusAction[];
  className?: string;
}>) => (
  <div
    className={cn(
      "relative isolate flex w-full grow items-center justify-center py-10 sm:py-16",
      className
    )}
  >
    <div aria-hidden className="doku-status-ground pointer-events-none absolute inset-0 -z-10" />

    <section className="doku-board relative w-full max-w-[600px] rounded-[20px] p-[3px]">
      <span
        aria-hidden
        className="doku-board-rim pointer-events-none absolute -inset-[3px] rounded-[23px]"
      />

      <div className="doku-board-face relative overflow-hidden rounded-[17px] p-[6px]">
        {/* ---- The chassis bar ---- */}
        <div className="flex items-center justify-between gap-3 px-2 pb-2.5 pt-1.5">
          <span className="flex min-w-0 items-center gap-2.5">
            <BrandDisc size={22} />
            <span className="truncate font-numeric text-[11px] uppercase leading-none tracking-[0.14em] text-ash">
              {eyebrow}
            </span>
          </span>
          {code && (
            <span
              data-tone={tone}
              className="doku-status-code shrink-0 rounded-[5px] px-1.5 py-1 font-numeric text-[11px] font-semibold uppercase leading-none tracking-[0.1em]"
            >
              {code}
            </span>
          )}
        </div>

        {/* ---- The screen ---- */}
        <div className="doku-board-screen rounded-[13px] px-5 pb-6 pt-7 sm:px-8 sm:pb-8 sm:pt-9">
          {/* `text-balance` so a two-line heading breaks somewhere sensible rather than leaving
              one orphaned word on the second line. */}
          <h1 className="text-balance font-pixel text-[30px] font-medium uppercase leading-[1.04] tracking-[0.02em] text-ink sm:text-[40px]">
            {title}
          </h1>

          {children && (
            <div className="mt-4 max-w-[48ch] font-ui text-[14px] leading-relaxed text-mute sm:text-[15px]">
              {children}
            </div>
          )}

          {reference && <Reference value={reference} />}
        </div>

        {/* ---- The keys ---- */}
        {actions.length > 0 && (
          <div className="flex flex-col gap-2.5 px-1 pb-1 pt-3 sm:flex-row sm:items-center">
            {actions.map((action) => (
              <StatusKey key={action.label} action={action} />
            ))}
          </div>
        )}
      </div>
    </section>
  </div>
);

export default StatusPage;
