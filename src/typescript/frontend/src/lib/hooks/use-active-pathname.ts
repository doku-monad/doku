"use client";

import { useEffect, useState } from "react";

/**
 * The current pathname, without `usePathname()`.
 *
 * ## Why not the router hook
 *
 * Calling `usePathname()` in the header crashes any route that defines its own `error.tsx`: Next
 * 14.2's ErrorBoundary calls the same hook while rendering that route and the dispatcher is null at
 * that point, so `/market/[market]` 500s with "Cannot read properties of null (reading
 * 'useContext')". This reads `window.location` instead, which has no such dependency.
 *
 * ## Why the patch, and why it is installed exactly once
 *
 * `popstate` fires for back and forward only. A `<Link>` navigation is a `history.pushState`, which
 * fires nothing at all — so without this, every nav indicator in the app stays on whatever route
 * the page was first loaded at. Patching `pushState`/`replaceState` to announce themselves is what
 * closes that gap.
 *
 * The patch lives here, at module scope, rather than inside the components that need it. That is
 * the whole reason this file exists: the top bar and the bottom tab bar both want it, and two
 * components each wrapping `history.pushState` in their own effect is a live bug — the second wraps
 * the first, and whichever unmounts first restores the *original*, throwing away the other's
 * wrapper and silently freezing its indicator. One patch, a set of subscribers, and it is never
 * uninstalled because there is no moment in this app's life when nothing is listening.
 */
const subscribers = new Set<() => void>();
let patched = false;

function announceAll(): void {
  // Deferred: the router calls `pushState` from inside its own update, and setting state
  // synchronously there would be a nested render.
  queueMicrotask(() => {
    for (const notify of subscribers) notify();
  });
}

function ensurePatched(): void {
  if (patched || typeof window === "undefined") return;
  patched = true;

  const { pushState, replaceState } = window.history;
  const announce =
    <T extends typeof pushState>(original: T) =>
    (...args: Parameters<T>) => {
      const result = original.apply(window.history, args);
      announceAll();
      return result;
    };

  window.history.pushState = announce(pushState);
  window.history.replaceState = announce(replaceState);
  window.addEventListener("popstate", announceAll);
}

export function useActivePathname(): string {
  /*
   * Starts empty rather than reading `window.location` in the initializer.
   *
   * The server renders this too, and a lazy initializer that touched `window` would either throw
   * there or produce markup the client immediately disagrees with. One frame with nothing selected
   * is the correct trade against a hydration mismatch on every route.
   */
  const [pathname, setPathname] = useState("");

  useEffect(() => {
    const sync = () => setPathname(window.location.pathname);
    sync();
    ensurePatched();
    subscribers.add(sync);
    return () => {
      subscribers.delete(sync);
    };
  }, []);

  return pathname;
}

/**
 * Whether a nav destination is the route currently being viewed.
 *
 * Segment-aware, so `/launch` does not light up on `/launching-soon` — a bare `startsWith` treats
 * any route that merely begins with the same letters as a child of it. External links are never
 * active: they are not this app's routes at all.
 */
export function isRouteActive(pathname: string, path: string): boolean {
  if (path.startsWith("https://")) return false;
  return pathname === path || pathname.startsWith(`${path}/`);
}
