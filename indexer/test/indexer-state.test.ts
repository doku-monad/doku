import { describe, expect, it } from "vitest";

import { IndexerState } from "../src/indexer/state.js";
import { createLogger, silentLogger } from "../src/utils/logger.js";

/**
 * What the process reports about itself.
 *
 * The phase is derived from the gap rather than set by the caller, so "live" always means the same
 * thing and cannot be asserted by a code path that has not checked. That matters because "behind
 * by four thousand blocks" is normal while catching up and an incident while live — without the
 * distinction a dashboard cannot tell a service that started two minutes ago from one that has
 * been failing for an hour.
 */
describe("indexer state", () => {
  it("starts before it has done anything", () => {
    expect(new IndexerState().snapshot().phase).toBe("starting");
  });

  it("is live when a pass finishes at the head", () => {
    const state = new IndexerState();
    state.passSucceeded(1_000n, 1_002n);
    const snap = state.snapshot();
    expect(snap.phase).toBe("live");
    expect(snap.lastBlock).toBe("1000");
    expect(snap.chainHead).toBe("1002");
  });

  it("is catching up when a pass finishes far behind the head", () => {
    const state = new IndexerState();
    state.passSucceeded(1_000n, 50_000n);
    expect(state.snapshot().phase).toBe("catching-up");
  });

  it("is degraded after a failure and counts consecutive ones", () => {
    const state = new IndexerState();
    state.passFailed(new Error("rpc down"));
    state.passFailed(new Error("rpc down"));
    const snap = state.snapshot();
    expect(snap.phase).toBe("degraded");
    expect(snap.consecutiveFailures).toBe(2);
    expect(snap.errors.rpc).toBe(2);
    expect(snap.lastError).toBe("rpc down");
  });

  /** Recovery has to clear the streak, or one bad minute makes the service look broken forever. */
  it("clears the failure streak on the next success", () => {
    const state = new IndexerState();
    state.passFailed(new Error("boom"));
    state.passSucceeded(10n, 10n);
    const snap = state.snapshot();
    expect(snap.consecutiveFailures).toBe(0);
    expect(snap.phase).toBe("live");
    // The cumulative count is not reset: it is the record of what happened.
    expect(snap.errors.rpc).toBe(1);
  });

  it("counts errors by kind", () => {
    const state = new IndexerState();
    state.recordError("database", new Error("pool timeout"));
    state.recordError("websocket", new Error("socket closed"));
    expect(state.snapshot().errors).toEqual({ rpc: 0, database: 1, websocket: 1 });
  });

  /** Once stopping, a late-landing pass must not report the service back to life. */
  it("stays stopping once it is stopping", () => {
    const state = new IndexerState();
    state.stopping();
    state.passSucceeded(10n, 10n);
    expect(state.snapshot().phase).toBe("stopping");
  });

  it("keeps an RPC endpoint, and any key inside it, out of the error /status serves", () => {
    const leak = new Error("HTTP request failed. URL: https://monad-mainnet.example.com/v2/s3cr3t-k3y Details: timeout");
    const failed = new IndexerState();
    failed.passFailed(leak);
    const recorded = new IndexerState();
    recorded.recordError("rpc", leak);
    const socket = new IndexerState();
    socket.recordError("websocket", "dropped wss://ws.example.com/v2/s3cr3t-k3y");

    for (const state of [failed, recorded, socket]) {
      const shown = JSON.stringify(state.snapshot());
      expect(shown).not.toContain("s3cr3t-k3y");
      expect(shown).not.toContain("example.com");
      expect(shown).toContain("<url>");
    }
    expect(failed.snapshot().lastError).toContain("HTTP request failed");
  });
});

describe("logger", () => {
  const capture = () => {
    const lines: string[] = [];
    const log = createLogger({
      pretty: false,
      write: (l) => lines.push(l),
      now: () => new Date("2026-08-24T00:00:00.000Z"),
    });
    return { log, lines, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
  };

  it("writes one JSON object per line, with level and time", () => {
    const { log, parsed } = capture();
    log.info("indexed", { from: 1, to: 100 });
    expect(parsed()[0]).toMatchObject({
      level: "info",
      time: "2026-08-24T00:00:00.000Z",
      message: "indexed",
      from: 1,
      to: 100,
    });
  });

  /**
   * `JSON.stringify` turns an Error into `{}` — which is how a stack trace goes missing from a log
   * that appears to be recording it.
   */
  it("keeps an error's message and stack", () => {
    const { log, parsed } = capture();
    log.error("ingest pass failed", { error: new Error("rpc down") });
    const error = parsed()[0]!.error as Record<string, unknown>;
    expect(error.message).toBe("rpc down");
    expect(typeof error.stack).toBe("string");
  });

  /** `JSON.stringify` throws on a bigint, and this service is full of them. */
  it("serialises bigint fields instead of throwing", () => {
    const { log, parsed } = capture();
    expect(() => log.info("indexed", { block: 12_345_678_901_234_567_890n })).not.toThrow();
    expect(parsed()[0]!.block).toBe("12345678901234567890");
  });

  it("does not emit below the configured level", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "warn", pretty: false, write: (l) => lines.push(l) });
    log.debug("noise");
    log.info("noise");
    log.warn("worth seeing");
    expect(lines).toHaveLength(1);
  });

  it("stamps child fields on every line", () => {
    const { log, parsed } = capture();
    log.child({ component: "ingest" }).info("started");
    expect(parsed()[0]!.component).toBe("ingest");
  });

  it("has a silent logger for tests", () => {
    expect(() => silentLogger.child({ a: 1 }).error("nothing happens")).not.toThrow();
  });
});
