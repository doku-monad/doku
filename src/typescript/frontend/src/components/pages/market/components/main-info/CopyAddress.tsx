"use client";

import { useCallback } from "react";

import { useCopyFlag } from "@/lib/hooks/use-copy-flag";

/**
 * The truncated market address with an inline copy control.
 *
 * This replaces a full-width `COPY COIN ADDRESS` button that occupied a third of the header. The
 * address itself is the useful part — people check the first and last characters against a link
 * they were sent — so it is shown, and copying becomes a 32px affordance beside it rather than the
 * only thing on offer.
 *
 * The confirmation is the icon swapping to a tick for a moment. A toast would be heavier than the
 * action deserves, and silence leaves people clicking twice.
 */
/**
 * The copy, and the moment of confirmation, without the control around them.
 *
 * The token masthead builds its own address control — three segments sharing one machined rail —
 * and it needs exactly this behaviour and none of this component's markup. Lifting the state out is
 * what stops a second `navigator.clipboard` call, a second 1400ms timer and a second idea of what
 * "copied" looks like from appearing in the app.
 */
export const useAddressCopy = (address: string) => {
  const { copied, copy } = useCopyFlag();
  return { copied, copy: useCallback(() => copy(address), [copy, address]) };
};

export const CopyAddress = ({ address, label }: { address: string; label?: string }) => {
  const { copied, copy } = useAddressCopy(address);

  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;

  return (
    /*
      A control, not a caption with an icon after it.
      ----------------------------------------------------------------------------------------
      The whole row is the button: the label, the address and the glyph. An address is something a
      person copies far more often than they read, and giving the label its own dead zone beside a
      32px target is how a control ends up being missed on the first try. The label is the pixel
      face — this app's display face — because it is a marker rather than prose.
    */
    <button
      type="button"
      onClick={copy}
      title={address}
      aria-label={copied ? "Address copied" : `Copy ${label ?? "market"} address ${address}`}
      className="doku-token-addr group/copy flex min-w-0 shrink-0 items-center gap-2 rounded-doku-lg py-1.5 pl-2.5 pr-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku"
    >
      {label && (
        <span className="font-ui font-semibold text-[11.5px] uppercase leading-none tracking-[0.04em] text-ash">
          {label}
        </span>
      )}
      <span className="truncate font-numeric text-[12.5px] leading-none text-ink">{short}</span>
      <span
        className={
          copied
            ? "grid h-5 w-5 shrink-0 place-items-center rounded-[6px] text-doku-ink"
            : "grid h-5 w-5 shrink-0 place-items-center rounded-[6px] text-mute transition-colors group-hover/copy:text-ink"
        }
      >
        {copied ? (
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-doku"
            aria-hidden
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        ) : (
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <rect x="9" y="9" width="12" height="12" rx="2.5" />
            <path d="M5 15V5a2 2 0 0 1 2-2h10" />
          </svg>
        )}
      </span>
    </button>
  );
};

export default CopyAddress;
