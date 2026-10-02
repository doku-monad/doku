/**
 * @jest-environment node
 */
import { tradeFeeSentence } from "../../src/lib/launch/fee-sentence";

/**
 * The market page's "Fees" tooltip said, on any market with no creator tax, "Every trade pays 1% to
 * the protocol. This coin's creator takes nothing" — including creator-routed markets, where the
 * creator takes 0.7% of every trade and the protocol keeps 0.3%.
 */
describe("tradeFeeSentence", () => {
  it("names the creator as the recipient of the 0.7% on a creator-routed market", () => {
    expect(tradeFeeSentence({ feeRouting: "creator", creatorFeePct: 0 })).toBe(
      "Every trade, buy or sell, pays 1%: 0.3% to the protocol and 0.7% to this coin's creator.",
    );
  });

  it("names the holders, and the burn, where that is where it goes", () => {
    expect(tradeFeeSentence({ feeRouting: "holders", creatorFeePct: 0 })).toBe(
      "Every trade, buy or sell, pays 1%: 0.3% to the protocol and 0.7% to this coin's holders as dividends.",
    );
    expect(tradeFeeSentence({ feeRouting: "buyback", creatorFeePct: 0 })).toBe(
      "Every trade, buy or sell, pays 1%: 0.3% to the protocol and 0.7% to burning this coin.",
    );
  });

  it("adds the creator tax on top, as the creator's", () => {
    expect(tradeFeeSentence({ feeRouting: "holders", creatorFeePct: 2 })).toBe(
      "Every trade, buy or sell, pays 3%: 0.3% to the protocol, 0.7% to this coin's holders as dividends, and a 2% tax to this coin's creator.",
    );
    expect(tradeFeeSentence({ feeRouting: "creator", creatorFeePct: 2.5 })).toBe(
      "Every trade, buy or sell, pays 3.5%: 0.3% to the protocol, 0.7% to this coin's creator, and a 2.5% tax to this coin's creator.",
    );
  });

  it("does not guess a recipient it has not been told", () => {
    expect(tradeFeeSentence({ feeRouting: null, creatorFeePct: 0 })).toBe(
      "Every trade, buy or sell, pays 1%: 0.3% to the protocol and 0.7% to where this coin's creator routed it.",
    );
  });
});
