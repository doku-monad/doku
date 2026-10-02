import { formatUnits } from "viem";

import {
  MONAD_RESERVE_WEI,
  nativeGasHeadroom,
  type ReserveVerdict,
  reserveVerdict,
} from "@/lib/chain/monad-reserve";

/**
 * What a launch costs in MON, and whether this wallet can actually pay it.
 *
 * ## The fee is not a constant and never was
 *
 * `DokuFactory.launchFee(who)` answers `feeExempt[who] ? 0 : launchFeeWei` — an owner-tunable
 * number with per-account exemptions on top of it. The rail printed "Gas only", which was true of
 * a 0.01 MON fee in the same way that "free" is true of a rounding error, and stopped being true
 * of anything the moment the owner raised it to 10 MON. Nothing here compiles a number in: the fee
 * arrives from the chain, keyed on the launcher, and until it does there is no fee to print.
 *
 * ## Why the reserve bites here harder than anywhere else
 *
 * Monad refuses a balance-decrementing transaction that would end below **10 MON**, and the one
 * exemption — the emptying transaction — is for a transaction that spends the account down to
 * nothing. A launch sends an exact value (`launchFee`, plus the first buy on a MON pair) and can
 * never be that transaction, so a launch that ends below the reserve reverts. With the fee at 10
 * MON this is not an edge: a wallet holding fifteen MON has enough for the fee, enough for the
 * gas, and cannot launch at all.
 *
 * ## And why it still warns rather than refuses
 *
 * The gas figure below is an assumption about a transaction that has not been built yet, not a
 * measurement of one. Blocking on `spend + gas > balance` refuses only launches that are short
 * before gas is even argued about; blocking on the reserve as well would refuse launches on the
 * strength of a number this file made up. So the shortfall blocks and the dip warns — the same
 * split the trade panel makes, for the same reason.
 */

/**
 * Gas to hold back from a launch, in MON.
 *
 * A launch is not a curve buy. The factory deploys the token and the curve, writes the market's
 * economics, and on a dev buy runs the first buy through the curve inside the same transaction —
 * millions of gas against the ~131,000 a later buy measures. Monad bills the LIMIT rather than the
 * consumption, so this is a limit times a ceiling and not an estimate of what will be spent.
 *
 * Generous on purpose. Being wrong low here blocks nothing and warns nobody, and the launcher
 * finds out from a revert.
 */
export const LAUNCH_GAS_HEADROOM = nativeGasHeadroom(3_000_000n, 300_000_000_000n);

/**
 * Gas for the ERC-20 approval a token-funded dev buy needs first.
 *
 * A dev buy paid in the pair's own asset is not sent with the launch — the factory *pulls* it, so
 * the launcher approves the factory in a transaction of its own before signing anything. That
 * transaction costs MON, from the same balance the fee comes out of, and it is the reason a
 * USDC-funded launch needs marginally more MON than a fee-only one rather than exactly the fee.
 *
 * 80,000 against a measured ~46,000, at the same price ceiling as everything else here. Over on
 * purpose: `submitLaunch` skips the approval entirely when the existing allowance already covers
 * the buy, so this is a reservation that is often not spent at all.
 */
export const APPROVAL_GAS_HEADROOM = nativeGasHeadroom(80_000n, 300_000_000_000n);

/**
 * Gas for the swap that funds a dev buy paid in MON.
 *
 * The other extra transaction, and the mirror of the one above: a launcher who chose MON on a
 * USDC pair signs a swap first, because the coin does not exist yet and no router can launch on
 * their behalf — see `lib/launch/pay-with`. The MON it swaps was already counted as the dev buy;
 * this is what the swap itself costs to run, which was not counted anywhere.
 *
 * 400,000 covers a multi-hop route. A single-hop swap is closer to half that.
 */
export const SWAP_GAS_HEADROOM = nativeGasHeadroom(400_000n, 300_000_000_000n);

/**
 * MON, at the precision the rail reads at.
 *
 * Four decimals and no trailing zeros, so a 10 MON fee is "10" and not "10.0000" — the same shape
 * the dev-buy row prints its estimate in. Grouped above a thousand because these are amounts
 * somebody is about to compare against their balance.
 */
export function formatMon(wei: bigint): string {
  const amount = Number(formatUnits(wei, 18));
  return amount.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

/**
 * An amount of the pair's own asset, at the precision that asset is traded at.
 *
 * `formatMon` for anything that is not MON. The decimals are the QUOTE's — six for USDC and gold,
 * eight for cbBTC, eighteen for MON — and a figure scaled by a global 18 is off by twelve orders
 * of magnitude for half the registry. The fraction budget follows the size rather than the token:
 * four places reads a stablecoin correctly and rounds a cbBTC dev buy to nothing, so anything
 * under one whole unit gets eight.
 */
export function formatQuote(raw: bigint, decimals: number): string {
  const amount = Number(formatUnits(raw, decimals));
  return amount.toLocaleString(undefined, {
    maximumFractionDigits: amount >= 1 ? 4 : 8,
  });
}

/**
 * The summary rail's launch-fee row.
 *
 * `undefined` is the read still being in flight, and it renders as the rail's own placeholder —
 * never as a number, because every number it could invent is a claim about money. Zero is a real
 * answer that only an exempt account gets, and "Free" says so rather than leaving a bare 0 to be
 * read as "not loaded yet".
 */
export function launchFeeLabel(fee: bigint | undefined): string {
  if (fee === undefined) return "—";
  if (fee === 0n) return "Free";
  return `${formatMon(fee)} MON`;
}

/**
 * The reserve notice: a heading and a sentence, not one paragraph.
 *
 * It was a single string, and it was written as an explanation of the chain — Monad's reserve, the
 * emptying exemption, why a launch cannot be one, then an amount to add. Four clauses of mechanism
 * in front of the one thing the reader has to act on, in a tinted box above a button that is
 * already held.
 *
 * Split, it can be *designed*: the heading names the rule in four words at display size, where a
 * heading is read; the body says what the balance has to cover, naming the rows of the summary rail
 * directly above it so the reader can check each one on screen. Which is also why this is a shape
 * rather than a string — a component cannot set a heading apart from a paragraph it was handed
 * glued together.
 *
 * The amount to add is not in here. It is the button's label, which `blockedReason` carries, and
 * the button is the thing being reached for; saying it twice in adjacent objects is a page arguing
 * with itself.
 */
export interface LaunchWarning {
  /** The rule, as a headline. Names the number rather than the mechanism. */
  title: string;
  /** One sentence. Everything else is the ledger. */
  body: string;
  /**
   * What the balance has to cover, itemised.
   *
   * A ledger rather than a sentence with three `+` signs in it. Somebody reading this is about to
   * go and find money, and "10 MON reserve + Launch fee (10 MON) + Dev buy" is arithmetic they have
   * to do in their head before they know how much — while the rail eighteen pixels above is already
   * a ruled list of label-and-figure rows. Same object, same reading.
   */
  parts: { label: string; value: string }[];
  /** The sum of `parts`, as the figure the headline names. */
  total: string;
}

/**
 * The whole of a launch's MON arithmetic, whether or not anything is wrong with it.
 *
 * ## Why this exists separately from `LaunchWarning`
 *
 * The warning is a *fault*: it appears when a launch cannot be signed, and it disappears the
 * moment the wallet clears. That made the reserve rule something a launcher only ever met by
 * being refused — the one moment they are least able to learn from it, and the reason the dev-buy
 * step had to defend itself with a locked control and a sentence about three deductions it never
 * showed the numbers for.
 *
 * The ledger is the *state*. It is available as soon as the balance and the fee are known, it says
 * the same thing in the same rows whether the launch clears or not, and the only difference
 * between the two cases is the last row: what is left afterwards, or how much is missing.
 *
 * Somebody deciding how large a dev buy to make is doing this sum. Showing it is the whole job.
 */
export interface LaunchLedger {
  /** What the wallet holds now. */
  held: string;
  /**
   * What the balance has to cover, itemised — the reserve first, then everything spent.
   *
   * The same array `LaunchWarning.parts` carries, because they are the same ledger read in two
   * moods and two lists that can disagree is how a form ends up contradicting itself.
   */
  parts: { label: string; value: string }[];
  /** Reserve + fee + buy + gas: the least this wallet may hold and still sign. */
  minimum: string;
  /** What the wallet is left holding once the launch lands. `null` when it cannot land. */
  remaining: string | null;
  /** What still has to arrive. `null` once the launch clears. */
  shortfall: string | null;
  /** Whether the launch, as configured, can be signed. */
  clears: boolean;
}

/**
 * The dev buy's OWN ledger, when the buy is funded in the pair's asset rather than in MON.
 *
 * ## Why it is a second list and not four more rows in the first one
 *
 * Because the two do not add up. `LaunchLedger` is a single column of MON that ends in a total,
 * and it is only meaningful because every row in it is the same unit: reserve, fee, buy, gas, and
 * the floor they have to clear together. A launcher funding a PENGU/WBTC dev buy in WBTC is
 * spending two assets on two different rules — MON for the fee and the gas, against a chain floor;
 * WBTC for the buy, against nothing but what they hold — and a list that put `0.004 WBTC` between
 * `10 MON` and `~0.9 MON` would be a total nobody could check.
 *
 * So the panel carries two ledgers with two totals, and the reserve appears in exactly one of them.
 * That is also the answer to what the reserve "becomes" for a token-funded buy: nothing. Monad's
 * floor is a rule about the native balance, and a buy that never touches the native balance cannot
 * be measured against it. What changes is the MON side getting *smaller* — the buy leaves it — and
 * the requirement moving here.
 *
 * ## Why an unknown balance clears
 *
 * `held` is `null` when the registry row carries no address, or before the read lands. Refusing a
 * launch on a balance this app has not read is refusing it on our own ignorance, and the wallet
 * knows the truth a moment later. Unknown is shown as unknown and blocks nothing.
 */
export interface QuoteLedger {
  /** The asset's ticker, for every figure below. */
  symbol: string;
  /** What the wallet holds. `null` when it has not been read. */
  held: string | null;
  /** What the launch will pull. */
  spend: string;
  /** What is left afterwards. `null` when the balance is unknown, or when it will not cover it. */
  remaining: string | null;
  /** What still has to arrive. `null` once it clears, and while the balance is unknown. */
  shortfall: string | null;
  /** Whether the wallet can pay for the buy. An unknown balance counts as clearing — see above. */
  clears: boolean;
}

export interface LaunchAffordability {
  /** Native MON the launch moves, gas excluded. */
  spend: bigint;
  /** `null` until both the balance and the fee are known — a pending read blocks nothing. */
  verdict: ReserveVerdict | null;
  /** Short enough to be the button's label. Non-null only when the launch cannot be paid for. */
  blockedReason: string | null;
  /** Names the rule the launch fell foul of, beside the button that states the remedy. */
  warning: LaunchWarning | null;
  /**
   * The sum, always — see `LaunchLedger`.
   *
   * `null` only while a read is in flight, or when the launch moves no MON at all: a launch with
   * an exempt fee and no dev buy cannot dip below the reserve, and a panel explaining a rule that
   * cannot bite is noise on the one screen somebody is trying to finish.
   */
  ledger: LaunchLedger | null;
  /**
   * The same sum for the pair's own asset, when that is what funds the buy — see `QuoteLedger`.
   *
   * `null` on every launch whose dev buy is paid in MON, which includes every MON pair: there is
   * no second asset to account for, and a panel with an empty second half is a panel that has been
   * built for a case rather than for a reader.
   */
  quoteLedger: QuoteLedger | null;
}

/**
 * @param nativeFirstBuy MON the buy takes out of the wallet, which is not always the first buy.
 *   On a MON pair it is the first buy itself, sent with the launch. On an ERC-20 pair the launch
 *   pulls the first buy as a token and this is zero — unless the launcher is paying for it in MON,
 *   in which case the swap in front of the launch spends that MON from the same balance and the
 *   launch has to be affordable with it already gone.
 * @param quoteBuy the dev buy the factory will PULL as a token, and what the wallet holds of it.
 *   Present only where the buy is funded in the pair's own asset — the case this used to have no
 *   answer for at all. `nativeFirstBuy` and this are mutually exclusive by construction: a buy is
 *   funded in one asset, and whichever it is, the other side of this function goes quiet.
 * @param swapFirst whether a swap runs in front of the launch, which is true exactly when a dev buy
 *   on a non-MON pair is funded in MON. The MON it swaps is already counted as `nativeFirstBuy`;
 *   this adds what running that transaction costs, which nothing was counting.
 */
export function launchAffordability(input: {
  balance: bigint | undefined;
  launchFee: bigint | undefined;
  nativeFirstBuy: bigint;
  quoteBuy?: {
    symbol: string;
    decimals: number;
    /** Raw units the launch will pull. Zero where there is no dev buy. */
    amount: bigint;
    /** Raw units held. `undefined` is a read in flight, not a zero — see `QuoteLedger`. */
    balance: bigint | undefined;
  } | null;
  swapFirst?: boolean;
  gas?: bigint;
}): LaunchAffordability {
  const buy = input.quoteBuy && input.quoteBuy.amount > 0n ? input.quoteBuy : null;

  /*
   * Gas is the launch's, plus whatever else this funding choice makes the launcher sign.
   *
   * It was `LAUNCH_GAS_HEADROOM` flat, which is the right number for the only flow that existed
   * when it was written: one transaction, sent from the same wallet, in MON. Both of the funding
   * routes now on the form put a second transaction in front of it — an approval for a buy the
   * factory pulls, a swap for a buy paid in MON — and both are billed in MON, from this balance,
   * before the launch is signed. An explicit `gas` still wins outright, because a caller that has
   * measured the transaction knows better than three constants do.
   */
  const gas =
    input.gas ??
    LAUNCH_GAS_HEADROOM +
      (buy ? APPROVAL_GAS_HEADROOM : 0n) +
      (input.swapFirst ? SWAP_GAS_HEADROOM : 0n);
  const spend = (input.launchFee ?? 0n) + input.nativeFirstBuy;

  /*
   * The pair's asset, on its own terms.
   *
   * Built before the early return, because it does not depend on either MON figure: a launcher
   * whose fee read is still in flight can already be told they are 40 USDC short of the buy they
   * typed. The two ledgers are genuinely independent — that is the whole reason there are two.
   */
  const quoteLedger: QuoteLedger | null = buy
    ? (() => {
        const held = buy.balance;
        const clears = held === undefined || held >= buy.amount;
        return {
          symbol: buy.symbol,
          held: held === undefined ? null : `${formatQuote(held, buy.decimals)} ${buy.symbol}`,
          spend: `${formatQuote(buy.amount, buy.decimals)} ${buy.symbol}`,
          remaining:
            held !== undefined && clears
              ? `${formatQuote(held - buy.amount, buy.decimals)} ${buy.symbol}`
              : null,
          shortfall:
            held !== undefined && !clears
              ? `${formatQuote(buy.amount - held, buy.decimals)} ${buy.symbol}`
              : null,
          clears,
        };
      })()
    : null;

  /*
   * The button's words for a buy the wallet cannot fund.
   *
   * A launch that reverts on `transferFrom` costs the launcher the approval, the gas limit and the
   * launch fee's worth of nerve, and tells them nothing — this is the state that was completely
   * unhandled while the app read no ERC-20 balances. Short enough to be a label, and it names the
   * asset, because the whole point of the funding control is that there are now two it could be.
   */
  const quoteBlocked =
    quoteLedger && !quoteLedger.clears ? `Need ${quoteLedger.shortfall} for the dev buy` : null;

  if (input.balance === undefined || input.launchFee === undefined) {
    return {
      spend,
      verdict: null,
      /* The MON side is unknown; this one is not, and holding the button on a shortfall the app
         can already prove beats letting the launcher sign into a revert while a read lands. */
      blockedReason: quoteBlocked,
      warning: null,
      ledger: null,
      quoteLedger,
    };
  }

  const verdict = reserveVerdict({ balance: input.balance, spend, gas });

  /*
   * One sentence, both refusals.
   *
   * The button said `Need 12.4 MON to launch` when the balance could not cover the spend at all,
   * and `Add 8.98 MON to clear the 10 MON reserve` when it could but would land under the reserve —
   * two different verbs, two different quantities, and the second one naming a chain rule in a
   * label that has room for about four words. They are the same fact: a launch needs the fee, the
   * buy, its gas *and* the ten MON Monad will not let the balance drop below, and the button's job
   * is to name that one number.
   *
   * So `needed` is the whole of it, and the only thing that changes between the two states is
   * whether the wallet is short by a little or by a lot.
   */
  const needed = MONAD_RESERVE_WEI + spend + gas;

  /*
   * The itemised balance requirement, built once and read in two moods.
   *
   * `warning.parts` is this array. It was assembled inside the `emptying` branch, which is why the
   * only launcher who ever saw the arithmetic was one who had already been refused — and why the
   * dev-buy step three panels to the left had to explain the same three deductions in prose, with
   * none of the numbers in it. One list, built whenever the figures exist.
   *
   * The fee is read, never written in. `launchFee(who)` is owner-tunable with per-account
   * exemptions, so a hard-coded "10 MON" is wrong for an exempt account and wrong the day the
   * owner moves it. Zero drops the clause entirely rather than printing "Launch fee (0 MON)".
   */
  const parts = [{ label: "Reserve", value: `${formatMon(MONAD_RESERVE_WEI)} MON` }];
  if (input.launchFee > 0n) {
    parts.push({ label: "Launch fee", value: `${formatMon(input.launchFee)} MON` });
  }
  if (input.nativeFirstBuy > 0n) {
    parts.push({ label: "Dev buy", value: `${formatMon(input.nativeFirstBuy)} MON` });
  }
  /* Gas is an assumption — a limit times a price ceiling, not a measurement — and the `~` says
     so. It is also why the headline reads "more than": the rest are exact and this one is not.
     On a token-funded buy it is two transactions' worth, and the row says which two rather than
     leaving the launcher to wonder why a fee-only launch wants more MON than the fee. */
  parts.push({
    label: buy ? "Gas + approval" : input.swapFirst ? "Gas + swap" : "Gas",
    value: `~${formatMon(gas)} MON`,
  });

  /*
   * The ledger, whenever the launch actually moves MON.
   *
   * A launch with an exempt fee and no dev buy decrements nothing, so the reserve cannot bite and
   * there is no sum worth showing — `reserveVerdict` already calls a zero spend safe. Everywhere
   * else the launcher is spending native MON and this is the arithmetic behind the number they are
   * choosing, which is precisely why it is not conditional on anything having gone wrong.
   */
  const clears = verdict === "safe";
  const ledger: LaunchLedger | null =
    spend > 0n
      ? {
          held: `${formatMon(input.balance)} MON`,
          parts,
          minimum: `${formatMon(needed)} MON`,
          /* What is left, not what was spent. `balance - spend - gas` is the figure the launcher
             will see in their wallet afterwards, and on a clearing launch it is by definition at
             or above the reserve. Withheld when the launch cannot land, because there is no
             "afterwards" to report. */
          remaining: clears ? `${formatMon(input.balance - spend - gas)} MON` : null,
          shortfall: clears ? null : `${formatMon(needed - input.balance)} MON`,
          clears,
        }
      : null;

  if (verdict === "insufficient") {
    return {
      spend,
      verdict,
      blockedReason: `Need ${formatMon(needed)} MON to launch`,
      warning: null,
      ledger,
      quoteLedger,
    };
  }

  if (verdict === "emptying") {
    /*
     * BLOCKED, not merely warned — and this is the one place a launch differs from a trade.
     *
     * The trade panel warns here and lets the trader through, because a trade CAN qualify for
     * Monad's emptying exemption: it goes through when the wallet has not moved in the last few
     * blocks. A launch never can. The exemption requires the transaction to spend the account to
     * zero, and a launch sends an exact `msg.value` — so this is not a risk the launcher is taking,
     * it is a transaction that is already known to revert. Letting them sign it spends gas at the
     * limit, which Monad bills whether or not the call succeeds, to buy a certainty.
     *
     * The sentence stays on screen as the warning band, because it names the amount to add; the
     * button carries the short form. Both, rather than either.
     */
    return {
      spend,
      verdict,
      blockedReason: `Need ${formatMon(needed)} MON to launch`,
      warning: {
        /*
         * The headline names the number, not the mechanism.
         *
         * It said "10 $MON minimum balance", which is the *chain's* floor and about half of what a
         * launcher actually has to be holding: the reserve is the level the balance may not drop
         * through, and the fee, the buy and the gas all come out of what sits above it. Somebody
         * reading "10" and topping up to 12 is still blocked. The figure here is everything, read
         * from the chain rather than written in — `launchFee(who)` is owner-tunable with
         * per-account exemptions, so a hard-coded 20 would be wrong the day the owner moves it.
         */
        title: `${formatMon(needed)} $MON minimum balance`,
        /*
         * The rule, then the remedy, in that order and in that many words.
         *
         * It named MetaMask and described a reserve the reader has never heard of before telling
         * them what to do about it. The rule is one sentence — ten MON has to survive the launch —
         * and the amount to add is the only thing on this panel anybody can act on, so it goes
         * first and it is a number rather than an instruction to go and work one out.
         */
        body: `Top up by ${formatMon(needed - input.balance)} MON. Monad keeps 10 MON back in every wallet and a launch cannot spend past it, so the fee, the buy and the gas all have to come out of what sits above that floor.`,
        parts,
        total: `${formatMon(needed)} MON`,
      },
      ledger,
      quoteLedger,
    };
  }

  /*
   * MON clears. The buy may still not.
   *
   * Two assets, two ways to be short, and only one of them is about the chain's reserve — so the
   * MON verdict stays `safe` and the button carries the token shortfall instead. Reporting this as
   * a reserve problem would send a launcher who is 40 USDC short off to buy MON.
   */
  return { spend, verdict, blockedReason: quoteBlocked, warning: null, ledger, quoteLedger };
}
