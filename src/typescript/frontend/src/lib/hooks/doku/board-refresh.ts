/**
 * When the board re-asks for its rows.
 *
 * The live socket says *that* something changed (a launch, a trade, a graduation, a metadata
 * edit) and the answer to "what did it change to" is a fresh `/api/explore` answer — a query
 * invalidation in `useExplore`, which refetches in place without touching client state or
 * scroll. Until 2026-09-12 nothing re-asked at all, so a board left open showed the world as it
 * was when the tab opened, and a new launch appeared only after a manual reload. Until 2026-09-18
 * the rows were server props and the re-ask was `router.refresh()`, a full server render per
 * viewer per event; the schedule below is unchanged from then, only what it fires is.
 *
 * Extracted from the hook because the parts worth testing are timing: events must be coalesced
 * (a fill is one swap event per block, not one refresh per swap), refreshes must be spaced (each
 * one is a round trip to the indexer), a hidden tab must not poll (a phone with the board in a
 * background tab is not a visitor), and a tab that comes back after a long absence should refresh
 * at once rather than wait for the next tick. `DEBOUNCE_MS` also bounds the API route's memo
 * (`lib/api/short-memo`): an answer older than the debounce cannot predate the event.
 */
export interface BoardRefreshDeps {
  refresh: () => void;
  now: () => number;
  isHidden: () => boolean;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface BoardRefresher {
  /** A live-feed event arrived. Coalesced; never refreshes more often than `MIN_GAP_MS`. */
  onEvent: () => void;
  /** The poll tick — call it every `POLL_MS`. Skipped while hidden. */
  onTick: () => void;
  /** The document became visible again. Refreshes now if the board is older than `STALE_MS`. */
  onVisible: () => void;
  dispose: () => void;
}

/** How long to wait after the first event for its siblings before refreshing once for all. */
export const DEBOUNCE_MS = 400;
/** The floor between two refreshes, whatever the socket says. */
export const MIN_GAP_MS = 1_500;
/** The fallback cadence while the tab is visible and the socket is quiet — or dead. */
export const POLL_MS = 15_000;
/** How old the board may be when a tab comes back before it is refreshed on the spot. */
export const STALE_MS = 5_000;

export function createBoardRefresher(deps: BoardRefreshDeps): BoardRefresher {
  let last = deps.now();
  let pending: unknown = null;
  let disposed = false;

  const fire = (): void => {
    pending = null;
    if (disposed) return;
    last = deps.now();
    deps.refresh();
  };

  const scheduleIn = (ms: number): void => {
    if (pending !== null) return;
    pending = deps.setTimeout(fire, Math.max(0, ms));
  };

  return {
    onEvent: () => {
      if (disposed || deps.isHidden()) return;
      const sinceLast = deps.now() - last;
      scheduleIn(Math.max(DEBOUNCE_MS, MIN_GAP_MS - sinceLast));
    },
    onTick: () => {
      if (disposed || deps.isHidden() || pending !== null) return;
      if (deps.now() - last >= POLL_MS - 1) fire();
    },
    onVisible: () => {
      if (disposed || pending !== null) return;
      if (deps.now() - last >= STALE_MS) fire();
    },
    dispose: () => {
      disposed = true;
      if (pending !== null) deps.clearTimeout(pending);
      pending = null;
    },
  };
}
