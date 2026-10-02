"use client";

import { cn } from "lib/utils/class-name";
import Link from "next/link";
import type React from "react";

/**
 * The filled faces this button can wear. Mirrors the market page's `TradeCta` tones.
 *
 * Every stop is a token, and the outer two did not used to be. They were literals — `#3BF06B` and
 * `#06C63C`, `#FFC170` and `#F09330` — with only the middle stop themed, under a label of
 * `text-canvas`. On the stage that is near-black on a bright green and reads at 10:1. On paper
 * `--canvas` is `rgb(237 240 238)`, so the launch page's one primary action rendered its label at
 * **1.32:1** against the top stop: "Launch" was not there at all. The button that commits the
 * whole form was the least readable thing on the page in one of the two themes.
 *
 * `--key-*` are the action keys' own tokens (see `global.css`), already restated per theme so a
 * white label clears 4.5:1 on paper and a near-black one clears it on the stage. Using them here
 * also makes this key the same object as Buy, Sell and Connect, which it always claimed to be.
 */
const TONES = {
  brand: {
    fill: "linear-gradient(180deg, var(--key-lip) 0%, rgb(255 255 255 / 0) 54%, rgb(0 0 0 / 0.14) 100%), var(--key-buy-fill)",
    glow: "0 12px 32px -14px rgba(10,228,72,0.9)",
  },
  warn: {
    fill: "linear-gradient(180deg, var(--key-lip) 0%, rgb(255 255 255 / 0) 54%, rgb(0 0 0 / 0.14) 100%), var(--key-warn-fill)",
    glow: "0 12px 32px -14px rgba(255,171,77,0.85)",
  },
} as const;

/**
 * The launch button.
 *
 * ## What it replaces
 *
 * A `CosmicButton` — a three-layer animated ring control used on this page and nowhere else, with
 * its label in a tracked pixel face at 13px, swapping its ring between `danger` and `brand` to
 * report readiness. Two problems. It was a bespoke control on the one page whose job is to look
 * like the rest of the product, and a red ring on a *disabled* button reads as "this is dangerous"
 * rather than "you have not finished" — the state it spent almost all of its time in, because the
 * button is unusable until a symbol is picked.
 *
 * `LaunchCta` below is the market page's trade CTA at launch scale: filled, full-width, 56px, label
 * in `--canvas` on brand green at 15px semibold — the highest-contrast pairing this palette has.
 * Disabled keeps its shape and its readable label and loses only the colour, so "Pick a valid
 * symbol" is still legible, which is the whole point of putting the reason *in* the label.
 *
 * ## Tone
 *
 * Green is the launch itself. `warn` is amber, and exists for the one thing that occupies this
 * button without being a launch: "Switch to Monad", when the wallet is connected to another
 * network. Colouring that green would make a detour look like the commitment it is standing in
 * front of, which is the same reason the trade CTA carries an amber tone for it.
 */
export function LaunchCta({
  children,
  disabled,
  loading,
  onClick,
  as,
  href,
  tone = "brand",
}: {
  children: React.ReactNode;
  disabled?: boolean;
  loading?: boolean;
  onClick?: () => void;
  as: "button" | "link";
  href?: string;
  tone?: keyof typeof TONES;
}) {
  const base = cn(
    "group/cta relative flex h-14 w-full items-center justify-center gap-2.5 rounded-[16px]",
    "font-ui text-[15px] font-semibold tracking-[0.01em]",
    "transition-[transform,box-shadow] duration-200 ease-out",
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku",
    disabled
      ? "cursor-not-allowed text-mute"
      : "text-[color:var(--key-ink)] hover:-translate-y-px active:translate-y-0 active:scale-[0.99]"
  );

  const style = disabled
    ? {
        background: "linear-gradient(180deg, var(--film-2) 0%, var(--film-1) 100%)",
        boxShadow: "inset 0 0 0 1px var(--film-2)",
        /* Opts out of `global.css`'s `:where(button:disabled) { opacity: 0.5 }`. That rule's own
           comment says it must lose to a component that styles its own disabled state, but
           `:where()` only zeroes specificity — with nothing competing, it still applied, and the
           held label here is the sentence telling a launcher what is missing ("Pick a valid
           symbol"). Half strength is the one thing it must not be. */
        opacity: 1,
      }
    : {
        background: TONES[tone].fill,
        boxShadow: `inset 0 1px 0 rgba(255,255,255,0.45), inset 0 -1px 0 var(--shade-1), ${TONES[tone].glow}`,
      };

  const inner = (
    <>
      {loading && (
        <span
          aria-hidden
          className="h-4 w-4 animate-spin rounded-full border-2 border-solid border-canvas/30 border-t-canvas"
        />
      )}
      {children}
    </>
  );

  return as === "link" ? (
    <Link href={href ?? "#"} className={base} style={style}>
      {inner}
    </Link>
  ) : (
    <button type="button" onClick={onClick} disabled={disabled} className={base} style={style}>
      {inner}
    </button>
  );
}

export default LaunchCta;
