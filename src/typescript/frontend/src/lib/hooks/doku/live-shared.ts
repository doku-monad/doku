import { connectLiveFeed, type LiveConnectionDeps, type LiveConnectionHandlers, type LiveEvent } from "./live-connection";

/**
 * One socket per feed URL, shared by every component that listens.
 *
 * `useLiveFeed` used to own its socket: mount opened one, unmount closed it. Measured on
 * 2026-09-12 against production, the board's socket closed 1.0 s after the first
 * `router.refresh()` and reopened 0.7 s later — and a swap announced inside that gap was simply
 * never seen, which is the one thing a live feed must not do. A board → market navigation did
 * the same dance on every click. The socket is not a component's; it is the page's, so it lives
 * at module level, components attach and detach, and it closes only after the last listener has
 * been gone for `GRACE_MS` — long enough for a remount, a refresh or a navigation to re-attach
 * without a reconnect, short enough that a tab that truly left does not hold a server slot.
 *
 * Pure apart from the deps it is handed, so the ref-counting and the grace timer are tested
 * without a DOM. The handlers are fanned out in attach order; a listener's own `onStatus` fires
 * once at attach with the connection's current state, so a component that mounts onto an
 * already-open socket does not sit at "connecting" until the next status change.
 */
export const GRACE_MS = 10_000;

export interface SharedLiveFeedDeps extends LiveConnectionDeps {
  connect?: typeof connectLiveFeed;
  graceMs?: number;
}

interface Shared {
  dispose: () => void;
  listeners: Set<LiveConnectionHandlers>;
  connected: boolean;
  grace: unknown | null;
}

export interface SharedLiveFeed {
  /** Attach to the feed at `url`; returns the detach function. */
  attach: (url: string, handlers: LiveConnectionHandlers) => () => void;
  /** How many URLs currently hold an open (or reconnecting) socket. For tests and diagnostics. */
  connectionCount: () => number;
}

export function createSharedLiveFeed(deps: SharedLiveFeedDeps): SharedLiveFeed {
  const connect = deps.connect ?? connectLiveFeed;
  const graceMs = deps.graceMs ?? GRACE_MS;
  const byUrl = new Map<string, Shared>();

  const open = (url: string): Shared => {
    const shared: Shared = { dispose: () => {}, listeners: new Set(), connected: false, grace: null };
    shared.dispose = connect(
      url,
      {
        onEvent: (event: LiveEvent) => {
          for (const l of shared.listeners) l.onEvent(event);
        },
        onStatus: (connected: boolean) => {
          shared.connected = connected;
          for (const l of shared.listeners) l.onStatus(connected);
        },
      },
      deps,
    );
    byUrl.set(url, shared);
    return shared;
  };

  return {
    attach: (url, handlers) => {
      let shared = byUrl.get(url);
      if (!shared) shared = open(url);
      if (shared.grace !== null) {
        deps.clearTimeout(shared.grace);
        shared.grace = null;
      }
      shared.listeners.add(handlers);
      handlers.onStatus(shared.connected);
      let detached = false;
      return () => {
        if (detached) return;
        detached = true;
        const s = byUrl.get(url);
        if (!s) return;
        s.listeners.delete(handlers);
        if (s.listeners.size > 0 || s.grace !== null) return;
        s.grace = deps.setTimeout(() => {
          if (s.listeners.size > 0) {
            s.grace = null;
            return;
          }
          s.dispose();
          byUrl.delete(url);
        }, graceMs);
      };
    },
    connectionCount: () => byUrl.size,
  };
}
