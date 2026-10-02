"use client";

import { toExplorerLink } from "lib/utils/explorer-link";

/**
 * What a trade actually did, as the notification for it.
 *
 * ## What it replaces
 *
 * The word `Bought`. One word, in the default toast body, after a transaction that moved money —
 * and it answered neither of the two questions somebody asks in the second after signing: *how much
 * did I get*, and *where is the transaction*. The first was left to the balance updating somewhere
 * behind the toast; the second had no answer on this page at all.
 *
 * ## The amount is read from the receipt
 *
 * Not from the quote. A quote is what the venue expected before the block; the receipt is what
 * landed, and on a curve mid-fill or a pool with another trade in the same block those differ. A
 * notification that reports the estimate as though it were the outcome is a notification nobody can
 * check their wallet against.
 *
 * `null` where the received asset is native MON — a sell into a MON-quoted market emits no ERC-20
 * `Transfer` to decode, and the figure is simply omitted rather than replaced with the quote. The
 * side and the link are still worth a toast on their own.
 */
export const TradeToast = ({
  side,
  amount,
  symbol,
  txHash,
}: {
  side: "buy" | "sell";
  /** Already formatted, in whole units. `null` when the receipt carried no readable transfer. */
  amount: string | null;
  symbol: string;
  txHash: string;
}) => (
  <div className="flex min-w-0 flex-col gap-2.5">
    <span className="font-ui font-semibold text-[12px] uppercase leading-none tracking-[0.06em] text-ink">
      {side === "sell" ? "Sold" : "Bought"}
    </span>

    {amount && (
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-1">
        <span className="min-w-0 truncate font-numeric text-[19px] font-semibold leading-none tabular-nums text-ink">
          {amount}
        </span>
        <span className="shrink-0 font-numeric text-[12px] font-medium leading-none tracking-[0.06em] text-mute">
          {symbol}
        </span>
      </span>
    )}

    {/*
      The way to the receipt.

      A key rather than a bare link: this is the one actionable thing in the toast, it sits in a
      surface the reader has three seconds with, and a coloured word in a sentence is not something
      a thumb finds in three seconds. `stopPropagation` because the toast itself is dismiss-on-click
      — without it, following the link closes the toast out from under the tap.
    */}
    <a
      href={toExplorerLink({ linkType: "txn", value: txHash })}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="doku-token-key inline-flex h-7 w-fit shrink-0 items-center gap-1.5 rounded-doku-lg px-2.5 font-ui font-semibold text-[11px] uppercase leading-none tracking-[0.05em] text-ash"
    >
      View transaction
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
        className="shrink-0 text-mute"
      >
        <path d="M7 17 17 7M9 7h8v8" />
      </svg>
    </a>
  </div>
);

export default TradeToast;
