/**
 * @jest-environment node
 */
import { matchRecordsToMarkets, type PositionRecord } from "../../src/lib/chain/position-matching";

const WMON = "0xA4Bf89CdE91ab662d0d44C5afC9B0eAAe2E59Dfd";
// Deliberately one below and one above WMON, so both token orderings get exercised.
const TOKEN_LOW = "0x1111111111111111111111111111111111111111";
const TOKEN_HIGH = "0xffffffffffffffffffffffffffffffffffffffff";

const market = (tokenAddress: string, symbol: string, poolAddress: string | null = "0xpool") => ({
  marketAddress: `market-${symbol}`,
  tokenAddress,
  poolAddress,
  symbol,
});

const record = (over: Partial<PositionRecord> = {}): PositionRecord => ({
  tokenId: 1n,
  token0: TOKEN_LOW,
  token1: WMON,
  fee: 0,
  tickLower: -887_200,
  tickUpper: 887_200,
  liquidity: 1_000n,
  ...over,
});

/**
 * Which of an address's Uniswap positions belong to a DOKU market.
 *
 * The position manager is one contract shared by every pool on the chain, so enumerating an
 * address returns positions in pools this app has never heard of. Every clause under test here is
 * a place a real position can disappear from somebody's screen — and a position that vanishes from
 * a liquidity page is indistinguishable from money that vanished.
 */
describe("matchRecordsToMarkets", () => {
  it("matches a position whose market token is token0", () => {
    const out = matchRecordsToMarkets([record()], [market(TOKEN_LOW, "🐎")], WMON);
    expect(out).toHaveLength(1);
    expect(out[0]!.symbol).toBe("🐎");
    expect(out[0]!.marketTokenIsToken0).toBe(true);
    expect(out[0]!.poolAddress).toBe("0xpool");
  });

  /**
   * V3 sorts its pair by address, so which side the market token lands on is a property of the
   * addresses rather than of the protocol. Handling one ordering only would make positions in
   * roughly half of all markets invisible — invisible in the specific way that reads as "you have
   * no liquidity".
   */
  it("matches a position whose market token is token1", () => {
    const out = matchRecordsToMarkets(
      [record({ token0: WMON, token1: TOKEN_HIGH })],
      [market(TOKEN_HIGH, "🏇")],
      WMON
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.marketTokenIsToken0).toBe(false);
  });

  /** Checksummed from a log, lowercase from the database, whatever was pasted from config. */
  it("matches regardless of the case each address arrives in", () => {
    const out = matchRecordsToMarkets(
      [record({ token0: TOKEN_LOW.toUpperCase().replace("0X", "0x"), token1: WMON.toLowerCase() })],
      [market(TOKEN_LOW.toLowerCase(), "🐎")],
      WMON
    );
    expect(out).toHaveLength(1);
  });

  /** DOKU graduates into the 1% tier. Another tier is another product's pool. */
  it("ignores another fee tier", () => {
    expect(
      matchRecordsToMarkets([record({ fee: 3_000 })], [market(TOKEN_LOW, "🐎")], WMON)
    ).toEqual([]);
  });

  it("ignores a pair with no WMON side", () => {
    const out = matchRecordsToMarkets(
      [record({ token0: TOKEN_LOW, token1: TOKEN_HIGH })],
      [market(TOKEN_LOW, "🐎")],
      WMON
    );
    expect(out).toEqual([]);
  });

  it("ignores a token that belongs to no known market", () => {
    expect(matchRecordsToMarkets([record()], [market(TOKEN_HIGH, "🏇")], WMON)).toEqual([]);
  });

  /**
   * A market that has not graduated has no pool, so it cannot hold a position. If a record turns
   * up anyway there is no pool address to price it against, and a row with no price is worse than
   * no row when the market itself is the thing that does not exist yet.
   */
  it("ignores a market with no pool", () => {
    expect(matchRecordsToMarkets([record()], [market(TOKEN_LOW, "🐎", null)], WMON)).toEqual([]);
  });

  /**
   * Withdrawn but never burned. This is the one omission the function makes, and it omits nothing:
   * an empty position sitting beside a real one invites withdrawing from the wrong row.
   */
  it("drops an emptied position", () => {
    expect(
      matchRecordsToMarkets([record({ liquidity: 0n })], [market(TOKEN_LOW, "🐎")], WMON)
    ).toEqual([]);
  });

  it("keeps every matching record, in order", () => {
    const out = matchRecordsToMarkets(
      [record({ tokenId: 1n }), record({ tokenId: 2n })],
      [market(TOKEN_LOW, "🐎")],
      WMON
    );
    expect(out.map((p) => p.tokenId)).toEqual([1n, 2n]);
  });

  it("returns nothing when there are no markets to match against", () => {
    expect(matchRecordsToMarkets([record()], [], WMON)).toEqual([]);
  });
});
