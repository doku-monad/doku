/**
 * @jest-environment node
 */
import { compactQuote, formatCompact, formatSupply } from "../../src/lib/utils/format-compact";

/**
 * The three figures a gold-priced test market got wrong on 2026-09-13, pinned: a burned supply
 * read "1000.00M", 0.000014 XAUt0 of liquidity read "0.00", and the progress read "0 / 2".
 */
describe("formatCompact", () => {
  it("promotes to the next unit when rounding lands on 1000", () => {
    expect(formatCompact(999_998_495.7, 2)).toBe("1B");
    expect(formatCompact(999_999, 1)).toBe("1M");
    expect(formatCompact(999_400, 1)).toBe("999.4K");
  });

  it("keeps the digits of a sub-one amount instead of printing 0.00", () => {
    expect(formatCompact(0.000014)).toBe("0.000014");
    expect(formatCompact(0.05)).toBe("0.05");
    expect(formatCompact(0.5)).toBe("0.5");
    expect(formatCompact(0.123456)).toBe("0.123");
    expect(formatCompact(0)).toBe("0");
  });

  it("is unchanged for the ordinary cases", () => {
    expect(formatCompact(1_234_567)).toBe("1.2M");
    expect(formatCompact(12_345)).toBe("12.3K");
    expect(formatCompact(305_868.39)).toBe("305.9K");
    expect(formatCompact(42)).toBe("42");
    expect(formatCompact(Number.NaN)).toBe("0");
  });
});

describe("formatSupply", () => {
  it("never overstates a burned supply", () => {
    expect(formatSupply(999_998_495.7)).toBe("999.99M");
    expect(formatSupply(1_000_000_000)).toBe("1B");
    expect(formatSupply(777_777_778)).toBe("777.77M");
    expect(formatSupply(12_500)).toBe("12,500");
  });
});

describe("compactQuote", () => {
  const raw = (n: number, d: number) => BigInt(Math.round(n * 10 ** d));
  it("keeps a gold target and a dust raise legible", () => {
    expect(compactQuote(1_809_590n, 6)).toBe("1.81");
    expect(compactQuote(14n, 6)).toBe("0.000014");
    expect(compactQuote(0n, 6)).toBe("0");
  });
  it("keeps MON targets as they were", () => {
    expect(compactQuote(raw(10, 18), 18)).toBe("10");
    expect(compactQuote(305868390948742537150460n, 18)).toBe("305.9K");
    expect(compactQuote(raw(0.98, 18), 18)).toBe("0.98");
    expect(compactQuote(raw(8000, 6), 6)).toBe("8.0K");
  });
});
