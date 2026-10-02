/**
 * @jest-environment node
 */
import {
  decodeSellTooLarge,
  decodeZapTooLarge,
  describeZapError,
  formatImpactBps,
  formatMonAmount,
  impactSeverity,
  poolSellZapPlan,
  poolZapPlan,
  restateAmount,
  routeLabels,
  sellZapPlan,
  sideAssetOptions,
  zapBounds,
  zapPlan,
  zapSlippageBps,
} from "../../src/lib/chain/zap-plan";
import { candidateRoutes } from "../../src/lib/chain/zap-routes";

const USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603";
const WBTC = "0x0555e30da8f98308edb960aa94c0db47230d2b9c";
const NATIVE = "0x0000000000000000000000000000000000000000";
const GOLD = "0x01bff41798a0bcf287b996046ca68b395dbc1071";

/** The shape the panel is in when a market is mid-trade on a live curve and nothing is wrong. */
const OFFERABLE = {
  routerConfigured: true,
  quoteAsset: USDC,
  isSell: false,
  venue: "curve" as const,
  venueKnown: true,
};

describe("whether trading in MON is offered at all", () => {
  it("is ABSENT with no router configured — the state this ships in", () => {
    // Not disabled and not erroring. There is no contract behind it, so there is nothing to
    // explain to somebody who works out how to enable the control.
    expect(sideAssetOptions({ ...OFFERABLE, routerConfigured: false })).toEqual(["quote"]);
  });

  it("offers the market's own asset in every single case, including that one", () => {
    const cases = [
      OFFERABLE,
      { ...OFFERABLE, routerConfigured: false },
      { ...OFFERABLE, isSell: true },
      { ...OFFERABLE, quoteAsset: NATIVE },
      { ...OFFERABLE, venue: "pool" as const },
      { ...OFFERABLE, venue: "pool" as const, routerConfigured: false },
    ];
    for (const input of cases) expect(sideAssetOptions(input)[0]).toBe("quote");
  });

  it("offers MON on a live curve priced in something else", () => {
    expect(sideAssetOptions(OFFERABLE)).toEqual(["quote", "native"]);
  });

  it("never offers MON on a market already priced in MON", () => {
    // There is nothing to swap, and the router reverts `NativeQuoteNeedsNoZap()` rather than
    // quietly ignoring the path and the bound that came with it.
    expect(sideAssetOptions({ ...OFFERABLE, quoteAsset: NATIVE })).toEqual(["quote"]);
  });

  it("offers MON on a SELL too, now that there is a road back out", () => {
    // The direction used to be a gate of its own, returning `["quote"]` before anything else was
    // looked at. It is not one any more: the curve sells into its quote asset and `sellRoutes`
    // carries that on to MON, which is the buy path run backwards.
    expect(sideAssetOptions({ ...OFFERABLE, isSell: true })).toEqual(["quote", "native"]);
  });

  it("asks the route graph in the DIRECTION being traded", () => {
    // Both walks are empty for a MON market and for an asset with no pool, and the gate has to
    // hold on a sell for the same reasons it holds on a buy — from the other end of the graph.
    const SELL = { ...OFFERABLE, isSell: true };
    expect(sideAssetOptions({ ...SELL, quoteAsset: NATIVE })).toEqual(["quote"]);
    expect(
      sideAssetOptions({ ...SELL, quoteAsset: "0xdead00000000000000000000000000000000dead" })
    ).toEqual(["quote"]);
    expect(sideAssetOptions({ ...SELL, venueKnown: false })).toEqual(["quote"]);
    expect(sideAssetOptions({ ...SELL, routerConfigured: false })).toEqual(["quote"]);
  });

  it("keeps offering MON once the market has graduated, by a different road", () => {
    // The ZAP ROUTER cannot serve this one: it buys through `BondingCurve.buyWithToken`, and a
    // graduated curve is closed for good. But the market's pool is an ordinary v4 pool, so the
    // same trade is one multi-hop swap through the UniversalRouter. See the pool block below.
    expect(sideAssetOptions({ ...OFFERABLE, venue: "pool" })).toEqual(["quote", "native"]);
  });

  it("waits rather than offering a choice it may have to withdraw", () => {
    // `venueKnown` is false while the curve's own `readyToGraduate` read is in flight. Offering
    // MON and removing it under the pointer is worse than showing it a moment later.
    expect(sideAssetOptions({ ...OFFERABLE, venueKnown: false })).toEqual(["quote"]);
  });

  it("never offers MON for an asset with no pool anywhere on the chain", () => {
    expect(
      sideAssetOptions({ ...OFFERABLE, quoteAsset: "0xdead00000000000000000000000000000000dead" })
    ).toEqual(["quote"]);
  });
  it("never offers MON on a gold market, buying or selling, on the curve or in the pool", () => {
    // Gold markets trade in gold only; MON reached them through two pools that collapse at size.
    // Mixed-case too, because the registry spells addresses however it likes.
    for (const quoteAsset of [GOLD, GOLD.toUpperCase().replace("0X", "0x")]) {
      for (const isSell of [false, true]) {
        for (const venue of ["curve", "pool"] as const) {
          expect(sideAssetOptions({ ...OFFERABLE, quoteAsset, isSell, venue })).toEqual(["quote"]);
        }
      }
    }
  });
});

describe("the two slippage floors", () => {
  it("puts each floor its own tolerance below its own quote", () => {
    const bounds = zapBounds({ quoteOut: 1_000_000n, baseOut: 2_000n, slippageBps: 100 });
    expect(bounds).toEqual({ minQuoteOut: 990_000n, minBaseOut: 1_980n });
  });

  it("holds the trader to exactly what they were quoted at zero tolerance", () => {
    expect(zapBounds({ quoteOut: 7n, baseOut: 9n, slippageBps: 0 })).toEqual({
      minQuoteOut: 7n,
      minBaseOut: 9n,
    });
  });

  it("refuses a tolerance wide enough to be a standing offer to be sandwiched", () => {
    // `applySlippage` owns that limit; this asserts the zap did not route around it.
    expect(() => zapBounds({ quoteOut: 10n, baseOut: 10n, slippageBps: 9_000 })).toThrow();
  });
});

describe("what the panel shows while somebody types", () => {
  const base = {
    amountIn: 10n ** 18n,
    quoting: false,
    route: { amountOut: 1_000_000n, impactBps: 12 },
    baseOut: 5_000n * 10n ** 18n,
    slippageBps: 100,
    maximum: 0n,
    quoteSymbol: "USDC",
  };

  it("says nothing at all before an amount is entered", () => {
    expect(zapPlan({ ...base, amountIn: 0n }).kind).toBe("idle");
  });

  it("shows a measured route with both floors on it", () => {
    const plan = zapPlan(base);
    expect(plan).toEqual({
      kind: "ready",
      quoteOut: 1_000_000n,
      baseOut: 5_000n * 10n ** 18n,
      minQuoteOut: 990_000n,
      minBaseOut: 4_950n * 10n ** 18n,
      impactBps: 12,
    });
  });

  it("does not accuse the pools of being thin before it has asked them", () => {
    // `undefined` is "not answered yet" and `null` is "answered, and the answer is no". Collapsing
    // them flashes the refusal message on every keystroke.
    expect(zapPlan({ ...base, route: undefined }).kind).toBe("quoting");
    expect(zapPlan({ ...base, route: null }).kind).toBe("unavailable");
  });

  it("keeps quoting until the curve has answered too", () => {
    expect(zapPlan({ ...base, baseOut: undefined }).kind).toBe("quoting");
  });

  it("holds the last state while the debounce is pending", () => {
    expect(zapPlan({ ...base, quoting: true }).kind).toBe("quoting");
  });

  it("says plainly that MON cannot be used, and names what can", () => {
    const plan = zapPlan({ ...base, route: null });
    if (plan.kind !== "unavailable") throw new Error(`expected unavailable, got ${plan.kind}`);
    // The whole requirement: not a broken quote, not a dead button, but the alternative in words.
    expect(plan.message).toContain("USDC");
    expect(plan.message.toLowerCase()).toContain("smaller");
  });

  it("names the ceiling and refuses before the wallet opens", () => {
    const plan = zapPlan({ ...base, amountIn: 26n * 10n ** 18n, maximum: 25n * 10n ** 18n });
    if (plan.kind !== "over-cap") throw new Error(`expected over-cap, got ${plan.kind}`);
    expect(plan.message).toContain("25 MON");
  });

  it("reports the ceiling ahead of the spinner, not after it", () => {
    // Two pieces of news in the right order: an oversized zap is refused by the router before it
    // touches a pool, so quoting one and then rejecting it wastes the trader's attention.
    const plan = zapPlan({
      ...base,
      quoting: true,
      route: undefined,
      amountIn: 26n * 10n ** 18n,
      maximum: 25n * 10n ** 18n,
    });
    expect(plan.kind).toBe("over-cap");
  });

  it("treats a zero ceiling as no ceiling, which is what the contract means by it", () => {
    expect(zapPlan({ ...base, amountIn: 10n ** 30n, maximum: 0n }).kind).toBe("ready");
  });

  it("does not enforce a ceiling it has not read", () => {
    expect(zapPlan({ ...base, amountIn: 10n ** 30n, maximum: undefined }).kind).toBe("ready");
  });

  it("allows a zap of exactly the ceiling", () => {
    // `msg.value > ceiling` reverts on chain; equal does not. Refusing the boundary would refuse a
    // trade the router accepts.
    expect(zapPlan({ ...base, amountIn: 25n * 10n ** 18n, maximum: 25n * 10n ** 18n }).kind).toBe(
      "ready"
    );
  });
});

describe("showing the route", () => {
  const symbols: Record<string, string> = { [USDC]: "USDC", [WBTC]: "WBTC" };
  const symbolOf = (address: string) => symbols[address.toLowerCase()];

  it("names every asset the money passes through, starting at MON", () => {
    const path = candidateRoutes(WBTC).find((p) => p.length === 2 && p[0].to === USDC)!;
    expect(routeLabels(path, symbolOf)).toEqual(["MON", "USDC", "WBTC"]);
  });

  it("falls back to a shortened address for an asset the registry has never heard of", () => {
    const path = candidateRoutes(USDC).find((p) => p.length === 1)!;
    expect(routeLabels(path, () => undefined)).toEqual(["MON", "0x7547…b603"]);
  });

  it("has nothing to draw for an empty route", () => {
    expect(routeLabels([], symbolOf)).toEqual([]);
  });
});

describe("price impact, in a form a human reads", () => {
  it("prints two decimals, because one is the difference between fine and free", () => {
    expect(formatImpactBps(42)).toBe("0.42%");
  });

  it("never claims a route that costs something is free", () => {
    expect(formatImpactBps(0.4)).toBe("<0.01%");
  });

  it("prints an exactly-flat route as zero", () => {
    expect(formatImpactBps(0)).toBe("0.00%");
  });

  it("stays quiet about impacts that are merely normal", () => {
    // Everything reaching here already passed the 300 bps ceiling, so these are gradations of
    // acceptable rather than warnings.
    expect(impactSeverity(12)).toBe("ok");
    expect(impactSeverity(80)).toBe("warn");
    expect(impactSeverity(250)).toBe("high");
  });
});

describe("MON amounts in a sentence", () => {
  it("drops precision nobody chose", () => {
    expect(formatMonAmount(25n * 10n ** 18n)).toBe("25");
  });

  it("keeps a fraction that is really there", () => {
    expect(formatMonAmount(2_500_000_000_000_000_00n)).toBe("0.25");
  });
});

describe("the ceiling revert", () => {
  /** How viem hands back a custom error it decoded itself. */
  const decoded = {
    name: "ContractFunctionExecutionError",
    shortMessage: 'The contract function "zapBuyWithNative" reverted.',
    cause: {
      name: "ContractFunctionRevertedError",
      data: { errorName: "ZapTooLarge", args: [30n * 10n ** 18n, 25n * 10n ** 18n] },
    },
  };

  it("finds the ceiling inside a nested viem error", () => {
    expect(decodeZapTooLarge(decoded)).toEqual({
      offered: 30n * 10n ** 18n,
      maximum: 25n * 10n ** 18n,
    });
  });

  it("also reads it out of a printed message, which is how a node rejection arrives", () => {
    expect(
      decodeZapTooLarge({
        message: "execution reverted",
        metaMessages: ["Error: ZapTooLarge(30000000000000000000, 25000000000000000000)"],
      })
    ).toEqual({ offered: 30n * 10n ** 18n, maximum: 25n * 10n ** 18n });
  });

  it("says what the ceiling is and what to do about it", () => {
    const described = describeZapError(decoded);
    expect(described.message).toBe(
      "This route accepts at most 25 MON in one trade, and this one offered 30. Buy a smaller amount."
    );
  });

  it("leaves Monad's reserve rule to the function that already names it", () => {
    // A zap spends MON, so the 10 MON reserve applies to it exactly as to a native buy. A second
    // implementation here would be a second place for that message to go stale.
    const described = describeZapError({ shortMessage: "reserve balance violation" });
    expect(described.kind).toBe("reserve");
  });

  it("still tells a cancelled transaction from a failed one", () => {
    expect(describeZapError({ name: "UserRejectedRequestError" }).kind).toBe("rejected");
  });

  it("finds no ceiling in an unrelated failure", () => {
    expect(decodeZapTooLarge(new Error("nonce too low"))).toBeNull();
    expect(decodeZapTooLarge(undefined)).toBeNull();
  });
});

describe("the slippage setting, on its way from localStorage to a contract", () => {
  it("passes an ordinary setting through", () => {
    expect(zapSlippageBps(100n)).toBe(100);
  });

  it("clamps a setting the write path would throw on", () => {
    // Storage may still hold 10,000 bps from a build that allowed it, and `applySlippage` refuses
    // a tolerance that wide because 100% is a floor of zero. That throw happens while the panel
    // RENDERS the bounds, so unclamped it would replace the market page with an error boundary.
    // The ceiling is the control's own — 5% — so the box, the row and the floor say one number.
    expect(zapSlippageBps(10_000n)).toBe(500);
  });

  it("never widens a tolerance by rounding it", () => {
    expect(zapSlippageBps(150.9)).toBe(150);
  });

  /**
   * Nonsense lands on the FLOOR, not on zero. Zero is not the narrowest tolerance, it is the
   * absence of one — every fill reverts on the curve's own movement — and the one direction this
   * must never fail in is wider than asked, which the floor is not.
   */
  it("treats nonsense as the narrowest tolerance rather than none", () => {
    expect(zapSlippageBps(-1)).toBe(10);
    expect(zapSlippageBps(Number.NaN)).toBe(10);
  });

  it("produces a tolerance the bounds function accepts, at both ends", () => {
    expect(() =>
      zapBounds({ quoteOut: 10n, baseOut: 10n, slippageBps: zapSlippageBps(10_000n) })
    ).not.toThrow();
  });
});

describe("keeping the typed number when the pay-with asset changes", () => {
  it("re-scales five USDC into five MON rather than five millionths of one", () => {
    expect(restateAmount(5_000_000n, 6, 18)).toBe(5n * 10n ** 18n);
  });

  it("re-scales the other way without inventing units the trader does not have", () => {
    expect(restateAmount(5n * 10n ** 18n, 18, 6)).toBe(5_000_000n);
  });

  it("truncates rather than rounds up when precision has to go", () => {
    // Just under two raw units of a six-decimal asset. Rounding up would offer a raw unit the
    // trader's balance does not contain, which fails at the transfer rather than in the field.
    expect(restateAmount(1_999_999_999_999n, 18, 6)).toBe(1n);
  });

  it("leaves an amount alone between assets of the same scale", () => {
    expect(restateAmount(42n, 18, 18)).toBe(42n);
  });
});

describe("trading in MON on a market that has GRADUATED", () => {
  /**
   * A graduated market has no curve to buy on, so the zap router is not involved at all: the
   * whole trade is one multi-hop swap through Uniswap's own router, MON to the market's quote
   * asset to its token. That means the option survives an unset `NEXT_PUBLIC_ZAP_ROUTER`, which
   * is the one case worth pinning — it is the difference between "no zap contract" and "no way to
   * pay with MON".
   */
  const POOL = { ...OFFERABLE, venue: "pool" as const };

  it("offers MON on a pool market", () => {
    expect(sideAssetOptions(POOL)).toEqual(["quote", "native"]);
  });

  it("offers it even with no zap router configured", () => {
    expect(sideAssetOptions({ ...POOL, routerConfigured: false })).toEqual(["quote", "native"]);
  });

  it("still refuses a MON market and an unreachable asset", () => {
    expect(sideAssetOptions({ ...POOL, quoteAsset: NATIVE })).toEqual(["quote"]);
    expect(
      sideAssetOptions({ ...POOL, quoteAsset: "0xdead00000000000000000000000000000000dead" })
    ).toEqual(["quote"]);
  });

  it("serves a SELL out of a graduated market with no zap router either", () => {
    // One multi-hop swap, token through to MON, and the ZapRouter is nowhere in it — so an unset
    // `NEXT_PUBLIC_ZAP_ROUTER` must not take the option away in this direction either.
    expect(sideAssetOptions({ ...POOL, isSell: true, routerConfigured: false })).toEqual([
      "quote",
      "native",
    ]);
  });

  it("still waits while the venue is unknown", () => {
    expect(sideAssetOptions({ ...POOL, venueKnown: false })).toEqual(["quote"]);
  });

  it("keeps requiring the zap router on a CURVE market", () => {
    expect(sideAssetOptions({ ...OFFERABLE, routerConfigured: false })).toEqual(["quote"]);
  });
});

describe("what the panel shows for a MON buy on a pool market", () => {
  const READY = {
    amountIn: 5n * 10n ** 18n,
    quoting: false,
    route: { amountOut: 43_628n * 10n ** 18n, impactBps: 40 },
    slippageBps: 100,
    quoteSymbol: "cbBTC",
  };

  it("is idle before anything is typed", () => {
    expect(poolZapPlan({ ...READY, amountIn: 0n }).kind).toBe("idle");
  });

  it("is quoting while the route is in flight, and while it is being re-measured", () => {
    expect(poolZapPlan({ ...READY, route: undefined }).kind).toBe("quoting");
    expect(poolZapPlan({ ...READY, quoting: true }).kind).toBe("quoting");
  });

  it("names the market's own asset when no route is deep enough", () => {
    const plan = poolZapPlan({ ...READY, route: null });
    expect(plan.kind).toBe("unavailable");
    if (plan.kind !== "unavailable") throw new Error("unreachable");
    expect(plan.message).toContain("cbBTC");
  });

  it("bounds the trade by the tokens received, which is the only figure the buyer gets", () => {
    const plan = poolZapPlan(READY);
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") throw new Error("unreachable");
    expect(plan.baseOut).toBe(READY.route.amountOut);
    // One floor, not two. There is no second leg to bound: the swap IS the trade.
    expect(plan.minBaseOut).toBe((READY.route.amountOut * 9900n) / 10_000n);
    expect(plan.impactBps).toBe(40);
  });

  it("holds the buyer to exactly the quote at zero tolerance", () => {
    const plan = poolZapPlan({ ...READY, slippageBps: 0 });
    if (plan.kind !== "ready") throw new Error("unreachable");
    expect(plan.minBaseOut).toBe(READY.route.amountOut);
  });

  it("has no ceiling to enforce, because no zap router is in the path", () => {
    // The curve plan refuses above `maxZapValue`. This one cannot: the trade goes through
    // Uniswap's router exactly as an ordinary pool buy does, and inventing a limit here would
    // refuse a trade the chain would have accepted.
    const huge = poolZapPlan({ ...READY, amountIn: 10n ** 24n });
    expect(huge.kind).toBe("ready");
  });
});

describe("what the panel shows for a SELL that pays out in MON", () => {
  /** Selling a thousand eighteen-decimal tokens into a USDC curve, then USDC on to MON. */
  const SELL = {
    amountIn: 1_000n * 10n ** 18n,
    quoting: false,
    route: { amountOut: 5n * 10n ** 18n, impactBps: 18 },
    quoteOut: 1_200_000n,
    slippageBps: 100,
    maximum: 0n,
    quoteSymbol: "USDC",
  };

  it("says nothing at all before an amount is entered", () => {
    expect(sellZapPlan({ ...SELL, amountIn: 0n }).kind).toBe("idle");
  });

  it("shows both floors, each its own tolerance below its own leg", () => {
    expect(sellZapPlan(SELL)).toEqual({
      kind: "ready",
      quoteOut: 1_200_000n,
      nativeOut: 5n * 10n ** 18n,
      minQuoteOut: 1_188_000n,
      minNativeOut: 4_950n * 10n ** 15n,
      impactBps: 18,
    });
  });

  it("holds the seller to exactly what they were quoted at zero tolerance", () => {
    const plan = sellZapPlan({ ...SELL, slippageBps: 0 });
    if (plan.kind !== "ready") throw new Error(`expected ready, got ${plan.kind}`);
    expect(plan.minQuoteOut).toBe(SELL.quoteOut);
    expect(plan.minNativeOut).toBe(SELL.route.amountOut);
  });

  it("does not accuse the pools of being thin before it has asked them", () => {
    expect(sellZapPlan({ ...SELL, route: undefined }).kind).toBe("quoting");
    expect(sellZapPlan({ ...SELL, route: null }).kind).toBe("unavailable");
  });

  it("keeps quoting until the curve has answered too", () => {
    expect(sellZapPlan({ ...SELL, quoteOut: undefined }).kind).toBe("quoting");
  });

  it("holds the last state while the debounce is pending", () => {
    expect(sellZapPlan({ ...SELL, quoting: true }).kind).toBe("quoting");
  });

  it("says the sentence the other way round: what to TAKE, not what to pay with", () => {
    const plan = sellZapPlan({ ...SELL, route: null });
    if (plan.kind !== "unavailable") throw new Error(`expected unavailable, got ${plan.kind}`);
    expect(plan.message).toBe(
      "USDC cannot be swapped into MON for a trade this size — the pools are too thin, and the " +
        "price you would get is not one worth taking. Take USDC instead, or try a smaller amount."
    );
  });

  /**
   * THE unit bug, pinned.
   *
   * `amountIn` is raw units of the market's eighteen-decimal TOKEN and `maximum` is MON wei. A
   * thousand tokens is 1e21 and a twenty-five MON ceiling is 2.5e19, so the buy path's
   * `amountIn > maximum` would refuse this sell — while the MON it actually produces, five, is
   * comfortably under. The ceiling has to be read against the one figure denominated in MON.
   */
  it("measures the ceiling against the MON, not against the tokens sold", () => {
    const plan = sellZapPlan({ ...SELL, maximum: 25n * 10n ** 18n });
    expect(plan.kind).toBe("ready");
  });

  it("still refuses a sell that really would produce too much MON", () => {
    const plan = sellZapPlan({
      ...SELL,
      route: { amountOut: 30n * 10n ** 18n, impactBps: 18 },
      maximum: 25n * 10n ** 18n,
    });
    if (plan.kind !== "over-cap") throw new Error(`expected over-cap, got ${plan.kind}`);
    expect(plan.maximum).toBe(25n * 10n ** 18n);
    expect(plan.message).toContain("25 MON");
    expect(plan.message).toContain("30");
  });

  it("allows a sell that produces exactly the ceiling", () => {
    // `> ceiling` reverts on chain; equal does not. Refusing the boundary would refuse a trade the
    // router accepts.
    const plan = sellZapPlan({
      ...SELL,
      route: { amountOut: 25n * 10n ** 18n, impactBps: 18 },
      maximum: 25n * 10n ** 18n,
    });
    expect(plan.kind).toBe("ready");
  });

  it("waits for the route before mentioning a ceiling, which inverts the buy's order", () => {
    // The buy reports the ceiling AHEAD of the spinner, because there `amountIn` is the MON being
    // spent and the ceiling bounds that same number. Here the ceiling cannot be evaluated at all
    // until the route has said how much MON comes out, so it necessarily comes second.
    expect(sellZapPlan({ ...SELL, route: undefined, maximum: 1n }).kind).toBe("quoting");
    expect(sellZapPlan({ ...SELL, quoting: true, maximum: 1n }).kind).toBe("quoting");
  });

  it("reports the ceiling as soon as the route allows, without waiting for the curve", () => {
    const plan = sellZapPlan({
      ...SELL,
      quoteOut: undefined,
      route: { amountOut: 30n * 10n ** 18n, impactBps: 18 },
      maximum: 25n * 10n ** 18n,
    });
    expect(plan.kind).toBe("over-cap");
  });

  it("treats a zero ceiling as no ceiling, and an unread one as no ceiling either", () => {
    const huge = { amountOut: 10n ** 30n, impactBps: 18 };
    expect(sellZapPlan({ ...SELL, route: huge, maximum: 0n }).kind).toBe("ready");
    expect(sellZapPlan({ ...SELL, route: huge, maximum: undefined }).kind).toBe("ready");
  });
});

describe("what the panel shows for a SELL out of a market that has GRADUATED", () => {
  const READY = {
    amountIn: 1_000n * 10n ** 18n,
    quoting: false,
    route: { amountOut: 5n * 10n ** 18n, impactBps: 40 },
    slippageBps: 100,
    quoteSymbol: "cbBTC",
  };

  it("is idle before anything is typed", () => {
    expect(poolSellZapPlan({ ...READY, amountIn: 0n }).kind).toBe("idle");
  });

  it("is quoting while the route is in flight, and while it is being re-measured", () => {
    expect(poolSellZapPlan({ ...READY, route: undefined }).kind).toBe("quoting");
    expect(poolSellZapPlan({ ...READY, quoting: true }).kind).toBe("quoting");
  });

  it("names the market's own asset when no route is deep enough", () => {
    const plan = poolSellZapPlan({ ...READY, route: null });
    if (plan.kind !== "unavailable") throw new Error(`expected unavailable, got ${plan.kind}`);
    expect(plan.message).toContain("cbBTC");
    expect(plan.message).toContain("Take cbBTC instead");
  });

  it("bounds the trade by the MON received, which is the only figure the seller gets", () => {
    const plan = poolSellZapPlan(READY);
    if (plan.kind !== "ready") throw new Error(`expected ready, got ${plan.kind}`);
    expect(plan.nativeOut).toBe(READY.route.amountOut);
    // One floor, not two. There is no second leg to bound: the swap IS the trade.
    expect(plan.minNativeOut).toBe((READY.route.amountOut * 9900n) / 10_000n);
    expect(plan.impactBps).toBe(40);
  });

  it("holds the seller to exactly the quote at zero tolerance", () => {
    const plan = poolSellZapPlan({ ...READY, slippageBps: 0 });
    if (plan.kind !== "ready") throw new Error(`expected ready, got ${plan.kind}`);
    expect(plan.minNativeOut).toBe(READY.route.amountOut);
  });

  it("has no ceiling to enforce at all, because no zap router is in the path", () => {
    // Not even an `over-cap` state to reach. `maxZapValue` belongs to the ZapRouter, and this trade
    // goes through Uniswap's router exactly as an ordinary pool sell does.
    const huge = poolSellZapPlan({
      ...READY,
      route: { amountOut: 10n ** 30n, impactBps: 40 },
    });
    expect(huge.kind).toBe("ready");
  });
});

describe("the ceiling revert, from the selling end", () => {
  /** How viem hands back a custom error it decoded itself. */
  const decoded = {
    name: "ContractFunctionExecutionError",
    shortMessage: 'The contract function "zapSellForNative" reverted.',
    cause: {
      name: "ContractFunctionRevertedError",
      data: { errorName: "SellTooLarge", args: [30n * 10n ** 18n, 25n * 10n ** 18n] },
    },
  };

  it("finds the ceiling inside a nested viem error", () => {
    expect(decodeSellTooLarge(decoded)).toEqual({
      paid: 30n * 10n ** 18n,
      maximum: 25n * 10n ** 18n,
    });
  });

  it("also reads it out of a printed message, which is how a node rejection arrives", () => {
    expect(
      decodeSellTooLarge({
        message: "execution reverted",
        metaMessages: ["Error: SellTooLarge(30000000000000000000, 25000000000000000000)"],
      })
    ).toEqual({ paid: 30n * 10n ** 18n, maximum: 25n * 10n ** 18n });
  });

  it("says what the ceiling is and what to do about it, in sell words", () => {
    const described = describeZapError(decoded);
    expect(described.kind).toBe("reverted");
    expect(described.message).toBe(
      "This route accepts at most 25 MON in one trade, and this one would have paid you 30. " +
        "Sell a smaller amount."
    );
  });

  it("does not confuse the two ceilings with each other", () => {
    // Neither name is a substring of the other, so neither reader may answer for the other's
    // revert — a buy told to "sell a smaller amount" is worse than a generic failure.
    expect(decodeZapTooLarge(decoded)).toBeNull();
    expect(
      decodeSellTooLarge({
        metaMessages: ["Error: ZapTooLarge(30000000000000000000, 25000000000000000000)"],
      })
    ).toBeNull();
  });

  it("finds no ceiling in an unrelated failure", () => {
    expect(decodeSellTooLarge(new Error("nonce too low"))).toBeNull();
    expect(decodeSellTooLarge(undefined)).toBeNull();
  });
});
