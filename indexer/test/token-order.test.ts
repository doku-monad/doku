import { describe, expect, it } from "vitest";

import { NATIVE_CURRENCY, marketTokenIsCurrency0 } from "../src/indexer/ingestion/ingest.js";

/**
 * Which side of a pool holds the market's token.
 *
 * Getting it backwards inverts both the direction and the price of every pool trade on the markets
 * it is wrong about — and inverts nothing on the rest, so a single passing market proves nothing.
 *
 * This was a sort-order comparison against the wrapper under V3, where either token could be
 * `token0`. Under v4 there is no wrapper: `currency0` is native MON, spelled `address(0)`, which
 * sorts below every possible token address. So the market's token is always `currency1`, and the
 * question is settled by identity rather than by ordering.
 */
describe("pool currency ordering", () => {
  const TOKEN = "0x8888888888888888888888888888888888888888";

  /** The case every DOKU pool is in. */
  it("puts the market's token on currency1 when currency0 is native MON", () => {
    expect(marketTokenIsCurrency0(TOKEN, NATIVE_CURRENCY)).toBe(false);
  });

  /**
   * `address(0)` is below every token address, so no token can displace it — including the
   * smallest one a launch could plausibly produce. Asserted because the previous implementation
   * answered this by sorting, and a token below the wrapper WOULD have taken `token0` there.
   */
  it("cannot be displaced by a very low token address", () => {
    expect(marketTokenIsCurrency0("0x0000000000000000000000000000000000000001", NATIVE_CURRENCY)).toBe(false);
  });

  /**
   * The stored PoolKey is believed over any assumption made here. If a pool ever reports the
   * market's token as `currency0`, that is what the swap maths must use — an assumption baked in
   * as a constant would silently invert every trade on it.
   */
  it("believes the pool's own currency0", () => {
    expect(marketTokenIsCurrency0(TOKEN, TOKEN)).toBe(true);
  });

  /**
   * Addresses arrive from different places in different cases — the database stores lowercase and
   * a log carries EIP-55 checksummed — so the two spellings of one address must compare equal.
   */
  it("compares addresses regardless of the case they arrive in", () => {
    expect(marketTokenIsCurrency0("0xAAAA000000000000000000000000000000000000", "0xaaaa000000000000000000000000000000000000")).toBe(true);
    expect(marketTokenIsCurrency0("0xaaaa000000000000000000000000000000000000", "0xAAAA000000000000000000000000000000000000")).toBe(true);
    expect(marketTokenIsCurrency0("0xFFFF000000000000000000000000000000000000", "0xaaaa000000000000000000000000000000000000")).toBe(false);
  });
});
