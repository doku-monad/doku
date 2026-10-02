/**
 * @jest-environment node
 */
import { sortCurrencies } from "../../src/lib/chain/pool-key";

/**
 * Which side of a v4 pool a market's two assets land on.
 *
 * The `PoolKey` is hashed into the `PoolId`, so the order is not a convention that can be got
 * wrong politely: a key built with the currencies the other way round hashes to a pool that does
 * not exist, and every read against it returns zeros. That renders as "this market has never
 * traded" rather than as an encoding mistake — the same failure `pool-id.ts` warns about for
 * packed encoding.
 *
 * It stopped being a constant when markets stopped being priced in MON. `currency0` used to be
 * native MON on every DOKU pool by construction; against a USDC or gold quote it is whichever of
 * the two addresses is numerically smaller, and that is a property of the pair.
 */
describe("pool key ordering", () => {
  const LOW = "0x0000000000000000000000000000000000000aaa" as const;
  const HIGH = "0xffffffffffffffffffffffffffffffffffffffff" as const;
  const NATIVE = "0x0000000000000000000000000000000000000000" as const;

  it("puts the numerically smaller address first", () => {
    expect(sortCurrencies(HIGH, LOW)).toEqual([LOW, HIGH]);
    expect(sortCurrencies(LOW, HIGH)).toEqual([LOW, HIGH]);
  });

  /** Native MON is `address(0)`, which is smaller than every token — so it is always currency0. */
  it("keeps native MON as currency0", () => {
    expect(sortCurrencies(NATIVE, HIGH)).toEqual([NATIVE, HIGH]);
    expect(sortCurrencies(HIGH, NATIVE)).toEqual([NATIVE, HIGH]);
  });

  /**
   * Checksummed against lower-case, which is where a string comparison quietly fails.
   *
   * `"0xF..." < "0xa..."` is true in ASCII and false as an address, so a row carrying a
   * checksummed address and a constant carrying a lower-cased one would sort differently — and
   * produce a key that hashes to nothing.
   */
  it("compares as addresses, not as ASCII", () => {
    const upper = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" as const;
    const lower = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
    expect(sortCurrencies(lower, upper)).toEqual([upper.toLowerCase(), lower.toLowerCase()]);
  });

  it("refuses a pair of the same currency", () => {
    expect(() => sortCurrencies(LOW, LOW.toUpperCase() as `0x${string}`)).toThrow();
  });
});
