"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * A menu that hangs off a trigger and cannot be clipped by anything.
 *
 * ## Why this is a hook rather than three copies
 *
 * The naive version — `absolute` inside the control — reads fine until it opens. Every one of these
 * triggers lives inside a bounded card, and a card ends where its content does: the launch form's
 * funding badge sits a few pixels above the bottom of its step, so its menu hung 108px past the
 * card and landed on the head of the step below. Nothing was clipping it; it had nowhere to go.
 *
 * So the menu is rendered into `document.body` by the caller and positioned from here against the
 * VIEWPORT. Fixed coordinates mean no ancestor's `overflow`, `transform` or stacking context can
 * crop it or paint over it — and this app has plenty of all three (`ContentWrapper` clips X, every
 * panel rounds and hides, the dock transforms on press).
 *
 * What this owns:
 *
 *   - **Placement**, flipping above the trigger when the viewport has no room below. That is the
 *     phone case, and the case at the foot of a long form.
 *   - **Clamping** to the viewport's edges, so a right-aligned menu on a narrow screen cannot hang
 *     off the side.
 *   - **Following** the trigger on scroll and resize. A fixed menu that does not re-place detaches
 *     from its button the instant anything scrolls, which is the bug that replaces the first one.
 *     The scroll listener is CAPTURING, because the trigger is usually inside a scroller of its own
 *     rather than on the document.
 *   - **Dismissal** on outside press and on Escape. The menu is checked separately from the
 *     trigger: once portalled it is no longer a descendant, so `trigger.contains(target)` is false
 *     for a click on the menu's own rows.
 *
 * The caller supplies the menu's size because it knows it before the element exists — measuring
 * after mount would place it once at the wrong spot and then correct, which is a visible jump.
 */
export function useAnchoredMenu<T extends HTMLElement = HTMLElement>({
  width,
  height,
  align = "right",
  gap = 8,
}: {
  width: number;
  height: number;
  /** Which edge of the menu lines up with the trigger's. */
  align?: "left" | "right";
  gap?: number;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<T | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const place = useCallback(() => {
    const t = triggerRef.current;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const flip = window.innerHeight - r.bottom < height + gap && r.top > height + gap;
    const wanted = align === "right" ? r.right - width : r.left;
    setPos({
      left: Math.max(8, Math.min(wanted, window.innerWidth - width - 8)),
      top: flip ? r.top - height - gap : r.bottom + gap,
    });
  }, [width, height, align, gap]);

  /* Before paint, so the menu never renders at a stale position for a frame. */
  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const follow = () => place();
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
    /* `menuRef` and `setOpen` are stable across renders; naming them satisfies the exhaustive
       deps rule without changing when this runs. */
  }, [open, place, menuRef, setOpen]);

  /** Spread onto the portalled menu element. */
  const menuStyle: React.CSSProperties = pos
    ? { position: "fixed", left: pos.left, top: pos.top, width }
    : { position: "fixed", left: -9999, top: -9999, width };

  return { open, setOpen, triggerRef, menuRef, pos, menuStyle };
}
