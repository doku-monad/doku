import { cn } from "lib/utils/class-name";
import React from "react";

/**
 * DOKU's loading marks.
 *
 * These replace `AnimatedLoadingBoxes` — a row of green-square emoji carrying a
 * `0 0 15px 4px #00FF0055` glow and an infinite `hue-rotate(0deg → 360deg)` filter. That was the
 * original terminal theme's idiom: neon on black, cycling through the spectrum. On a paper-white
 * canvas with one brand hue it read as a rendering fault, and it was the first thing you saw after
 * launching a token, while the byte meter waited on the availability check.
 *
 * Brand rules that shape what's here: one green, no gradients, `ease-out-quint`, and "no bounce on
 * data". Motion is CSS rather than framer-motion so the global `prefers-reduced-motion` rule in
 * `global.css` switches it off along with everything else.
 */

/** Three dots that breathe in the brand green. The default inline loader. */
export const PulseDots = ({
  size = 5,
  className,
  label = "Loading",
}: {
  size?: number;
  className?: string;
  /** Announced to screen readers; never drawn. */
  label?: string;
}) => (
  <span
    role="status"
    aria-label={label}
    className={cn("inline-flex items-center gap-[5px]", className)}
  >
    {[0, 1, 2].map((i) => (
      <span
        key={i}
        aria-hidden
        className="doku-pulse-dot rounded-full bg-doku"
        style={{ width: size, height: size, animationDelay: `${i * 0.14}s` }}
      />
    ))}
  </span>
);

/**
 * An indeterminate hairline, for the top of a panel whose contents are still arriving. A 3px track
 * with a green sliver travelling across it — the same shape as the byte meter on the launch form,
 * so a panel that is loading and a panel that is filling up read as one family.
 */
export const IndeterminateBar = ({ className }: { className?: string }) => (
  <span
    role="status"
    aria-label="Loading"
    className={cn("relative block h-[3px] w-full overflow-hidden rounded-full bg-sink", className)}
  >
    <span
      aria-hidden
      className="doku-indeterminate absolute inset-y-0 w-1/3 rounded-full bg-doku"
    />
  </span>
);

export default PulseDots;
