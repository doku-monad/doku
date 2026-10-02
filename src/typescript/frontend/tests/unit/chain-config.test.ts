import {
  defineDokuChain,
  requireAddress,
  requireChainId,
  toNominal,
} from "../../src/lib/chain/config";

/**
 * Chain configuration is the one place where a wrong value is both easy to introduce and
 * impossible to notice: an app pointed at the wrong chain id renders perfectly and then sends
 * transactions nowhere, and an undefined contract address becomes the zero address, which accepts
 * MON and keeps it.
 */
describe("chain config", () => {
  it("describes Monad, not a placeholder", () => {
    const chain = defineDokuChain("https://rpc.example", 143);
    expect(chain.id).toBe(143);
    expect(chain.nativeCurrency).toEqual({ name: "Monad", symbol: "MON", decimals: 18 });
    expect(chain.rpcUrls.default.http[0]).toBe("https://rpc.example");
  });

  /**
   * Which Monad this is, is configuration.
   *
   * Mainnet is 143 and testnet is 10143, and an app built for one and pointed at the other
   * renders perfectly: the wallet simply reports the wrong network, or worse, the RPC accepts
   * calls and every address resolves to nothing. It was a constant, which made a testnet
   * deployment impossible to express at all.
   */
  it("takes its chain id from configuration", () => {
    expect(defineDokuChain("https://rpc.example", 10143).id).toBe(10143);
  });

  /**
   * No silent default, and mainnet least of all.
   *
   * Falling back to 143 means a deployment that forgot the variable points at mainnet — the one
   * network where being wrong costs money. An unset variable has to stop the boot.
   */
  it("refuses to guess a chain id", () => {
    expect(() => requireChainId(undefined, "NEXT_PUBLIC_MONAD_CHAIN_ID")).toThrow(
      /NEXT_PUBLIC_MONAD_CHAIN_ID/
    );
    expect(() => requireChainId("", "X")).toThrow();
  });

  it("rejects a chain id that is not a positive integer", () => {
    expect(() => requireChainId("mainnet", "X")).toThrow(/not a chain id/i);
    expect(() => requireChainId("0", "X")).toThrow(/not a chain id/i);
    expect(() => requireChainId("-1", "X")).toThrow(/not a chain id/i);
    expect(() => requireChainId("143.5", "X")).toThrow(/not a chain id/i);
  });

  it("parses a decimal chain id", () => {
    expect(requireChainId("10143", "X")).toBe(10143);
  });

  it("throws on a missing address rather than yielding undefined", () => {
    expect(() => requireAddress(undefined, "NEXT_PUBLIC_DOKU_FACTORY")).toThrow(
      /NEXT_PUBLIC_DOKU_FACTORY/
    );
  });

  /// `undefined` coerced into a call becomes the zero address, which is a real address that can
  /// receive MON and never give it back. An empty string is the same mistake wearing a disguise.
  it("rejects an empty or malformed address", () => {
    expect(() => requireAddress("", "X")).toThrow();
    expect(() => requireAddress("0x123", "X")).toThrow(/not an address/i);
    expect(() => requireAddress("not-an-address", "X")).toThrow(/not an address/i);
  });

  it("accepts a well-formed address and normalises its case", () => {
    const mixed = "0xAAbbCCddEEff00112233445566778899aAbBcCdD";
    expect(requireAddress(mixed, "X")).toBe(mixed.toLowerCase());
  });

  /**
   * Base units to a display number.
   *
   * The hard case is not the large one. This divided by 1e12 as a bigint before touching floating
   * point, to keep a balance inside float64's exact range — which works for balances, and silently
   * floors every value below 1e-6 to zero. A launchpad's prices live there: two of the four trades
   * on the first testnet market rendered as "0.000000000" in the trade feed, and on a market with
   * a smaller target every one of them would have.
   */
  describe("toNominal", () => {
    it("keeps a price far below one whole unit", () => {
      // 1.006e-7, which is where a curve trades early on.
      expect(toNominal(100_600_000_000n)).toBeCloseTo(0.0000001006, 15);
    });

    it("keeps a price small enough that the old bigint pre-division floored it", () => {
      expect(toNominal(1n)).toBeGreaterThan(0);
      expect(toNominal(1_000_000n)).toBeCloseTo(1e-12, 20);
    });

    it("still converts a whole-token balance exactly", () => {
      expect(toNominal(45_000_000n * 10n ** 18n)).toBe(45_000_000);
      expect(toNominal(10n ** 18n)).toBe(1);
    });

    it("is zero for zero", () => {
      expect(toNominal(0n)).toBe(0);
    });
  });
});
