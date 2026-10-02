/**
 * @jest-environment node
 */
import { MONAD_RESERVE_WEI } from "../../src/lib/chain/monad-reserve";
import {
  APPROVAL_GAS_HEADROOM,
  formatMon,
  formatQuote,
  LAUNCH_GAS_HEADROOM,
  launchAffordability,
  launchFeeLabel,
  SWAP_GAS_HEADROOM,
} from "../../src/lib/launch/cost";

const mon = (n: string) => BigInt(Math.round(Number(n) * 1e6)) * 10n ** 12n;

/** The fee the owner raised it to. Every figure below is sized against this one. */
const FEE = mon("10");

describe("printing the launch fee", () => {
  it("shows the fee in MON, without the zeros it does not have", () => {
    expect(launchFeeLabel(FEE)).toBe("10 MON");
    expect(launchFeeLabel(mon("0.01"))).toBe("0.01 MON");
  });

  /**
   * The one thing the rail must never print while the read is in flight. "Gas only" was the string
   * this replaced, and a zero would be read as the fee rather than as the absence of an answer.
   */
  it("shows a placeholder, not a number, before the chain has answered", () => {
    expect(launchFeeLabel(undefined)).toBe("—");
    expect(launchFeeLabel(undefined)).not.toMatch(/0/);
  });

  /** `feeExempt[who]` returns a real zero, which is good news and not a missing read. */
  it("names an exempt account's zero rather than showing it as a figure", () => {
    expect(launchFeeLabel(0n)).toBe("Free");
  });

  it("groups an amount somebody has to compare against a balance", () => {
    expect(formatMon(mon("1500"))).toBe("1,500");
  });
});

describe("whether a wallet can pay for a launch", () => {
  it("says nothing at all until both the balance and the fee are known", () => {
    expect(launchAffordability({ balance: undefined, launchFee: FEE, nativeFirstBuy: 0n })).toEqual(
      {
        spend: FEE,
        verdict: null,
        blockedReason: null,
        warning: null,
        ledger: null,
        quoteLedger: null,
      }
    );
    expect(
      launchAffordability({ balance: mon("1"), launchFee: undefined, nativeFirstBuy: 0n })
    ).toEqual({
      spend: 0n,
      verdict: null,
      blockedReason: null,
      warning: null,
      ledger: null,
      quoteLedger: null,
    });
  });

  it("leaves a wallet that clears the reserve alone", () => {
    const result = launchAffordability({
      balance: mon("100"),
      launchFee: FEE,
      nativeFirstBuy: mon("5"),
    });
    expect(result.verdict).toBe("safe");
    expect(result.blockedReason).toBeNull();
    expect(result.warning).toBeNull();
  });

  /**
   * The case the fee rise creates: enough for the fee, enough for the gas, and still refused.
   *
   * BLOCKED rather than warned, which is where a launch parts company with a trade. A trade can
   * qualify for Monad's emptying exemption — it goes through when the wallet has not moved for a
   * few blocks — so the panel warns and lets the trader decide. A launch never can: the exemption
   * needs the transaction to spend the account to zero and a launch sends an exact `msg.value`.
   * There is no risk to weigh, only a revert to pay the gas limit for.
   */
  it("blocks the fifteen-MON wallet that a ten-MON fee leaves under the reserve", () => {
    const result = launchAffordability({
      balance: mon("15"),
      launchFee: FEE,
      nativeFirstBuy: 0n,
    });
    expect(result.verdict).toBe("emptying");
    expect(result.blockedReason).not.toBeNull();
    /* The headline names everything the wallet has to hold, not the chain's floor alone —
       somebody who reads "10" and tops up to 12 is still blocked. */
    expect(result.warning?.title).toBe(
      `${formatMon(MONAD_RESERVE_WEI + FEE + LAUNCH_GAS_HEADROOM)} $MON minimum balance`
    );
    expect(result.warning?.total).toBe(
      `${formatMon(MONAD_RESERVE_WEI + FEE + LAUNCH_GAS_HEADROOM)} MON`
    );
  });

  /**
   * One sentence on the button, in both refusals.
   *
   * It said `Need X MON to launch` when the balance could not cover the spend at all and `Add Y MON
   * to clear the 10 MON reserve` when it could but would land under the reserve — two verbs, two
   * quantities, and the second naming a chain rule in a label with room for four words. The number
   * a launcher needs in either state is the same: everything the launch spends, plus the ten MON
   * the chain will not let them drop below.
   */
  it("names one total on the button, whichever way the balance falls short", () => {
    const needed = formatMon(MONAD_RESERVE_WEI + FEE + LAUNCH_GAS_HEADROOM);
    const short = launchAffordability({ balance: mon("5"), launchFee: FEE, nativeFirstBuy: 0n });
    const dipping = launchAffordability({ balance: mon("15"), launchFee: FEE, nativeFirstBuy: 0n });

    expect(short.verdict).toBe("insufficient");
    expect(dipping.verdict).toBe("emptying");
    expect(short.blockedReason).toBe(`Need ${needed} MON to launch`);
    expect(dipping.blockedReason).toBe(`Need ${needed} MON to launch`);
  });

  /** A wallet that clears the reserve is neither blocked nor warned — the ordinary path. */
  it("leaves a launch that clears the reserve completely alone", () => {
    const result = launchAffordability({
      balance: mon("40"),
      launchFee: FEE,
      nativeFirstBuy: 0n,
    });
    expect(result.verdict).toBe("safe");
    expect(result.blockedReason).toBeNull();
    expect(result.warning).toBeNull();
  });

  /** The total counts the reserve, not just what leaves the wallet. */
  it("counts the reserve in what the button asks for", () => {
    const result = launchAffordability({ balance: mon("15"), launchFee: FEE, nativeFirstBuy: 0n });
    expect(result.blockedReason).toContain(
      formatMon(MONAD_RESERVE_WEI + FEE + LAUNCH_GAS_HEADROOM)
    );
    expect(result.blockedReason).not.toContain("reserve");
  });

  /**
   * The fee is read, never written in.
   *
   * `launchFee(who)` is owner-tunable with per-account exemptions, so a notice that hard-codes
   * "10 MON" is wrong for an exempt account and wrong the day the owner moves the number.
   */
  it("names the launch fee at whatever the chain says it is", () => {
    const result = launchAffordability({
      balance: mon("12"),
      launchFee: mon("2.5"),
      nativeFirstBuy: 0n,
    });
    expect(result.verdict).toBe("emptying");
    expect(result.warning?.parts).toContainEqual({ label: "Launch fee", value: "2.5 MON" });
  });

  /**
   * An exempt account is not told to hold a fee it does not pay.
   *
   * It takes a dev buy to get there at all: with the fee waived and nothing bought, a launch spends
   * no native MON, and `reserveVerdict` calls a zero spend safe because a transaction that does not
   * decrement the balance cannot dip below the reserve.
   */
  it("drops the fee clause when the account is exempt", () => {
    const result = launchAffordability({
      balance: mon("12"),
      launchFee: 0n,
      nativeFirstBuy: mon("3"),
    });
    expect(result.verdict).toBe("emptying");
    const labels = result.warning?.parts.map((p) => p.label) ?? [];
    expect(labels).not.toContain("Launch fee");
    expect(labels).toContain("Dev buy");
  });

  /** The dev buy is only part of what the balance has to cover when there is one. */
  it("names the dev buy only when there is one", () => {
    const shared = { balance: mon("18"), launchFee: FEE };
    const labels = (n: bigint) =>
      launchAffordability({ ...shared, nativeFirstBuy: n }).warning?.parts.map((p) => p.label) ??
      [];
    expect(labels(mon("2"))).toContain("Dev buy");
    expect(labels(0n)).not.toContain("Dev buy");
  });

  /** Gas is always in the ledger, and always marked as the estimate it is. */
  it("carries gas as an approximation", () => {
    const result = launchAffordability({ balance: mon("15"), launchFee: FEE, nativeFirstBuy: 0n });
    expect(result.warning?.parts).toContainEqual({
      label: "Gas",
      value: `~${formatMon(LAUNCH_GAS_HEADROOM)} MON`,
    });
  });

  it("blocks, rather than warns, when the fee and its gas exceed the balance", () => {
    const result = launchAffordability({ balance: mon("5"), launchFee: FEE, nativeFirstBuy: 0n });
    expect(result.verdict).toBe("insufficient");
    expect(result.warning).toBeNull();
    expect(result.blockedReason).toBe(
      `Need ${formatMon(MONAD_RESERVE_WEI + FEE + LAUNCH_GAS_HEADROOM)} MON to launch`
    );
  });

  /**
   * On a MON pair the first buy rides along in `msg.value`, so it is spent whether or not the fee
   * alone would have fitted.
   */
  it("counts a native first buy against the balance", () => {
    const shared = { balance: mon("40"), launchFee: FEE };
    expect(launchAffordability({ ...shared, nativeFirstBuy: 0n }).verdict).toBe("safe");
    expect(launchAffordability({ ...shared, nativeFirstBuy: mon("25") }).verdict).toBe("emptying");
    expect(launchAffordability({ ...shared, nativeFirstBuy: mon("35") }).verdict).toBe(
      "insufficient"
    );
  });

  /** An ERC-20 pair pulls the first buy as a token, so none of it comes out of the MON balance. */
  it("charges nothing for a first buy the launch pulls as a token", () => {
    const result = launchAffordability({
      balance: mon("21"),
      launchFee: FEE,
      nativeFirstBuy: 0n,
    });
    expect(result.spend).toBe(FEE);
    expect(result.verdict).toBe("safe");
  });

  /**
   * The headroom is a limit times a ceiling because Monad bills the LIMIT — and it has to be
   * enough for a transaction that deploys two contracts, not for the buy that follows one.
   */
  it("holds back a launch's worth of gas, not a buy's", () => {
    expect(LAUNCH_GAS_HEADROOM).toBe(3_000_000n * 300n * 10n ** 9n);
    expect(LAUNCH_GAS_HEADROOM).toBeGreaterThan(mon("0.5"));
  });
});

/**
 * A dev buy the factory PULLS, in the pair's own asset.
 *
 * The case the launch form offered a key for and then had no arithmetic behind. `PENGU/WBTC` funded
 * in WBTC spends no MON on the buy at all, so the MON requirement gets *smaller* — and a second
 * requirement appears that Monad's reserve has nothing to say about.
 */
describe("a dev buy funded in the pair's own asset", () => {
  const usdc = (whole: string) => BigInt(Math.round(Number(whole) * 1e6));
  const buy = (over: Partial<{ amount: bigint; balance: bigint | undefined }> = {}) => ({
    symbol: "USDC",
    decimals: 6,
    amount: usdc("250"),
    balance: usdc("1000"),
    ...over,
  });

  it("leaves the MON side to the fee and the gas, because the buy does not touch it", () => {
    const result = launchAffordability({
      balance: mon("25"),
      launchFee: FEE,
      // Zero: the launch pulls the buy as a token. This is the figure that used to be the only one
      // this function knew about, and the reason a token-funded buy was invisible to it.
      nativeFirstBuy: 0n,
      quoteBuy: buy(),
    });
    expect(result.spend).toBe(FEE);
    expect(result.verdict).toBe("safe");
    expect(result.warning).toBeNull();
    expect(result.ledger?.parts.map((p) => p.label)).not.toContain("Dev buy");
  });

  it("counts the approval it has to sign first, which is MON out of the same balance", () => {
    const shared = { balance: mon("25"), launchFee: FEE, nativeFirstBuy: 0n };
    const withBuy = launchAffordability({ ...shared, quoteBuy: buy() });
    const without = launchAffordability(shared);
    expect(withBuy.ledger?.parts).toContainEqual({
      label: "Gas + approval",
      value: `~${formatMon(LAUNCH_GAS_HEADROOM + APPROVAL_GAS_HEADROOM)} MON`,
    });
    expect(without.ledger?.parts).toContainEqual({
      label: "Gas",
      value: `~${formatMon(LAUNCH_GAS_HEADROOM)} MON`,
    });
  });

  it("keeps its own ledger rather than adding a foreign unit to the MON one", () => {
    const result = launchAffordability({
      balance: mon("25"),
      launchFee: FEE,
      nativeFirstBuy: 0n,
      quoteBuy: buy(),
    });
    expect(result.quoteLedger).toEqual({
      symbol: "USDC",
      held: "1,000 USDC",
      spend: "250 USDC",
      remaining: "750 USDC",
      shortfall: null,
      clears: true,
    });
    // Every figure in the MON list is MON. That is what makes its total checkable.
    for (const part of result.ledger?.parts ?? []) expect(part.value).toContain("MON");
  });

  it("holds the button when the wallet is short of the asset, and names the asset", () => {
    const result = launchAffordability({
      balance: mon("40"),
      launchFee: FEE,
      nativeFirstBuy: 0n,
      quoteBuy: buy({ balance: usdc("210") }),
    });
    // MON is fine. Reporting this as a reserve problem would send somebody who is 40 USDC short
    // off to buy MON.
    expect(result.verdict).toBe("safe");
    expect(result.warning).toBeNull();
    expect(result.quoteLedger?.clears).toBe(false);
    expect(result.quoteLedger?.shortfall).toBe("40 USDC");
    expect(result.blockedReason).toBe("Need 40 USDC for the dev buy");
  });

  /** A balance this app has not read is not a balance of zero — refusing on it refuses on our own
   *  ignorance, and the wallet knows the truth a moment later. */
  it("claims nothing while the balance read is in flight", () => {
    const result = launchAffordability({
      balance: mon("40"),
      launchFee: FEE,
      nativeFirstBuy: 0n,
      quoteBuy: buy({ balance: undefined }),
    });
    expect(result.quoteLedger?.held).toBeNull();
    expect(result.quoteLedger?.clears).toBe(true);
    expect(result.blockedReason).toBeNull();
  });

  it("answers about the buy before the MON reads have landed", () => {
    const result = launchAffordability({
      balance: undefined,
      launchFee: undefined,
      nativeFirstBuy: 0n,
      quoteBuy: buy({ balance: usdc("10") }),
    });
    expect(result.ledger).toBeNull();
    expect(result.blockedReason).toBe("Need 240 USDC for the dev buy");
  });

  it("has no second ledger at all when there is no buy to pull", () => {
    expect(
      launchAffordability({
        balance: mon("25"),
        launchFee: FEE,
        nativeFirstBuy: 0n,
        quoteBuy: buy({ amount: 0n }),
      }).quoteLedger
    ).toBeNull();
  });

  it("reads an amount at the asset's own decimals", () => {
    // 0.05 cbBTC at eight decimals, not 5e-14 of one.
    expect(formatQuote(5_000_000n, 8)).toBe("0.05");
    expect(formatQuote(1_500_000_000n, 6)).toBe("1,500");
  });
});

/**
 * The swap in front of a dev buy funded in MON.
 *
 * The MON it swaps was already counted as the dev buy. What was not counted anywhere is the cost of
 * running that transaction, which is billed in MON from the same balance before the launch is
 * signed — and which is why the presets row has to leave room for two transactions, not one.
 */
describe("a dev buy funded in MON on a pair that is not MON", () => {
  it("counts the swap's own gas as well as the launch's", () => {
    const shared = { balance: mon("40"), launchFee: FEE, nativeFirstBuy: mon("5") };
    expect(launchAffordability({ ...shared, swapFirst: true }).ledger?.parts).toContainEqual({
      label: "Gas + swap",
      value: `~${formatMon(LAUNCH_GAS_HEADROOM + SWAP_GAS_HEADROOM)} MON`,
    });
    expect(launchAffordability(shared).ledger?.parts).toContainEqual({
      label: "Gas",
      value: `~${formatMon(LAUNCH_GAS_HEADROOM)} MON`,
    });
  });

  it("asks for more MON than the same launch without a swap in front of it", () => {
    const shared = { balance: mon("22"), launchFee: FEE, nativeFirstBuy: mon("1") };
    const withSwap = launchAffordability({ ...shared, swapFirst: true });
    const without = launchAffordability(shared);
    expect(without.verdict).toBe("safe");
    expect(withSwap.verdict).toBe("emptying");
  });
});
