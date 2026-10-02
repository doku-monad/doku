/**
 * @jest-environment node
 */
import { minimumOut } from "../../src/lib/chain/writes";
import {
  getMaxSlippageSettings,
  MAX_UI_SLIPPAGE_BPS,
  MIN_SLIPPAGE_BPS,
  setMaxSlippage,
} from "../../src/utils/slippage";

/**
 * The floor a trade is signed with, and the one place it can still be zero.
 *
 * `applySlippage` refuses above 50% and the slippage box now offers 0.1% to 5%, so the tolerance
 * looks bounded from both ends. It is not: the value lives in `localStorage` between visits, an
 * older build wrote anything up to 10,000 bps there, and the panel's own floor was computed from
 * that stored number directly rather than from the clamped one the zap uses. A returning wallet
 * carrying `maxSlippage=10000` therefore signed `minBaseOut = 0` on every curve and pool trade —
 * silently, with the box showing "100" and the receipt showing a minimum of zero, which is a
 * standing offer to be sandwiched for the entire trade.
 */

/** A `localStorage` that exists only for the length of one test. */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

function withStorage(initial: Record<string, string>, run: () => void) {
  const g = globalThis as Record<string, unknown>;
  const hadWindow = "window" in g;
  const previousWindow = g.window;
  const previousStorage = g.localStorage;
  const storage = fakeStorage(initial);
  g.localStorage = storage;
  g.window = { localStorage: storage };
  try {
    run();
  } finally {
    if (hadWindow) g.window = previousWindow;
    else delete g.window;
    g.localStorage = previousStorage;
  }
}

const CUSTOM = { maxSlippageMode: "custom" };

describe("the tolerance that comes back from localStorage", () => {
  it("passes a setting the box can express straight through", () => {
    withStorage({ ...CUSTOM, maxSlippage: "300" }, () => {
      expect(getMaxSlippageSettings().maxSlippage).toBe(300n);
    });
  });

  /**
   * The stale-storage case. 10,000 bps was writable by an older build and is not reachable from
   * today's control at all, so showing it in a box whose maximum is 5 makes the box a lie about
   * what will be signed.
   */
  it("clamps a stale hundred-percent setting to what the control can offer", () => {
    withStorage({ ...CUSTOM, maxSlippage: "10000" }, () => {
      expect(getMaxSlippageSettings().maxSlippage).toBe(MAX_UI_SLIPPAGE_BPS);
    });
  });

  it("lifts a zero tolerance to the floor, where an ordinary fill can still land", () => {
    withStorage({ ...CUSTOM, maxSlippage: "0" }, () => {
      expect(getMaxSlippageSettings().maxSlippage).toBe(MIN_SLIPPAGE_BPS);
    });
  });

  /**
   * `BigInt("5.5")` throws, and this runs while the market page renders — so garbage in storage
   * took the whole page to an error boundary rather than the trade to a default.
   */
  it("falls back to the default rather than throwing on a value that is not an integer", () => {
    for (const junk of ["5.5", "abc", "", "-100", "1e3"]) {
      withStorage({ ...CUSTOM, maxSlippage: junk }, () => {
        expect(() => getMaxSlippageSettings()).not.toThrow();
        const { maxSlippage } = getMaxSlippageSettings();
        expect(maxSlippage).toBeGreaterThanOrEqual(MIN_SLIPPAGE_BPS);
        expect(maxSlippage).toBeLessThanOrEqual(MAX_UI_SLIPPAGE_BPS);
      });
    }
  });

  it("refuses to persist a tolerance wider than the control offers", () => {
    withStorage({ ...CUSTOM }, () => {
      setMaxSlippage(10_000n);
      expect(getMaxSlippageSettings().maxSlippage).toBeLessThanOrEqual(MAX_UI_SLIPPAGE_BPS);
    });
  });
});

describe("the floor the trade is actually signed with", () => {
  const quoted = 8_810_322_202_371_741_196_291n;

  it("takes the tolerance off the quote", () => {
    expect(minimumOut(quoted, 100n)).toBe((quoted * 9_900n) / 10_000n);
  });

  /**
   * The property that matters, stated as one: no setting that can reach this function — from the
   * box, from storage, from an older build — may produce a floor of zero for a non-zero quote.
   * Zero is not a wide tolerance, it is the absence of one.
   */
  it("never returns a zero floor for a quote worth something", () => {
    for (const setting of [0n, 1n, 500n, 5_000n, 9_999n, 10_000n, 1_000_000n]) {
      expect(minimumOut(quoted, setting)).toBeGreaterThan(0n);
    }
  });

  it("still floors an empty quote at zero, because there is nothing to protect", () => {
    expect(minimumOut(0n, 100n)).toBe(0n);
  });

  it("never rounds a floor up past what the trade can deliver", () => {
    expect(minimumOut(3n, 1n)).toBeLessThanOrEqual(3n);
  });

  it("agrees with the clamp the zap already applied, so the two paths sign the same floor", () => {
    expect(minimumOut(quoted, 10_000n)).toBe(minimumOut(quoted, MAX_UI_SLIPPAGE_BPS));
  });
});
