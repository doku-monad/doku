/**
 * @jest-environment node
 */
import { priceFromSqrtX96 } from "../../src/lib/chain/pool-price";

// Mainnet's WMON. Passed in rather than imported: which address wraps the native token is a
// property of the network, and burying it in the module made the function untestable against any
// network but one — and undeployable to any other.
const WMON = "0x3bd359c1119da7da1d913d1c4d2b7c461115433a";
const TOKEN = "0x1111111111111111111111111111111111111111";
const Q96 = 2n ** 96n;

/** `sqrtPriceX96` for a given token1-per-token0 ratio. */
const sqrtFor = (ratio: number) => BigInt(Math.floor(Math.sqrt(ratio) * Number(Q96)));

describe("pool price", () => {
  /**
   * The direction, which is the half that silently inverts.
   *
   * V3 sorts its tokens by address, so whether MON is token0 is a property of the addresses, not
   * of the protocol. Getting it backwards yields the reciprocal — a price that is wrong by orders
   * of magnitude and still renders as a perfectly ordinary number.
   */
  it("inverts when MON is token0", () => {
    // token1-per-token0 = 5 means 5 tokens per MON, i.e. 0.2 MON per token.
    expect(priceFromSqrtX96(sqrtFor(5), WMON, WMON)).toBeCloseTo(0.2, 6);
  });

  it("does not invert when MON is token1", () => {
    // token1-per-token0 = 5 means 5 MON per token.
    expect(priceFromSqrtX96(sqrtFor(5), TOKEN, WMON)).toBeCloseTo(5, 6);
  });

  it("is case-insensitive about the token0 address", () => {
    expect(priceFromSqrtX96(sqrtFor(4), WMON.toUpperCase(), WMON)).toBeCloseTo(
      priceFromSqrtX96(sqrtFor(4), WMON, WMON),
      12
    );
  });

  /// A market minutes off its curve trades at a very small number of MON per token. Squaring
  /// before descaling has to survive that without collapsing to zero.
  it("handles the small prices a freshly graduated market has", () => {
    // 0.0002 MON per token, with MON as token1.
    const price = priceFromSqrtX96(sqrtFor(0.0002), TOKEN, WMON);
    expect(price).toBeGreaterThan(0);
    expect(price).toBeCloseTo(0.0002, 9);
  });

  it("reports zero rather than NaN for an uninitialised pool", () => {
    expect(priceFromSqrtX96(0n, WMON, WMON)).toBe(0);
    expect(priceFromSqrtX96(-1n, WMON, WMON)).toBe(0);
  });
});
