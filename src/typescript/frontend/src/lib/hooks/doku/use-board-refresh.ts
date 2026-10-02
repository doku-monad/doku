"use client";

import { useEffect, useMemo, useRef } from "react";

import { type BoardRefresher, createBoardRefresher, POLL_MS } from "./board-refresh";

/**
 * Keeps the board current without a reload.
 *
 * Returns the refresher whose `onEvent` the live feed should be handed. Wires the visible-tab
 * poll and the visibility listener itself, and disposes everything on unmount. Timing rules and
 * their reasons live in `board-refresh.ts`, which is where they are tested.
 *
 * `refresh` is what a tick fires. It was `router.refresh()` — a server re-render of the page —
 * while the rows were server props; it is a query invalidation now that they come from
 * `/api/explore` (`useRefreshExplore`). Held in a ref so a caller passing a fresh function each
 * render does not rebuild the refresher and lose its timing state.
 */
export function useBoardRefresh(refresh: () => void): BoardRefresher {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const refresher = useMemo(
    () =>
      createBoardRefresher({
        refresh: () => refreshRef.current(),
        now: () => Date.now(),
        isHidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
        setTimeout: (fn, ms) => window.setTimeout(fn, ms),
        clearTimeout: (handle) => window.clearTimeout(handle as number),
      }),
    [],
  );

  useEffect(() => {
    const tick = window.setInterval(() => refresher.onTick(), POLL_MS);
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") refresher.onVisible();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisibility);
      refresher.dispose();
    };
  }, [refresher]);

  return refresher;
}
