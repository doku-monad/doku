import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import { createHeadWatcher, parseHead } from "../src/indexer/rpc/head-watcher.js";
import { silentLogger } from "../src/utils/logger.js";

/**
 * The chain WebSocket.
 *
 * Everything here is written from one premise: this is an accelerator and never a source of truth.
 * A frame it cannot parse, a node that goes silent, a socket that dies — none of those may throw,
 * and none of them may stop the HTTP poll loop from indexing every block. So the tests are mostly
 * about what *does not* happen.
 */

class FakeSocket extends EventEmitter {
  readyState = 0;
  sent: string[] = [];
  terminated = false;
  send(data: string): void {
    this.sent.push(data);
  }
  terminate(): void {
    this.terminated = true;
    this.emit("close");
  }
  openIt(): void {
    this.readyState = 1;
    this.emit("open");
  }
}

const newHeads = (height: string) =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "eth_subscription",
    params: { subscription: "0x1", result: { number: height, hash: "0xabc" } },
  });

describe("parseHead", () => {
  it("reads the height out of a newHeads notification", () => {
    expect(parseHead(newHeads("0x64"))).toBe(100n);
  });

  /**
   * A malformed frame must be ignored, not thrown. This parses untrusted JSON inside a socket
   * handler; an exception there takes the process down over a message that was only ever a hint.
   */
  it.each([
    ["not json", "}{"],
    ["a subscription ack", '{"jsonrpc":"2.0","id":1,"result":"0x1"}'],
    ["no params", '{"jsonrpc":"2.0"}'],
    ["no result", '{"params":{}}'],
    ["a non-string height", '{"params":{"result":{"number":100}}}'],
    ["a height that is not hex", '{"params":{"result":{"number":"banana"}}}'],
    ["null", "null"],
    ["an array", "[]"],
  ])("returns null for %s", (_label, raw) => {
    expect(parseHead(raw)).toBeNull();
  });
});

describe("head watcher", () => {
  const build = () => {
    const socket = new FakeSocket();
    const heads: bigint[] = [];
    const watcher = createHeadWatcher({
      url: "wss://node.example/ws",
      log: silentLogger,
      onHead: (h) => heads.push(h),
      connect: () => socket as unknown as WebSocket,
      reconnectMinMs: 1,
      reconnectMaxMs: 2,
      heartbeatMs: 10_000,
    });
    return { socket, heads, watcher };
  };

  it("subscribes to newHeads once open", () => {
    const { socket, watcher } = build();
    watcher.start();
    socket.openIt();
    expect(socket.sent).toHaveLength(1);
    const sent = JSON.parse(socket.sent[0]!) as { method: string; params: string[] };
    expect(sent.method).toBe("eth_subscribe");
    expect(sent.params).toEqual(["newHeads"]);
    watcher.stop();
  });

  it("reports each announced head", () => {
    const { socket, heads, watcher } = build();
    watcher.start();
    socket.openIt();
    socket.emit("message", Buffer.from(newHeads("0x1")));
    socket.emit("message", Buffer.from(newHeads("0x2")));
    expect(heads).toEqual([1n, 2n]);
    watcher.stop();
  });

  it("ignores a frame it cannot parse rather than throwing", () => {
    const { socket, heads, watcher } = build();
    watcher.start();
    socket.openIt();
    expect(() => socket.emit("message", Buffer.from("}{"))).not.toThrow();
    expect(heads).toEqual([]);
    watcher.stop();
  });

  /** A socket error costs latency, not correctness, so it must not propagate. */
  it("survives a socket error", () => {
    const { socket, watcher } = build();
    watcher.start();
    socket.openIt();
    expect(() => socket.emit("error", new Error("ECONNRESET"))).not.toThrow();
    watcher.stop();
  });

  it("reconnects after the socket closes", async () => {
    const socket = new FakeSocket();
    const connect = vi.fn(() => socket as unknown as WebSocket);
    const watcher = createHeadWatcher({
      url: "wss://node.example/ws",
      log: silentLogger,
      onHead: () => {},
      connect,
      reconnectMinMs: 1,
      reconnectMaxMs: 2,
    });
    watcher.start();
    socket.openIt();
    expect(connect).toHaveBeenCalledTimes(1);

    socket.emit("close");
    await new Promise((r) => setTimeout(r, 30));
    expect(connect.mock.calls.length).toBeGreaterThan(1);
    watcher.stop();
  });

  /** After stop, a late close must not resurrect the socket — a stopping process has to stop. */
  it("does not reconnect once stopped", async () => {
    const socket = new FakeSocket();
    const connect = vi.fn(() => socket as unknown as WebSocket);
    const watcher = createHeadWatcher({
      url: "wss://node.example/ws",
      log: silentLogger,
      onHead: () => {},
      connect,
      reconnectMinMs: 1,
      reconnectMaxMs: 2,
    });
    watcher.start();
    socket.openIt();
    watcher.stop();
    socket.emit("close");
    await new Promise((r) => setTimeout(r, 30));
    expect(connect).toHaveBeenCalledTimes(1);
  });

  /**
   * A node that stops sending is indistinguishable from a quiet chain, and TCP will not notice for
   * a long time. Silence past the deadline is treated as a dead socket.
   */
  it("terminates a socket that has gone silent", async () => {
    const socket = new FakeSocket();
    const watcher = createHeadWatcher({
      url: "wss://node.example/ws",
      log: silentLogger,
      onHead: () => {},
      connect: () => socket as unknown as WebSocket,
      reconnectMinMs: 1,
      reconnectMaxMs: 2,
      heartbeatMs: 5,
    });
    watcher.start();
    socket.openIt();
    await new Promise((r) => setTimeout(r, 40));
    expect(socket.terminated).toBe(true);
    watcher.stop();
  });

  it("does not blow up when the connection cannot even be opened", () => {
    const watcher = createHeadWatcher({
      url: "wss://node.example/ws",
      log: silentLogger,
      onHead: () => {},
      connect: () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
      reconnectMinMs: 1,
      reconnectMaxMs: 2,
    });
    expect(() => watcher.start()).not.toThrow();
    expect(watcher.connected()).toBe(false);
    watcher.stop();
  });
});
