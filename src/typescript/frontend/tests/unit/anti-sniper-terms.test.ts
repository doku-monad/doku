/**
 * @jest-environment node
 */
import { antiSniperLabel } from "../../src/lib/launch/anti-sniper";

/**
 * The launch form said "50% → 0% over 5 min" as a hard-coded string while the factory on mainnet
 * held 50% over THREE SECONDS — a hundredfold wrong, on the one number a first-minute buyer needs.
 * The terms are a Safe-owned launch parameter (`DokuFactory.taxTerms`), so the form reads them and
 * this says what they mean.
 */
describe("antiSniperLabel", () => {
  it("describes the live terms: a clock, fifty percent, three seconds", () => {
    expect(antiSniperLabel({ startBps: 5000, window: 3, mode: 0 })).toBe("50% → 0% over 3 s, buys only, burned");
  });

  it("speaks in the unit the window is in", () => {
    expect(antiSniperLabel({ startBps: 5000, window: 300, mode: 0 })).toBe("50% → 0% over 5 min, buys only, burned");
    expect(antiSniperLabel({ startBps: 2500, window: 90, mode: 0 })).toBe("25% → 0% over 90 s, buys only, burned");
    expect(antiSniperLabel({ startBps: 1250, window: 3600, mode: 0 })).toBe("12.5% → 0% over 1 h, buys only, burned");
  });

  it("describes a tax that falls with the raise, and one that takes the larger of the two", () => {
    expect(antiSniperLabel({ startBps: 5000, window: 0, mode: 1 })).toBe("50% → 0% as the curve fills, buys only, burned");
    expect(antiSniperLabel({ startBps: 5000, window: 300, mode: 2 })).toBe(
      "50% → 0% over 5 min or as the curve fills, whichever is higher, buys only, burned",
    );
  });

  it("says a MAX tax with a zero window falls with the raise, because that is what the contract does", () => {
    // V12 finding #283327 (2026-09-20): `TaxMath.rate(MAX, start, 0, …)` is exactly PROGRESS —
    // the clock term is zero and the progress term is not — while one NatSpec line says a zero
    // window "switches the tax off". Whatever the comment says, a buyer must be told the truth.
    expect(antiSniperLabel({ startBps: 5000, window: 0, mode: 2 })).toBe("50% → 0% as the curve fills, buys only, burned");
  });

  it("says there is none when the terms disable it", () => {
    expect(antiSniperLabel({ startBps: 0, window: 300, mode: 0 })).toBe("None");
    // A zero window disables the clock (TaxMath._clock), so a CLOCK tax with no window is no tax.
    expect(antiSniperLabel({ startBps: 5000, window: 0, mode: 0 })).toBe("None");
  });

  it("does not invent terms it has not read", () => {
    expect(antiSniperLabel(undefined)).toBe("Reading…");
  });
});
