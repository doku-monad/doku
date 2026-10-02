"use client";

import { useEffect, useState } from "react";

/**
 * A clock, for labels that say how long ago something happened.
 *
 * Returns `Date.now()`, refreshed on an interval, and it exists because an age label has no other
 * way to advance: nothing about the market changes when "4d" becomes "5d", so no data update will
 * ever re-render it.
 *
 * ## The two things this gets right that the copies did not
 *
 * **It stops while the tab is hidden.** The market masthead and the runner board each ran their own
 * `setInterval(() => setNow(Date.now()), 10_000)`, and neither checked `visibilityState` — so a
 * backgrounded tab re-rendered a 1,098-line masthead, or a four-row board, six times a minute
 * forever, to move a figure nobody was looking at. `use-board-refresh.ts` already gates its poll
 * this way; this is the same gate for the two clocks that did not.
 *
 * **It catches up on return.** Skipping hidden ticks means the label is stale when the tab comes
 * back, so `visibilitychange` sets the clock immediately — which is also what makes skipping safe:
 * the first thing a returning reader sees is the corrected value, not a ten-second-old one.
 *
 * Seeded at `0` rather than at `Date.now()`, deliberately: the server and the first client render
 * must agree, and a timestamp cannot. Callers render an em dash for that one frame, which is
 * cheaper than a hydration mismatch on every row.
 */
export const useTicker = (intervalMs: number): number => {
  const [now, setNow] = useState(0);

  useEffect(() => {
    const sync = () => setNow(Date.now());
    sync();

    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") sync();
    }, intervalMs);

    const onVisibility = () => {
      if (document.visibilityState === "visible") sync();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs]);

  return now;
};

export default useTicker;
