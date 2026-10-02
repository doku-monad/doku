/**
 * @jest-environment node
 */
import {
  applySlippage,
  curveBuyEntry,
  curveIsClosed,
  deadlineFrom,
  isNativeQuote,
  MAX_SLIPPAGE_BPS,
  SlippageError,
} from "../../src/lib/chain/writes";

/**
 * Slippage and deadline are the two arguments a trading UI is most likely to get wrong, and both
 * fail in the direction of the user losing money rather than seeing an error.
 */
describe("slippage", () => {
  it("lowers the minimum received by the tolerance", () => {
    // 1 token expected, 1% tolerance -> accept 0.99.
    expect(applySlippage(1_000_000_000_000_000_000n, 100)).toBe(990_000_000_000_000_000n);
  });

  it("rounds the minimum down, never up", () => {
    // Rounding up would set a floor above what the trade can deliver, so a fair fill reverts.
    expect(applySlippage(999n, 100)).toBe(989n);
  });

  /// Zero tolerance means the quote must be met exactly. It is a valid, if impatient, choice and
  /// must not silently become the default.
  it("accepts zero tolerance without widening it", () => {
    expect(applySlippage(1_000n, 0)).toBe(1_000n);
  });

  /**
   * The one that actually protects someone.
   *
   * A slippage field that accepts 10000 bps sets the minimum received to zero, which is a
   * standing offer to be sandwiched for the entire trade. Refusing is better than trusting the
   * input, because the input is a text box.
   */
  it("refuses a tolerance that would set the floor to nothing", () => {
    expect(() => applySlippage(1_000n, 10_000)).toThrow(SlippageError);
    expect(() => applySlippage(1_000n, MAX_SLIPPAGE_BPS + 1)).toThrow(SlippageError);
  });

  it("refuses a negative or non-integer tolerance", () => {
    expect(() => applySlippage(1_000n, -1)).toThrow(SlippageError);
    expect(() => applySlippage(1_000n, 12.5)).toThrow(SlippageError);
  });

  it("never returns more than the quote", () => {
    for (const bps of [0, 1, 50, 100, 500, MAX_SLIPPAGE_BPS]) {
      expect(applySlippage(1_000_000n, bps)).toBeLessThanOrEqual(1_000_000n);
    }
  });
});

describe("deadline", () => {
  it("is seconds since the epoch, not milliseconds", () => {
    const now = 1_800_000_000_000; // ms
    // A deadline in milliseconds is ~1000x too far in the future, which disables the protection
    // entirely while looking like it works.
    expect(deadlineFrom(now, 60)).toBe(1_800_000_060n);
  });

  it("moves forward with the window", () => {
    expect(deadlineFrom(1_800_000_000_000, 300) - deadlineFrom(1_800_000_000_000, 60)).toBe(240n);
  });

  it("refuses a window that has already passed", () => {
    expect(() => deadlineFrom(1_800_000_000_000, 0)).toThrow();
    expect(() => deadlineFrom(1_800_000_000_000, -60)).toThrow();
  });
});

/**
 * Which entry point the curve accepts, and what its quote means.
 *
 * `BondingCurve` has three ways in and they are mutually exclusive on chain: a native-quote market
 * reverts `QuoteIsNotNative()` on `buyWithToken`, and an ERC-20-quote market reverts
 * `QuoteIsNative()` on `buy`. There is no forgiving path, so the choice is made from the market's
 * own `quote_asset` rather than from anything a component happened to be holding.
 */
describe("the curve's buy entry point", () => {
  const NATIVE = "0x0000000000000000000000000000000000000000";
  const USDC = "0xf817257fed379853cDe0fa4F97AB987181B1E5Ea";

  it("sends a native-quote market to `buy`", () => {
    expect(curveBuyEntry({ quoteAsset: NATIVE })).toBe("buy");
    // Checksummed, lower-cased, whatever the row happens to carry.
    expect(curveBuyEntry({ quoteAsset: NATIVE.toUpperCase().replace("0X", "0x") })).toBe("buy");
  });

  it("sends an ERC-20 quote to `buyWithToken`", () => {
    expect(curveBuyEntry({ quoteAsset: USDC })).toBe("buyWithToken");
    expect(curveBuyEntry({ quoteAsset: USDC.toLowerCase() })).toBe("buyWithToken");
  });

  it("prefers `buyWithPermit` when a signature is in hand", () => {
    expect(curveBuyEntry({ quoteAsset: USDC, hasPermit: true })).toBe("buyWithPermit");
    // A permit over native MON is meaningless — there is no token to sign for.
    expect(curveBuyEntry({ quoteAsset: NATIVE, hasPermit: true })).toBe("buy");
  });

  it("knows which asset is the native one", () => {
    expect(isNativeQuote(NATIVE)).toBe(true);
    expect(isNativeQuote(USDC)).toBe(false);
  });
});

/**
 * The five-value buy quote, and the one shape that is not a trade.
 *
 * A closed curve does not revert when quoted — it returns the whole input as `refund` and nothing
 * out. Read as a tuple of numbers that is a zero-output trade, and the panel keeps its button lit
 * and reverts on every click. It has to be read as a STATE.
 */
describe("reading a buy quote", () => {
  const closed = { baseOut: 0n, fee: 0n, antiSniperTax: 0n, creatorTax: 0n, refund: 1_000_000n };
  const open = {
    baseOut: 5_000n,
    fee: 10_000n,
    antiSniperTax: 3_000n,
    creatorTax: 2_000n,
    refund: 0n,
  };

  it("names a closed curve rather than quoting zero", () => {
    expect(curveIsClosed(closed, 1_000_000n)).toBe(true);
  });

  it("does not call an ordinary trade closed", () => {
    expect(curveIsClosed(open, 1_000_000n)).toBe(false);
  });

  /**
   * The overshoot, which looks the same and is not.
   *
   * The buy that FILLS a curve takes what it still needs and refunds the rest, so it has a real
   * `baseOut` and a large refund at once. Treating that as "graduated" would refuse the single
   * most important trade in a market's life.
   */
  it("does not call a filling buy closed", () => {
    const filling = { ...open, refund: 900_000n };
    expect(curveIsClosed(filling, 1_000_000n)).toBe(false);
  });

  it("says nothing about a zero-sized input", () => {
    expect(curveIsClosed({ ...closed, refund: 0n }, 0n)).toBe(false);
  });
});
