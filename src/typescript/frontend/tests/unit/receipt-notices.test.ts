/**
 * @jest-environment node
 */
import { receiptNotices } from "../../src/lib/chain/receipt-notices";

/**
 * The swap receipt shows what arrives and the floor it may not fall through, and deliberately no
 * rows of machinery. Two charges pass the panel's own test for a sentence — they change what the
 * next click should be — and neither was shown: the anti-sniper tax (up to half of a buy, computed
 * by the quote and dropped on the floor, and avoided by waiting a few seconds) and a creator tax
 * (a third party's charge of up to 10% each way).
 */
describe("receiptNotices", () => {
  const MON = 10n ** 18n;

  it("says what share of a buy the anti-sniper tax is taking", () => {
    expect(receiptNotices({ isSell: false, antiSniperTax: 33n * MON, curveInput: 100n * MON, creatorFeePct: 0 })).toEqual({
      antiSniperPct: 33,
      creatorTaxPct: null,
    });
    expect(receiptNotices({ isSell: false, antiSniperTax: 1n * MON, curveInput: 800n * MON, creatorFeePct: 0 }).antiSniperPct).toBe(0.13);
  });

  it("never claims an anti-sniper tax on a sell, on a zero input, or when the quote carries none", () => {
    expect(receiptNotices({ isSell: true, antiSniperTax: 5n, curveInput: 10n, creatorFeePct: 0 }).antiSniperPct).toBeNull();
    expect(receiptNotices({ isSell: false, antiSniperTax: 5n, curveInput: 0n, creatorFeePct: 0 }).antiSniperPct).toBeNull();
    expect(receiptNotices({ isSell: false, antiSniperTax: 0n, curveInput: 10n, creatorFeePct: 0 }).antiSniperPct).toBeNull();
  });

  it("shows a share too small for two decimals as present, not as zero", () => {
    expect(receiptNotices({ isSell: false, antiSniperTax: 1n, curveInput: 10n ** 9n, creatorFeePct: 0 }).antiSniperPct).toBe(0.01);
  });

  it("names a creator tax on buys and on sells alike, and only where there is one", () => {
    expect(receiptNotices({ isSell: false, antiSniperTax: 0n, curveInput: 1n, creatorFeePct: 2.5 }).creatorTaxPct).toBe(2.5);
    expect(receiptNotices({ isSell: true, antiSniperTax: 0n, curveInput: 1n, creatorFeePct: 10 }).creatorTaxPct).toBe(10);
    expect(receiptNotices({ isSell: true, antiSniperTax: 0n, curveInput: 1n, creatorFeePct: 0 }).creatorTaxPct).toBeNull();
  });
});
