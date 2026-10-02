"use client";

import { cn } from "lib/utils/class-name";

/**
 * An on/off switch with its own label and explanation.
 *
 * The whole control is the target, not just the track — a 44×24 toggle is a small thing to hit and
 * the words beside it are the part people aim at anyway. `role="switch"` with `aria-checked` so it
 * announces as a switch rather than as a button somebody has to infer the state of.
 *
 * On is the brand hue with a lit rim; off is a recessed well. Both states carry a hairline, so the
 * control never disappears into the panel behind it — the previous version's off state was a dark
 * fill on a dark card, which read as an absence rather than as a switch that is off.
 */
export const Switch = ({
  checked,
  onChange,
  label,
  hint,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  className?: string;
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    onClick={() => onChange(!checked)}
    className={cn(
      "group flex w-full items-center justify-between gap-4 rounded-doku-2xl px-3.5 py-3 text-left transition-[background-color,box-shadow]",
      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku",
      /* The card's edge — a hairline, a lit lip, a shaded foot — and the brand's version of the
         same three lines when it is on, so throwing the switch changes the surface's light rather
         than recolouring an outline. */
      checked
        ? "bg-doku/10 shadow-[inset_0_0_0_1px_rgb(var(--doku-rgb)/0.45),inset_0_1px_0_rgb(var(--doku-rgb)/0.3),inset_0_-1px_0_var(--shade-2)]"
        : "doku-edge hover:bg-[var(--film-1)]",
      className
    )}
  >
    <span className="flex min-w-0 flex-col gap-1">
      <span
        className={cn(
          "font-ui text-[14px] font-semibold transition-colors",
          checked ? "text-doku-ink" : "text-ink"
        )}
      >
        {label}
      </span>
      {hint && <span className="font-ui text-[12px] leading-snug text-mute">{hint}</span>}
    </span>

    {/* The track. A fixed width so the thumb's travel is the same on every switch in the app. */}
    <span
      aria-hidden
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-doku-pill transition-colors duration-200",
        checked ? "bg-doku" : "bg-[var(--film-3)]"
      )}
      style={checked ? undefined : { boxShadow: "var(--mat-well-shadow)" }}
    >
      <span
        className={cn(
          "absolute top-1/2 h-[18px] w-[18px] -translate-y-1/2 rounded-full bg-pure-white shadow-doku-card transition-[left] duration-200 ease-out motion-reduce:transition-none",
          checked ? "left-[23px]" : "left-[3px]"
        )}
      />
    </span>
  </button>
);

export default Switch;
