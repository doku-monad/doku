import React from "react";

/**
 * The social marks, drawn in `currentColor`.
 *
 * ## Why these are not the icons in `components/svg/icons/`
 *
 * `Twitter.tsx` and `TelegramOutlineIcon.tsx` already exist and neither can be used here. Both are
 * built on the legacy `components/svg/Svg` styled-components wrapper and both fill their path from
 * `darkTheme.colors[color]` — a colour imported from the DARK theme object at module scope. On the
 * Lite canvas that paints a near-black glyph regardless of what the surrounding text is doing, and
 * it cannot follow a `text-mute` → `text-ink` hover, because the fill is not `currentColor`.
 *
 * `TelegramOutlineIcon` additionally draws its own `<circle stroke="black">`, so it is a bordered
 * badge rather than a glyph — it would sit beside the X letterform as a different kind of object.
 *
 * These are single paths at `currentColor` on a 24 grid, so they inherit the row's colour, animate
 * with its hover transition, and take the same `width`/`height` props the legacy icons do — which
 * is what lets them sit in one `SOCIAL_ICONS` list beside `Discord`.
 */

type MarkProps = {
  width?: string | number;
  height?: string | number;
  className?: string;
};

const base = (width: MarkProps["width"], height: MarkProps["height"]) => ({
  width: width ?? 15,
  height: height ?? 15,
  viewBox: "0 0 24 24",
  fill: "currentColor",
  "aria-hidden": true as const,
  focusable: "false" as const,
});

/** The X letterform — the mark itself, with no enclosing disc. */
export const XMark = ({ width, height, className }: MarkProps) => (
  <svg {...base(width, height)} className={className}>
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);

/** Telegram's plane, at the same optical weight as the X — no disc, for the same reason. */
export const TelegramMark = ({ width, height, className }: MarkProps) => (
  <svg {...base(width, height)} className={className}>
    <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z" />
  </svg>
);
