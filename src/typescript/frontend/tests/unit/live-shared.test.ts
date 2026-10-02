import type { LiveConnectionHandlers } from "../../src/lib/hooks/doku/live-connection";
import { createSharedLiveFeed, GRACE_MS } from "../../src/lib/hooks/doku/live-shared";

/** A fake `connectLiveFeed` that records connections and lets the test drive them. */
function harness() {
  const connections: { url: string; handlers: LiveConnectionHandlers; disposed: boolean }[] = [];
  const timers: { fn: () => void; ms: number; id: number; cleared: boolean }[] = [];
  let nextId = 1;
  const feed = createSharedLiveFeed({
    connect: (url, handlers) => {
      const c = { url, handlers, disposed: false };
      connections.push(c);
      return () => {
        c.disposed = true;
      };
    },
    createSocket: () => {
      throw new Error("not used: connect is faked");
    },
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.push({ fn, ms, id, cleared: false });
      return id;
    },
    clearTimeout: (h) => {
      const t = timers.find((x) => x.id === h);
      if (t) t.cleared = true;
    },
  });
  const fireTimers = () => {
    for (const t of timers.splice(0)) if (!t.cleared) t.fn();
  };
  const listener = () => {
    const seen: unknown[] = [];
    const status: boolean[] = [];
    return { seen, status, handlers: { onEvent: (e: unknown) => seen.push(e), onStatus: (s: boolean) => status.push(s) } as LiveConnectionHandlers };
  };
  return { feed, connections, timers, fireTimers, listener };
}

const URL = "wss://indexer.example/live";
const swap = { type: "swap", market: "0xm", isBuy: true } as const;

describe("the shared live feed", () => {
  it("opens one socket for two listeners on the same URL and fans events out to both", () => {
    const h = harness();
    const a = h.listener();
    const b = h.listener();
    h.feed.attach(URL, a.handlers);
    h.feed.attach(URL, b.handlers);
    expect(h.connections).toHaveLength(1);
    h.connections[0].handlers.onEvent(swap);
    expect(a.seen).toEqual([swap]);
    expect(b.seen).toEqual([swap]);
  });

  it("tells a late listener the current status at attach, not at the next change", () => {
    const h = harness();
    const a = h.listener();
    h.feed.attach(URL, a.handlers);
    h.connections[0].handlers.onStatus(true);
    const late = h.listener();
    h.feed.attach(URL, late.handlers);
    expect(late.status).toEqual([true]);
  });

  it("keeps the socket open while any listener remains", () => {
    const h = harness();
    const a = h.listener();
    const b = h.listener();
    const detachA = h.feed.attach(URL, a.handlers);
    h.feed.attach(URL, b.handlers);
    detachA();
    h.fireTimers();
    expect(h.connections[0].disposed).toBe(false);
    h.connections[0].handlers.onEvent(swap);
    expect(a.seen).toEqual([]); // detached listeners hear nothing
    expect(b.seen).toEqual([swap]);
  });

  it("closes only after the last listener has been gone for the grace period — and a re-attach inside it reuses the socket", () => {
    const h = harness();
    const a = h.listener();
    const detach = h.feed.attach(URL, a.handlers);
    detach();
    expect(h.timers[0].ms).toBe(GRACE_MS);
    expect(h.connections[0].disposed).toBe(false);
    // A remount / refresh / navigation comes back inside the grace period.
    const b = h.listener();
    h.feed.attach(URL, b.handlers);
    h.fireTimers();
    expect(h.connections).toHaveLength(1);
    expect(h.connections[0].disposed).toBe(false);
    h.connections[0].handlers.onEvent(swap);
    expect(b.seen).toEqual([swap]);
  });

  it("disposes the socket when nobody came back", () => {
    const h = harness();
    const detach = h.feed.attach(URL, h.listener().handlers);
    detach();
    h.fireTimers();
    expect(h.connections[0].disposed).toBe(true);
    expect(h.feed.connectionCount()).toBe(0);
    // The next attach opens a fresh one.
    h.feed.attach(URL, h.listener().handlers);
    expect(h.connections).toHaveLength(2);
  });

  it("detaching twice is harmless", () => {
    const h = harness();
    const detach = h.feed.attach(URL, h.listener().handlers);
    detach();
    detach();
    expect(h.timers).toHaveLength(1);
  });
});
