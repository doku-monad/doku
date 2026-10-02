"use client";

import ButtonWithConnectWalletFallback from "components/header/wallet-button/ConnectWalletButton";
import {
  useDokuPublicClient,
  useDokuWallet,
  useDokuWalletClient,
} from "context/wallet-context/DokuWalletProvider";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Notice } from "@/components/ui/notice";
import { swapNativeForAndWait } from "@/lib/chain/pool";
import { CONTRACTS } from "@/lib/chain/wagmi";
import { launchChain } from "@/lib/chain/writes";
import { useBatchSupport } from "@/lib/hooks/use-batch-support";
import type { LaunchLedger, LaunchWarning, QuoteLedger } from "@/lib/launch/cost";
import {
  draftIsComplete,
  draftProblems,
  type LaunchDraft,
  type LaunchResult,
  submitLaunch,
} from "@/lib/launch/submit";
import { marketPath } from "@/lib/market-path";

import { LaunchCta } from "./LaunchCta";

/**
 * The end of the bench: the one control that turns a draft into a transaction.
 *
 * ## The draft arrives; it is not rebuilt here
 *
 * This component used to assemble a second `LaunchDraft` from the individual props it was given —
 * name, ticker, links, routing, dev buy — and that second draft was the one that got signed. It
 * was missing `creatorFee` and `creatorFeeRecipient`, because those were never passed: the bench
 * had them, its summary panel printed them, and the object handed to `submitLaunch` did not carry
 * them. A launcher could set a 5% creator tax, watch the summary say "6% per trade", and launch a
 * market with no tax at all.
 *
 * Two drafts, one of which is the one that gets signed, is not a bug to fix in place. The bench
 * builds the draft it already shows and passes it, so what is summarised and what is submitted are
 * the same object.
 *
 * ## The wrong network is asked about first
 *
 * `ButtonWithConnectWalletFallback` only knows about "no wallet". A wallet connected to some other
 * chain sails past it, and the launch is attempted: the wallet opens, the write goes to a chain
 * where the factory address holds nothing, and what the launcher sees is an incomprehensible
 * failure on a form they filled in correctly. That is worse here than in the trade panel, because
 * a launch costs a listing fee on top of gas. So `wrongChain` takes the button over entirely and
 * turns it into the one action that helps — exactly as `SwapButton` does on the market page.
 *
 * ## After it lands
 *
 * `predictMarket(creator)` gives the address before the transaction confirms, so the market page
 * opens straight away rather than after the indexer has caught up.
 */
/**
 * Where somebody short of MON goes to get some.
 *
 * Uniswap's own swap page rather than a route this app builds: the launcher is not on Monad's
 * balance sheet yet and there is nothing for this product to quote for them. A link out is the
 * honest shape, and it opens in a tab so a half-filled draft is not navigated away from.
 */
const MON_SWAP_URL = "https://app.uniswap.org/swap";

/**
 * One ruled list of label-and-figure rows, with an optional bottom line.
 *
 * Extracted the moment there were two ledgers to draw. The MON list and the pair-asset list are the
 * same object read against two different rules, and two hand-built copies of a `dl` is how the
 * second one ends up with a different row height, a different ink or a bottom line that means
 * something subtly else.
 */
const LedgerList = ({
  rows,
  foot,
}: {
  rows: { label: string; value: string }[];
  /** The bottom line: what is left, or what is missing. Absent when neither can be stated. */
  foot?: { label: string; value: string; clears: boolean } | null;
}) => (
  <dl className="doku-summary-list flex flex-col overflow-hidden rounded-doku-lg">
    {rows.map((row) => (
      <div
        key={row.label}
        className="doku-summary-row flex items-baseline justify-between gap-3 px-3 py-2"
      >
        <dt className="shrink-0 font-pixel text-[11px] uppercase leading-none tracking-[0.05em] text-mute">
          {row.label}
        </dt>
        <dd className="min-w-0 truncate font-numeric text-[12.5px] font-semibold leading-none tabular-nums text-ash">
          {row.value}
        </dd>
      </div>
    ))}

    {foot && (
      <div className="doku-summary-row flex items-baseline justify-between gap-3 px-3 py-2.5">
        <dt
          className={`shrink-0 font-pixel text-[11px] uppercase leading-none tracking-[0.05em] ${
            foot.clears ? "text-halo-ink" : "text-warn-ink"
          }`}
        >
          {foot.label}
        </dt>
        <dd
          className={`min-w-0 truncate font-numeric text-[13.5px] font-semibold leading-none tabular-nums ${
            foot.clears ? "text-halo-ink" : "text-warn-ink"
          }`}
        >
          {foot.value}
        </dd>
      </div>
    )}
  </dl>
);

export const LaunchAction = ({
  draft,
  insufficientBalance,
  blockedReason,
  warning,
  ledger,
  quoteLedger,
}: {
  /** The bench's draft — the same one the summary panel is rendering. */
  draft: Partial<LaunchDraft>;
  insufficientBalance: boolean;
  /**
   * A few words that hold the button, for a state the DRAFT cannot express.
   *
   * Two of them. A dev buy being paid for in MON whose route has not been measured yet: the draft
   * is complete and would launch — with no dev buy at all, because the swap that funds it has not
   * been priced. And a wallet that cannot cover the fee, the buy and the gas, which is a fact about
   * the launcher rather than about the draft. Neither is a defect `draftProblems` could name, and
   * both must stop the launch: the first silently drops the thing the launcher asked for, the
   * second spends gas on a revert.
   */
  blockedReason?: string | null;
  /**
   * What will go wrong if they press it anyway — shown, not enforced.
   *
   * Monad's reserve, which a launch cannot spend past. It is judged against a gas figure this app
   * assumed rather than one the chain quoted, so it says so and leaves the button alone; see
   * `lib/launch/cost`.
   */
  warning?: LaunchWarning | null;
  /**
   * The dev buy's own arithmetic, when the buy is funded in the pair's asset rather than in MON.
   *
   * Its own list beside the MON one, never rows inside it — see `QuoteLedger`. Present on exactly
   * the launches the MON ledger has nothing to say about the buy for, which is the point: between
   * the two, every launch this form can produce now shows the whole of what it costs.
   */
  quoteLedger?: QuoteLedger | null;
  /**
   * The launch's MON arithmetic, present whether or not anything is wrong with it.
   *
   * This panel used to appear only on a launch that could not be signed, which made the reserve
   * something a launcher met exclusively as a refusal — and left the dev-buy step three panels to
   * the left explaining the same three deductions in prose, with none of the numbers in it. The
   * ledger is the same rows in both moods; `warning` decides the tone and the heading.
   */
  ledger?: LaunchLedger | null;
}) => {
  const router = useRouter();
  const { address, wrongChain, switchToMonad } = useDokuWallet();

  /*
   * Whether this wallet will take the swap, the approval and the launch as ONE prompt.
   *
   * The only launch that costs more than one signature is a dev buy funded in MON, and it costs
   * three. An unanswered, failed or unrecognised capability reads as `none` and changes nothing —
   * the three-transaction path is what every wallet gets until one positively says otherwise.
   *
   * The bench reads the same hook for the same answer, which is what keeps the dev-buy step's copy,
   * the ceiling on the amount field and this button from disagreeing about how many prompts are
   * coming; see `useBatchSupport` for why it is one hook rather than three reads.
   */
  const batchSupport = useBatchSupport(address);

  const wallet = useDokuWalletClient();
  const publicClient = useDokuPublicClient();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<LaunchResult | null>(null);

  const complete = draftIsComplete(draft);

  /*
   * The label says the reason, not just "disabled".
   *
   * The summary above already lists everything missing; this repeats only the *first* of them, so
   * the button answers "why can I not press you" without becoming a second copy of that list.
   */
  const [firstProblem] = draftProblems(draft);
  const label = pending
    ? "Launching…"
    : insufficientBalance
      ? "Insufficient balance"
      : (blockedReason ?? firstProblem ?? "Launch coin");

  /**
   * Whether the panel is reporting a fault or explaining a plan.
   *
   * It was `Boolean(warning)`, which named exactly one of the three ways a launch can be refused:
   * the reserve dip. A wallet that cannot cover the fee at all sets `blockedReason` and no warning,
   * and a wallet that is short of the pair's asset sets neither — so both drew an informational
   * blue panel whose bottom line said "Short by 40 USDC" in amber, on a button that was already
   * held. One condition, read from the ledgers themselves, so the tone cannot disagree with the
   * figure directly under it.
   */
  const blocking =
    Boolean(warning) ||
    Boolean(ledger && !ledger.clears) ||
    Boolean(quoteLedger && !quoteLedger.clears);

  const onClick = async () => {
    // Belt as well as braces. The render below never shows the launch button on the wrong chain,
    // but a chain switch that lands mid-flight would otherwise leave a stale handler able to fire.
    if (wrongChain) return;
    if (!complete || pending) return;
    if (blockedReason) return;
    if (!wallet || !publicClient) return;

    setPending(true);
    setResult(null);
    try {
      /*
        The port, composed here.

        `launchChain` is the protocol — the factory and the curve — and it takes the MON swap as an
        argument rather than importing it, because `pool.ts` already depends on `writes.ts` and the
        two must not depend on each other. The swap is used by one flow: a dev buy paid for in MON,
        which needs its own transaction because the coin does not exist until the launch creates
        it. On every other launch it is never called.
      */
      const outcome = await submitLaunch(
        draft,
        launchChain(
          wallet,
          publicClient,
          CONTRACTS.factory,
          (params) => swapNativeForAndWait(wallet, publicClient, params),
          /*
            And the batch, composed the same way and only where the wallet claims it.

            `wallet_sendCalls` is not a router: the wallet makes each call itself, so `msg.sender`
            is this launcher on all three and the factory records them as the creator. That is why
            batching is allowed here when the router `pay-with.ts` describes is not.

            Passed as `undefined` for every wallet that cannot batch, which leaves the port exactly
            the shape it was before this existed — `submitLaunch` then has nothing to take the
            batched branch with.
          */
          batchSupport === "none"
            ? undefined
            : {
                support: batchSupport,
                send: async (calls, opts) => {
                  const { id } = await wallet.sendCalls({
                    account: wallet.account!,
                    chain: wallet.chain,
                    calls,
                    /* Ask for atomicity only where the wallet said it has it: `forceAtomic` sets
                       the spec's `atomicRequired`, which a wallet that batches sequentially must
                       REFUSE — so asking blindly turns a working one-prompt launch into an error. */
                    forceAtomic: opts.atomic,
                  });

                  /* A batch answers with an id, and an id says nothing about landing. Waiting on
                     the status is what keeps the market page from opening over a launch that has
                     not happened; `throwOnFailure` sends a reverted batch down the same road as
                     every other failure, into `explainChainError`. */
                  const { receipts } = await wallet.waitForCallsStatus({
                    id,
                    throwOnFailure: true,
                  });

                  /* The LAST receipt is the launch. An atomic batch has one; a sequential one has
                     the swap and the approval in front of it, and returning the swap's hash would
                     link the market page to a transaction that created no market.

                     A confirmed batch carries receipts — EIP-5792 requires them at status 200 — so
                     this throw is for a wallet answering outside its own spec. It reads as a
                     failure because that is honest: with no transaction to look at, this app
                     cannot say whether a coin exists. */
                  const last = receipts?.at(-1);
                  if (!last) {
                    throw new Error(
                      "Your wallet confirmed the batch but returned no transaction. Check your wallet before launching again."
                    );
                  }
                  /*
                   * The last receipt's own STATUS, not merely its existence, and here it matters
                   * more than anywhere else in the app.
                   *
                   * `throwOnFailure` reads the BATCH's status code, and viem maps EIP-5792 v1.0's
                   * `"CONFIRMED"` string straight to success without inspecting the receipts
                   * (`getCallsStatus.js`). A wallet answering that older shape can report a
                   * confirmed batch whose LAUNCH reverted after the swap and the approval landed
                   * — and this component then clears the draft and navigates to a predicted market
                   * that does not exist. The MON is spent, the draft is gone, and the page is dead.
                   */
                  if (last.status !== "success") {
                    throw new Error(
                      "Your wallet reported the batch as confirmed, but the launch reverted. Your draft is safe — check your wallet before launching again."
                    );
                  }
                  return last.transactionHash;
                },
              }
        )
      );
      setResult(outcome);
      if (outcome.status === "submitted") {
        /*
         * Straight to the market, on the predicted address, carrying `launched=1`.
         *
         * That flag is what stops the market page concluding "nobody has launched this coin".
         * `submitLaunch` returns as soon as the wallet hands back a hash — it does not wait for a
         * block — so the page runs while there is genuinely no contract at the address yet, and
         * the only thing that knows a transaction is in flight is this browser.
         *
         * `pending` is deliberately left set: the button stays in its launching state while the
         * route changes, so nothing on this screen re-enables itself behind the navigation.
         */
        router.push(`${marketPath(outcome.tokenAddress)}?launched=1`);
        return;
      }
    } catch (error) {
      setResult({
        status: "failed",
        reason: error instanceof Error ? error.message : "Something went wrong.",
      });
    }
    setPending(false);
  };

  if (wrongChain) {
    return (
      <div className="flex flex-col gap-3">
        <ButtonWithConnectWalletFallback className="w-full" block variant="solid" solidSize="lg">
          <LaunchCta as="button" tone="warn" onClick={switchToMonad}>
            Switch to Monad
          </LaunchCta>
        </ButtonWithConnectWalletFallback>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/*
        The reserve notice, above the button rather than under it: this is the sentence that should
        change what the next click is, and a warning read afterwards is a post-mortem.

        It was built by hand here — its own panel, its own mounted mark, its own heading — repeating
        `Notice`'s construction beside `Notice`'s own call sites elsewhere on this same page. It is
        the component now, so the launch rail's warning and the dev buy's are one object rather than
        two that happen to look alike until one of them is tuned.
      */}
      {blocking && (ledger || quoteLedger) && (
        /*
          The ledger, only when the launch cannot be signed.

          It rendered whenever the launch moved MON at all — which, with the fee at 10 MON, is every
          launch anybody makes. The reasoning was that a launcher should meet the reserve before
          walking into it rather than as a refusal, and the rows are the same in both moods, so the
          blue informational copy cost nothing to leave up.

          It cost the screen. A launcher holding plenty of MON got a five-row panel above the button
          restating a floor that was never going to be reached, on every single launch, and a notice
          that is present when nothing is wrong is a notice nobody reads when something is. The
          arithmetic it carries is still worth showing at the moment it decides something — which is
          exactly when the fee, the buy and the gas will not fit above the ten MON Monad holds back.
          That is `blocking`, and it is read from the ledgers rather than from `warning` alone,
          because a wallet short of the fee outright and a wallet short of the pair's asset are both
          refusals that `warning` never names.

          What the launcher loses is the preview, and the dev-buy step is where that belongs: it is
          the control that moves the number, and it is on screen while there is still a decision to
          make. This panel is the refusal.
        */
        <Notice
          tone="warn"
          title={
            warning?.title ??
            (ledger
              ? `${ledger.minimum} minimum balance`
              : /* No MON moves at all — an exempt account funding its buy in the pair's asset — so
                   the panel is about the buy, and the heading names it rather than a floor that
                   cannot be reached from here. */
                `${quoteLedger!.spend} for the dev buy`)
          }
          alert
        >
          <div className="flex min-w-0 flex-col gap-3">
            <p className="min-w-0">
              {warning?.body ??
                (ledger
                  ? `Monad keeps 10 MON back in every wallet and a launch cannot spend past it, so the fee, the buy and the gas all come out of what sits above that floor.`
                  : `The factory pulls the buy from your wallet when the launch runs, so the ${quoteLedger!.symbol} has to be there when you sign.`)}
            </p>

            {/*
              The MON ledger.

              Four amounts and a total, ruled — the same object as `Your coin` eighteen pixels up
              this rail, deliberately. The alternative is a sentence that asks a reader to add three
              numbers in their head before they know how much to go and find; and a person reading
              about money is the last person who should be doing arithmetic.

              `You hold` leads it now. It was absent, so the ledger stated a requirement without
              ever stating the thing being compared against it — the reader had to go and find their
              own balance to make the list mean anything. It is also the row that moves when they act
              on this panel, which makes it the one worth being able to watch.
            */}
            {ledger && (
              <LedgerList
                rows={[{ label: "You hold", value: ledger.held }, ...ledger.parts]}
                /*
                  The bottom line, and it says one of two things.

                  Short by X, or X left afterwards. Both are the answer to the same question — "can
                  I sign this, and what happens to my wallet if I do" — and printing the minimum
                  alone left the reader to subtract it from a balance the panel had not shown them.
                */
                foot={{
                  label: ledger.clears ? "Left after launch" : "Short by",
                  value: (ledger.clears ? ledger.remaining : ledger.shortfall) ?? "",
                  clears: ledger.clears,
                }}
              />
            )}

            {/*
              And the pair's own asset, when that is what the buy is funded in.

              A second list rather than three more rows in the first, because the two do not add up:
              one column is MON against a chain floor, the other is USDC or WBTC against nothing but
              what the wallet holds. A `0.004 WBTC` row between `10 MON` and `~0.92 MON` would make
              a total nobody could check — and the reserve, which is the whole reason the first list
              exists, has no meaning at all for an asset it does not apply to.

              Which is the answer to what changes when a launcher funds the buy in the pair's asset:
              the reserve does not move, the MON requirement gets SMALLER because the buy leaves it,
              and the buy turns up here instead.
            */}
            {quoteLedger && (
              <LedgerList
                rows={[
                  /* Only when it has been read. A row saying "You hold —" is a panel admitting it
                     does not know, in the middle of a list of things it does. */
                  ...(quoteLedger.held ? [{ label: "You hold", value: quoteLedger.held }] : []),
                  { label: "Dev buy", value: quoteLedger.spend },
                ]}
                /* Nothing to state when the balance has not been read: neither "left after" nor
                   "short by" is knowable, and inventing either is a claim about somebody's money. */
                foot={
                  quoteLedger.held === null
                    ? null
                    : {
                        label: quoteLedger.clears ? "Left after launch" : "Short by",
                        value:
                          (quoteLedger.clears ? quoteLedger.remaining : quoteLedger.shortfall) ??
                          "",
                        clears: quoteLedger.clears,
                      }
                }
              />
            )}

            {/*
              And the way out of it.

              A warning that names a shortfall and stops has told somebody they are stuck. This is
              the one thing they can do about it, as a key rather than a link in a sentence: the row
              is the last thing in the notice, it is the only thing in it that can be pressed, and it
              should look like it. Only on the MON shortfall — the pair's asset is bought wherever
              its holders buy it, and this app has no business guessing where that is.
            */}
            {ledger && !ledger.clears && (
              <a
                href={MON_SWAP_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="doku-token-key inline-flex h-9 w-full items-center justify-center gap-2 rounded-doku-lg px-3 font-ui font-semibold text-[11.5px] uppercase leading-none tracking-[0.05em] text-warn-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku"
              >
                Get MON
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                  className="shrink-0"
                >
                  <path d="M7 17 17 7M9 7h8v8" />
                </svg>
              </a>
            )}
          </div>
        </Notice>
      )}

      <ButtonWithConnectWalletFallback className="w-full" block variant="solid" solidSize="lg">
        <LaunchCta
          as="button"
          disabled={!complete || pending || insufficientBalance || Boolean(blockedReason)}
          loading={pending}
          onClick={onClick}
        >
          {label}
        </LaunchCta>
      </ButtonWithConnectWalletFallback>

      {/*
        The outcome, in the app's own message material.

        This was a hand-built panel repeating `Notice`'s construction — the same 10%/30% tint pair,
        its own radius and padding — with the severity carried by an emoji at the head of the title
        (`⏳`, `🔄`, `⚠️`). Three emoji is three marks the theme cannot reach and that render at
        three different weights per platform, on the one message a launcher reads after committing
        to a transaction.

        `terms-changed` and `awaiting-contract` stay amber rather than red, for the reason they
        always did: the terms moved, nothing was spent, and the next press reads the new ones. That
        is news, and colouring it as a fault teaches people to distrust a form that is working
        correctly.
      */}
      {result && result.status !== "submitted" && (
        <Notice
          tone={
            result.status === "awaiting-contract" || result.status === "terms-changed"
              ? "warn"
              : "error"
          }
          title={
            result.status === "awaiting-contract"
              ? "Not yet"
              : result.status === "terms-changed"
                ? "The terms moved"
                : "Didn't go through"
          }
          /* The original error, behind a disclosure. It was the *message* until now, which is how
             an unreachable RPC put its URL, its JSON request body and a viem version stamp under
             the launch button — see `explainChainError`. */
          detail={result.status === "failed" ? result.detail : undefined}
        >
          {result.reason}
        </Notice>
      )}
    </div>
  );
};

export default LaunchAction;
