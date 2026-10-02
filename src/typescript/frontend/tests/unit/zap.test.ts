/**
 * @jest-environment node
 */
import { encodeFunctionData, toFunctionSelector } from "viem";

import { ZAP_ROUTER } from "../../src/lib/chain/addresses";
import { optionalAddress } from "../../src/lib/chain/config";
import {
  SELL_GAS_CAP,
  SELL_GAS_FLOOR,
  sellPoolZapPathKeys,
  toPathKeys,
  zapGasLimit,
  zapRouterAbi,
  zapSellGasLimit,
} from "../../src/lib/chain/zap";
import { candidateRoutes, sellRoutes } from "../../src/lib/chain/zap-routes";

const USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603";
const WBTC = "0x0555e30da8f98308edb960aa94c0db47230d2b9c";
const CURVE = "0x00000000000000000000000000000000000c0ffe";
const NATIVE = "0x0000000000000000000000000000000000000000";

describe("the router address, which a deployment is allowed not to have", () => {
  it("is absent in this environment, which is the one the feature ships in", () => {
    // `tests/integration/env.ts` fills every REQUIRED address and deliberately not this one. So
    // this assertion is the shipping configuration: no router, and therefore no feature.
    expect(ZAP_ROUTER).toBeNull();
  });

  it("reads an address that is set", () => {
    expect(optionalAddress("0x000000000000000000000000000000000000BEEF", "NAME")).toBe(
      "0x000000000000000000000000000000000000beef"
    );
  });

  it("treats an empty string as absent, because that is what an unset variable becomes", () => {
    expect(optionalAddress("", "NAME")).toBeNull();
    expect(optionalAddress("   ", "NAME")).toBeNull();
    expect(optionalAddress(undefined, "NAME")).toBeNull();
  });

  it("still refuses a value that is set and malformed", () => {
    // Absent and mistyped are opposite mistakes: one is a deployment that has not turned the
    // feature on, the other is one that thinks it has. Only the second is worth a boot failure.
    expect(() => optionalAddress("0xnope", "NAME")).toThrow("NAME");
  });
});

describe("the path, as the contracts read it", () => {
  it("drops the native input, because a path names what each hop swaps INTO", () => {
    const direct = candidateRoutes(USDC).find((p) => p.length === 1)!;
    const keys = toPathKeys(direct);
    expect(keys).toHaveLength(1);
    expect(keys[0].intermediateCurrency).toBe(USDC);
  });

  it("ends at the market's own quote asset, which the router checks and reverts on", () => {
    for (const path of candidateRoutes(WBTC)) {
      expect(toPathKeys(path)[path.length - 1].intermediateCurrency).toBe(WBTC);
    }
  });

  it("carries the intermediate of a two-hop route as its own entry", () => {
    const viaUsdc = candidateRoutes(WBTC).find((p) => p.length === 2 && p[0].to === USDC)!;
    expect(toPathKeys(viaUsdc).map((k) => k.intermediateCurrency)).toEqual([USDC, WBTC]);
  });

  it("keeps each hop's own fee tier and spacing", () => {
    const viaUsdc = candidateRoutes(WBTC).find((p) => p.length === 2 && p[0].to === USDC)!;
    expect(toPathKeys(viaUsdc).map((k) => [k.fee, k.tickSpacing])).toEqual(
      viaUsdc.map((hop) => [hop.fee, hop.tickSpacing])
    );
  });

  it("puts NO hook on any hop", () => {
    // These are Uniswap's own pools, not DOKU's. Writing the DOKU hook here would address a pool
    // that was never initialised, which reads as a route with no liquidity rather than a mistake.
    for (const path of candidateRoutes(WBTC)) {
      for (const key of toPathKeys(path)) {
        expect(key.hooks).toBe("0x0000000000000000000000000000000000000000");
        expect(key.hookData).toBe("0x");
      }
    }
  });

  it("never names native MON as an intermediate, which the router refuses", () => {
    for (const asset of [USDC, WBTC]) {
      for (const path of candidateRoutes(asset)) {
        for (const key of toPathKeys(path)) {
          expect(key.intermediateCurrency).not.toBe("0x0000000000000000000000000000000000000000");
        }
      }
    }
  });
});

describe("the path a sell takes, which is not the buy's path reversed", () => {
  // A market that graduated under the OLDER of the two live DOKU hooks: the whole point of reading
  // the key off the market rather than off this app's constants.
  const OLD_HOOK = "0x00000000000000000000000000000000000dead0" as const;
  const marketPoolKey = { fee: 3000, tickSpacing: 60, hooks: OLD_HOOK };

  it("spends the market's token first, so the quote asset leads the path", () => {
    // A buy appends the market's pool; a sell prepends it. The seller holds the TOKEN, so the
    // market's own pool is hop one and the token itself is the implied input that never appears.
    const route = sellRoutes(USDC).find((p) => p.length === 1)!;
    const keys = sellPoolZapPathKeys(route, { quoteAsset: USDC, poolKey: marketPoolKey });
    expect(keys).toHaveLength(2);
    expect(keys[0].intermediateCurrency).toBe(USDC);
    expect(keys[keys.length - 1].intermediateCurrency).toBe(NATIVE);
  });

  it("ends in native MON however long the route out is", () => {
    for (const route of sellRoutes(WBTC)) {
      const keys = sellPoolZapPathKeys(route, { quoteAsset: WBTC, poolKey: marketPoolKey });
      expect(keys).toHaveLength(route.length + 1);
      expect(keys[keys.length - 1].intermediateCurrency).toBe(NATIVE);
    }
  });

  it("carries the market's RECORDED hook, fee and spacing on the first hop", () => {
    // Two DOKU hooks are live on mainnet. Assembling this hop from `CONTRACTS.hook` would hash to a
    // pool nobody ever initialised for a market that graduated under the older one — which quotes
    // zero and reads as "no route", hiding a market that trades perfectly well.
    const route = sellRoutes(WBTC)[0];
    const [first] = sellPoolZapPathKeys(route, { quoteAsset: WBTC, poolKey: marketPoolKey });
    expect(first.hooks).toBe(OLD_HOOK);
    expect(first.fee).toBe(3000);
    expect(first.tickSpacing).toBe(60);
  });

  it("leaves every hop AFTER the market's pool hookless, because those are Uniswap's pools", () => {
    const route = sellRoutes(WBTC).find((p) => p.length === 2)!;
    const keys = sellPoolZapPathKeys(route, { quoteAsset: WBTC, poolKey: marketPoolKey });
    for (const key of keys.slice(1)) {
      expect(key.hooks).toBe("0x0000000000000000000000000000000000000000");
      expect(key.hookData).toBe("0x");
    }
  });

  it("lands on native MON on every route the sell walk returns", () => {
    for (const asset of [USDC, WBTC]) {
      const routes = sellRoutes(asset);
      expect(routes.length).toBeGreaterThan(0);
      for (const route of routes) {
        const keys = toPathKeys(route);
        expect(keys[keys.length - 1].intermediateCurrency).toBe(NATIVE);
      }
    }
  });

  it("drops the quote asset being spent, because a path names what each hop swaps INTO", () => {
    // The mirror of the buy's first assertion. USDC -> MON is the one-entry path `[NATIVE]`; the
    // USDC is implied by being the currency handed to the quoter, not by appearing in the array.
    const direct = sellRoutes(USDC).find((p) => p.length === 1)!;
    expect(toPathKeys(direct).map((k) => k.intermediateCurrency)).toEqual([NATIVE]);
  });

  it("carries a two-hop sell's intermediate as its own entry, input still absent", () => {
    const viaUsdc = sellRoutes(WBTC).find((p) => p.length === 2 && p[0].to === USDC)!;
    expect(toPathKeys(viaUsdc).map((k) => k.intermediateCurrency)).toEqual([USDC, NATIVE]);
  });
});

describe("the hand-written ABI against the contract's own signature", () => {
  it("encodes the selector `ZapRouter.zapBuyWithNative` actually answers to", () => {
    // The ABI in `zap.ts` is written by hand because the contract is not deployed and there is no
    // artifact to generate from. This pins it to the Solidity declaration: a field reordered or a
    // type widened changes the selector, and the call would land on no function at all.
    const encoded = encodeFunctionData({
      abi: zapRouterAbi,
      functionName: "zapBuyWithNative",
      args: [CURVE, toPathKeys(candidateRoutes(USDC)[0]), 1n, 2n, 3n],
    });
    expect(encoded.slice(0, 10)).toBe(
      toFunctionSelector(
        "zapBuyWithNative(address,(address,uint24,int24,address,bytes)[],uint256,uint256,uint256)"
      )
    );
  });
});

describe("the gas limit on the buy that graduates a market", () => {
  const hint = 2_500_000n;

  it("leaves an ordinary zap to the wallet", () => {
    expect(zapGasLimit({ estimate: 400_000n, graduationHint: hint, fills: false })).toBeNull();
  });

  it("adds the curve's own hint on the buy that fills it", () => {
    // The estimator cannot see graduation: it runs behind a `try`/`catch` that swallows failure, so
    // the estimate comes back at a limit where the market fills and does not graduate — with no
    // revert and nothing on the receipt to say so.
    expect(zapGasLimit({ estimate: 400_000n, graduationHint: hint, fills: true })).toBe(2_900_000n);
  });

  it("adds the hint to an allowance when the estimator will not answer", () => {
    // The alternative is the wallet's own estimate, which is the number known to be short.
    expect(zapGasLimit({ estimate: null, graduationHint: hint, fills: true })).toBe(3_500_000n);
  });

  it("does not over-reserve on a zap that is not filling anything", () => {
    // Monad bills the gas LIMIT rather than the gas used, so a blanket allowance would charge every
    // buyer in every market for headroom one transaction in a market's life needs.
    expect(zapGasLimit({ estimate: null, graduationHint: hint, fills: false })).toBeNull();
  });
});

describe("the gas limit on a zapped sell", () => {
  // The transaction this whole function exists because of: a real `zapSellToNative` on 2026-09-10,
  // sent with the estimator's own limit and billed for all of it.
  const WHAT_THE_ESTIMATOR_SAID = 4_795_725n;
  // What the same call really costs, measured in isolation on a mainnet fork by
  // `test_whatASellCostsInIsolationOnMainnetFork`: 240,758 one hop, 270,699 two hops (gold).
  const WHAT_A_SELL_REALLY_COSTS = 270_699n;

  it("truncates the estimate that cost 0.489 MON to deliver 0.489 MON", () => {
    expect(zapSellGasLimit(WHAT_THE_ESTIMATOR_SAID)).toBe(SELL_GAS_CAP);
    // The point of the cap, stated as the ratio rather than as a constant: an estimate an order of
    // magnitude over measured reality is not caution, it is a transfer to the validator.
    expect(WHAT_THE_ESTIMATOR_SAID / SELL_GAS_CAP).toBeGreaterThanOrEqual(10n);
  });

  it("believes an estimator that lands between the two bounds", () => {
    // It sees the actual market, route and balances; this function knows what three shapes cost on
    // one day. Between the bounds the estimator is the better-informed of the two.
    const sane = SELL_GAS_FLOOR + 1n;
    expect(zapSellGasLimit(sane)).toBe(sane);
    expect(zapSellGasLimit(SELL_GAS_CAP - 1n)).toBe(SELL_GAS_CAP - 1n);
  });

  it("refuses to send less than a real sell was measured to need", () => {
    // The asymmetry that matters: an under-set limit reverts AND is billed on Monad, so the seller
    // pays and receives nothing. That is strictly worse than over-paying, so a low estimate is
    // discarded rather than trusted.
    expect(zapSellGasLimit(21_000n)).toBe(SELL_GAS_FLOOR);
    expect(zapSellGasLimit(WHAT_A_SELL_REALLY_COSTS)).toBe(SELL_GAS_FLOOR);
  });

  it("takes the cap, not the floor, when the estimator will not answer", () => {
    // The case with the least information is the case to be most generous in.
    expect(zapSellGasLimit(null)).toBe(SELL_GAS_CAP);
  });

  it("never leaves the limit to the wallet, which is what the buy does", () => {
    // `zapGasLimit` returns null on an ordinary buy and lets the wallet decide. A sell cannot: the
    // wallet's own limit is the 4,795,725 above.
    for (const e of [null, 0n, 1n, WHAT_A_SELL_REALLY_COSTS, WHAT_THE_ESTIMATOR_SAID]) {
      expect(zapSellGasLimit(e)).not.toBeNull();
    }
  });

  it("keeps both bounds above what the fork measured, and the cap above the floor", () => {
    // The bounds are derived in `zap.ts` from three measured numbers; these are the two properties
    // that derivation has to have, asserted rather than assumed.
    // `contracts/test/ZapFork.t.sol` is what checks them against the live chain.
    expect(SELL_GAS_FLOOR).toBeGreaterThan(WHAT_A_SELL_REALLY_COSTS);
    expect(SELL_GAS_CAP).toBeGreaterThan(SELL_GAS_FLOOR);
  });

  it("clamps every estimate into the band, whatever the estimator returns", () => {
    for (const e of [0n, 1n, 100_000n, SELL_GAS_FLOOR, SELL_GAS_CAP, 10_000_000n]) {
      const gas = zapSellGasLimit(e);
      expect(gas).toBeGreaterThanOrEqual(SELL_GAS_FLOOR);
      expect(gas).toBeLessThanOrEqual(SELL_GAS_CAP);
    }
  });
});

describe("the sell, as the router's ABI describes it", () => {
  const errorNames = zapRouterAbi.filter((e) => e.type === "error").map((e) => e.name);

  it("carries the sell entry point, with the two floors in the right order", () => {
    const fn = zapRouterAbi.find((e) => e.type === "function" && e.name === "zapSellToNative");
    expect(fn).toBeDefined();
    expect(fn!.inputs.map((i) => i.name)).toEqual([
      "curve",
      "path",
      "baseIn",
      "minQuoteOut",
      "minNativeOut",
      "deadline",
    ]);
  });

  it("is nonpayable, because a sell sends no MON", () => {
    // A `payable` entry here would let a wallet attach `value` to a sell, and the router has no
    // path that returns it: `receive()` is gated to the PoolManager, so the transaction reverts
    // after the seller has already signed.
    const fn = zapRouterAbi.find((e) => e.type === "function" && e.name === "zapSellToNative");
    expect(fn!.stateMutability).toBe("nonpayable");
  });

  /*
   * viem decodes a custom error only if the ABI it was given lists it. An omitted one arrives as an
   * undecodable hex string that `describeZapError` cannot tell from any other failure — so this is
   * the difference between "this route accepts at most 20,000 MON" and "the contract rejected this
   * transaction".
   */
  it.each([
    "SellTooLarge",
    "SellFloorTooLarge",
    "InsufficientNativeOut",
    "ZeroAmount",
    "PathDoesNotEndAtNative",
    "UnexpectedNativeDebit",
    "OnlyPoolManagerPays",
    "EmptyPath",
    "PathTooLong",
    "NativeIntermediate",
  ])("names %s, so a revert reaches the seller as a sentence", (name) => {
    expect(errorNames).toContain(name);
  });

  it.each(["ZeroOutput", "InsufficientOutput"])(
    "names the CURVE's own %s, which a sell reverts with too",
    (name) => {
      // `BondingCurve.sell` reverts `ZeroOutput` on a sale that pays nothing, and its own comment
      // shows that is reachable with ordinary amounts on a six-decimal quote — which is exactly
      // the gold market this feature exists to serve.
      expect(errorNames).toContain(name);
    }
  );

  it("keeps every error the BUY path already relied on", () => {
    for (const name of ["ZapTooLarge", "Expired", "UnknownMarket", "NativeQuoteNeedsNoZap"]) {
      expect(errorNames).toContain(name);
    }
  });
});
