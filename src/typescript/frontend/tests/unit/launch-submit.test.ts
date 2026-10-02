/**
 * @jest-environment node
 */
import { decodeFunctionData, erc20Abi } from "viem";

import type { QuoteAsset } from "../../src/lib/assets/quote-assets";
import { factoryAbi } from "../../src/lib/chain/abis";
import type { EncodedCall } from "../../src/lib/chain/encoded-call";
import type { LaunchChain, LaunchParams } from "../../src/lib/chain/writes";
import {
  draftProblems,
  FIXED_SUPPLY,
  type LaunchDraft,
  submitLaunch,
} from "../../src/lib/launch/submit";

const CREATOR = "0x1111111111111111111111111111111111111111" as const;
const CURVE = "0x2222222222222222222222222222222222222222" as const;
const TOKEN = "0x3333333333333333333333333333333333333333" as const;
const FACTORY = "0x4444444444444444444444444444444444444444" as const;
const RECIPIENT = "0x5555555555555555555555555555555555555555" as const;
const PIN = `0x${"ab".repeat(32)}` as const;
const ZERO = "0x0000000000000000000000000000000000000000";

const MON: QuoteAsset = {
  id: "mon",
  symbol: "MON",
  name: "Monad",
  kind: "native",
  status: "live",
  decimals: 18,
  address: ZERO,
  blurb: "",
};

/** Six decimals, and that is the whole point of having it here. */
const USDC: QuoteAsset = {
  id: "usdc",
  symbol: "USDC",
  name: "USD Coin",
  kind: "stablecoin",
  status: "live",
  decimals: 6,
  address: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
  blurb: "",
};

const draft = (over: Partial<LaunchDraft> = {}): LaunchDraft => ({
  name: "Fork Gold",
  ticker: "GLDF",
  quote: MON,
  supply: FIXED_SUPPLY,
  feeRouting: "creator",
  creatorFee: 0,
  ...over,
});

interface Recorded {
  params: LaunchParams;
  value: bigint;
}

const fakeChain = (over: Partial<LaunchChain> = {}) => {
  const sent: Recorded[] = [];
  const approvals: { token: string; spender: string; amount: bigint }[] = [];
  const pinCalls: { quoteAsset: string; sink: number; creatorTaxBps: number; at: number }[] = [];
  const swaps: { amountIn: bigint; minOut: bigint; at: number }[] = [];
  const batches: { calls: EncodedCall[]; atomic: boolean; at: number }[] = [];
  let clock = 0;
  let held = 0n;
  let delivered = 0n;

  const chain: LaunchChain = {
    account: CREATOR,
    factory: FACTORY,
    launchFee: async () => 10n ** 17n,
    economicsPin: async (quoteAsset, sink, creatorTaxBps) => {
      pinCalls.push({ quoteAsset, sink, creatorTaxBps, at: clock++ });
      return PIN;
    },
    predictMarket: async () => ({ curve: CURVE, token: TOKEN }),
    allowance: async () => 0n,
    approve: async (token, spender, amount) => {
      approvals.push({ token, spender, amount });
      clock++;
      return "0xapprove";
    },
    launch: async (params, value) => {
      sent.push({ params, value });
      clock++;
      return "0xlaunch";
    },
    /* A wallet that starts with none of the pair's asset and receives whatever the swap delivers.
       Overridden per test where the launcher already holds some, which is the case that must not
       be swept into the dev buy. */
    balanceOf: async () => held,
    swapNativeFor: async (params) => {
      swaps.push({ ...params, at: clock++ });
      held += delivered;
      return "0xswap";
    },
    ...over,
  };

  return {
    chain,
    sent,
    approvals,
    pinCalls,
    swaps,
    batches,
    /** What the next swap will deliver, and what the wallet holds before it. */
    setDelivery: (amount: bigint) => {
      delivered = amount;
    },
    setHeld: (amount: bigint) => {
      held = amount;
    },
    /**
     * Turns this port into one belonging to a wallet that batches.
     *
     * The port is the whole reason no node is needed for this: a batched launch is three encoded
     * calls handed to `sendBatch`, and the calls are what the assertions read. Nothing about the
     * sequential members changes, which is the point — a wallet that cannot batch sees the port
     * exactly as it was.
     */
    withBatching: (support: "atomic" | "sequential") => {
      chain.batchSupport = support;
      chain.sendBatch = async (calls, opts) => {
        batches.push({ calls, atomic: opts.atomic, at: clock++ });
        return "0xbatch";
      };
    },
  };
};

describe("submitLaunch", () => {
  it("submits, and answers with the market address", async () => {
    const { chain } = fakeChain();
    const result = await submitLaunch(draft(), chain);

    expect(result.status).toBe("submitted");
    if (result.status !== "submitted") throw new Error("not submitted");
    // `predictMarket(creator)` — known before the transaction lands, so the market page can open
    // the moment it confirms.
    expect(result.marketAddress).toBe(CURVE);
    expect(result.txHash).toBe("0xlaunch");
  });

  /**
   * Percent to basis points, and the multiple-of-ten rule.
   *
   * `creatorTaxBps` is 0-1000 AND a multiple of 10 on chain. The form holds a percent to one
   * decimal place, so `pct * 100` lands on a legal value by construction — 2.5% is 250 bps, which
   * is what makes the constraint invisible rather than a validation rule the launcher trips over.
   */
  it("turns a percent into basis points as pct * 100", async () => {
    const { chain, sent } = fakeChain();
    await submitLaunch(draft({ creatorFee: 2.5 }), chain);

    expect(sent[0].params.creatorTaxBps).toBe(250);
    expect(sent[0].params.creatorTaxBps % 10).toBe(0);
  });

  /**
   * `routedRecipient` and `taxRecipient` are different fields for different money.
   *
   * `routedRecipient` names who receives the market's share of the PROTOCOL fee, and it is
   * meaningful only when the routing is `creator` — a holders or buyback market pays its sink, and
   * naming an address there is either ignored or wrong. `taxRecipient` is who receives the
   * creator's own tax. Collapsing them is how a buyback market ends up paying a wallet.
   */
  it("sends a zero routedRecipient unless the routing is `creator`", async () => {
    const { chain, sent } = fakeChain();

    await submitLaunch(draft({ feeRouting: "holders", creatorFeeRecipient: RECIPIENT }), chain);
    expect(sent[0].params.routedRecipient).toBe(ZERO);
    // The tax recipient is unaffected: it is a different charge with a different destination.
    expect(sent[0].params.taxRecipient).toBe(RECIPIENT);

    await submitLaunch(draft({ feeRouting: "buyback" }), chain);
    expect(sent[1].params.routedRecipient).toBe(ZERO);

    await submitLaunch(draft({ feeRouting: "creator", creatorFeeRecipient: RECIPIENT }), chain);
    expect(sent[2].params.routedRecipient).toBe(RECIPIENT);
  });

  it("maps the routing to the sink the contract uses", async () => {
    const { chain, sent } = fakeChain();
    await submitLaunch(draft({ feeRouting: "buyback" }), chain);
    await submitLaunch(draft({ feeRouting: "holders" }), chain);
    await submitLaunch(draft({ feeRouting: "creator" }), chain);

    expect(sent.map((s) => s.params.sink)).toEqual([0, 1, 2]);
  });

  /**
   * A dev buy is whole units of the QUOTE asset, and the quote decides the scale.
   *
   * 25 USDC is 25_000_000, not 25e18. Scaling by a global 18 would ask the factory to pull
   * twenty-five trillion dollars, which fails on the allowance and reads as a wallet problem.
   */
  it("scales the dev buy by the quote asset's own decimals", async () => {
    const { chain, sent } = fakeChain();

    await submitLaunch(draft({ devBuy: 25 }), chain);
    expect(sent[0].params.firstBuyQuote).toBe(25n * 10n ** 18n);

    await submitLaunch(draft({ quote: USDC, devBuy: 25 }), chain);
    expect(sent[1].params.firstBuyQuote).toBe(25_000_000n);
  });

  /**
   * The value is EXACT, not a minimum.
   *
   * `msg.value == launchFee(sender) + firstBuyQuote` for a native quote. Sending more reverts, so
   * the usual "add a little for safety" instinct is precisely wrong here.
   */
  it("sends exactly the launch fee plus the first buy for a native quote", async () => {
    const { chain, sent } = fakeChain();
    await submitLaunch(draft({ devBuy: 3 }), chain);

    expect(sent[0].value).toBe(10n ** 17n + 3n * 10n ** 18n);
  });

  /**
   * For an ERC-20 quote the first buy is PULLED, and the puller is the factory.
   *
   * Approving the curve is the natural mistake — it is the contract that holds the reserves and the
   * one every later buy approves — and it leaves the launch reverting on an allowance the launcher
   * can see they granted.
   */
  it("sends only the launch fee for an ERC-20 quote, and approves the FACTORY", async () => {
    const { chain, sent, approvals } = fakeChain();
    await submitLaunch(draft({ quote: USDC, devBuy: 25 }), chain);

    expect(sent[0].value).toBe(10n ** 17n);
    expect(approvals).toHaveLength(1);
    expect(approvals[0].token).toBe(USDC.address);
    expect(approvals[0].spender).toBe(FACTORY);
    expect(approvals[0].spender).not.toBe(CURVE);
    expect(approvals[0].amount).toBe(25_000_000n);
  });

  it("does not approve anything when there is no first buy", async () => {
    const { chain, approvals } = fakeChain();
    await submitLaunch(draft({ quote: USDC }), chain);
    expect(approvals).toHaveLength(0);
  });

  /**
   * The pin is read AFTER the approval and immediately before the send.
   *
   * `economicsPin(quoteAsset, sink, creatorTaxBps)` is a commitment to the terms as they stand. An
   * approval is a whole transaction the launcher waits on, so a pin read before it is a pin read
   * across a gap of arbitrary length — and if the launch fee or a sink moved in that gap the
   * transaction reverts `EconomicsChanged()`.
   */
  it("reads the economics pin last, after any approval", async () => {
    const { chain, pinCalls, approvals } = fakeChain();
    await submitLaunch(draft({ quote: USDC, devBuy: 5 }), chain);

    expect(pinCalls).toHaveLength(1);
    expect(approvals).toHaveLength(1);
    expect(pinCalls[0].at).toBeGreaterThan(0);
    expect(pinCalls[0].quoteAsset).toBe(USDC.address);
    expect(pinCalls[0].sink).toBe(2);
    expect(pinCalls[0].creatorTaxBps).toBe(0);
  });

  /**
   * `EconomicsChanged()` is not a failure, it is news.
   *
   * The terms moved between the quote and the send. Nothing is wrong with the draft and nothing was
   * spent; the honest response is to show the new terms and let the launcher press again.
   */
  it("reports EconomicsChanged as the terms having moved, not as a failure", async () => {
    const { chain } = fakeChain({
      launch: async () => {
        throw new Error("execution reverted: custom error 0x... EconomicsChanged()");
      },
    });

    /* Asserted as one object rather than two statements: `LaunchResult` is a union, and only
       four of its five members carry a `reason` — reading the field after a separate
       `expect(...status)` is not a narrowing the compiler can see. */
    const result = await submitLaunch(draft(), chain);
    expect(result).toMatchObject({
      status: "terms-changed",
      reason: expect.stringMatching(/terms/i),
    });
  });

  /** `links.discord` has no on-chain field. It is dropped, and the form says so. */
  it("drops discord, which the metadata struct has no field for", async () => {
    const { chain, sent } = fakeChain();
    await submitLaunch(
      draft({ links: { website: "https://a.example", discord: "https://discord.gg/x" } }),
      chain
    );

    expect(sent[0].params.meta.website).toBe("https://a.example");
    expect(JSON.stringify(sent[0].params.meta)).not.toMatch(/discord/i);
  });

  it("refuses a data: logo rather than sending 30KB into a 128-byte field", async () => {
    const { chain, sent } = fakeChain();
    const result = await submitLaunch(draft({ logo: "data:image/png;base64,iVBORw0KGgo=" }), chain);

    expect(result).toMatchObject({
      status: "rejected",
      reason: expect.stringMatching(/still uploading|not been uploaded|data:/i),
    });
    expect(sent).toHaveLength(0);
  });

  it("never sends when the draft breaks a rule the contract enforces", async () => {
    const { chain, sent } = fakeChain();
    const result = await submitLaunch(draft({ ticker: "GO LD" }), chain);

    expect(result.status).toBe("rejected");
    expect(sent).toHaveLength(0);
  });
});

/**
 * The caps are BYTES, and the difference is not academic.
 *
 * `name` is 2-42 bytes on chain. Twenty-one emoji is twenty-one characters and eighty-four bytes,
 * so a name that looks half the length of the limit is twice it — and the launcher finds out from
 * a revert after everything else is filled in.
 */
describe("the validation the contract actually performs", () => {
  const ok = (over: Partial<LaunchDraft>) => draftProblems(draft(over));

  it("measures the name in bytes, not characters", () => {
    // 42 ASCII characters: exactly the limit.
    expect(ok({ name: "a".repeat(42) })).toEqual([]);
    expect(ok({ name: "a".repeat(43) })).not.toEqual([]);

    // 21 four-byte emoji is 21 characters and 84 bytes.
    expect(ok({ name: "🚀".repeat(21) })).not.toEqual([]);
    // 10 of them is 40 bytes, which fits.
    expect(ok({ name: "🚀".repeat(10) })).toEqual([]);
  });

  it("enforces the ticker's charset and length", () => {
    expect(ok({ ticker: "GLDF" })).toEqual([]);
    expect(ok({ ticker: "GLD-F" })).not.toEqual([]);
    expect(ok({ ticker: "G" })).not.toEqual([]);
    expect(ok({ ticker: "A".repeat(13) })).not.toEqual([]);
    // Digits are allowed; a leading digit is not special.
    expect(ok({ ticker: "W3B3" })).toEqual([]);
  });

  it("refuses DOKU as a name or ticker, in any case or spelling, and nothing that merely contains it", () => {
    const reserved = (over: Partial<LaunchDraft>) =>
      ok(over).some((p) => /reserved/i.test(p));
    for (const ticker of ["DOKU", "doku", "Doku", "D0KU"]) expect(reserved({ ticker })).toBe(true);
    for (const name of ["DOKU", "Doku", " doku ", "$DOKU", "D.O.K.U", "D O K U", "D0KU"]) {
      expect(reserved({ name })).toBe(true);
    }
    // A coin is not barred for having the letters inside a longer word.
    expect(ok({ ticker: "DOKUCAT" })).toEqual([]);
    expect(ok({ name: "Doku Cat" })).toEqual([]);
  });

  it("caps the URIs at 128 bytes and the description at 240", () => {
    expect(ok({ logo: `ipfs://${"a".repeat(121)}` })).toEqual([]);
    expect(ok({ logo: `ipfs://${"a".repeat(122)}` })).not.toEqual([]);
    expect(ok({ description: "d".repeat(240) })).toEqual([]);
    expect(ok({ description: "d".repeat(241) })).not.toEqual([]);
  });

  it("rejects a creator tax that is not a multiple of ten basis points", () => {
    expect(ok({ creatorFee: 2.5 })).toEqual([]);
    // 2.55% is 255 bps, which the contract refuses.
    expect(ok({ creatorFee: 2.55 })).not.toEqual([]);
  });
});

/**
 * Paying for the dev buy in MON, which is the one flow in this app that cannot be one signature.
 *
 * The coin does not exist until the launch creates it, and the factory records `msg.sender` as the
 * creator — so nothing can launch on the launcher's behalf, and the swap has to be its own
 * transaction in front of the ordinary launch.
 */
describe("a dev buy paid for in MON", () => {
  const PATH = [
    {
      intermediateCurrency: "0x754704bc059f8c67012fed69bc8a327a5aafb603" as const,
      fee: 500,
      tickSpacing: 10,
      hooks: "0x0000000000000000000000000000000000000000" as const,
      hookData: "0x" as const,
    },
  ];
  const withMon = (over: Partial<LaunchDraft["devBuyWithMon"]> = {}) => ({
    amountInWei: 5_000n * 10n ** 18n,
    path: PATH,
    minQuoteOut: 120_000_000n,
    ...over,
  });

  it("swaps first, then launches", async () => {
    const { chain, swaps, sent, setDelivery } = fakeChain();
    setDelivery(128_400_000n);

    const result = await submitLaunch(
      draft({ quote: USDC, devBuy: 128.4, devBuyWithMon: withMon() }),
      chain
    );

    expect(result.status).toBe("submitted");
    expect(swaps).toHaveLength(1);
    expect(swaps[0].amountIn).toBe(5_000n * 10n ** 18n);
    expect(swaps[0].minOut).toBe(120_000_000n);
    expect(sent).toHaveLength(1);
  });

  /**
   * The assertion this whole flow turns on. A swap delivers what it delivers, and launching
   * against the ESTIMATE approves and pulls an amount the wallet may not hold — reverting for a
   * shortfall the launcher has already paid for.
   */
  it("buys with what the swap MEASURED, not with what it was quoted", async () => {
    const { chain, sent, approvals, setDelivery } = fakeChain();
    setDelivery(127_000_000n); // the quote said 128.4 USDC; the pool moved

    await submitLaunch(draft({ quote: USDC, devBuy: 128.4, devBuyWithMon: withMon() }), chain);

    expect(sent[0].params.firstBuyQuote).toBe(127_000_000n);
    expect(approvals[0].amount).toBe(127_000_000n);
  });

  /** A launcher who already held some of the pair's asset must not have it swept into the buy. */
  it("spends only what the swap added, not what the wallet already held", async () => {
    const { chain, sent, setDelivery, setHeld } = fakeChain();
    setHeld(1_000_000_000n);
    setDelivery(128_400_000n);

    await submitLaunch(draft({ quote: USDC, devBuy: 128.4, devBuyWithMon: withMon() }), chain);

    expect(sent[0].params.firstBuyQuote).toBe(128_400_000n);
  });

  it("launches nothing when the swap delivered nothing", async () => {
    const { chain, sent, setDelivery } = fakeChain();
    setDelivery(0n);

    const result = await submitLaunch(
      draft({ quote: USDC, devBuy: 128.4, devBuyWithMon: withMon() }),
      chain
    );

    expect(result.status).toBe("failed");
    expect(sent).toHaveLength(0);
  });

  /**
   * The pin is a commitment to the terms as they stand, and the swap is a whole transaction the
   * launcher waits on. Reading it before the swap would read it across a gap of arbitrary length.
   */
  it("still reads the economics pin last, after the swap and the approval", async () => {
    const { chain, pinCalls, swaps, approvals, setDelivery } = fakeChain();
    setDelivery(128_400_000n);

    await submitLaunch(draft({ quote: USDC, devBuy: 128.4, devBuyWithMon: withMon() }), chain);

    expect(swaps[0].at).toBeLessThan(pinCalls[0].at);
    expect(approvals).toHaveLength(1);
  });

  it("says what the launcher is holding when the launch fails after the swap", async () => {
    const { chain, setDelivery } = fakeChain({
      launch: async () => {
        throw new Error("user rejected the request");
      },
    });
    setDelivery(128_400_000n);

    const result = await submitLaunch(
      draft({ quote: USDC, devBuy: 128.4, devBuyWithMon: withMon() }),
      chain
    );

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error("unreachable");
    // Not "nothing was spent" — the swap landed, and telling them otherwise invites a second one.
    expect(result.reason).toContain("128.4 USDC");
    expect(result.reason).not.toContain("Nothing was spent");
  });

  it("never swaps for a MON pair, which keeps its single signature", async () => {
    const { swaps } = fakeChain();
    const problems = draftProblems(draft({ quote: MON, devBuy: 5, devBuyWithMon: withMon() }));
    expect(problems.join(" ")).toContain("MON pair needs no swap");
    expect(swaps).toHaveLength(0);
  });

  it("refuses a route with no hops in it", () => {
    const problems = draftProblems(
      draft({ quote: USDC, devBuy: 1, devBuyWithMon: withMon({ path: [] }) })
    );
    expect(problems.join(" ")).toContain("No route");
  });
});

/**
 * The same dev buy, as ONE wallet prompt.
 *
 * EIP-5792 is not a router and this is the distinction the whole feature rests on: the wallet makes
 * each call itself, so `msg.sender` is the launcher on the swap, the approval and the launch alike,
 * and the factory records the launcher as the creator. A contract doing this would BE the creator
 * and would own the market's creator fees — which is why `pay-with.ts` says no router can serve a
 * launch, and why a batch can.
 */
describe("a MON-funded dev buy sent as one batch", () => {
  const PATH = [
    {
      intermediateCurrency: "0x754704bc059f8c67012fed69bc8a327a5aafb603" as const,
      fee: 500,
      tickSpacing: 10,
      hooks: "0x0000000000000000000000000000000000000000" as const,
      hookData: "0x" as const,
    },
  ];
  const MIN_OUT = 120_000_000n;
  const withMon = (over: Partial<LaunchDraft["devBuyWithMon"]> = {}) => ({
    amountInWei: 5_000n * 10n ** 18n,
    path: PATH,
    minQuoteOut: MIN_OUT,
    ...over,
  });
  const monDraft = () => draft({ quote: USDC, devBuy: 128.4, devBuyWithMon: withMon() });

  it("sends three calls in one batch and nothing on its own", async () => {
    const fake = fakeChain();
    fake.withBatching("atomic");
    fake.setDelivery(128_400_000n);

    const result = await submitLaunch(monDraft(), fake.chain);

    expect(result).toMatchObject({ status: "submitted", marketAddress: CURVE, txHash: "0xbatch" });
    expect(fake.batches).toHaveLength(1);
    expect(fake.batches[0].calls).toHaveLength(3);
    // Not one transaction of any of it: the sequential members of the port are untouched.
    expect(fake.swaps).toHaveLength(0);
    expect(fake.approvals).toHaveLength(0);
    expect(fake.sent).toHaveLength(0);
  });

  /**
   * The assertion the batched path turns on, and the one that would be a money bug to get wrong.
   *
   * The sequential path reads the balance before and after the swap and buys with the DIFFERENCE.
   * A batch cannot read a balance between its own calls, so it buys with `minQuoteOut` — the floor
   * the swap is signed with, which the pool enforces as `amountOutMinimum` inside the transaction.
   * Either at least that much arrives or the swap reverts and nothing downstream of it runs, so
   * the launch can never be short; and because the figure came from this swap rather than from the
   * wallet, nothing the launcher already held is swept into the buy.
   *
   * It is also slightly SMALLER than the measured buy — the overshoot stays in the wallet — which
   * is a real behaviour difference the dev-buy step states on screen.
   */
  it("buys with the swap's guaranteed minimum, not with the quote and not with a balance", async () => {
    const fake = fakeChain();
    fake.withBatching("atomic");
    // The launcher already holds a fortune in the pair's asset, and the swap over-delivers against
    // its floor. Neither figure may reach the first buy.
    fake.setHeld(1_000_000_000n);
    fake.setDelivery(128_400_000n);

    await submitLaunch(monDraft(), fake.chain);

    const launch = fake.batches[0].calls[2];
    const decoded = decodeFunctionData({ abi: factoryAbi, data: launch.data });
    const params = (decoded.args as unknown as readonly LaunchParams[])[0];
    expect(decoded.functionName).toBe("launch");
    expect(params.firstBuyQuote).toBe(MIN_OUT);
    // 128.4 USDC was the ESTIMATE and 1,000 USDC was already in the wallet. Neither is the buy.
    expect(params.firstBuyQuote).not.toBe(128_400_000n);
    expect(params.firstBuyQuote).not.toBe(1_000_000_000n);
  });

  it("approves exactly that minimum, and approves the FACTORY", async () => {
    const fake = fakeChain();
    fake.withBatching("atomic");

    await submitLaunch(monDraft(), fake.chain);

    const approve = fake.batches[0].calls[1];
    expect(approve.to).toBe(USDC.address);
    const decoded = decodeFunctionData({ abi: erc20Abi, data: approve.data });
    expect(decoded.functionName).toBe("approve");
    // Exact, not max: this allowance has no life after the launch that spends it.
    expect(decoded.args).toEqual([FACTORY, MIN_OUT]);
  });

  it("carries the MON on the swap and the launch fee on the launch", async () => {
    const fake = fakeChain();
    fake.withBatching("atomic");

    await submitLaunch(monDraft(), fake.chain);

    const [swap, approve, launch] = fake.batches[0].calls;
    expect(swap.value).toBe(5_000n * 10n ** 18n);
    expect(approve.value).toBeUndefined();
    // The fee ALONE. A batched launch is never a native-quote launch, so no first buy rides in
    // `msg.value` — and the value is exact, because the factory reverts on more.
    expect(launch.value).toBe(10n ** 17n);
  });

  /**
   * The pin is read last, before the send, exactly as on every other path.
   *
   * It is a commitment to the terms as they stand. Here the gap it spans is a single round trip
   * rather than two whole transactions the launcher waits on, which makes it stricter rather than
   * looser — but the ORDER is the load-bearing part and it does not change.
   */
  it("still reads the economics pin last, immediately before the batch", async () => {
    const fake = fakeChain();
    fake.withBatching("atomic");

    await submitLaunch(monDraft(), fake.chain);

    expect(fake.pinCalls).toHaveLength(1);
    expect(fake.batches).toHaveLength(1);
    expect(fake.pinCalls[0].at).toBeLessThan(fake.batches[0].at);
    expect(fake.pinCalls[0].quoteAsset).toBe(USDC.address);
  });

  it("asks for atomicity only where the wallet promised it", async () => {
    // `atomicRequired` against a wallet that batches sequentially is a REFUSAL, so asking blindly
    // would turn a working one-prompt launch into an error.
    const atomic = fakeChain();
    atomic.withBatching("atomic");
    await submitLaunch(monDraft(), atomic.chain);
    expect(atomic.batches[0].atomic).toBe(true);

    const sequential = fakeChain();
    sequential.withBatching("sequential");
    await submitLaunch(monDraft(), sequential.chain);
    expect(sequential.batches[0].atomic).toBe(false);
  });

  /** A launch with nothing to swap has nothing to batch, and a batch of one call is worse. */
  it("does not batch a launch with no MON-funded dev buy", async () => {
    const fake = fakeChain();
    fake.withBatching("atomic");

    await submitLaunch(draft({ quote: USDC, devBuy: 25 }), fake.chain);
    await submitLaunch(draft({ devBuy: 3 }), fake.chain);

    expect(fake.batches).toHaveLength(0);
    expect(fake.sent).toHaveLength(2);
  });

  /**
   * The fallback, which is the whole safety property: a wallet that cannot batch must see the
   * three-transaction launch exactly as it is today.
   */
  it("takes the three-transaction path when the port carries no batching", async () => {
    const fake = fakeChain();
    fake.setDelivery(128_400_000n);

    await submitLaunch(monDraft(), fake.chain);

    expect(fake.batches).toHaveLength(0);
    expect(fake.swaps).toHaveLength(1);
    expect(fake.approvals).toHaveLength(1);
    // And it buys with the MEASURED delivery, not with the floor — that path is unchanged.
    expect(fake.sent[0].params.firstBuyQuote).toBe(128_400_000n);
  });

  /** A port that says it batches but hands over no sender is not a port that can batch. */
  it("falls back when the capability is claimed but nothing can send it", async () => {
    const fake = fakeChain({ batchSupport: "atomic" });
    fake.setDelivery(128_400_000n);

    const result = await submitLaunch(monDraft(), fake.chain);

    expect(result.status).toBe("submitted");
    expect(fake.swaps).toHaveLength(1);
    expect(fake.sent).toHaveLength(1);
  });

  it("says a sequential batch may have partly landed, and an atomic one did not", async () => {
    /*
     * After a failure the two are genuinely different states. An atomic batch landed all three
     * calls or none, so "nothing was spent" is true. A sequential one can have landed a prefix —
     * a swap, or a swap and an approval — and telling that launcher nothing was spent invites them
     * to swap a second time.
     */
    const boom = async () => {
      throw new Error("execution reverted");
    };

    const sequential = fakeChain();
    sequential.withBatching("sequential");
    sequential.chain.sendBatch = boom;
    const partial = await submitLaunch(monDraft(), sequential.chain);
    expect(partial).toMatchObject({
      status: "failed",
      reason: expect.stringMatching(/part of it may have|batch/i),
    });
    if (partial.status !== "failed") throw new Error("unreachable");
    expect(partial.reason).toContain("USDC");

    const atomic = fakeChain();
    atomic.withBatching("atomic");
    atomic.chain.sendBatch = boom;
    const allOrNothing = await submitLaunch(monDraft(), atomic.chain);
    if (allOrNothing.status !== "failed") throw new Error("unreachable");
    expect(allOrNothing.reason).not.toMatch(/part of it may have/i);
  });

  it("reports a cancelled batch as a cancellation, with nothing spent", async () => {
    // One prompt covers all three calls and it precedes every one of them, so a rejection really
    // is a rejection of the whole thing.
    const fake = fakeChain();
    fake.withBatching("atomic");
    fake.chain.sendBatch = async () => {
      throw new Error("user rejected the request");
    };

    const result = await submitLaunch(monDraft(), fake.chain);
    expect(result).toMatchObject({
      status: "rejected",
      reason: expect.stringContaining("Nothing was spent"),
    });
  });
});
