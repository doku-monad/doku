/**
 * The live feed's connection state machine, without React.
 *
 * Extracted because the parts worth testing — reconnect backoff, and not leaking a socket when the
 * caller goes away — are plain logic, and testing them through a component would mean asserting on
 * a render to find out whether a timer was cleared.
 */

export type LiveEvent =
  /** `isBuy` is the direction of the most recent trade in the batch this covers. */
  | { type: "swap"; market: string; isBuy: boolean }
  | { type: "market"; market: string }
  | { type: "graduation"; market: string };

/** Backoff between reconnects: quick at first, then patient. Capped so it always keeps trying. */
export const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export interface LiveConnectionHandlers {
  onEvent: (event: LiveEvent) => void;
  onStatus: (connected: boolean) => void;
}

/** Just enough of the WebSocket surface to be substitutable in a test. */
export interface SocketLike {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  close: () => void;
}

export interface LiveConnectionDeps {
  createSocket: (url: string) => SocketLike;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

/**
 * Opens a connection that reconnects until disposed.
 *
 * @returns a disposer. After it runs nothing reconnects and no handler fires, which is the whole
 *          point: without it, navigating between markets accumulates one live socket per visit.
 */
export function connectLiveFeed(
  url: string,
  handlers: LiveConnectionHandlers,
  deps: LiveConnectionDeps,
): () => void {
  let socket: SocketLike | undefined;
  let retry: unknown;
  let attempt = 0;
  let disposed = false;

  const open = () => {
    if (disposed) return;
    socket = deps.createSocket(url);

    socket.onopen = () => {
      attempt = 0;
      handlers.onStatus(true);
    };

    socket.onmessage = (message) => {
      let event: LiveEvent;
      try {
        event = JSON.parse(String(message.data)) as LiveEvent;
      } catch {
        // A malformed frame is the server's problem, not a reason to tear down the connection.
        return;
      }
      if (event?.market) handlers.onEvent(event);
    };

    socket.onclose = () => {
      handlers.onStatus(false);
      if (disposed) return;
      const delay = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!;
      attempt += 1;
      retry = deps.setTimeout(open, delay);
    };

    // `onerror` is always followed by `onclose`, so reconnecting here too would open two sockets
    // for one failure.
    socket.onerror = () => socket?.close();
  };

  open();

  return () => {
    disposed = true;
    if (retry !== undefined) deps.clearTimeout(retry);
    if (socket) {
      // Cleared before closing: `close()` fires `onclose`, which would otherwise schedule a
      // reconnect for a caller that has already gone away.
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.onopen = null;
      socket.close();
    }
  };
}
