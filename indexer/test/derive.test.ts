import { describe, expect, it } from "vitest";
import { bucketOf, PERIODS } from "../src/indexer/processing/derive.js";

describe("candle bucketing", () => {
  /// An off-by-one here does not throw — it silently attributes trades to the wrong candle, and
  /// the chart looks plausible while being wrong. Boundaries are pinned explicitly.
  // Derived rather than hardcoded: 1_700_000_000 is not actually divisible by 3600, and an
  // assumed boundary made these tests fail against correct code.
  const boundary = Math.floor(1_700_000_000 / 3600) * 3600 * 1000;

  it("puts a timestamp exactly on a boundary in the bucket it opens", () => {
    expect(bucketOf(new Date(boundary), 3600).getTime()).toBe(boundary);
  });

  it("puts a timestamp one second before a boundary in the previous bucket", () => {
    expect(bucketOf(new Date(boundary - 1000), 3600).getTime()).toBe(boundary - 3_600_000);
  });

  it("puts a timestamp one second after a boundary in the new bucket", () => {
    expect(bucketOf(new Date(boundary + 1000), 3600).getTime()).toBe(boundary);
  });

  it("never returns a bucket after the timestamp", () => {
    for (const period of PERIODS) {
      for (let i = 0; i < 200; i++) {
        const ts = new Date(1_700_000_000_000 + i * 137_000);
        expect(bucketOf(ts, period).getTime()).toBeLessThanOrEqual(ts.getTime());
      }
    }
  });

  it("aligns every bucket to its period", () => {
    for (const period of PERIODS) {
      const ts = new Date(1_700_000_123_456);
      expect(bucketOf(ts, period).getTime() / 1000 % period).toBe(0);
    }
  });

  /// Sub-millisecond drift would accumulate across a day of trades.
  it("is stable across a full day for every period", () => {
    for (const period of PERIODS) {
      const start = bucketOf(new Date(1_700_000_000_000), period).getTime();
      const later = bucketOf(new Date(1_700_000_000_000 + 86_400_000), period).getTime();
      expect((later - start) % (period * 1000)).toBe(0);
    }
  });
});
