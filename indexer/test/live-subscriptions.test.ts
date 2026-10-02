import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { createLiveFeed, type LiveFeed, parseSubscribe } from "../src/websocket/live.js";

/**
 * Subscriptions and backpressure on the client feed.
 *
 * The feed's contract is that it is an accelerator: the frontend polls underneath, so a dropped
 * message costs a slower update and never a wrong screen. Everything here follows from that — an
 * unrecognised request leaves a client receiving everything, and a client that stops draining is
 * disconnected rather than buffered, because the alternative is that the slowest browser on the
 * service decides how much memory the server uses.
 */
describe("subscription parsing", () => {
  it("reads a subscribe request", () => {
    expect(parseSubscribe(JSON.stringify({ action: "subscribe", markets: ["0xA", "0xb"] }))).toEqual(
      { action: "subscribe", markets: ["0xa", "0xb"] },
    );
  });

  it("reads an unsubscribe request", () => {
    expect(parseSubscribe(JSON.stringify({ action: "unsubscribe", markets: ["0xa"] }))).toEqual({
      action: "unsubscribe",
      markets: ["0xa"],
    });
  });

  it("reads a request to go back to everything", () => {
    expect(parseSubscribe(JSON.stringify({ action: "all" }))).toEqual({ action: "all", markets: [] });
  });

  /**
   * Untrusted input, parsed inside a socket handler. Anything unrecognised is ignored, which
   * leaves the client subscribed to everything — the behaviour it had before subscriptions
   * existed, and the safe direction to fail in.
   */
  it.each([
    ["not json", "}{"],
    ["no action", '{"markets":["0xa"]}'],
    ["an unknown action", '{"action":"explode","markets":["0xa"]}'],
    ["markets that are not an array", '{"action":"subscribe","markets":"0xa"}'],
    ["an empty market list", '{"action":"subscribe","markets":[]}'],
    ["null", "null"],
  ])("ignores %s", (_label, raw) => {
    expect(parseSubscribe(raw)).toBeNull();
  });

  /** The list is held per connection and arrives from a client, so it needs a ceiling. */
  it("bounds how many markets one client may name", () => {
    const many = Array.from({ length: 500 }, (_, i) => `0x${i}`);
    expect(parseSubscribe(JSON.stringify({ action: "subscribe", markets: many }))!.markets).toHaveLength(200);
  });

  it("drops non-string entries rather than rejecting the request", () => {
    expect(parseSubscribe(JSON.stringify({ action: "subscribe", markets: ["0xa", 5, null] }))).toEqual(
      { action: "subscribe", markets: ["0xa"] },
    );
  });
});

describe("live feed", () => {
  let server: Server | undefined;
  let feed: LiveFeed | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const s of sockets) s.close();
    sockets.length = 0;
    await feed?.close();
    await new Promise<void>((r) => server?.close(() => r()));
    server = undefined;
    feed = undefined;
  });

  const start = async (): Promise<string> => {
    server = createServer();
    feed = createLiveFeed(server, { heartbeatMs: 50 });
    await new Promise<void>((r) => server!.listen(0, r));
    const { port } = server.address() as { port: number };
    return `ws://127.0.0.1:${port}/live`;
  };

  const connect = async (url: string): Promise<WebSocket> => {
    const socket = new WebSocket(url);
    sockets.push(socket);
    await new Promise((r) => socket.once("open", r));
    return socket;
  };

  const nextMessage = (socket: WebSocket, ms = 300): Promise<string | null> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      socket.once("message", (d) => {
        clearTimeout(timer);
        resolve(d.toString());
      });
    });

  it("sends every event to a client that has not subscribed to anything", async () => {
    const url = await start();
    const socket = await connect(url);
    feed!.publish({ type: "market", market: "0xa" });
    expect(JSON.parse((await nextMessage(socket))!)).toEqual({ type: "market", market: "0xa" });
  });

  it("sends only the subscribed markets once a client asks", async () => {
    const url = await start();
    const socket = await connect(url);
    socket.send(JSON.stringify({ action: "subscribe", markets: ["0xa"] }));
    await new Promise((r) => setTimeout(r, 50));

    feed!.publish({ type: "market", market: "0xb" });
    feed!.publish({ type: "market", market: "0xa" });

    // The first message through is 0xa: 0xb was filtered out rather than queued.
    expect(JSON.parse((await nextMessage(socket))!)).toEqual({ type: "market", market: "0xa" });
  });

  it("goes back to everything when asked", async () => {
    const url = await start();
    const socket = await connect(url);
    socket.send(JSON.stringify({ action: "subscribe", markets: ["0xa"] }));
    await new Promise((r) => setTimeout(r, 50));
    socket.send(JSON.stringify({ action: "all" }));
    await new Promise((r) => setTimeout(r, 50));

    feed!.publish({ type: "market", market: "0xb" });
    expect(JSON.parse((await nextMessage(socket))!)).toEqual({ type: "market", market: "0xb" });
  });

  it("counts connected clients", async () => {
    const url = await start();
    await connect(url);
    await connect(url);
    await new Promise((r) => setTimeout(r, 50));
    expect(feed!.clientCount()).toBe(2);
  });

  /**
   * A TCP connection to a laptop that closed its lid stays "open" for a long time. Without the
   * heartbeat the server holds those sockets, counts them as clients, and serialises every event
   * for them forever.
   */
  it("drops a client that stops answering pings", async () => {
    const url = await start();
    const socket = await connect(url);
    // Stop the client answering, the way a vanished peer would.
    socket.pong = () => {};
    await new Promise((r) => setTimeout(r, 250));
    expect(feed!.clientCount()).toBe(0);
  });

  it("keeps a client that is answering", async () => {
    const url = await start();
    await connect(url);
    await new Promise((r) => setTimeout(r, 250));
    expect(feed!.clientCount()).toBe(1);
  });

  it("never throws out of publish, whatever the sockets are doing", async () => {
    const url = await start();
    const socket = await connect(url);
    socket.terminate();
    expect(() => feed!.publish({ type: "swap", market: "0xa", isBuy: true })).not.toThrow();
  });
});
