import { WebSocket } from "ws";

import type { Logger } from "../../utils/logger.js";

/**
 * Hearing about new heads over the chain's WebSocket.
 *
 * **This is an accelerator and never a source of truth.** It exists to shorten the gap between a
 * block being produced and the indexer looking for it — nothing more. Everything it reports is
 * re-derived over HTTP by the pass it wakes, and if it never connects, never fires, or silently
 * dies, the loop keeps polling and keeps indexing every block. That is the whole design: a socket
 * that drops without saying so is the classic way a "live" pipeline goes stale while continuing to
 * look healthy, so nothing here is allowed to be load-bearing.
 *
 * Concretely it does one thing: calls `onHead` when the node announces a block. The loop uses that
 * to cut its sleep short. It does not decode logs, does not advance the checkpoint, and does not
 * report what the head *is* — the pass asks the HTTP endpoint for that, because the socket can lie
 * by omission and the HTTP endpoint cannot.
 */

export interface HeadWatcherOptions {
  url: string;
  onHead: (blockNumber: bigint) => void;
  log: Logger;
  /** Injected in tests. */
  connect?: (url: string) => WebSocket;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** How long without a message before the socket is treated as dead. */
  heartbeatMs?: number;
}

export interface HeadWatcher {
  start(): void;
  stop(): void;
  /** Whether a socket is currently open. Reported on status, never acted on. */
  connected(): boolean;
}

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const HEARTBEAT_MS = 60_000;

export function createHeadWatcher(options: HeadWatcherOptions): HeadWatcher {
  const {
    url,
    onHead,
    log,
    connect = (target: string) => new WebSocket(target),
    reconnectMinMs = RECONNECT_MIN_MS,
    reconnectMaxMs = RECONNECT_MAX_MS,
    heartbeatMs = HEARTBEAT_MS,
  } = options;

  let socket: WebSocket | undefined;
  let stopped = false;
  let backoff = reconnectMinMs;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let deadline: NodeJS.Timeout | undefined;

  const clearTimers = (): void => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (deadline) clearTimeout(deadline);
    reconnectTimer = undefined;
    deadline = undefined;
  };

  /**
   * A node that stops sending is indistinguishable from a quiet chain, and TCP will not notice for
   * a long time. So silence past the deadline is treated as a dead socket and reconnected — the
   * cost of being wrong is one reconnect, and the cost of not doing it is a socket that never
   * delivers again while reporting itself open.
   */
  const armDeadline = (): void => {
    if (deadline) clearTimeout(deadline);
    deadline = setTimeout(() => {
      if (stopped) return;
      log.warn("chain websocket silent, reconnecting", { silentForMs: heartbeatMs });
      socket?.terminate();
    }, heartbeatMs);
    deadline.unref();
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer) return;
    // Full jitter, so several replicas do not reconnect in lockstep after a shared outage.
    const delay = Math.round(Math.random() * backoff);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      open();
    }, delay);
    reconnectTimer.unref();
    backoff = Math.min(backoff * 2, reconnectMaxMs);
  };

  const open = (): void => {
    if (stopped) return;
    try {
      socket = connect(url);
    } catch (err) {
      log.warn("chain websocket could not be opened", { error: err });
      scheduleReconnect();
      return;
    }

    socket.on("open", () => {
      backoff = reconnectMinMs;
      log.info("chain websocket connected", { url });
      socket?.send(JSON.stringify({ id: 1, jsonrpc: "2.0", method: "eth_subscribe", params: ["newHeads"] }));
      armDeadline();
    });

    socket.on("message", (raw: Buffer | string) => {
      armDeadline();
      const height = parseHead(raw.toString());
      if (height !== null) onHead(height);
    });

    socket.on("error", (err: Error) => {
      // Logged at warn, not error: losing this socket costs latency, not correctness.
      log.warn("chain websocket error", { error: err });
    });

    socket.on("close", () => {
      clearTimers();
      socket = undefined;
      if (!stopped) {
        log.warn("chain websocket closed, will reconnect");
        scheduleReconnect();
      }
    });
  };

  return {
    start: open,
    stop() {
      stopped = true;
      clearTimers();
      socket?.terminate();
      socket = undefined;
    },
    connected: () => socket?.readyState === WebSocket.OPEN,
  };
}

/**
 * The block height out of a `newHeads` notification, or null for anything else.
 *
 * Tolerant by design. This parses untrusted JSON from a remote node, and the only correct response
 * to something unexpected is to ignore it — a malformed frame must not throw inside a socket
 * handler and take the process down for a message that was only ever a hint.
 */
export function parseHead(raw: string): bigint | null {
  try {
    const message: unknown = JSON.parse(raw);
    if (typeof message !== "object" || message === null) return null;
    const params = (message as { params?: unknown }).params;
    if (typeof params !== "object" || params === null) return null;
    const result = (params as { result?: unknown }).result;
    if (typeof result !== "object" || result === null) return null;
    const number = (result as { number?: unknown }).number;
    if (typeof number !== "string") return null;
    const height = BigInt(number);
    return height >= 0n ? height : null;
  } catch {
    return null;
  }
}
