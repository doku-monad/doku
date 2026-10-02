/**
 * @jest-environment node
 */
import { parseEther } from "viem";

import { MONAD_RESERVE_WEI } from "../../src/lib/chain/monad-reserve";
import {
  LAUNCH_GAS_HEADROOM,
  launchAffordability,
  SWAP_GAS_HEADROOM,
} from "../../src/lib/launch/cost";
import {
  devBuyPlan,
  devBuySwapBounds,
  launchPayWithOptions,
  monShareOfBalance,
  quoteShareOfBalance,
  trimAmount,
} from "../../src/lib/launch/pay-with";

const asset = (
  over: Partial<{ id: string; symbol: string; decimals: number; address: `0x${string}` | null }>
) => ({
  id: "usdc",
  symbol: "USDC",
  name: "USD Coin",
  kind: "stablecoin" as const,
  status: "live" as const,
  decimals: 6,
  address: "0x754704bc059f8c67012fed69bc8a327a5aafb603" as `0x${string}` | null,
  blurb: "",
  ...over,
});

describe("whether the launch form offers to pay a dev buy in MON", () => {
  it("offers it on a pair priced in something else", () => {
    expect(launchPayWithOptions(asset({}))).toEqual(["quote", "native"]);
  });

  /**
   * The case the user asked to be left alone: a MON pair already costs one signature and must keep
   * costing one. There is nothing to swap, so offering the choice would add a step that buys
   * nothing.
   */
  it("never offers it on a MON pair", () => {
    expect(
      launchPayWithOptions(
        asset({
          id: "mon",
          symbol: "MON",
          decimals: 18,
          address: "0x0000000000000000000000000000000000000000",
        })
      )
    ).toEqual(["quote"]);
  });

  it("never offers it for an asset with no pool anywhere on the chain", () => {
    expect(
      launchPayWithOptions(asset({ address: "0xdead00000000000000000000000000000000dead" }))
    ).toEqual(["quote"]);
  });

  it("never offers it for a catalogued asset that is not deployed", () => {
    expect(launchPayWithOptions(asset({ address: null }))).toEqual(["quote"]);
  });

  it("offers nothing at all before a pair is chosen", () => {
    expect(launchPayWithOptions(null)).toEqual(["quote"]);
  });
});

describe("what the dev buy shows while it is being priced in MON", () => {
  const READY = {
    amountIn: 5_000n * 10n ** 18n,
    quoting: false,
    route: { amountOut: 128_400_000n, impactBps: 40 },
    slippageBps: 100,
    quoteSymbol: "USDC",
  };

  it("is idle before anything is typed", () => {
    expect(devBuyPlan({ ...READY, amountIn: 0n }).kind).toBe("idle");
  });

  it("is quoting while the route is in flight", () => {
    expect(devBuyPlan({ ...READY, route: undefined }).kind).toBe("quoting");
    expect(devBuyPlan({ ...READY, quoting: true }).kind).toBe("quoting");
  });

  it("names the pair's own asset when no route is deep enough", () => {
    const plan = devBuyPlan({ ...READY, route: null });
    if (plan.kind !== "unavailable") throw new Error("expected unavailable");
    expect(plan.message).toContain("USDC");
  });

  it("reports what the swap buys and the floor it is bounded by", () => {
    const plan = devBuyPlan(READY);
    if (plan.kind !== "ready") throw new Error("expected ready");
    expect(plan.quoteOut).toBe(128_400_000n);
    expect(plan.minQuoteOut).toBe((128_400_000n * 9900n) / 10_000n);
    expect(plan.impactBps).toBe(40);
  });

  it("clamps a tolerance the write path would throw on", () => {
    // The slippage setting reaches 100% from storage and `applySlippage` throws above 50%. This
    // runs during render, so an unclamped value replaces the launch form with an error boundary.
    const bounds = devBuySwapBounds(1_000_000n, 10_000);
    expect(bounds).toBeGreaterThanOrEqual(0n);
  });
});

describe("spending a share of a MON balance", () => {
  /**
   * The presets are a percentage of what the launcher HOLDS, and paying in MON is the first time
   * the form knows that number for a non-MON pair — this app cannot read an ERC-20 balance, so a
   * USDC pair could only ever say "connect a wallet".
   */
  it("takes a percentage of what is SPENDABLE, not of the whole balance", () => {
    // 100 MON held, less the chain's 10 MON reserve and the headroom the launch that follows needs:
    // the launch's own gas, the swap's, and a tenth of a MON of margin. Applying the percentage to
    // the raw balance would make the 100% preset offer an amount that cannot be signed, which is
    // the one figure on this row that has to be correct.
    const spendable =
      100n * 10n ** 18n - MONAD_RESERVE_WEI - LAUNCH_GAS_HEADROOM - SWAP_GAS_HEADROOM - 10n ** 17n;
    expect(monShareOfBalance(100n * 10n ** 18n, 25)).toBe(trimAmount(spendable / 4n, 18));
  });

  /**
   * The ceiling and the check have to agree, and the only way to guarantee that is to derive one
   * from the other's inputs.
   *
   * This is the bug that keeps coming back: the presets were computed against one figure and the
   * launch button against another, so the key marked "all of it" filled the field with an amount
   * the button then refused. Adding the swap's gas to `launchAffordability` would have reopened it
   * against a flat one-MON headroom — 100% would leave 9.98 MON behind and Monad's floor is ten.
   */
  it("leaves enough behind that the 100% key produces a launch that clears the reserve", () => {
    const held = 250n * 10n ** 18n;
    const fee = 10n * 10n ** 18n;
    const all = monShareOfBalance(held, 100, fee);
    const verdict = launchAffordability({
      balance: held,
      launchFee: fee,
      nativeFirstBuy: parseEther(all as `${number}`),
      swapFirst: true,
    });
    expect(verdict.verdict).toBe("safe");
    expect(verdict.blockedReason).toBeNull();
  });

  it("keeps the reserve out of it, because a launch that ends below 10 MON reverts", () => {
    // 12 MON held, 100% asked for: only what is above the reserve can be spent.
    expect(Number(monShareOfBalance(12n * 10n ** 18n, 100))).toBeLessThanOrEqual(2);
  });

  it("is empty when there is nothing spendable", () => {
    expect(monShareOfBalance(9n * 10n ** 18n, 50)).toBe("");
    expect(monShareOfBalance(undefined, 50)).toBe("");
  });
});

/**
 * The pair's own asset, which the form could not previously take a percentage of at all.
 *
 * Nothing comes off a token balance, and that is the whole difference from the MON row above: the
 * fee, the gas and Monad's reserve are claims on a balance this buy does not touch, so `100%` here
 * really is all of it.
 */
describe("spending a share of the pair's own asset", () => {
  const USDC = 6;

  it("offers the whole balance, because nothing else is spending it", () => {
    expect(quoteShareOfBalance(1_000_000_000n, 100, USDC)).toBe("1000");
    expect(quoteShareOfBalance(1_000_000_000n, 25, USDC)).toBe("250");
  });

  it("reads a balance at the asset's own decimals and not at eighteen", () => {
    // 0.05 cbBTC at eight decimals. Scaled as if it were MON this is dust, and a launcher would be
    // shown a dev-buy ceiling twelve orders of magnitude out.
    expect(quoteShareOfBalance(5_000_000n, 100, 8)).toBe("0.05");
  });

  it("says nothing at all when the balance has not been read", () => {
    expect(quoteShareOfBalance(undefined, 50, USDC)).toBe("");
  });

  /**
   * Floored, never rounded — the property the 100% key depends on.
   *
   * `toFixed` rounds half up, so formatting a whole balance can produce a figure a hair ABOVE it:
   * the key that means "all of it" then lights the over-limit warning and asks the wallet for money
   * it does not have.
   */
  it("never rounds a share up past the balance it is a share of", () => {
    const held = 123_456_789n; // 123.456789 USDC
    const all = quoteShareOfBalance(held, 100, USDC);
    expect(Number(all) * 10 ** USDC).toBeLessThanOrEqual(Number(held));
  });

  it("keeps enough decimals for an asset a whole unit of which is worth a house", () => {
    // 0.00034 cbBTC. Four decimal places would round this to nothing.
    expect(trimAmount(34_000n, 8)).toBe("0.00034");
  });
});
