import { decodePositionInfo } from "../../src/lib/chain/position-info";

/** Packs a `PositionInfo` the way `PositionInfoLibrary` does, to decode it back. */
function pack(tickLower: number, tickUpper: number, hasSubscriber = false): bigint {
  const to24 = (t: number) => BigInt(t < 0 ? t + 0x1000000 : t);
  return (to24(tickUpper) << 32n) | (to24(tickLower) << 8n) | (hasSubscriber ? 1n : 0n);
}

describe("v4 position info", () => {
  it("reads a range above the price", () => {
    expect(decodePositionInfo(pack(60, 120))).toEqual({
      tickLower: 60,
      tickUpper: 120,
      hasSubscriber: false,
    });
  });

  /**
   * The case that makes this a module.
   *
   * Any range that reaches below the current price has a negative lower tick, and a `uint24` read
   * of `-60` is `16_777_156` — past `MAX_TICK`, so the position reads as a vast range off the top
   * of the price scale. Nothing throws; the amounts are just wrong.
   */
  it("reads negative ticks as negative", () => {
    expect(decodePositionInfo(pack(-60, 60))).toEqual({
      tickLower: -60,
      tickUpper: 60,
      hasSubscriber: false,
    });
    expect(decodePositionInfo(pack(-120, -60))).toEqual({
      tickLower: -120,
      tickUpper: -60,
      hasSubscriber: false,
    });
  });

  /** The full-range position DOKU itself mints, which is the one that must never misread. */
  it("reads the widest usable range", () => {
    expect(decodePositionInfo(pack(-887_220, 887_220))).toEqual({
      tickLower: -887_220,
      tickUpper: 887_220,
      hasSubscriber: false,
    });
  });

  it("does not let the pool id bleed into the ticks", () => {
    const withPoolId = (1n << 255n) | (0xdeadbeefn << 56n) | pack(-600, 600);
    expect(decodePositionInfo(withPoolId)).toEqual({
      tickLower: -600,
      tickUpper: 600,
      hasSubscriber: false,
    });
  });

  it("reads the subscriber flag without disturbing the ticks", () => {
    expect(decodePositionInfo(pack(-60, 60, true))).toEqual({
      tickLower: -60,
      tickUpper: 60,
      hasSubscriber: true,
    });
  });

  it("decodes an empty position as an empty range", () => {
    expect(decodePositionInfo(0n)).toEqual({
      tickLower: 0,
      tickUpper: 0,
      hasSubscriber: false,
    });
  });
});
