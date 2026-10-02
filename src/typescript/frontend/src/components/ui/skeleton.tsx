import { cn } from "lib/utils/class-name";

/**
 * The shimmer block every loading state in this app is built from.
 *
 * ## Why a component and not a class
 *
 * Because the rule that matters is not the shimmer, it is the *size*. A skeleton exists to hold
 * the exact box its content will occupy, so the page does not jump when the data lands — and the
 * only way that stays true is if the skeleton and the real thing are written next to each other
 * and sized from the same numbers. A bare utility class invites a 40px placeholder in front of a
 * 52px row, which is a layout shift with extra steps.
 *
 * ## Why the shimmer is a background, not an overlay
 *
 * A moving highlight drawn as a pseudo-element needs `overflow: hidden` and a second stacking
 * layer per placeholder, and a grid of twenty cards then carries forty composited layers doing
 * nothing but sweeping. This animates `background-position` on the element itself — one property,
 * no extra nodes, and it stops dead under `prefers-reduced-motion` (see `global.css`), where the
 * block simply sits at its base tint.
 */
export function Skeleton({
  className,
  /** Softens to a circle for glyph tiles and dots. */
  round,
  style,
}: {
  className?: string;
  round?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <span
      aria-hidden
      className={cn("doku-skeleton block", round ? "rounded-full" : "rounded-[8px]", className)}
      style={style}
    />
  );
}

/**
 * The wrapper that tells assistive technology something is coming.
 *
 * `aria-busy` plus a polite live region: a screen reader announces "loading" once rather than
 * reading out a wall of empty boxes, and announces the content when it replaces this. The
 * individual `Skeleton` blocks are `aria-hidden` for the same reason — they are furniture.
 */
export function SkeletonRegion({
  children,
  label = "Loading",
  className,
}: {
  children: React.ReactNode;
  label?: string;
  className?: string;
}) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

export default Skeleton;
