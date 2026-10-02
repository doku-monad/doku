import type { Server } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";

import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";

/**
 * The client-facing live feed.
 *
 * Separate from the chain WebSocket in every sense: different direction, different protocol,
 * different failure consequences. That one tells us a block landed; this one tells browsers a
 * market changed. Neither knows about the other, and the only thing connecting them is that a
 * committed transaction eventually causes a publish here.
 *
 * The frontend polls as its baseline and treats this as an accelerator, which is deliberate: a
 * socket that drops silently is the classic way a "live" feed goes stale while still looking
 * connected. Polling underneath means the worst a broken socket can do is make updates slower.
 *
 * Events carry only what changed and its market address — never a payload the client is expected
 * to merge into state. The client invalidates and refetches, so a dropped or duplicated message
 * costs a request rather than corrupting what is on screen. That is the whole reason this is not a
 * state-replication protocol.
 */

export type LiveEvent =
  /**
   * `isBuy` is the direction of the *last* trade in the range this announcement covers.
   *
   * Carried because the client cannot recover it: the socket says a market changed and the API is
   * asked what it changed to, and by then the trade is one row among many. It exists for the
   * moment of feedback — a card flashing green or red as a trade lands — so the last direction is
   * the right one, not the first.
   */
  | { type: "swap"; market: string; isBuy: boolean }
  | { type: "market"; market: string }
  | { type: "graduation"; market: string }
  /** A market's on-chain metadata changed: name, ticker, images, links. */
  | { type: "metadata"; market: string }
  /**
   * A fee ledger moved for one recipient on one market.
   *
   * Keyed by recipient as well as market, because a single trade credits two different people —
   * the routed recipient and the tax recipient — and a per-market key would collapse them into
   * one frame, leaving whichever arrived first watching a balance that never appears to change.
   */
  | { type: "fees"; market: string; recipient: string };

export interface LiveFeed {
  /** Announce a change. Never throws: a broken socket must not break ingestion. */
  publish(event: LiveEvent): void;
  clientCount(): number;
  close(): Promise<void>;
}

/** A feed that does nothing, for tests and for running the ingester without a server. */
export const nullFeed: LiveFeed = {
  publish: () => {},
  clientCount: () => 0,
  close: async () => {},
};

export interface LiveFeedOptions {
  path?: string;
  log?: Logger;
  /** How often to ping. A client that misses two in a row is dropped. */
  heartbeatMs?: number;
  /**
   * How much unsent data a client may accumulate before it is disconnected.
   *
   * A browser on a bad connection, or one that has stopped reading, accumulates everything the
   * server sends in a kernel buffer the server pays for. Without a ceiling one slow client is a
   * memory leak that grows for as long as it stays connected.
   */
  maxBufferedBytes?: number;
}

interface Client {
  socket: WebSocket;
  alive: boolean;
  /** Empty means every event. Otherwise only these markets. */
  markets: Set<string>;
}

const HEARTBEAT_MS = 30_000;
const MAX_BUFFERED_BYTES = 1_000_000;

export function createLiveFeed(server: Server, options: LiveFeedOptions = {}): LiveFeed {
  const {
    path = "/live",
    log = silentLogger,
    heartbeatMs = HEARTBEAT_MS,
    maxBufferedBytes = MAX_BUFFERED_BYTES,
  } = options;

  const wss = new WebSocketServer({ server, path });
  const clients = new Map<WebSocket, Client>();

  wss.on("connection", (socket) => {
    const client: Client = { socket, alive: true, markets: new Set() };
    clients.set(socket, client);

    socket.on("pong", () => {
      client.alive = true;
    });

    /**
     * Subscriptions, so a market page is not woken by every other market on the chain.
     *
     * Optional: a client that never sends anything receives everything, which is what the existing
     * frontend does and must keep doing.
     */
    socket.on("message", (raw: Buffer | string) => {
      const request = parseSubscribe(raw.toString());
      if (!request) return;
      if (request.action === "subscribe") for (const m of request.markets) client.markets.add(m);
      else if (request.action === "unsubscribe")
        for (const m of request.markets) client.markets.delete(m);
      else client.markets.clear();
    });

    // A socket that errors is a socket that is gone. Removing it here rather than waiting for
    // "close" keeps a half-open connection from collecting broadcasts nobody receives.
    socket.on("error", () => {
      clients.delete(socket);
      socket.terminate();
    });
    socket.on("close", () => clients.delete(socket));
  });

  /**
   * Ping every client, and drop the ones that did not answer the previous round.
   *
   * A TCP connection to a laptop that closed its lid stays "open" for a long time. Without this
   * the server holds those sockets, counts them as clients, and serialises every event for them
   * forever.
   */
  const heartbeat = setInterval(() => {
    for (const [socket, client] of clients) {
      if (!client.alive) {
        clients.delete(socket);
        socket.terminate();
        continue;
      }
      client.alive = false;
      try {
        socket.ping();
      } catch {
        clients.delete(socket);
        socket.terminate();
      }
    }
  }, heartbeatMs);
  // Never keeps the process alive on its own.
  heartbeat.unref();

  return {
    publish(event) {
      const message = JSON.stringify(event);
      for (const [socket, client] of clients) {
        // OPEN is 1. Sending to a CONNECTING or CLOSING socket throws, and one dead client must
        // not stop the others from being told.
        if (socket.readyState !== 1) continue;
        if (client.markets.size > 0 && !client.markets.has(event.market)) continue;

        /**
         * Backpressure. A client that is not draining gets disconnected rather than buffered
         * indefinitely — the alternative is that the slowest client on the service decides how
         * much memory the server uses.
         */
        if (socket.bufferedAmount > maxBufferedBytes) {
          log.warn("dropping a client that is not keeping up", {
            bufferedBytes: socket.bufferedAmount,
          });
          clients.delete(socket);
          socket.terminate();
          continue;
        }

        try {
          socket.send(message);
        } catch {
          clients.delete(socket);
          socket.terminate();
        }
      }
    },
    clientCount: () => clients.size,
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat);
        for (const socket of clients.keys()) socket.terminate();
        clients.clear();
        wss.close(() => resolve());
      }),
  };
}

interface SubscribeRequest {
  action: "subscribe" | "unsubscribe" | "all";
  markets: string[];
}

/**
 * A subscription request, or null for anything else.
 *
 * Tolerant on purpose: this is untrusted input from a browser, arriving inside a socket handler
 * where a thrown exception would take down the process. Anything unrecognised is ignored, which
 * leaves the client receiving everything — the safe default, since that is the behaviour it had
 * before subscriptions existed.
 */
export function parseSubscribe(raw: string): SubscribeRequest | null {
  try {
    const message: unknown = JSON.parse(raw);
    if (typeof message !== "object" || message === null) return null;
    const action = (message as { action?: unknown }).action;
    if (action === "all") return { action: "all", markets: [] };
    if (action !== "subscribe" && action !== "unsubscribe") return null;

    const markets = (message as { markets?: unknown }).markets;
    if (!Array.isArray(markets)) return null;
    const cleaned = markets
      .filter((m): m is string => typeof m === "string")
      .map((m) => m.toLowerCase())
      // A bound, because the list arrives from a client and is held per connection.
      .slice(0, 200);
    return cleaned.length > 0 ? { action, markets: cleaned } : null;
  } catch {
    return null;
  }
}
