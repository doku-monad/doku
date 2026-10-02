import {
  depositWithin,
  makerLevyBps,
  NO_LEVY,
  SINK_BURN,
  SINK_REWARDS,
  withLevy,
} from "../../src/lib/chain/maker-levy";

/**
 * The maker levy, pinned against what the deployed hook charged on Monad mainnet.
 *
 * These are not derived from the contract source. They are the boundary an `eth_call` against
 * `0x5b7eC4a9…` (PositionManager) actually found for 🎏 — pool
 * `0x8643d4d5…`, hook `0xccb654c2…` — by bisection: with a balance of exactly 8,400,000 tokens the
 * largest deposit that mints is 8,337,468.98263027295285382, and one wei more reverts with
 * `TRANSFER_FROM_FAILED`. `balance / that` is 1.0075 to twenty-two significant figures, which is
 * the seventy-five basis points `_bps1` charges a BURN market — and which the same market's
 * `markets(id).makerBps1` reports as zero.
 */
const TOKEN_BALANCE = 8_400_000_000_000_000_000_000_000n;
const LARGEST_DEPOSIT_THAT_MINTS = 8_337_468_982_630_272_952_853_820n;

describe("the maker levy", () => {
  describe("rates", () => {
    it("charges a BURN market seventy-five basis points of the token leg", () => {
      // The mainnet case: 🎁 and 🎏 both read sink 0, protocolBps 25.
      expect(makerLevyBps({ sink: SINK_BURN, protocolBps: 25 })).toEqual({ bps0: 25, bps1: 75 });
    });

    it("charges a REWARDS market the whole hundred on the MON leg and nothing on the token", () => {
      // 🐋's configuration, read from the previous hook: makerBps0 100, makerBps1 0.
      expect(makerLevyBps({ sink: SINK_REWARDS, protocolBps: 25 })).toEqual({ bps0: 100, bps1: 0 });
    });

    it("levies nothing when the market has not been read", () => {
      expect(makerLevyBps(null)).toEqual(NO_LEVY);
    });
  });

  describe("withLevy", () => {
    it("floors the levy the way the hook does", () => {
      // 10_000 * 75 / 10_000 is exact; 9_999 * 75 / 10_000 is 74.9925 and the hook keeps 74.
      expect(withLevy(10_000n, 75)).toBe(10_075n);
      expect(withLevy(9_999n, 75)).toBe(9_999n + 74n);
    });

    it("costs nothing extra at a zero rate", () => {
      expect(withLevy(12_345n, 0)).toBe(12_345n);
    });

    it("charges nothing on nothing", () => {
      expect(withLevy(0n, 75)).toBe(0n);
    });
  });

  describe("depositWithin", () => {
    /**
     * The regression. Depositing the whole balance is what the Max button used to ask for, and it
     * is the one amount that cannot work.
     */
    it("leaves room for the levy, so the full balance is never asked for", () => {
      const deposit = depositWithin(TOKEN_BALANCE, 75);
      expect(deposit).toBeLessThan(TOKEN_BALANCE);
      expect(withLevy(deposit, 75)).toBeLessThanOrEqual(TOKEN_BALANCE);
    });

    it("lands within a wei of the boundary the chain actually enforces", () => {
      // Bisection found 8_337_468_982_630_272_952_853_820 mintable from a 8_400_000e18 balance.
      // A conservative floor may sit a hair below it; it must never sit above.
      const deposit = depositWithin(TOKEN_BALANCE, 75);
      expect(deposit).toBeLessThanOrEqual(LARGEST_DEPOSIT_THAT_MINTS);
      expect(LARGEST_DEPOSIT_THAT_MINTS - deposit).toBeLessThan(1_000_000n);
    });

    it("is the whole balance when nothing is levied", () => {
      expect(depositWithin(TOKEN_BALANCE, 0)).toBe(TOKEN_BALANCE);
    });

    it("never returns something the levy pushes back over the balance", () => {
      // Every rate the hook can reach, against a balance chosen to round badly.
      for (const bps of [0, 25, 75, 100, 200]) {
        for (const balance of [1n, 7n, 9_999n, 10_001n, 123_456_789n, TOKEN_BALANCE]) {
          expect(withLevy(depositWithin(balance, bps), bps)).toBeLessThanOrEqual(balance);
        }
      }
    });
  });
});
