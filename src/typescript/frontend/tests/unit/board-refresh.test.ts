import {
  createBoardRefresher,
  DEBOUNCE_MS,
  MIN_GAP_MS,
  POLL_MS,
  STALE_MS,
} from "@/lib/hooks/doku/board-refresh";

/** A clock and a timer queue the test advances by hand. */
function harness(hidden = false) {
  let t = 100_000;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const refreshes: number[] = [];
  const state = { hidden };
  const r = createBoardRefresher({
    refresh: () => refreshes.push(t),
    now: () => t,
    isHidden: () => state.hidden,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: t + ms, fn, id });
      return id;
    },
    clearTimeout: (h) => {
      const i = timers.findIndex((x) => x.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const advance = (ms: number) => {
    const until = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > until) break;
      t = next.at;
      timers.shift();
      next.fn();
    }
    t = until;
  };
  return { r, advance, refreshes, state, now: () => t };
}

describe("the board refresher", () => {
  it("coalesces a burst of events into one refresh after the debounce", () => {
    const h = harness();
    h.r.onEvent();
    h.advance(200);
    h.r.onEvent();
    h.advance(200);
    h.r.onEvent();
    expect(h.refreshes).toEqual([]);
    h.advance(MIN_GAP_MS);
    expect(h.refreshes).toHaveLength(1);
  });

  it("never refreshes twice inside the minimum gap, however many events arrive", () => {
    const h = harness();
    h.advance(MIN_GAP_MS); // the initial render is old enough for the first event to be quick
    h.r.onEvent();
    h.advance(DEBOUNCE_MS);
    expect(h.refreshes).toHaveLength(1);
    const first = h.refreshes[0];
    h.r.onEvent();
    h.advance(DEBOUNCE_MS);
    expect(h.refreshes).toHaveLength(1);
    h.advance(MIN_GAP_MS);
    expect(h.refreshes).toHaveLength(2);
    expect(h.refreshes[1] - first).toBeGreaterThanOrEqual(MIN_GAP_MS);
  });

  it("polls on the tick while visible and the socket is quiet", () => {
    const h = harness();
    h.advance(POLL_MS);
    h.r.onTick();
    expect(h.refreshes).toHaveLength(1);
    h.r.onTick(); // same instant: too soon
    expect(h.refreshes).toHaveLength(1);
  });

  it("does nothing while the tab is hidden, and refreshes at once when it comes back stale", () => {
    const h = harness(true);
    h.advance(POLL_MS);
    h.r.onTick();
    h.r.onEvent();
    h.advance(MIN_GAP_MS);
    expect(h.refreshes).toEqual([]);
    h.state.hidden = false;
    h.r.onVisible();
    expect(h.refreshes).toHaveLength(1);
  });

  it("leaves a fresh board alone when the tab merely blinks", () => {
    const h = harness();
    h.advance(STALE_MS - 1);
    h.r.onVisible();
    expect(h.refreshes).toEqual([]);
  });

  it("fires nothing after dispose, including a refresh already scheduled", () => {
    const h = harness();
    h.r.onEvent();
    h.r.dispose();
    h.advance(MIN_GAP_MS + DEBOUNCE_MS);
    h.r.onTick();
    h.r.onVisible();
    expect(h.refreshes).toEqual([]);
  });
});
