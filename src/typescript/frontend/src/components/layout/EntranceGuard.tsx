"use client";

import { useEffect, useLayoutEffect } from "react";

/**
 * Retires the page's entrance animations once the first render has had them.
 *
 * ## The problem this exists for
 *
 * On any route that reads the URL's search parameters — `/explore` reads them on the server,
 * `/launch` reads them through `useSearchParams` — Next's router **re-renders the entire route
 * subtree** when it hydrates, replacing every node under the page frame with a fresh one. Measured
 * on `/explore`: all 1,561 nodes, at 4.69s on a mid-range phone profile. `/assets`, which reads no
 * parameters, replaces nothing.
 *
 * That re-render costs what it costs, and it is not this component's business. What *is* this
 * component's business is that a brand-new element starts its CSS animations from zero — so the
 * board faded in beautifully at 1.3s and then, two and a half seconds later, faded in again.
 *
 * ## Why an attribute rather than a timer
 *
 * An entrance belongs to the first render of a document. Saying so in one attribute is both the
 * implementation and the explanation: `[data-entering]` is on the `<html>` element in the server's
 * markup, the stylesheet switches every entrance off without it, and this effect takes it away
 * once there is nothing left to switch off.
 *
 * The check is `getAnimations()` rather than a fixed delay because the two events race: on a fast
 * connection hydration can land *during* the entrance, and cutting an animation half way is worse
 * than letting it restart — at 300ms in, a restart is a fade that stutters; a cut is a row of cards
 * that pops. So the attribute survives while any entrance is still running, and the (imperceptible)
 * restart is allowed. It is only the finished case — where a second entrance would be a distinct,
 * unexplained event seconds later — that gets suppressed.
 */

/** `useLayoutEffect` warns when React renders a client component on the server. */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** The animations this guard governs. Keep in step with `global.css`. */
const ENTRANCES = new Set(["doku-rise", "doku-cell-rise"]);

export const EntranceGuard = () => {
  /*
   * A layout effect, not an effect: this has to run between React inserting the replaced nodes and
   * the browser painting them. An effect runs after that paint, which is one frame of the second
   * entrance already on screen — and since it starts at zero opacity, that frame is a flash of
   * nothing.
   */
  useIsomorphicLayoutEffect(() => {
    const root = document.documentElement;
    if (typeof document.getAnimations !== "function") {
      /* Without the API there is no way to tell a finished entrance from a running one. Leaving
         the attribute keeps the animation, which is the side to err on. */
      return;
    }
    const stillRunning = document
      .getAnimations()
      .some((a) => ENTRANCES.has((a as CSSAnimation).animationName) && a.playState === "running");
    if (!stillRunning) root.removeAttribute("data-entering");
  }, []);

  return null;
};

export default EntranceGuard;
