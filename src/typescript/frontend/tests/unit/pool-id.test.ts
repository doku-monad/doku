import { POOL_FEE_TIER, POOL_TICK_SPACING } from "../../src/lib/chain/config";
import { poolIdFrom } from "../../src/lib/chain/pool-id";

/**
 * Pinned against a pool that exists.
 *
 * This is the 🐋 market on Monad mainnet, the first DOKU market to graduate. The expected id was
 * not produced by this function — it came from `cast keccak` over `cast abi-encode` of the same
 * key, and was then confirmed by calling `StateView.getSlot0` with it and getting a live price and
 * 1e22 of liquidity back. A hash that agrees only with itself would pass a round-trip test while
 * addressing nothing.
 */
const WHALE_KEY = {
  currency0: "0x0000000000000000000000000000000000000000" as const,
  currency1: "0x5755b8edcd8765d7319fc6ae05389c1e7c7fa17e" as const,
  fee: 0,
  tickSpacing: 60,
  hooks: "0x0c0F84F5c2Cba0C2ce058dA755bd6f7215D76FcF" as const,
};

describe("v4 pool id", () => {
  /**
   * The constants the app builds pool keys from must be the ones the live pool was created with.
   *
   * This is the assertion that matters, and the one that was missing. `POOL_TICK_SPACING` lived in
   * `range.ts` as 200 — Uniswap V3's spacing for the 1% tier — while the pool uses 60, so every
   * range the UI produced was misaligned and every deposit reverted. Nothing compared the two,
   * because nothing could: they were different constants in different files.
   *
   * Tying them to `WHALE_KEY` fixes that, because that key is not a guess. The id below was
   * produced independently with `cast` and confirmed by calling `StateView.getSlot0` with it and
   * getting a live price and 1e22 of liquidity back. So if either constant drifts from the chain,
   * this fails — where a test comparing the app to itself would happily pass.
   */
  it("is built from the same fee and spacing the live pool was created with", () => {
    expect(POOL_TICK_SPACING).toBe(WHALE_KEY.tickSpacing);
    expect(POOL_FEE_TIER).toBe(WHALE_KEY.fee);
  });

  it("matches the id of a live mainnet pool", () => {
    expect(poolIdFrom(WHALE_KEY)).toBe(
      "0x3d11fd598cfd3ea892295006d81e11799cbe6122dbe6a626891901b0b6befd99"
    );
  });

  it("does not depend on the case the addresses arrive in", () => {
    expect(
      poolIdFrom({ ...WHALE_KEY, hooks: WHALE_KEY.hooks.toLowerCase() as `0x${string}` })
    ).toBe(poolIdFrom(WHALE_KEY));
  });

  /** Every field is part of the identity; two pools differing only in spacing are two pools. */
  it("changes when any field of the key changes", () => {
    const id = poolIdFrom(WHALE_KEY);
    expect(poolIdFrom({ ...WHALE_KEY, tickSpacing: 10 })).not.toBe(id);
    expect(poolIdFrom({ ...WHALE_KEY, fee: 3_000 })).not.toBe(id);
    expect(
      poolIdFrom({ ...WHALE_KEY, currency1: "0x0000000000000000000000000000000000000001" })
    ).not.toBe(id);
  });
});
