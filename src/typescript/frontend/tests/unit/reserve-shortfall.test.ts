/**
 * @jest-environment node
 */

/**
 * The amount to add, which is the only part of the reserve rule anyone can act on.
 *
 * Both surfaces say it now — the trade panel's warning and the launch form's blocked button — and
 * they say it from this one function, so a chain rule cannot end up described two different ways in
 * two places.
 */
import { MONAD_RESERVE_WEI, reserveShortfall } from "../../src/lib/chain/monad-reserve";

const mon = (n: string) => BigInt(Math.round(Number(n) * 1e6)) * 10n ** 12n;

describe("what to add to clear Monad's reserve", () => {
  it("is nothing when the trade already clears it", () => {
    expect(reserveShortfall({ balance: mon("40"), spend: mon("10"), gas: mon("0.12") })).toBe(0n);
  });

  it("is measured to the reserve, not to the spend", () => {
    // 15 held, 10 spent, 0.12 gas: 10 + 0.12 + 10 reserve = 20.12 needed, so 5.12 short.
    expect(reserveShortfall({ balance: mon("15"), spend: mon("10"), gas: mon("0.12") })).toBe(
      mon("5.12")
    );
  });

  it("never goes negative, so a caller can treat zero as nothing to say", () => {
    expect(reserveShortfall({ balance: mon("1000"), spend: 1n, gas: 1n })).toBe(0n);
  });

  it("counts the gas, because the reserve is checked after it is paid", () => {
    const withoutGas = reserveShortfall({ balance: mon("15"), spend: mon("10"), gas: 0n });
    const withGas = reserveShortfall({ balance: mon("15"), spend: mon("10"), gas: mon("1") });
    expect(withGas - withoutGas).toBe(mon("1"));
  });

  it("agrees with the reserve constant it is derived from", () => {
    // A wallet holding exactly the reserve, spending nothing, needs exactly its spend back.
    expect(reserveShortfall({ balance: MONAD_RESERVE_WEI, spend: mon("3"), gas: 0n })).toBe(
      mon("3")
    );
  });
});
