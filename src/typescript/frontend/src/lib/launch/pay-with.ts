import { formatUnits } from "viem";

import type { QuoteAsset } from "@/lib/assets/quote-assets";
import { MONAD_RESERVE_WEI } from "@/lib/chain/monad-reserve";
import { applySlippage } from "@/lib/chain/writes";
import { zapSlippageBps } from "@/lib/chain/zap-plan";
import { candidateRoutes } from "@/lib/chain/zap-routes";
import { LAUNCH_GAS_HEADROOM, SWAP_GAS_HEADROOM } from "@/lib/launch/cost";

/**
 * Paying for the launch's own dev buy in MON, decided with no chain and no React.
 *
 * ## Why the launch cannot do this in one transaction, and does not pretend to
 *
 * Everywhere else in this app, paying with MON is one signature: the trade router swaps and buys
 * inside a single call. A launch cannot be, and it is worth being precise about why, because the
 * shape of the whole flow follows from it.
 *
 * The coin does not exist yet. There is no curve to buy on and no pool to swap into until
 * `DokuFactory.launch` creates them, and the factory records `msg.sender` as the creator — so a
 * contract that launched on the creator's behalf would BE the creator, and would own the market's
 * creator fees. No router can serve this.
 *
 * So the swap is its own transaction: MON into the pair's asset, delivered to the launcher's own
 * wallet, and then the ordinary launch spends it. The dev buy itself is unchanged — it still
 * happens INSIDE the launch transaction, at the first price anyone pays, which is the property
 * that makes it un-frontrunnable and the reason it is on the form at all.
 *
 * ## One TRANSACTION, but not necessarily one prompt
 *
 * None of the above is an argument about signatures, and a wallet that implements EIP-5792 can
 * take the swap, the approval and the launch in a single prompt without any of it going through a
 * contract: `wallet_sendCalls` has the WALLET make each call, so `msg.sender` is still the
 * launcher and the factory still records them as the creator. That is the whole difference between
 * a batch and a router, and `lib/chain/launch-batch` is where it is written down — along with what
 * a batch gives up, which is the balance read between the swap and the buy.
 *
 * On a MON pair none of this applies and none of it appears: `launchPayWithOptions` returns a
 * single option, the control renders nothing, and the launch stays at one signature.
 */

export type LaunchPayWith = "quote" | "native";

/**
 * What is left for the launch after the chain's reserve and the transactions that follow.
 *
 * Two subtractions, and each is a different failure. Monad reverts a balance-decrementing
 * transaction that would end below **10 MON** unless it qualifies as an emptying transaction, and
 * the swap here cannot qualify — an emptying transaction is one where nothing else follows, and
 * something else always follows here: the launch. Then the launch itself costs a fee plus gas
 * billed at the LIMIT, so a launcher who spent everything above the reserve on the swap would be
 * left holding an asset they cannot launch with.
 *
 * ## It is derived, because a flat number drifts
 *
 * It was `1 MON`, chosen as "generous against a launch measured in millions of gas at ~200 gwei" —
 * and it was, until the swap in front of a MON-funded dev buy started being charged for. Add the
 * swap's own gas to `launchAffordability` and a flat MON stops covering both transactions, which
 * turns the 100% key into an amount the launch button then refuses: the ceiling and the check
 * disagreeing is the exact bug this file already fixed once.
 *
 * So it is the two gas reservations the affordability check actually applies, plus a tenth of a MON
 * of margin. They cannot drift apart, because there is now only one place either can be edited.
 *
 * ## And the swap is not always a transaction
 *
 * A wallet that takes `wallet_sendCalls` signs the swap, the approval and the launch as one batch,
 * and there is then no second transaction to reserve gas for — see the module note above. So the
 * swap's reservation is conditional on the launch NOT being batched, which is the same condition
 * `launchAffordability`'s `swapFirst` carries, read from the same `useBatchSupport` answer. Both
 * sides of the rule move together or neither does; that is the whole reason `batched` is a
 * parameter here rather than a second capability read.
 */
/**
 * The margin on top of the gas reservations: the distance between an assumed gas price and a real
 * one. A tenth of a MON, and it is the only hand-written number left in the headroom.
 */
const LAUNCH_MARGIN_WEI = 100_000_000_000_000_000n;

/**
 * @param batched whether the swap rides INSIDE the launch as one `wallet_sendCalls`, which is the
 *   one thing that makes the swap's gas not its own transaction. `false` — the three-transaction
 *   path every wallet gets until one positively says otherwise — is the default everywhere, so a
 *   caller that knows nothing about batching reserves both, exactly as it always did.
 *
 *   It is a fact about the WALLET, and it arrives here rather than being read here: `useBatchSupport`
 *   is the single read of that capability, and its docblock says why there must only ever be one.
 *   The same answer sets `launchAffordability`'s `swapFirst`, which is what keeps this ceiling and
 *   that check from disagreeing.
 */
function launchHeadroom(batched: boolean): bigint {
  return LAUNCH_GAS_HEADROOM + (batched ? 0n : SWAP_GAS_HEADROOM) + LAUNCH_MARGIN_WEI;
}

/**
 * The most MON a dev buy can be, given what else the launch has to pay for.
 *
 * Three subtractions, and the third is the one that was missing:
 *
 *   1. **Monad's 10 MON reserve.** The chain refuses a balance-decrementing transaction that would
 *      end below it, and a launch can never be the one exempt shape — see `monad-reserve`.
 *   2. **Gas, plus the margin between an assumed gas price and a real one** — `launchHeadroom`,
 *      which is the launch's own reservation, the swap's where the swap is a transaction of its
 *      own, and a tenth of a MON on top. Being generous costs a launcher a rounding error; being
 *      tight costs them a revert after the swap has already landed.
 *   3. **The launch fee.** It comes out of the same balance, in the same transaction, and it was
 *      not subtracted here at all — so "100%" produced a buy that consumed everything the reserve
 *      and the slack left behind and then had nothing to pay the fee with. The launch was blocked
 *      by the button, with the wallet's own maximum in the field.
 *
 * The fee is a parameter rather than a constant because `launchFee(who)` is owner-tunable with
 * per-account exemptions. `undefined` — the read still in flight — is treated as the fee being
 * unknown rather than zero: offering a buy that a fee might invalidate is the failure this exists
 * to prevent, and the number settles a moment later.
 */
export function spendableMon(
  balance: bigint | undefined,
  launchFee?: bigint,
  batched = false
): bigint {
  if (balance === undefined) return 0n;
  const fee = launchFee ?? 0n;
  const spendable = balance - MONAD_RESERVE_WEI - launchHeadroom(batched) - fee;
  return spendable > 0n ? spendable : 0n;
}

/**
 * What has to arrive before a dev buy of any size is possible at all.
 *
 * The mirror of `spendableMon`, and deliberately next to it: they are the same subtraction read
 * from opposite ends, and a form that can say "you have nothing to spend" without being able to say
 * "you are 4.2 MON away from spending something" has told the launcher they are stuck rather than
 * what to do. That was the whole of the dev-buy step's old failure state — ten dead percentage
 * keys, an inert field, and a sentence naming three deductions it never showed the value of.
 *
 * Zero when there is already something to spend, so a caller can treat it as "nothing to say"
 * without a second condition — the same shape `reserveShortfall` carries for the trade panel.
 *
 * `undefined` balance is not "nothing": it is a read in flight or a wallet that has not connected,
 * and inventing a top-up figure for it would be a claim about somebody's money.
 */
export function monTopUpForDevBuy(
  balance: bigint | undefined,
  launchFee?: bigint,
  batched = false
): bigint {
  if (balance === undefined) return 0n;
  const floor = MONAD_RESERVE_WEI + launchHeadroom(batched) + (launchFee ?? 0n);
  return floor > balance ? floor - balance : 0n;
}

/**
 * A raw amount as a string somebody could have typed, and never larger than the amount itself.
 *
 * Two properties matter, and the old code had neither for a token that is not MON.
 *
 * **It floors.** `toFixed` rounds half up, so formatting a whole balance to four places could
 * produce a figure a hair *above* it — which lights the over-limit warning on the very key that
 * means "all of it", and asks a wallet for money it does not have. Truncating in raw units cannot.
 *
 * **It knows the asset's decimals.** Six for USDC and gold, eight for cbBTC, eighteen for MON. The
 * display budget follows the SIZE rather than the token, because a fixed four places reads a
 * stablecoin correctly and rounds a whole cbBTC dev buy to zero.
 */
export function trimAmount(raw: bigint, decimals: number): string {
  if (raw <= 0n) return "";
  const whole = raw / 10n ** BigInt(decimals);
  const places = whole >= 1000n ? 2 : whole >= 1n ? 4 : 8;
  /* Floor to `places`, in raw units. `formatUnits` drops the trailing zeros itself and omits the
     point entirely when nothing is left of the fraction, so there is no string to tidy up after. */
  const step = 10n ** BigInt(Math.max(decimals - places, 0));
  const floored = (raw / step) * step;
  return floored <= 0n ? "" : formatUnits(floored, decimals);
}

/**
 * A percentage of a spendable balance, as a string for the amount field.
 *
 * Raw in, string out, and the decimals are the asset's. This is the generic behind both presets
 * rows: the MON one, which has three deductions in front of it, and the pair's own asset, which
 * has none — a launcher funding a PENGU/WBTC dev buy in WBTC can spend every satoshi of it,
 * because the fee and the gas come out of a different balance entirely.
 */
export function shareOfBalance(spendable: bigint, percent: number, decimals: number): string {
  if (spendable <= 0n) return "";
  /* Basis points, not whole percent. Every caller used to be one of eight integer presets, so
     `BigInt(Math.round(percent))` was exact; the dev-buy step now has a field somebody can type
     12.5 into, and rounding that to 13 is the form quietly spending money the launcher did not
     ask it to. Two decimal places of percent is as fine as that field goes. */
  return trimAmount((spendable * BigInt(Math.round(percent * 100))) / 10_000n, decimals);
}

/**
 * A percentage of the spendable MON balance.
 *
 * The presets are a share of what the launcher HOLDS, less everything the launch itself has to pay
 * for out of the same balance — see `spendableMon`.
 */
export function monShareOfBalance(
  balance: bigint | undefined,
  percent: number,
  launchFee?: bigint,
  batched = false
): string {
  return shareOfBalance(spendableMon(balance, launchFee, batched), percent, 18);
}

/**
 * A percentage of what the wallet holds of the pair's own asset.
 *
 * No deductions, and that is the point rather than an omission. A dev buy funded in the pair's
 * asset is pulled by the factory from the token balance; the fee, the gas and Monad's reserve are
 * all claims on the MON balance, which this one cannot be spent on. So `100%` here really is all
 * of it, and the MON side is accounted for separately by `launchAffordability`.
 *
 * `undefined` is a read in flight or an asset with no address, and produces no amount — inventing
 * one would be a claim about somebody's money.
 */
export function quoteShareOfBalance(
  balance: bigint | undefined,
  percent: number,
  decimals: number
): string {
  if (balance === undefined) return "";
  return shareOfBalance(balance, percent, decimals);
}

/**
 * Whether this pair's dev buy may be paid for in MON.
 *
 * Three refusals, all of which are ordinary states rather than errors: no pair chosen yet, a pair
 * that IS MON — nothing to swap, and the user asked that those keep their single signature — and a
 * pair this chain has no route to, which `candidateRoutes` answers from the measured edge table.
 */
export function launchPayWithOptions(quote: Pick<QuoteAsset, "address"> | null): LaunchPayWith[] {
  if (!quote?.address) return ["quote"];
  if (candidateRoutes(quote.address).length === 0) return ["quote"];
  return ["quote", "native"];
}

/** The floor the swap carries, with the trader's tolerance clamped to what the write path takes. */
export function devBuySwapBounds(quoteOut: bigint, slippageBps: number): bigint {
  return applySlippage(quoteOut, zapSlippageBps(slippageBps));
}

export type DevBuyPlan =
  | { kind: "idle" }
  | { kind: "quoting" }
  | { kind: "unavailable"; message: string }
  | {
      kind: "ready";
      /** Raw units of the pair's asset the swap is expected to deliver. */
      quoteOut: bigint;
      /** The floor it is signed with. */
      minQuoteOut: bigint;
      impactBps: number;
    };

/**
 * What the dev-buy step should be showing about a MON payment right now.
 *
 * The same three states as the trade panel's, for the same reasons — "not measured yet" is not
 * "no route", and a message that accuses the pools of being thin for a quarter of a second on
 * every keystroke is a message people learn to ignore.
 *
 * There is no ceiling here. `maxZapValue` belongs to the ZapRouter, which is not in this path at
 * all: the swap goes through Uniswap's own router, exactly as any other swap does.
 */
export function devBuyPlan(input: {
  /** MON to spend, in wei. */
  amountIn: bigint;
  quoting: boolean;
  route: { amountOut: bigint; impactBps: number } | null | undefined;
  slippageBps: number;
  quoteSymbol: string;
}): DevBuyPlan {
  if (input.amountIn <= 0n) return { kind: "idle" };
  if (input.quoting || input.route === undefined) return { kind: "quoting" };

  if (input.route === null) {
    return {
      kind: "unavailable",
      message: `MON cannot be swapped into ${input.quoteSymbol} for an amount this size — the pools are too thin, and the price you would get is not one worth taking. Buy a smaller amount, or bring your own ${input.quoteSymbol}.`,
    };
  }

  return {
    kind: "ready",
    quoteOut: input.route.amountOut,
    minQuoteOut: devBuySwapBounds(input.route.amountOut, input.slippageBps),
    impactBps: input.route.impactBps,
  };
}
