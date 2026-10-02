import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { createLiveFeed, type LiveFeed } from "../src/websocket/live.js";

/**
 * The live feed, over a real socket.
 *
 * A mock `send` would prove the code calls a function. What matters is what a browser actually
 * receives, and the failure modes worth testing — a client that vanishes, a client that never
 * finished connecting — only exist on a real connection.
 */
describe("live feed", () => {
  let feed: LiveFeed | undefined;
  let server: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    await feed?.close();
    await new Promise<void>((r) => server?.close(() => r()) ?? r());
    feed = undefined;
    server = undefined;
  });

  const start = async () => {
    server = createServer();
    feed = createLiveFeed(server, { path: "/live" });
    await new Promise<void>((r) => server!.listen(0, r));
    const { port } = server.address() as { port: number };
    return `ws://127.0.0.1:${port}/live`;
  };

  const connect = (url: string) =>
    new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    });

  const next = (socket: WebSocket) =>
    new Promise<unknown>((resolve) => socket.once("message", (d) => resolve(JSON.parse(String(d)))));

  it("delivers an event to a connected client", async () => {
    const url = await start();
    const socket = await connect(url);
    const received = next(socket);

    feed!.publish({ type: "swap", market: "0xabc", isBuy: true });
    expect(await received).toEqual({ type: "swap", market: "0xabc", isBuy: true });
    socket.close();
  });

  it("delivers to every connected client", async () => {
    const url = await start();
    const [a, b] = await Promise.all([connect(url), connect(url)]);
    const both = Promise.all([next(a), next(b)]);

    feed!.publish({ type: "graduation", market: "0xdef" });
    const [ra, rb] = await both;
    expect(ra).toEqual(rb);
    a.close();
    b.close();
  });

  /**
   * The failure that matters most.
   *
   * Ingestion calls `publish` on every range. If a dead client can make that throw, one closed
   * browser tab stops the indexer writing — the feed taking down the thing it reports on.
   */
  it("keeps publishing after a client disappears", async () => {
    const url = await start();
    const doomed = await connect(url);
    const survivor = await connect(url);

    doomed.terminate();
    await new Promise((r) => setTimeout(r, 50));

    const received = next(survivor);
    expect(() => feed!.publish({ type: "swap", market: "0x1", isBuy: false })).not.toThrow();
    expect(await received).toEqual({ type: "swap", market: "0x1", isBuy: false });
    survivor.close();
  });

  it("publishes safely with nobody listening", async () => {
    await start();
    expect(() => feed!.publish({ type: "swap", market: "0x1", isBuy: false })).not.toThrow();
    expect(feed!.clientCount()).toBe(0);
  });

  it("forgets clients that close", async () => {
    const url = await start();
    const socket = await connect(url);
    expect(feed!.clientCount()).toBe(1);

    socket.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(feed!.clientCount()).toBe(0);
  });
});
