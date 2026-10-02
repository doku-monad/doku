import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createLiveFeed, type LiveFeed } from "../src/websocket/live.js";

/**
 * The two frames generation 2 adds to the feed.
 *
 * The feed stays an invalidation channel: a frame says WHAT changed, never what it changed to, so
 * the client refetches and reads one consistent answer from the API rather than assembling a view
 * out of frames that arrived in an order nobody controls. `metadata` says a market's identity moved;
 * `fees` says a ledger row landed for a market and a recipient, which is what a portfolio page needs
 * to know its own balance is stale.
 */
describe("gen-2 live frames", () => {
  let feed: LiveFeed | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  afterEach(async () => {
    await feed?.close();
    await new Promise<void>((r) => {
      if (server) server.close(() => r());
      else r();
    });
  });
  const start = async (): Promise<string> => {
    server = createServer();
    feed = createLiveFeed(server, { path: "/live" });
    await new Promise<void>((r) => server!.listen(0, r));
    return `ws://127.0.0.1:${(server.address() as { port: number }).port}/live`;
  };
  const connect = (url: string): Promise<WebSocket> =>
    new Promise<WebSocket>((res, rej) => {
      const s = new WebSocket(url);
      s.once("open", () => res(s));
      s.once("error", rej);
    });
  const next = (s: WebSocket): Promise<unknown> =>
    new Promise<unknown>((r) => s.once("message", (d) => r(JSON.parse(String(d)))));

  it("delivers metadata and fees frames verbatim", async () => {
    const s = await connect(await start());
    const a = next(s);
    feed!.publish({ type: "metadata", market: "0xm" });
    expect(await a).toEqual({ type: "metadata", market: "0xm" });
    const b = next(s);
    feed!.publish({ type: "fees", market: "0xm", recipient: "0xme" });
    expect(await b).toEqual({ type: "fees", market: "0xm", recipient: "0xme" });
    s.close();
  });

  it("respects market subscriptions for the new frames", async () => {
    const s = await connect(await start());
    s.send(JSON.stringify({ action: "subscribe", markets: ["0xother"] }));
    await new Promise((r) => setTimeout(r, 50));
    let got = 0;
    s.on("message", () => got++);
    feed!.publish({ type: "fees", market: "0xm", recipient: "0xme" });
    feed!.publish({ type: "metadata", market: "0xother" });
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toBe(1);
    s.close();
  });
});
