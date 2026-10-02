/**
 * @jest-environment node
 */
import { pruneFlashes, recordFlash, type TradeFlash } from "../../src/lib/trade-flash";

/**
 * The green/red pulse a card gives when a trade lands on it.
 *
 * Feedback, not data — so it has to expire on its own. A flash that outlives its trade is worse
 * than no flash: a card glowing green minutes after the buy tells a lie about what is happening
 * right now, and a page left open would end up with every card lit.
 */
describe("trade flashes", () => {
  const now = 1_000_000;

  it("records the direction against the market", () => {
    const flashes = recordFlash({}, "0xabc", true, now);
    expect(flashes["0xabc"]).toEqual({ isBuy: true, at: now });
  });

  /// The newest trade wins: a sell straight after a buy should turn the card red, not stay green.
  it("replaces an earlier flash on the same market", () => {
    let flashes: Record<string, TradeFlash> = recordFlash({}, "0xabc", true, now);
    flashes = recordFlash(flashes, "0xabc", false, now + 100);
    expect(flashes["0xabc"]).toEqual({ isBuy: false, at: now + 100 });
  });

  it("keeps markets apart", () => {
    let flashes = recordFlash({}, "0xabc", true, now);
    flashes = recordFlash(flashes, "0xdef", false, now);
    expect(Object.keys(flashes).sort()).toEqual(["0xabc", "0xdef"]);
  });

  it("drops a flash once it has run its course", () => {
    const flashes = recordFlash({}, "0xabc", true, now);
    expect(pruneFlashes(flashes, now + 1_000)).toEqual(flashes);
    expect(pruneFlashes(flashes, now + 10_000)).toEqual({});
  });

  it("keeps the fresh ones while dropping the stale", () => {
    let flashes = recordFlash({}, "0xold", true, now);
    flashes = recordFlash(flashes, "0xnew", true, now + 5_000);
    expect(Object.keys(pruneFlashes(flashes, now + 5_500))).toEqual(["0xnew"]);
  });

  /// Pruning nothing must not hand back a new object, or React re-renders the grid on every tick.
  it("returns the same object when nothing expired", () => {
    const flashes = recordFlash({}, "0xabc", true, now);
    expect(pruneFlashes(flashes, now + 500)).toBe(flashes);
  });
});
