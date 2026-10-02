import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { toBigInt, toBigIntOrNull, toNumeric } from "../src/db/numeric.js";

/**
 * The conversion between `NUMERIC(78,0)` and `bigint`.
 *
 * This has a test because the obvious implementation is wrong in a way nothing would catch.
 * Prisma maps `NUMERIC` to a Decimal whose `toString()` switches to exponential notation above
 * 1e21 — and every amount on this chain is 18-decimal fixed point, so essentially all of them are
 * past that. `BigInt("1e+27")` throws; a version of this module that used `toString()` would work
 * on every small number in a test fixture and fail on the first real balance.
 */
describe("numeric conversion", () => {
  const cases: [label: string, value: string][] = [
    ["zero", "0"],
    ["one", "1"],
    ["one token", "1000000000000000000"],
    ["past the exponential threshold", "1000000000000000000000000000"],
    ["thirty-nine digits", "123456789012345678901234567890123456789"],
    [
      "the column maximum",
      "999999999999999999999999999999999999999999999999999999999999999999999999999999",
    ],
  ];

  it.each(cases)("round-trips %s", (_label, value) => {
    expect(toBigInt(toNumeric(BigInt(value)))).toBe(BigInt(value));
  });

  /**
   * The specific trap, asserted directly so nobody "simplifies" `toFixed(0)` back to `toString()`.
   */
  it("does not go through the exponential string form", () => {
    const big = new Prisma.Decimal("1000000000000000000000000000");
    expect(big.toString()).toContain("e+");
    expect(() => BigInt(big.toString())).toThrow();
    expect(toBigInt(big)).toBe(1_000_000_000_000_000_000_000_000_000n);
  });

  it("keeps null null", () => {
    expect(toBigIntOrNull(null)).toBeNull();
    expect(toBigIntOrNull(new Prisma.Decimal("5"))).toBe(5n);
  });

  /**
   * The low digits survive, which is the whole point. Routing the same value through `number`
   * loses them — asserted here so the contrast is on the record rather than assumed.
   */
  it("does not lose the low digits of a large amount", () => {
    const exact = 123_456_789_012_345_678_901_234_567_890n;
    expect(toBigInt(toNumeric(exact))).toBe(exact);
    expect(BigInt(Number(exact))).not.toBe(exact);
  });
});
