"use client";

import { useReducedMotion } from "framer-motion";
import FEATURE_FLAGS from "lib/feature-flags";
import { cn } from "lib/utils/class-name";
import Link from "next/link";
import { ROUTES } from "router/routes";

/**
 * The liquidity call to action.
 *
 * ## Why it is no longer the loud one
 *
 * It used to be the only filled, gradient, glowing control on the market page, on the argument
 * that a page where three things glow has no primary action. The argument was right and the
 * conclusion was applied to the wrong control: this navigates to another route, while the button
 * directly above it *spends money on this one*. Two filled green pills stacked with the quieter of
 * them shouting was a hierarchy that pointed away from the page's own purpose.
 *
 * So the trade button is filled now (see `SwapButton`), and this is what a strong secondary looks
 * like: the same height and radius, a real surface rather than a ghost, a hairline that warms to
 * the accent on hover, and a label at full `--ink` contrast. It still reads as a destination —
 * nothing else in the column is a link — without competing with the control beside it.
 *
 * ## The shine is masked, not layered
 *
 * A diagonal highlight sweeping across a surface is trivial to get wrong — the usual mistake is a
 * white bar that visibly leaves one edge and enters the other. Here the sweep is clipped by
 * `overflow-hidden`, travels well past both sides, and rests between passes, so it reads as light
 * crossing a surface rather than as an element in motion.
 *
 * ## Why it is a link
 *
 * It navigates. Making it a `<button>` with an `onClick` router push would cost middle-click,
 * open-in-new-tab, and the status bar preview that tells someone where they are about to go.
 */
export function AddLiquidityCta({
  className,
  label = "Add liquidity",
}: {
  className?: string;
  label?: string;
}) {
  const reduced = useReducedMotion();

  /* `/pools` answers 404 while `FEATURE_FLAGS.Liquidity` is off — see `middleware.ts`. This sits
     directly under Buy on every market page, which made it the one people found. */
  if (!FEATURE_FLAGS.Liquidity) return null;

  return (
    <div className={cn("group/cta relative", className)}>
      <Link
        href={ROUTES.pools}
        className={cn(
          "relative flex h-[52px] w-full items-center justify-center gap-2.5 overflow-hidden rounded-[14px]",
          "font-ui text-[14px] font-semibold text-ash",
          "transition-all duration-200 ease-out hover:-translate-y-px hover:text-ink active:translate-y-0",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku"
        )}
        /* `--mat-bezel-bg` rather than a literal dark gradient. It was `rgba(34,34,38,0.80)`, which
           is a raised face on the dark stage and a charcoal slab in Lite Mode — with `--ash` label
           text on it, so on paper the page's secondary action was a grey block with an unreadable
           word in it. The bezel is the same face the top bar and the market card are cut from and
           it states itself per theme. */
        style={{
          background: "var(--mat-bezel-bg)",
          boxShadow:
            "inset 0 0 0 1px var(--film-2), inset 0 1px 0 var(--film-3), 0 12px 28px -20px var(--shade-4)",
        }}
      >
        {/* The accent edge, on hover only — the surface answering the pointer. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[14px] opacity-0 transition-opacity duration-300 group-hover/cta:opacity-100"
          style={{
            boxShadow:
              "inset 0 0 0 1px rgba(10,228,72,0.40), 0 12px 30px -16px rgba(10,228,72,0.45)",
          }}
        />

        {/* The shine. One pass every few seconds, clipped to the surface. */}
        {!reduced && (
          <span
            aria-hidden
            className="doku-shine pointer-events-none absolute inset-y-0 w-1/4"
            style={{
              background: "linear-gradient(100deg, transparent, var(--film-2), transparent)",
            }}
          />
        )}

        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="relative shrink-0 text-doku"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span className="relative">{label}</span>
      </Link>
    </div>
  );
}

export default AddLiquidityCta;
