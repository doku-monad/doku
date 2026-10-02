/**
 * @jest-environment node
 */
import { amountToField, fieldToAmount } from "../../src/lib/chain/amount-field";

const MON = 18;
const USDC = 6;
const WBTC = 8;

describe("the crash this module was written for", () => {
  /**
   * `SyntaxError: Cannot convert 1418629511979.7036 to a BigInt`, thrown during render, which took
   * the whole market page down.
   *
   * The trade panel moves an amount field's scale in ordinary use — `inputDecimals` follows the
   * direction and the pay-with choice, so flipping Buy/Sell on a USDC market takes it from 18 to 6.
   * The string in the box was still written at eighteen, the field re-read it at six, and the old
   * `Big(str).mul(10 ** 6)` came out fractional. `BigInt()` throws on a fraction rather than
   * rounding it.
   */
  it("reads a string carrying more decimals than the scale allows", () => {
    expect(() => fieldToAmount("1418629.5119797036", USDC)).not.toThrow();
    expect(fieldToAmount("1418629.5119797036", USDC)).toBe(1418629511980n);
  });

  it("survives an eighteen-decimal string re-read at every scale a market can carry", () => {
    const written = amountToField(1418629511979703600000000n, MON);
    for (const scale of [0, USDC, WBTC, MON]) {
      expect(() => fieldToAmount(written, scale)).not.toThrow();
      expect(typeof fieldToAmount(written, scale)).toBe("bigint");
    }
  });

  /**
   * The other half of the fault, and the reason the digits in the error were not the digits in the
   * balance: the outbound conversion went through `Number(value) / 10 ** decimals`, which is lossy
   * above 2^53. The box showed a number that was never the amount.
   */
  it("does not lose precision on an amount past 2^53", () => {
    const value = 1418629511979703600000000n;
    expect(amountToField(value, MON)).toBe("1418629.5119797036");
    // What the old implementation produced, off in the last two digits.
    expect(amountToField(value, MON)).not.toBe((Number(value) / 10 ** MON).toString());
  });

  /** `Big.toString()` goes exponential above 1e21, and `BigInt()` refuses `"1e+21"` too. */
  it("never emits exponential notation, at any size", () => {
    for (const value of [10n ** 21n, 10n ** 30n, 10n ** 40n]) {
      expect(amountToField(value, 0)).not.toMatch(/e/i);
      expect(fieldToAmount(amountToField(value, USDC), USDC)).toBe(value);
    }
  });
});

describe("round-tripping", () => {
  it("returns the same amount it was given, at each asset's own scale", () => {
    const cases: [bigint, number][] = [
      [0n, MON],
      [1n, WBTC],
      [26n, WBTC],
      [1_000_000n, USDC],
      [10n ** 18n, MON],
      [123_456_789_012_345_678n, MON],
    ];
    for (const [value, decimals] of cases) {
      expect(fieldToAmount(amountToField(value, decimals), decimals)).toBe(value);
    }
  });

  it("treats an absent scale as raw units", () => {
    expect(amountToField(500n)).toBe("500");
    expect(fieldToAmount("500")).toBe(500n);
  });
});

describe("what a field can be holding that is not a number", () => {
  /**
   * `isNumberInConstruction` deliberately allows half-typed states, and the field is read on every
   * keystroke. None of these is an error worth propagating — the box is holding zero right now.
   */
  it("reads a half-typed or empty box as zero rather than throwing", () => {
    for (const text of ["", ".", "-", "-.", "abc", "1e3", "1.2.3"]) {
      expect(() => fieldToAmount(text, USDC)).not.toThrow();
      expect(fieldToAmount(text, USDC)).toBe(0n);
    }
  });

  it("still reads the partial forms that ARE numbers", () => {
    expect(fieldToAmount("1.", USDC)).toBe(1_000_000n);
    expect(fieldToAmount(".5", USDC)).toBe(500_000n);
    expect(fieldToAmount("00.5", USDC)).toBe(500_000n);
  });

  /** Below one raw unit there is nothing to represent, and rounding is not inventing money. */
  it("reads an amount finer than the asset can express as zero", () => {
    expect(fieldToAmount("0.0000001", USDC)).toBe(0n);
  });
});
