/**
 * @jest-environment node
 */
import { formatAssetAmount } from "../../src/lib/chain/amount-display";

/** The assets DOKU actually prices markets in, and the decimals each really has. */
const MON = 18;
const USDC = 6;
const WBTC = 8;
const GOLD = 6;

describe("the bug this module was written for", () => {
  /*
   * Measured from the live panel: a WBTC-quoted market, one MON of input, and a receipt row
   * reading "Swap delivers 0.000000 WBTC" directly above "You receive 8,297.6892 TEST".
   */
  it("never renders a non-zero amount as zero", () => {
    expect(formatAssetAmount(26n, WBTC)).toBe("0.00000026");
  });

  it("shows the smallest possible unit of the coarsest asset", () => {
    // One raw unit of six-decimal gold. `toFixed(6)` happened to survive this one; the fix must
    // not regress it while fixing the eight-decimal case.
    expect(formatAssetAmount(1n, GOLD)).toBe("0.000001");
  });

  it("shows one wei, which eighteen fixed places would also have shown as zero", () => {
    expect(formatAssetAmount(1n, MON)).toBe("0.000000000000000001");
  });

  it("only ever renders zero for an amount that is actually zero", () => {
    expect(formatAssetAmount(0n, WBTC)).toBe("0");
    expect(formatAssetAmount(0n, MON)).toBe("0");
  });
});

describe("amounts big enough to read", () => {
  it("keeps an ordinary amount at ordinary precision", () => {
    expect(formatAssetAmount(1_500_000n, USDC)).toBe("1.5");
    expect(formatAssetAmount(8_000_000_000n, USDC)).toBe("8000");
  });

  it("does not pad a whole number with meaningless zeros", () => {
    expect(formatAssetAmount(1_000_000n, USDC)).toBe("1");
  });

  it("truncates rather than rounds, because this sits beside a floor being signed", () => {
    // Rounding up could print an amount the chain will not honour.
    expect(formatAssetAmount(1_999_999_999_999_999_999n, MON)).toBe("1.999999");
  });
});

describe("precision that does not exist is not invented", () => {
  it("never shows more places than the asset has", () => {
    for (const raw of [1n, 7n, 123n, 999_999n]) {
      const shown = formatAssetAmount(raw, USDC);
      const places = shown.includes(".") ? shown.split(".")[1].length : 0;
      expect(places).toBeLessThanOrEqual(USDC);
    }
  });

  it("handles a zero-decimal asset without inventing a point", () => {
    expect(formatAssetAmount(42n, 0)).toBe("42");
  });
});

describe("values a float would have corrupted", () => {
  it("survives above 2^53, which is nine tokens at eighteen decimals", () => {
    // `Number(formatUnits(v, 18))` drops digits here. Nothing in this module converts to Number.
    const raw = 123_456_789_123_456_789_123_456_789n;
    expect(formatAssetAmount(raw, MON)).toBe("123456789.123456");
  });

  it("keeps every integer digit of a very large balance", () => {
    const raw = 10n ** 30n;
    expect(formatAssetAmount(raw, MON)).toBe("1000000000000");
  });
});

describe("the knobs", () => {
  it("takes a wider default precision when asked", () => {
    expect(formatAssetAmount(1_234_567_890n, MON, { minPlaces: 9 })).toBe("0.00000000123");
  });

  it("keeps the requested significant digits past the leading zeros", () => {
    // One digit past the leading zeros, which is what was asked for -- and still not zero, which
    // is the invariant. Truncated, not rounded: 0.00000026 shows as 0.0000002, never 0.0000003.
    expect(formatAssetAmount(26n, WBTC, { significantDigits: 1 })).toBe("0.0000002");
    expect(formatAssetAmount(123_456n, MON, { significantDigits: 2 })).toBe("0.00000000000012");
  });
});

describe("negatives, which a delta can be", () => {
  it("keeps the sign and the precision rule together", () => {
    expect(formatAssetAmount(-26n, WBTC)).toBe("-0.00000026");
    expect(formatAssetAmount(-1_500_000n, USDC)).toBe("-1.5");
  });
});
