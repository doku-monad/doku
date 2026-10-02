/**
 * @jest-environment node
 */
import {
  connectLiveFeed,
  type LiveConnectionDeps,
  RETRY_MS,
  type SocketLike,
} from "../../src/lib/hooks/doku/live-connection";

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;

  close() {
    this.closed = true;
    this.onclose?.();
  }
}

const harness = () => {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const events: unknown[] = [];
  const statuses: boolean[] = [];

  const deps: LiveConnectionDeps = {
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms, cleared: false });
      return timers.length - 1;
    },
    clearTimeout: (handle) => {
      const timer = timers[handle as number];
      if (timer) timer.cleared = true;
    },
  };

  const dispose = connectLiveFeed(
    "ws://x/live",
    { onEvent: (e) => events.push(e), onStatus: (c) => statuses.push(c) },
    deps
  );

  return { sockets, timers, events, statuses, dispose };
};

describe("live connection", () => {
  it("reports connected and passes events through", () => {
    const h = harness();
    h.sockets[0]!.onopen!();
    h.sockets[0]!.onmessage!({ data: JSON.stringify({ type: "swap", market: "0xa" }) });

    expect(h.statuses).toEqual([true]);
    expect(h.events).toEqual([{ type: "swap", market: "0xa" }]);
  });

  /// A malformed frame is the server's problem. Tearing down a working connection over one bad
  /// message turns a cosmetic bug into an outage.
  it("survives a frame it cannot parse", () => {
    const h = harness();
    expect(() => h.sockets[0]!.onmessage!({ data: "not json" })).not.toThrow();
    expect(h.events).toEqual([]);
    expect(h.sockets[0]!.closed).toBe(false);
  });

  it("ignores a message with no market", () => {
    const h = harness();
    h.sockets[0]!.onmessage!({ data: JSON.stringify({ type: "swap" }) });
    expect(h.events).toEqual([]);
  });

  it("backs off further on each failed attempt", () => {
    const h = harness();
    h.sockets[0]!.onclose!();
    expect(h.timers[0]!.ms).toBe(RETRY_MS[0]);

    h.timers[0]!.fn();
    h.sockets[1]!.onclose!();
    expect(h.timers[1]!.ms).toBe(RETRY_MS[1]);
  });

  /// Otherwise a flaky connection climbs to the maximum delay and stays there for the session.
  it("resets the backoff once a connection succeeds", () => {
    const h = harness();
    h.sockets[0]!.onclose!();
    h.timers[0]!.fn();
    h.sockets[1]!.onopen!();
    h.sockets[1]!.onclose!();

    expect(h.timers[1]!.ms).toBe(RETRY_MS[0]);
  });

  it("keeps retrying at the longest delay rather than giving up", () => {
    const h = harness();
    for (let i = 0; i < RETRY_MS.length + 3; i++) {
      const socket = h.sockets.at(-1)!;
      socket.onclose!();
      h.timers.at(-1)!.fn();
    }
    expect(h.timers.at(-1)!.ms).toBe(RETRY_MS.at(-1));
  });

  /**
   * The leak this exists to prevent.
   *
   * `close()` fires `onclose`, which schedules a reconnect. Disposing without clearing the
   * handlers first means every visit to a market page leaves a socket reconnecting forever.
   */
  it("does not reconnect after disposal", () => {
    const h = harness();
    h.dispose();

    expect(h.sockets[0]!.closed).toBe(true);
    expect(h.sockets).toHaveLength(1);
    expect(h.timers.filter((t) => !t.cleared)).toHaveLength(0);
  });

  it("cancels a reconnect already scheduled when disposed", () => {
    const h = harness();
    h.sockets[0]!.onclose!();
    expect(h.timers).toHaveLength(1);

    h.dispose();
    h.timers[0]!.fn();

    // The pending timer fired anyway; it must not have opened anything.
    expect(h.sockets).toHaveLength(1);
    expect(h.timers[0]!.cleared).toBe(true);
  });

  it("does not deliver events after disposal", () => {
    const h = harness();
    const socket = h.sockets[0]!;
    h.dispose();

    expect(socket.onmessage).toBeNull();
    expect(h.events).toEqual([]);
  });
});
