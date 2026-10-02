import { describe, expect, it, vi } from "vitest";

import { isRetryable, withRetry } from "../src/db/retry.js";

const err = (code: string) => Object.assign(new Error(code), { code });
const noSleep = () => Promise.resolve();

/**
 * Retrying the database failures worth retrying.
 *
 * The classification is the part with teeth. Retrying a unique-constraint violation does not fix
 * it — it reports the same error five times as slowly, after a delay, with the original stack
 * buried under four repeats. So the test that matters most is the one asserting a *non*-retryable
 * error is raised immediately.
 */
describe("withRetry", () => {
  it("returns the first success without sleeping", async () => {
    const sleep = vi.fn(noSleep);
    const work = vi.fn(() => Promise.resolve("ok"));
    expect(await withRetry(work, { sleep })).toBe("ok");
    expect(work).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a lost connection and then succeeds", async () => {
    let calls = 0;
    const work = vi.fn(() => {
      calls += 1;
      if (calls < 3) throw err("08006");
      return Promise.resolve("ok");
    });
    expect(await withRetry(work, { sleep: noSleep })).toBe("ok");
    expect(work).toHaveBeenCalledTimes(3);
  });

  /** A deadlock is the database saying "you lost, run it again". The pass is idempotent, so we do. */
  it("retries a deadlock", async () => {
    let calls = 0;
    const work = () => {
      calls += 1;
      if (calls === 1) throw err("40P01");
      return Promise.resolve(calls);
    };
    expect(await withRetry(work, { sleep: noSleep })).toBe(2);
  });

  it("raises a constraint violation immediately", async () => {
    const work = vi.fn(() => Promise.reject(err("23505")));
    await expect(withRetry(work, { sleep: noSleep })).rejects.toThrow("23505");
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("gives up after the last attempt rather than looping forever", async () => {
    const work = vi.fn(() => Promise.reject(err("08006")));
    await expect(withRetry(work, { attempts: 3, sleep: noSleep })).rejects.toThrow("08006");
    expect(work).toHaveBeenCalledTimes(3);
  });

  /**
   * Jitter, not a fixed schedule: every connection in the pool fails at the same instant when a
   * database goes away, and a deterministic backoff has them all wake together and stampede it the
   * moment it returns.
   */
  it("backs off within a growing ceiling, jittered", async () => {
    const delays: number[] = [];
    const work = () => Promise.reject(err("08006"));
    await expect(
      withRetry(work, {
        attempts: 5,
        baseMs: 100,
        maxMs: 5_000,
        sleep: async (ms) => {
          delays.push(ms);
          await Promise.resolve();
        },
      }),
    ).rejects.toThrow();

    expect(delays).toHaveLength(4);
    // Full jitter picks a point in [0, ceiling], so assert the ceiling rather than the value.
    for (const [i, delay] of delays.entries()) {
      const ceiling = Math.min(100 * 2 ** i, 5_000);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(ceiling);
    }
  });

  it("reports each retry so an outage is visible rather than silent", async () => {
    const seen: number[] = [];
    await expect(
      withRetry(() => Promise.reject(err("08006")), {
        attempts: 3,
        sleep: noSleep,
        onRetry: (_e, attempt) => seen.push(attempt),
      }),
    ).rejects.toThrow();
    expect(seen).toEqual([1, 2]);
  });
});

describe("isRetryable", () => {
  it.each(["08006", "08003", "40001", "40P01", "57P01", "53300", "P1001", "P1017", "P2024"])(
    "retries %s",
    (code) => expect(isRetryable(err(code))).toBe(true),
  );

  it.each(["23505", "23503", "42P01", "22P02", "P2002"])(
    "does not retry %s",
    (code) => expect(isRetryable(err(code))).toBe(false),
  );

  it("does not retry something that is not an error object", () => {
    expect(isRetryable("boom")).toBe(false);
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable(new Error("no code"))).toBe(false);
  });
});
