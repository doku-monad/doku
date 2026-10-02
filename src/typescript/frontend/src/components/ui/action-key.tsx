"use client";

import { cn } from "lib/utils/class-name";
import type React from "react";

/**
 * The one key shape every committing action in this product wears.
 *
 * ## Why it is one component and not four
 *
 * Buy, Sell, *Switch to Monad* and *Connect* all occupy the same slot at the foot of the same
 * panel, one at a time, and they were three different objects: two of them shared a local `TradeCta`
 * in the market page, and Connect was standing in with the **navigation bar's** control — a recessed
 * well with a turning conic ring, rendered full width. So the single most-used column in the app
 * changed its material depending on which of four things it currently had to say.
 *
 * They are the same key now: same height, same radius, same lit lip, same foot in shadow. Only the
 * paint moves, and it moves for a reason a trader already knows — green takes money in, red takes it
 * out, amber is a detour. Nothing about the shape encodes meaning, so nothing about the shape has to
 * be re-learned.
 *
 * `connect` is the one tone that is not painted: attaching a wallet signs nothing, so it wears the
 * bezel face with a brand hairline instead of a fill, and becomes the filled brand key once there is
 * something to sign. See `.doku-key--connect`.
 *
 * ## Why the material is CSS and not inline style
 *
 * The connect fallback cannot be a `<button>` — it is *inside* one, because the component that
 * decides whether a wallet is attached owns the click. An inline `:hover` cannot cross that
 * boundary; a class can, and `button:hover > .doku-key` does. One recipe, two hosts.
 */

export type ActionTone = "buy" | "sell" | "warn" | "connect";

const TONE_CLASS: Record<ActionTone, string> = {
  buy: "doku-key--buy",
  sell: "doku-key--sell",
  warn: "doku-key--warn",
  connect: "doku-key--connect",
};

/**
 * Two sizes, and they are the two slots this key lands in.
 *
 * `md` is the trade panel's action column, sized to the direction keys above it. `lg` is the launch
 * bench's rail, where the button is the last thing on a page-long form and carries more weight than
 * anything around it.
 */
const SIZE_CLASS = {
  md: "h-12 gap-2 rounded-[14px] text-[15px]",
  lg: "h-14 gap-2.5 rounded-[16px] text-[15px]",
} as const;

/**
 * The key's radius, for the host that has to match it.
 *
 * `ButtonWithConnectWalletFallback` renders this component as a `span` inside its own button, and
 * `global.css` gives any button that did not ask for a radius a pill one. So the ring on a
 * keyboard-focused Connect key was a 9999px pill drawn around a 16px rounded rectangle — which is
 * what a launcher saw after closing the wallet dialog with Escape, because that hands focus back to
 * the trigger. Exported rather than duplicated: two numbers in two files drift.
 */
export const KEY_RADIUS_CLASS = {
  md: "rounded-[14px]",
  lg: "rounded-[16px]",
} as const;

export function ActionKey({
  children,
  tone,
  size = "md",
  disabled,
  loading,
  onClick,
  as = "button",
  className,
}: {
  children: React.ReactNode;
  tone: ActionTone;
  size?: keyof typeof SIZE_CLASS;
  disabled?: boolean;
  loading?: boolean;
  onClick?: () => void;
  /**
   * `span` for the connect fallback, which is rendered inside a button this component does not own.
   * Everything visual is identical; only the semantics move to the host.
   */
  as?: "button" | "span";
  className?: string;
}) {
  const classes = cn(
    "doku-key relative flex w-full items-center justify-center font-ui font-semibold tracking-[0.01em]",
    SIZE_CLASS[size],
    /* No `text-mute` here: it lost to `.doku-key`'s own colour every time — equal specificity,
       and `global.css` is ordered after the utilities layer — so the held label rendered in the
       canvas colour on a near-canvas fill. The disabled colour lives in `.doku-key--off`, beside
       the rule that would otherwise beat it. */
    disabled ? "doku-key--off cursor-not-allowed" : TONE_CLASS[tone],
    className
  );

  const inner = (
    <>
      {loading && (
        <span
          aria-hidden
          className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-solid border-canvas/30 border-t-canvas"
        />
      )}
      {children}
    </>
  );

  if (as === "span") {
    return <span className={classes}>{inner}</span>;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        classes,
        /* Ink, not brand. The house ring is `--doku` and that is right on a neutral surface; two
           pixels off a saturated brand face it reads as a second selected state rather than as
           focus. Ink clears both fills and both themes. */
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      )}
    >
      {inner}
    </button>
  );
}

export default ActionKey;
