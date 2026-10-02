/**
 * @jest-environment node
 */
import {
  maxNativeSpend,
  MONAD_RESERVE_WEI,
  reserveVerdict,
} from "../../src/lib/chain/monad-reserve";
import { describeTxError } from "../../src/lib/chain/wallet-state";

const mon = (n: string) => BigInt(Math.round(Number(n) * 1e6)) * 10n ** 12n;
/** Roughly what a curve buy reserves: ~131k gas measured on mainnet, at a generous fee. */
const GAS = mon("0.05");

describe("Monad's 10 MON reserve", () => {
  it("is ten MON, which is the protocol's number and not ours", () => {
    expect(MONAD_RESERVE_WEI).toBe(10n * 10n ** 18n);
  });
});

describe("what a trade leaves behind", () => {
  it("is fine when the balance stays above the reserve", () => {
    expect(reserveVerdict({ balance: mon("50"), spend: mon("20"), gas: GAS })).toBe("safe");
  });

  it("warns when the trade would drop the balance under the reserve", () => {
    // Not a refusal: an account that has been quiet for a few blocks may spend anyway, as an
    // "emptying transaction". It is a warning because whether that applies is not knowable here.
    expect(reserveVerdict({ balance: mon("12"), spend: mon("5"), gas: GAS })).toBe("emptying");
  });

  it("warns for an account already under the reserve, where every spend needs the exemption", () => {
    expect(reserveVerdict({ balance: mon("3"), spend: mon("1"), gas: GAS })).toBe("emptying");
  });

  it("refuses a spend the balance cannot cover once gas is reserved", () => {
    expect(reserveVerdict({ balance: mon("1"), spend: mon("1"), gas: GAS })).toBe("insufficient");
  });

  it("treats the boundary as safe, because the rule is a strict dip below", () => {
    // Ending exactly on the reserve does not dip below it.
    const balance = MONAD_RESERVE_WEI + GAS + mon("1");
    expect(reserveVerdict({ balance, spend: mon("1"), gas: GAS })).toBe("safe");
    expect(reserveVerdict({ balance, spend: mon("1") + 1n, gas: GAS })).toBe("emptying");
  });

  it("says nothing about a zero trade", () => {
    expect(reserveVerdict({ balance: mon("1"), spend: 0n, gas: GAS })).toBe("safe");
  });
});

describe("the largest amount a max button should offer", () => {
  it("stops at the reserve when the balance is comfortably above it", () => {
    // 50 MON: spend 50 - 10 - gas, so the trade lands with no caveat at all.
    expect(maxNativeSpend({ balance: mon("50"), gas: GAS })).toBe(
      mon("50") - MONAD_RESERVE_WEI - GAS
    );
  });

  it("offers the whole balance less gas when the reserve is already unreachable", () => {
    // Under 10 MON every spend needs the emptying exemption, so withholding the reserve would
    // withhold everything and the button would offer zero on an account that can in fact trade.
    expect(maxNativeSpend({ balance: mon("4"), gas: GAS })).toBe(mon("4") - GAS);
  });

  it("never offers more than the balance, or a negative amount", () => {
    expect(maxNativeSpend({ balance: GAS, gas: GAS })).toBe(0n);
    expect(maxNativeSpend({ balance: mon("0.001"), gas: GAS })).toBe(0n);
    expect(maxNativeSpend({ balance: 0n, gas: GAS })).toBe(0n);
  });

  it("does not fall off a cliff either side of the reserve", () => {
    // Just above the threshold the safe amount is small; just below, the emptying amount is larger.
    // Both are legitimate; what matters is that neither is negative and neither exceeds the balance.
    for (const b of ["9.9", "10", "10.1", "10.06", "11"]) {
      const balance = mon(b);
      const max = maxNativeSpend({ balance, gas: GAS });
      expect(max).toBeGreaterThanOrEqual(0n);
      expect(max + GAS).toBeLessThanOrEqual(balance);
    }
  });

  it("leaves the old 0.01 MON headroom far behind, which is what reverted", () => {
    // A curve buy measured 131k gas on mainnet; at a 200 gwei max fee that reserves 0.026 MON,
    // more than the constant the max button used to withhold.
    expect(GAS).toBeGreaterThan(mon("0.026"));
  });
});

describe("explaining a reserve violation after the fact", () => {
  /*
   * The panel warns before the wallet opens, but the exemption depends on what this wallet did in
   * the last second, so a trade can still be refused. When it is, the raw text is "reserve balance
   * violation", which explains nothing to a trader and names a rule most have never heard of.
   */
  const cases = [
    "reserve balance violation",
    "Reserve Balance Violation",
    "execution reverted: reserve balance violation",
  ];

  it.each(cases)("recognises %p", (text) => {
    const described = describeTxError({ shortMessage: text });
    expect(described.kind).toBe("reserve");
    expect(described.message).toMatch(/10 MON/);
  });

  it("still reads a user rejection as a rejection, not a failure", () => {
    expect(describeTxError({ name: "UserRejectedRequestError" }).kind).toBe("rejected");
  });

  it("leaves an ordinary revert alone, so its reason still reaches the trader", () => {
    const described = describeTxError({ shortMessage: "execution reverted: InsufficientOutput" });
    expect(described.kind).toBe("reverted");
    expect(described.message).toContain("InsufficientOutput");
  });
});
