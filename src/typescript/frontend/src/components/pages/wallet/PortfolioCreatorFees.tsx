"use client";

import { cn } from "lib/utils/class-name";
import React from "react";

import type { CreatorClaimLot, CreatorMarketFees } from "@/lib/chain/creator-fees";
import { collectPlan, formatQuoteAmount } from "@/lib/chain/creator-fees";

import { PORTFOLIO_LABEL } from "./PortfolioMasthead";
import { useCreatorFeeActions, useCreatorFees } from "./useCreatorFees";
import type { LaunchRow } from "./usePortfolioLaunches";

/**
 * What the creator sink is holding for the reader, and the two calls that move it.
 *
 * ## Why a panel and not a column on the launches list
 *
 * A claim is per QUOTE ASSET. `CreatorSink.claimable` is keyed `(who, quote)` and one `claim(quote)`
 * empties the lot however many markets fed it, including markets the reader has since sold and
 * money credited by a curve whose push to their wallet failed. There is no market to hang that
 * button on, so it hangs on the asset.
 *
 * A pull is per MARKET, and it is the step nothing in this app has ever offered. `DokuHook` pushes
 * to nobody — a push inside `afterSwap` that reverted would brick every swap in the pool — so a
 * graduated market's fees sit in the hook's ledgers until somebody calls `CreatorSink.pull`, which
 * sweeps them across into `claimable`. A creator whose only view was `claimable` therefore saw
 * zero, correctly, over real money.
 *
 * ## Every figure is in its own market's quote asset
 *
 * Six decimals for USDC and for gold, eight for the wrapped bitcoins, eighteen for MON, and never a
 * global. Nothing here is added across two assets, and nothing is sorted by size across them
 * either — that is the same mistake wearing a different hat. `formatQuoteAmount` prints a positive
 * balance too small to render as "<0.0001" rather than as "0", so the figure and a live Claim
 * button never contradict each other.
 */

/**
 * One sub-figure under a lot's headline: money that is real and is NOT what the Claim button
 * beside it would pay. Rendered as a plus so the two figures cannot be read as alternatives.
 */
const Waiting = ({ amount, note, lot }: { amount: bigint; note: string; lot: CreatorClaimLot }) =>
  amount === 0n ? null : (
    <span className="font-numeric text-[11px] leading-none text-mute">
      {`+${formatQuoteAmount(amount, lot.quoteDecimals)} ${lot.quoteSymbol ?? ""} ${note}`.replace(
        /\s+/g,
        " "
      )}
    </span>
  );

export const PortfolioCreatorFees = ({
  rows,
  onClaimed,
}: {
  /** The reader's own launches. Every read below is scoped to these markets. */
  rows: LaunchRow[];
  /** Refreshes the launches list, whose pending figures the same transaction changes. */
  onClaimed: () => void;
}) => {
  const { markets, lots, sink, refetch } = useCreatorFees(rows);
  const { pull, collect, pending, progress, error } = useCreatorFeeActions(sink);

  const done = () => {
    refetch();
    onClaimed();
  };

  /*
    Nothing anywhere at any of the three hops. The panel says nothing rather than announcing a zero
    — the launches list below already says "Nothing yet" against each market, and a second empty
    heading is a page telling somebody the same thing twice.
  */
  const anything = lots.some((l) => l.claimable > 0n || l.pullable > 0n || l.onCurve > 0n);
  if (!anything) return null;

  /** The markets an asset's pull would draw from, so a Pull button can name the coin it acts on. */
  const pullableIn = (lot: CreatorClaimLot): CreatorMarketFees[] =>
    markets.filter((m) => m.quoteAsset.toLowerCase() === lot.quoteAsset && m.pullable > 0n);

  const tickerOf = (marketAddress: string) =>
    rows.find((r) => r.marketAddress === marketAddress)?.ticker ??
    rows.find((r) => r.marketAddress === marketAddress)?.symbol ??
    "coin";

  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <span className={PORTFOLIO_LABEL}>Creator fees</span>

      {lots.map((lot) => {
        const toPull = pullableIn(lot);
        // One press: a pull for every market with fees still in the pool, then the claim.
        const plan = collectPlan(lot, markets);
        const prompts = plan.length;
        const busy = pending === lot.quoteAsset;
        return (
          <div key={lot.quoteAsset} className="flex flex-col gap-1.5">
            <div className="doku-feed-row flex items-center gap-3 rounded-[11px] px-3 py-2">
              <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="font-ui text-[12.5px] leading-none text-ash">
                  Held for you by the creator sink
                </span>
                <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <Waiting amount={lot.pullable} note="waiting on a pull" lot={lot} />
                  <Waiting amount={lot.onCurve} note="still on the curve" lot={lot} />
                </span>
              </span>

              <span className="shrink-0 font-numeric text-[13px] font-medium tabular-nums text-ink">
                {formatQuoteAmount(lot.claimable, lot.quoteDecimals)}
                <span className="ml-1 text-[0.78em] font-normal text-mute">
                  {lot.quoteSymbol ?? "—"}
                </span>
              </span>

              {/*
                The reason sits on the wrapper, because a disabled button cannot show it.

                `global.css` gives every disabled button `pointer-events: none`, so a creator
                looking at a dead Claim key beside a figure that reads as money got no answer at
                all — and this is precisely the case that needs one, because the figure and the
                raw balance disagree on purpose (see below). Worse, while any claim is pending
                *every* key on the page is disabled, so the whole panel went quiet at once.
              */}
              <span
                title={
                  prompts === 0
                    ? "Nothing is held for you in this asset, in the sink or in the pools"
                    : prompts === 1
                      ? `Withdraw everything the sink holds for you in ${lot.quoteSymbol ?? "this asset"}`
                      : `Moves your fees out of ${prompts - 1} ${prompts === 2 ? "pool" : "pools"} and then withdraws everything in ${lot.quoteSymbol ?? "this asset"}: ${prompts} wallet prompts, one after another`
                }
                className="inline-flex shrink-0"
              >
                <button
                  type="button"
                  /*
                  `claim(quote)` reverts `NothingToClaim` at zero, and on Monad gas is billed at the
                  LIMIT, so a live button over an empty lot charges a creator for an error. The test
                  that fixes this is on the raw `bigint`, never on the figure beside it — one raw
                  unit of six-decimal gold renders as 0.00 and is still money.
                */
                  disabled={prompts === 0 || pending !== null}
                  onClick={() => void collect(lot.quoteAsset, plan, done)}
                  className="doku-launch-claim inline-flex h-8 shrink-0 items-center rounded-doku-lg px-2.5 font-ui font-semibold text-[11px] uppercase leading-none tracking-[0.04em] text-doku-ink disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku"
                >
                  {busy
                    ? progress && progress.of > 1
                      ? `${progress.kind === "pull" ? "Pulling" : "Claiming"} ${progress.step}/${progress.of}…`
                      : "Claiming…"
                    : prompts > 1
                      ? "Collect & claim"
                      : "Claim"}
                </button>
              </span>
            </div>

            {/*
              One row per market whose hook ledgers still need draining. Per market and not per
              asset because `pull` takes a market: it reads that market's pool id out of the sink's
              own entry, and there is no call that does every market at once.
            */}
            {toPull.map((m) => (
              <div
                key={m.marketAddress}
                className="doku-feed-row ml-4 flex items-center gap-3 rounded-[11px] px-3 py-1.5"
              >
                <span className="min-w-0 flex-1 font-ui text-[12px] leading-none text-mute">
                  {`$${tickerOf(m.marketAddress)} — move fees out of the pool into your balance`}
                </span>
                <span className="shrink-0 font-numeric text-[12px] tabular-nums text-ash">
                  {formatQuoteAmount(m.pullable, m.quoteDecimals)}
                  <span className="ml-1 text-[0.8em] text-mute">{m.quoteSymbol ?? "—"}</span>
                </span>
                <span
                  title="Anyone may do this; the money can only ever reach the recipients the market registered."
                  className="inline-flex shrink-0"
                >
                  <button
                    type="button"
                    disabled={pending !== null}
                    onClick={() => void pull(m.marketAddress, done)}
                    className={cn(
                      "doku-token-key inline-flex h-7 shrink-0 items-center rounded-doku-lg px-2.5 font-ui font-semibold text-[11px] uppercase leading-none tracking-[0.04em] text-ash",
                      "disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku"
                    )}
                  >
                    {pending === m.marketAddress ? "Pulling…" : "Pull"}
                  </button>
                </span>
              </div>
            ))}
          </div>
        );
      })}

      {error && (
        <p role="alert" className="pt-1 font-ui text-[12px] leading-snug text-loss-ink">
          {error}
        </p>
      )}
    </div>
  );
};

export default PortfolioCreatorFees;
