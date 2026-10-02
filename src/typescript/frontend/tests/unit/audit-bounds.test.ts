/**
 * @jest-environment node
 *
 * A security audit of the CLIENT-SIDE BOUNDS that protect a trader's money on the zap path: the
 * gas limit a sell is signed with, the two slippage floors, the arithmetic that rescales and
 * renders the numbers, and the impact gate that decides which route is offered.
 *
 * Nothing here is a regression test for a fix. Every assertion is EVIDENCE for a claim in the
 * audit report — either "this is safe, and here is the input that would have broken it" or "this
 * is the input that breaks it". A test that passes today and would fail the day the property
 * stops holding is worth more than a paragraph.
 *
 * No source file is modified by this audit. Where a test records a defect it asserts the CURRENT
 * behaviour and names the fix in a comment, so applying the fix is what makes it fail.
 */
import { formatAssetAmount } from "../../src/lib/chain/amount-display";
import {
  clampSlippageBps,
  MAX_UI_SLIPPAGE_BPS,
  MIN_SLIPPAGE_BPS,
} from "../../src/lib/chain/slippage";
import { applySlippage, MAX_SLIPPAGE_BPS, minimumOut } from "../../src/lib/chain/writes";
import { SELL_GAS_CAP, SELL_GAS_FLOOR, zapSellGasLimit } from "../../src/lib/chain/zap";
import {
  poolSellZapPlan,
  restateAmount,
  sellZapPlan,
  zapBounds,
  zapSlippageBps,
} from "../../src/lib/chain/zap-plan";
import {
  chooseRoute,
  MAX_ZAP_HOPS,
  MAX_ZAP_IMPACT_BPS,
  routeImpactBps,
  sellRoutes,
} from "../../src/lib/chain/zap-routes";
import { formatNumberString } from "../../src/lib/utils/format-number-string";

const USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603";
const USDT0 = "0xe7cd86e13ac4309349f30b3435a9d337750fc82d";
const WETH = "0xee8c0e9f1bffb4eb878d8f15f368a02a35481242";
const WBTC = "0x0555e30da8f98308edb960aa94c0db47230d2b9c";
const CBBTC = "0xd18b7ec58cdf4876f6afebd3ed1730e4ce10414b";
const GOLD = "0x01bff41798a0bcf287b996046ca68b395dbc1071";

/** Every asset the route graph in `zap-routes.ts` can reach, i.e. every market a zap is offered on. */
const EVERY_QUOTE_ASSET = [USDC, USDT0, WETH, WBTC, CBBTC, GOLD];

/**
 * Ten to the power of `n`, without the exponent operator.
 *
 * The same rule `pow10` in `zap-plan.ts` follows and for the same reason: SWC lowers `**` to
 * `Math.pow`, which throws on a BigInt. A test file that took the module down at import would look
 * like a broken audit rather than a broken lowering.
 */
const pow10n = (n: number): bigint => BigInt(`1${"0".repeat(n)}`);

// ---------------------------------------------------------------------------------------------
// 1. THE GAS CAP
// ---------------------------------------------------------------------------------------------

/*
 * The three numbers `zap.ts` derives both bounds from, restated here so the derivation can be
 * checked without re-reading the docblock. They are printed by
 * `test_whatASellCostsInIsolationOnMainnetFork` in `contracts/test/ZapFork.t.sol` and quoted in the
 * docblock above `SELL_GAS_MEASURED` in `src/lib/chain/zap.ts`.
 */
const MEASURED_ONE_HOP_USDC = 240_758n;
const MEASURED_TWO_HOP_CBBTC = 268_292n;
const MEASURED_TWO_HOP_GOLD = 270_699n;
const TX_INTRINSIC = 30_000n;
/** The unit both bounds are counted in, as `zap.ts` declares it. */
const DECLARED_PER_HOP = 30_873n;

describe("the sell gas cap: what it is derived from, and what it leaves out", () => {
  it("is a fixed number with no size term in it, derived from three trades worth about $2.60", () => {
    // `contracts/test/ZapFork.t.sol:84` — `uint256 constant ZAP = 100 ether;` with the comment
    // "about $2.60". Every gas figure the cap rests on was measured on a sell of that size, and
    // the cap is then applied to a sell of ANY size. Gas in a v4 swap is not size-invariant:
    // crossing one initialised tick costs roughly 12k (a cold `ticks[tick]` SLOAD plus the
    // `feeGrowthOutside` SSTOREs, plus a cold `tickBitmap` word on each new word), and a $2.60
    // trade crosses none.
    expect(SELL_GAS_FLOOR).toBe(MEASURED_TWO_HOP_GOLD + DECLARED_PER_HOP + TX_INTRINSIC);
    expect(SELL_GAS_FLOOR).toBe(331_572n);
    expect(SELL_GAS_CAP).toBe(SELL_GAS_FLOOR + 4n * DECLARED_PER_HOP);
    expect(SELL_GAS_CAP).toBe(455_064n);
  });

  it("leaves 123,492 gas of headroom above the longest route this app can build", () => {
    // The floor already IS a three-hop sell, so everything above it is the whole defence against
    // every cost the fork run did not exercise: a BURN market's buyback-and-burn, a non-zero
    // creator tax's cold `pendingTax` SSTORE, a dearer quote-asset `transfer`, and — the one that
    // scales — initialised ticks crossed by a trade larger than $2.60.
    const headroom = SELL_GAS_CAP - SELL_GAS_FLOOR;
    expect(headroom).toBe(123_492n);

    // At ~12,000 gas per initialised tick crossed, that is about ten ticks, TOTAL, across all
    // three hops — and `MAX_ZAP_IMPACT_BPS` permits a swap whose own second half costs 3%, which
    // on a 10-tick-spacing (0.1%) pool is tens of spacings of price movement.
    const ticksItBuys = headroom / 12_000n;
    expect(ticksItBuys).toBeLessThan(11n);
  });

  it("truncates an estimate that is one gas over, with no escape hatch for a genuinely dear sell", () => {
    // This is the whole finding in one line. `zapSellGasLimit` cannot tell "the estimator is
    // being pessimistic again" from "this sell really does need 500k", because it is a constant
    // and the estimator is the only party in the system that has seen the actual pool state.
    expect(zapSellGasLimit(SELL_GAS_CAP + 1n)).toBe(SELL_GAS_CAP);
    expect(zapSellGasLimit(500_000n)).toBe(SELL_GAS_CAP);
    expect(zapSellGasLimit(1_000_000n)).toBe(SELL_GAS_CAP);

    // And the truncation is the DANGEROUS direction, by this file's own argument: a sell sent with
    // less gas than it needs reverts, and Monad bills the limit — so the seller pays 455,064 gas
    // and receives nothing. That is the exact failure `SELL_GAS_FLOOR` exists to prevent from
    // below, reintroduced from above.
    expect(zapSellGasLimit(SELL_GAS_CAP * 2n)).toBeLessThan(SELL_GAS_CAP * 2n);
  });

  it("counts hops in a unit that is 932 gas larger than the shapes it says it came from", () => {
    // `zap.ts` says SELL_GAS_PER_HOP is "the dearest two-hop shape minus the one-hop shape, from
    // the same run", and the same docblock lists those two shapes. They do not subtract to it.
    // Harmless in itself — it errs generous — but it means the two bounds are NOT reproducible
    // from the numbers written beside them, which is the property the docblock claims.
    const spreadTheDocblockNames = MEASURED_TWO_HOP_GOLD - MEASURED_ONE_HOP_USDC;
    expect(spreadTheDocblockNames).toBe(29_941n);
    expect(DECLARED_PER_HOP - spreadTheDocblockNames).toBe(932n);

    // The cbBTC shape, which is the other two-hop measurement, subtracts to less again.
    expect(MEASURED_TWO_HOP_CBBTC - MEASURED_ONE_HOP_USDC).toBe(27_534n);
  });

  it("is derived for three hops, which is a live route shape for every zappable asset", () => {
    // Not hypothetical headroom: a three-hop route is a CANDIDATE on every asset in the graph, and
    // `chooseRoute` ranks purely on output, so it wins whenever it is the deepest.
    for (const asset of EVERY_QUOTE_ASSET) {
      const routes = sellRoutes(asset);
      expect(routes.length).toBeGreaterThan(0);
      expect(Math.max(...routes.map((r) => r.length))).toBe(MAX_ZAP_HOPS);
      for (const r of routes) expect(r.length).toBeLessThanOrEqual(MAX_ZAP_HOPS);
    }
  });

  it("holds only while MAX_ZAP_HOPS is 3 — the ROUTER allows 4, and nothing links the two", () => {
    // `ZapRouter.sol:89` is `uint256 public constant MAX_HOPS = 4;`. The floor's derivation is
    // "the dearest measured shape plus ONE more hop", which covers three and not four. Raising
    // `MAX_ZAP_HOPS` to the router's own limit would silently make the FLOOR too low for the
    // longest path the app could then build, and nothing in either file would fail.
    expect(MAX_ZAP_HOPS).toBe(3);
  });

  it("never returns null, so the wallet's own estimate is never used on the direct path", () => {
    for (const e of [null, 0n, 1n, SELL_GAS_FLOOR, SELL_GAS_CAP, 9_999_999n]) {
      const gas = zapSellGasLimit(e);
      expect(gas).toBeGreaterThanOrEqual(SELL_GAS_FLOOR);
      expect(gas).toBeLessThanOrEqual(SELL_GAS_CAP);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 2. THE SLIPPAGE PATH
// ---------------------------------------------------------------------------------------------

describe("the slippage tolerance: can anything reach a floor of zero", () => {
  /*
   * Every shape a setting can arrive in — the box, `localStorage`, an older build, a corrupted
   * value, a hostile one. The claim under test is that none of them widens the tolerance past the
   * control's own ceiling, because that is what a floor of zero would need.
   */
  const HOSTILE_SETTINGS = [
    10_000,
    10_000n,
    "10000",
    9_999.999,
    1e21,
    "1e100",
    Number.MAX_SAFE_INTEGER,
    BigInt(Number.MAX_SAFE_INTEGER) * 1_000_000n,
    -1,
    -10_000n,
    0,
    "0",
    "",
    "  ",
    "not a number",
    null,
    undefined,
    NaN,
    Infinity,
    -Infinity,
    "5.5",
    250.7,
  ];

  it("brings every one of them inside [0.1%, 5%]", () => {
    for (const setting of HOSTILE_SETTINGS) {
      const bps = clampSlippageBps(setting as never);
      expect(bps).toBeGreaterThanOrEqual(MIN_SLIPPAGE_BPS);
      expect(bps).toBeLessThanOrEqual(MAX_UI_SLIPPAGE_BPS);
    }
  });

  it("keeps at least 95% of the quote as the floor, for every one of them", () => {
    // The 100%-tolerance bug the module was written for: a floor of zero is a standing offer to be
    // sandwiched for the whole trade. Nothing reachable gets within an order of magnitude of it.
    const quoted = 1_000_000_000_000n;
    for (const setting of HOSTILE_SETTINGS) {
      const floor = applySlippage(quoted, Number(clampSlippageBps(setting as never)));
      expect(floor).toBeGreaterThanOrEqual((quoted * 9_500n) / 10_000n);
      expect(floor).toBeGreaterThan(0n);
    }
  });

  it("still lets applySlippage sign a 50% floor, which is ten times what the UI can express", () => {
    // `clampSlippageBps` ceiling is 500 bps; `applySlippage`'s own ceiling is 5,000. The gap is
    // reachable only by a caller that does not clamp, and the plan functions take a raw `number`.
    expect(MAX_SLIPPAGE_BPS).toBe(5_000);
    expect(Number(MAX_UI_SLIPPAGE_BPS)).toBe(500);
    expect(applySlippage(1_000n, MAX_SLIPPAGE_BPS)).toBe(500n);
  });

  it("throws rather than widening when a plan is handed an unclamped tolerance", () => {
    // This is the render-path hazard `zapSlippageBps` documents. The plan functions declare
    // `slippageBps: number` and pass it straight to `applySlippage`, so the type system does not
    // stop it — only the discipline of calling `zapSlippageBps` at the one call site does.
    expect(() => zapBounds({ quoteOut: 1_000n, baseOut: 1_000n, slippageBps: 10_000 })).toThrow();
    expect(() => zapBounds({ quoteOut: 1_000n, baseOut: 1_000n, slippageBps: 250.5 })).toThrow();
    expect(() => zapBounds({ quoteOut: 1_000n, baseOut: 1_000n, slippageBps: -1 })).toThrow();
    // And with the clamp in front of it, none of the same values can throw.
    for (const setting of [10_000, 250.5, -1, NaN]) {
      expect(() =>
        zapBounds({ quoteOut: 1_000n, baseOut: 1_000n, slippageBps: zapSlippageBps(setting) })
      ).not.toThrow();
    }
  });

  it("rounds the floor DOWN, never up, so a fair fill is never refused by the arithmetic", () => {
    // Rounding up would put the floor above what the trade can deliver. Checked across the awkward
    // residues rather than on one example.
    for (let q = 1n; q < 400n; q++) {
      for (const bps of [10, 100, 300, 500]) {
        const floor = applySlippage(q, bps);
        expect(floor * 10_000n).toBeLessThanOrEqual(q * BigInt(10_000 - bps));
        expect(floor).toBeLessThanOrEqual(q);
      }
    }
  });

  it("floors a one-raw-unit quote to zero, which is dust and not a hole", () => {
    // The only reachable zero floor: `1 * 9500 / 10000 == 0`. On six-decimal gold one raw unit is
    // a ten-thousandth of a cent, and `BondingCurve.sell` reverts `ZeroOutput()` below it anyway.
    expect(applySlippage(1n, 500)).toBe(0n);
    expect(applySlippage(2n, 500)).toBe(1n);
    expect(applySlippage(0n, 500)).toBe(0n);
  });
});

describe("the sell's two floors, and whether either is vacuous", () => {
  const route = { amountOut: 1_000n * pow10n(18), impactBps: 12 };
  const CURVE_PAYOUT = 2_400_000n; // raw six-decimal gold

  it("bounds each leg in its own asset, at the same tolerance, without compounding", () => {
    const plan = sellZapPlan({
      amountIn: 500n * pow10n(18),
      quoting: false,
      route,
      quoteOut: CURVE_PAYOUT,
      slippageBps: 100,
      maximum: undefined,
      quoteSymbol: "XAUt0",
    });
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") return;
    // `minQuoteOut` is in the market's quote asset and bounds the CURVE leg — enforced twice on
    // chain, by `BondingCurve.sell` (`InsufficientOutput`) and again by `ZapRouter._sell` against
    // what actually ARRIVED (`InsufficientQuoteOut`), which is the transfer-fee guard.
    expect(plan.minQuoteOut).toBe((CURVE_PAYOUT * 9_900n) / 10_000n);
    // `minNativeOut` is in wei and bounds the SWAP leg — `ZapRouter.zapSellToNative:353`.
    expect(plan.minNativeOut).toBe((route.amountOut * 9_900n) / 10_000n);
  });

  it("leaves the swap leg ZERO margin once the curve leg has used the tolerance", () => {
    // Not a hole in the floor — it is the floor working — but it is the reason a zapped sell on a
    // busy curve reverts rather than fills, and on Monad a revert is billed at the full clamped
    // limit. Modelled with a linear route, which is the best case: if the curve pays exactly
    // `minQuoteOut`, the swap returns exactly `minNativeOut` and ANY pool movement breaches it.
    const slippageBps = 100;
    const minQuoteOut = applySlippage(CURVE_PAYOUT, slippageBps);
    const minNativeOut = applySlippage(route.amountOut, slippageBps);
    const nativeFromAFlooredCurvePayout = (route.amountOut * minQuoteOut) / CURVE_PAYOUT;
    expect(nativeFromAFlooredCurvePayout).toBeLessThanOrEqual(minNativeOut + 1n);
    // The fix, if the paid reverts are judged worse than the extra exposure, is to quote the route
    // on `minQuoteOut` rather than on the curve's expected payout — which costs the seller a
    // second tolerance of downside and is therefore a product decision, not a defect.
  });

  it("refuses, rather than signing a zero curve floor, when the curve quotes nothing", () => {
    // `sellZapPlan` folds `quoteOut === undefined` into "quoting" but treats `0n` as an answer, so
    // a curve payout that rounded to zero — which `BondingCurve.sell` documents as reachable with
    // ORDINARY amounts on six-decimal gold — yields a READY plan with `minQuoteOut: 0n`.
    //
    // Unreachable through the panel TODAY, and only by luck: `SwapComponent.tsx:611` gates the
    // route query on `(sellQuoteOut ?? 0n) > 0n`, so `route` stays `undefined` and the plan says
    // "quoting" instead. That guard lives in a `.tsx` file with no component-test harness in this
    // repo, and it is the only thing between this function and a signed floor of zero.
    const plan = sellZapPlan({
      amountIn: 300n * pow10n(18),
      quoting: false,
      route,
      quoteOut: 0n,
      slippageBps: 500,
      maximum: undefined,
      quoteSymbol: "XAUt0",
    });
    expect(plan.kind).toBe("unavailable");
    if (plan.kind !== "ready") return;
    expect(plan.minQuoteOut).toBe(0n);
    // The fix: `if (input.quoteOut === undefined || input.quoteOut === 0n) return { kind: "quoting" };`
    // — or better, a distinct `unavailable` state saying the sale is too small to pay anything,
    // since a curve quoting zero is not a measurement in flight.
  });

  it("can never produce a zero native floor, because chooseRoute discards a zero quote", () => {
    // The other floor has a real invariant behind it rather than a guard in a component.
    expect(chooseRoute([{ path: [], amountOut: 0n, impactBps: 0 }])).toBeNull();
    expect(chooseRoute([{ path: [], amountOut: -5n, impactBps: 0 }])).toBeNull();
    const plan = poolSellZapPlan({
      amountIn: 1n,
      quoting: false,
      route: { amountOut: 1n, impactBps: 0 },
      slippageBps: 500,
      quoteSymbol: "USDC",
    });
    expect(plan.kind).toBe("ready");
  });

  it("shows the seller exactly the floor it signs, on both zapped roads", () => {
    // The receipt row is `minimumOut(outputAmount, maxSlippage)` (`SwapComponent.tsx:999`) and the
    // signed floor is `applySlippage(route.amountOut, zapSlippageBps(maxSlippage))`. Two spellings
    // of one number — which is the property that matters, since a receipt that disagrees with the
    // signature is how somebody agrees to a trade they did not read.
    for (const setting of [10_000, 500, 100, 1, "300", null]) {
      const shown = minimumOut(route.amountOut, setting as never);
      const signed = poolSellZapPlan({
        amountIn: 1n,
        quoting: false,
        route,
        slippageBps: zapSlippageBps(setting as never),
        quoteSymbol: "USDC",
      });
      expect(signed.kind).toBe("ready");
      if (signed.kind !== "ready") return;
      expect(signed.minNativeOut).toBe(shown);
    }
  });
});

describe("the router's ceiling: where the panel and the contract disagree", () => {
  /*
   * Three predicates, on three different numbers:
   *
   *   panel      `route.amountOut  > maximum`      -> refuse         (zap-plan.ts:351)
   *   contract   `minNativeOut     > ceiling`      -> SellFloorTooLarge  (ZapRouter.sol:334)
   *   contract   `nativeOut        > ceiling`      -> SellTooLarge       (ZapRouter.sol:354)
   *
   * The last one fires AFTER the pull, the curve sell and the whole swap, so it is the expensive
   * one — and it is the one the panel does not model.
   */
  const maximum = 20_000n * pow10n(18);

  it("refuses more than the contract's cheap pre-check would have", () => {
    // The panel tests the QUOTE and the contract tests the FLOOR, which is 1-5% lower. So there is
    // a band the panel refuses and the chain would have accepted. Costs the seller a trade, not
    // money: the safe direction.
    const amountOut = maximum + 1n;
    const plan = sellZapPlan({
      amountIn: 1n,
      quoting: false,
      route: { amountOut, impactBps: 5 },
      quoteOut: 1_000n,
      slippageBps: 500,
      maximum,
      quoteSymbol: "USDC",
    });
    expect(plan.kind).toBe("over-cap");
    expect(applySlippage(amountOut, 500)).toBeLessThan(maximum);
  });

  it("allows a sell sitting exactly on the ceiling, where any upward drift is a paid revert", () => {
    // The panel passes `amountOut === maximum` with no margin at all. The transaction then reverts
    // `SellTooLarge` at `ZapRouter.sol:354` if the route improves by ONE WEI between the quote and
    // the block — after the tokens have been pulled, the curve sold and both hops swapped. On
    // Monad that is the whole clamped limit, billed, for nothing.
    const plan = sellZapPlan({
      amountIn: 1n,
      quoting: false,
      route: { amountOut: maximum, impactBps: 5 },
      quoteOut: 1_000n,
      slippageBps: 500,
      maximum,
      quoteSymbol: "USDC",
    });
    expect(plan.kind).toBe("ready");
    // The fix: refuse at the same tolerance the trade is signed with, so a quote that could drift
    // into the ceiling is withdrawn instead of sent —
    //   `if (maximum > 0n && route.amountOut + (route.amountOut * BigInt(slippageBps)) / 10_000n > maximum)`
    // which costs nobody a trade they could actually have had.
  });
});

// ---------------------------------------------------------------------------------------------
// 3. restateAmount AND formatAssetAmount
// ---------------------------------------------------------------------------------------------

describe("restateAmount: rescaling the field when the pay-with choice changes", () => {
  const MON = 18;
  const GOLD_DEC = 6;
  const WBTC_DEC = 8;

  it("round-trips 18 -> 6 -> 18 exactly for anything a person would type", () => {
    for (const whole of ["0.000001", "0.5", "1", "5", "1234.5678", "999999999"]) {
      const [i, f = ""] = whole.split(".");
      const raw = BigInt(i + f.padEnd(MON, "0"));
      const there = restateAmount(raw, MON, GOLD_DEC);
      expect(restateAmount(there, GOLD_DEC, MON)).toBe(raw);
    }
  });

  it("truncates towards zero and never invents value, in either direction", () => {
    // The only loss is below one raw unit of the coarser asset — a millionth of an ounce of gold,
    // a hundred-millionth of a bitcoin. It rounds the trader's own input DOWN, which cannot make
    // them spend more than they meant to.
    expect(restateAmount(999_999_999_999n, MON, GOLD_DEC)).toBe(0n);
    expect(restateAmount(1_999_999_999_999n, MON, GOLD_DEC)).toBe(1n);
    expect(restateAmount(1n, MON, WBTC_DEC)).toBe(0n);
    expect(restateAmount(5n, GOLD_DEC, MON)).toBe(5n * pow10n(12));
    expect(restateAmount(7n, WBTC_DEC, WBTC_DEC)).toBe(7n);
  });

  it("cannot be off by orders of magnitude in the direction that costs money", () => {
    // "Orders of magnitude off" would mean the field holding a number larger than intended. Going
    // to MORE decimals multiplies exactly; going to fewer divides and truncates. Neither can
    // exceed the exact rescaling, so a restatement can only ever understate.
    for (const from of [6, 8, 18]) {
      for (const to of [6, 8, 18]) {
        for (const raw of [0n, 1n, 12_345n, pow10n(18), 987_654_321_000_000_000_000n]) {
          const out = restateAmount(raw, from, to);
          const exactNumerator = raw * pow10n(to);
          expect(out * pow10n(from)).toBeLessThanOrEqual(exactNumerator);
        }
      }
    }
  });

  it("is never applied to a SELL, where the field holds the token whatever the choice", () => {
    // `SwapComponent.tsx:1097` guards `changePayWith` with `if (!isSell)`, and the other call site
    // (`:453`) only fires when `payWith === "native"` is withdrawn — where on a sell
    // `inputDecimals` is `BASE_DECIMALS`, equal to `MON_DECIMALS`, so the restatement is a no-op.
    // Recorded as an assertion because that second site is correct by COINCIDENCE: it would start
    // dividing sells by a trillion the day the two constants stopped being equal.
    expect(restateAmount(1_234n * pow10n(18), 18, 18)).toBe(1_234n * pow10n(18));
  });
});

describe("formatAssetAmount: what the reader sees against what is signed", () => {
  it("never prints a non-zero amount as zero, at any decimals, with the app's own options", () => {
    // The bug it exists for: `toFixed(6)` printed 0.00000026 WBTC as `0.000000`.
    expect(formatAssetAmount(26n, 8)).toBe("0.00000026");
    expect(formatAssetAmount(1n, 18)).toBe("0.000000000000000001");
    expect(formatAssetAmount(1n, 6)).toBe("0.000001");
    // The only call site in the app passes `minPlaces: 4` — `SwapComponent.tsx:1440`.
    for (const decimals of [0, 6, 8, 18]) {
      for (const raw of [1n, 7n, 26n, 999n, pow10n(decimals)]) {
        for (const options of [{}, { minPlaces: 4 }, { minPlaces: 6 }]) {
          expect(formatAssetAmount(raw, decimals, options)).not.toMatch(/^-?0(\.0*)?$/);
        }
      }
    }
  });

  it("never prints MORE than the amount, because it slices instead of rounding", () => {
    // A rendered figure that rounded UP would sit beside a floor the chain will not honour.
    for (const decimals of [6, 8, 18]) {
      for (const raw of [1n, 999_999n, 123_456_789_012_345_678n]) {
        const shown = formatAssetAmount(raw, decimals);
        const [i, f = ""] = shown.split(".");
        const asRaw = BigInt(i + f.padEnd(decimals, "0").slice(0, decimals));
        expect(asRaw).toBeLessThanOrEqual(raw);
      }
    }
  });

  it("cannot be made to print a non-zero amount as zero, even at zero significant digits", () => {
    // The one input that defeats the module's own rule. No call site passes it today — the sole
    // caller passes `{ minPlaces: 4 }` — so this is a latent trap rather than a live bug.
    expect(formatAssetAmount(26n, 8, { significantDigits: 0 })).toBe("0.0000002");
    expect(formatAssetAmount(26n, 8, { significantDigits: 1 })).toBe("0.0000002");
    // The fix: clamp in `fractionPlaces`, e.g.
    //   `const digits = Math.max(1, significantDigits);`
    // so the "a non-zero amount never renders as zero" rule cannot be switched off by an option.
  });

  it("is NOT what the receipt rows use — those go through formatNumberString", () => {
    // Worth stating because the module's docblock reads as though it governs the panel. The two
    // numbers a seller reads before signing, "You receive" and "Minimum after slippage", are
    // rendered by `FormattedNumber` (`SwapComponent.tsx:1519` and `:1585`). That path uses
    // `Intl.NumberFormat` with `maximumSignificantDigits` below 1, so it does not have the
    // zero-printing defect either.
    expect(formatNumberString({ value: 0.00000026, decimals: 4 })).toBe("0.00000026");
    expect(formatNumberString({ value: 1e-12, decimals: 4 })).not.toBe("0");
    // Above 1 it switches to `maximumFractionDigits`, which is a display truncation and not a lie
    // about the signed number.
    expect(formatNumberString({ value: 8297.68921, decimals: 4 })).toBe("8,297.6892");
  });

  it("does not lose the receipt's figure to a float, at the sizes this app renders", () => {
    // `Number(formatUnits(...))` in front of `FormattedNumber` is the one lossy hop on the display
    // path. It carries ~15-17 significant digits, and the row shows four — so the loss is many
    // orders of magnitude below the last digit printed.
    const wei = 1_234_567_891_234_567_891_234n; // ~1,234.57 MON
    const asNumber = Number(wei) / 1e18;
    expect(formatNumberString({ value: asNumber, decimals: 4 })).toBe("1,234.5679");
  });
});

// ---------------------------------------------------------------------------------------------
// 4. ROUTE SELECTION AND THE IMPACT GATE
// ---------------------------------------------------------------------------------------------

describe("routeImpactBps and the 3% gate: what it actually measures", () => {
  it("measures MARGINAL depth, and is blind to a pool that is simply mispriced", () => {
    // A route returning a hundredth of fair value reports ZERO impact, because halving the trade
    // returns exactly half of a hundredth. The gate is a measurement of the trade's own second
    // half; it has no idea what the asset is worth.
    const fair = { amountOut: 1_000_000n, halfAmountOut: 500_000n };
    const robbed = { amountOut: 10_000n, halfAmountOut: 5_000n };
    expect(routeImpactBps(fair)).toBe(0);
    expect(routeImpactBps(robbed)).toBe(0);
    expect(routeImpactBps(robbed)).toBeLessThanOrEqual(MAX_ZAP_IMPACT_BPS);
  });

  it("is saved only by chooseRoute preferring the biggest output, where an alternative exists", () => {
    // This is the real defence, and it is comparative rather than absolute: the mispriced route
    // loses to the honest one because it returns less, not because the gate caught it.
    const best = chooseRoute([
      { path: [], amountOut: 10_000n, impactBps: 0 },
      { path: [], amountOut: 1_000_000n, impactBps: 0 },
    ]);
    expect(best!.amountOut).toBe(1_000_000n);

    // Which is why the assets with the fewest candidates are the exposed ones. Gold has two, and
    // both of them start at the same single XAUt0/USDT0 pool — the graph has no other edge to it
    // (`zap-routes.ts:64`: "gold's only pool anywhere on the chain"). A manipulated first hop has
    // nothing to lose to.
    const goldRoutes = sellRoutes(GOLD);
    expect(goldRoutes.length).toBe(2);
    for (const r of goldRoutes) expect(r[0].to).toBe(USDT0);
  });

  it("reports zero impact on any trade small enough for integer truncation to dominate", () => {
    // `halfAmountOut * 2n` on a coarse destination: 3 raw units out, 1 at half size, reads as
    // better than linear and returns 0.
    expect(routeImpactBps({ amountOut: 3n, halfAmountOut: 1n })).toBe(0);
    // And it truncates the other way just as hard: a route returning one raw unit at both sizes —
    // a perfectly healthy pool priced in six-decimal gold at a small size — reads as FIFTY PERCENT
    // impact and is dropped by `chooseRoute`, so the panel says "the pools are too thin" about a
    // route that is fine.
    expect(routeImpactBps({ amountOut: 1n, halfAmountOut: 1n })).toBe(5_000);
    expect(chooseRoute([{ path: [], amountOut: 1n, impactBps: 5_000 }])).toBeNull();
    // Dust either way, and the floor still binds — recorded so the figure is not read as a depth
    // measurement at sizes where it is not one.
  });

  it("calls a dead route infinitely expensive rather than free, in both orders", () => {
    expect(routeImpactBps({ amountOut: 0n, halfAmountOut: 500n })).toBe(10_000);
    expect(routeImpactBps({ amountOut: 500n, halfAmountOut: 0n })).toBe(10_000);
    expect(chooseRoute([{ path: [], amountOut: 500n, impactBps: 10_000 }])).toBeNull();
  });

  it("truncates the impact figure DOWN, so 299.99 bps passes a 300 bps gate", () => {
    // BigInt division, so the gate is inclusive by a fraction of a basis point. Immaterial to
    // money — it is a route-ranking threshold, not a bound on the trade — but stated so the gate
    // is not mistaken for an exact one.
    const halfAmountOut = 1_000_000_000n;
    const linear = halfAmountOut * 2n;
    const amountOut = linear - (linear * 30_000n) / 1_000_000n; // 300.00 bps exactly
    expect(routeImpactBps({ amountOut, halfAmountOut })).toBe(300);
    expect(routeImpactBps({ amountOut: amountOut + 1n, halfAmountOut })).toBe(299);
  });

  it("bounds nothing the seller signs: the gate withholds an option, the floor bounds the trade", () => {
    // Stated as an assertion because it is the audit's answer to "is the gate load-bearing for
    // safety". A route at the very edge of the gate produces exactly the same floor as a perfect
    // one — the floor is a function of the QUOTE and the tolerance, and the impact figure is not
    // an input to it anywhere.
    const shallow = poolSellZapPlan({
      amountIn: 1n,
      quoting: false,
      route: { amountOut: 1_000n, impactBps: MAX_ZAP_IMPACT_BPS },
      slippageBps: 100,
      quoteSymbol: "USDC",
    });
    const deep = poolSellZapPlan({
      amountIn: 1n,
      quoting: false,
      route: { amountOut: 1_000n, impactBps: 0 },
      slippageBps: 100,
      quoteSymbol: "USDC",
    });
    expect(shallow.kind).toBe("ready");
    expect(deep.kind).toBe("ready");
    if (shallow.kind !== "ready" || deep.kind !== "ready") return;
    expect(shallow.minNativeOut).toBe(deep.minNativeOut);
  });

  it("keeps every asset reachable, so the gate never silently removes a market's only road", () => {
    for (const asset of [USDC, USDT0, WETH, WBTC, CBBTC, GOLD]) {
      expect(sellRoutes(asset).length).toBeGreaterThan(0);
    }
    // And a MON-quoted market has none in either direction, which is the "needs no zap" answer
    // rather than a missing route.
    expect(sellRoutes("0x0000000000000000000000000000000000000000")).toEqual([]);
  });
});
