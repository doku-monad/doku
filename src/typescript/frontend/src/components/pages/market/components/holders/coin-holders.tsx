"use client";

import { cn } from "lib/utils/class-name";
import { useRouter } from "next/navigation";
import { type FC, useMemo } from "react";
import { ROUTES } from "router/routes";
import { formatUnits } from "viem";

/* The token's own decimals. Every launched token is eighteen; this column is a token balance,
   not a quote amount, so this is the one figure on the page a fixed eighteen is right for. */
import { TOKEN_DECIMALS as BASE_DECIMALS } from "@/lib/chain/config";
import type { HolderModel } from "@/lib/models";

interface Props {
  /** The coin's ticker, for the balance column's header. Not the on-chain emoji symbol. */
  ticker: string;
  holders: HolderModel[];
}

/**
 * Top holders.
 *
 * ## Why this is rows and not the table component
 *
 * It was an `EcTable` — a bordered grid with its own cell components, its own sort machinery and
 * its own type scale — one tab away from a trade feed built out of soft-edged rows. Two tabs in
 * one deck, listing two facts about the same market, in two visual languages: switching between
 * them read as arriving somewhere else. The feed made this argument first (see `TradeFeed`); this
 * is the same argument applied to the tab beside it.
 *
 * ## The share bar
 *
 * A distribution is a shape, not a column of percentages. The bar behind each row is that shape
 * drawn at the width the figure states, so "one wallet holds a third of this" is visible before
 * any number is read — which is the single thing somebody opens this tab to find out.
 *
 * ## What the percentage is *of*, and why the browser must not compute it
 *
 * SUPPLY, net of burns — the figure every explorer and wallet tracker reports, so a reader can
 * check it anywhere. It was a fraction of circulating (supply minus the pool and the curve), which
 * on a graduated market made a wallet holding 5% of the token read as 28%. The service knows the
 * burned amount and the browser does not, so `share` comes off the endpoint.
 *
 * It used to be recomputed here as a fraction of the balances on THIS PAGE. That is a different
 * denominator on every list — fifty rows of a market with two thousand holders sum to a fraction
 * of supply, so every share was inflated, and by a different factor per market. On the one tab
 * people open to judge concentration.
 *
 * `label` comes from the same place: the creator is the one address worth marking, and the list
 * leaves out what the holder count leaves out — the curve, the pool, the hook, the sink and the
 * dead address — so the tab's row count and the masthead's figure are the same number.
 */
export const CoinHolders: FC<Props> = ({ ticker, holders }) => {
  const router = useRouter();

  const rows = useMemo(
    () =>
      holders
        .slice()
        .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0))
        .map((h, index) => ({
          holder: h.holder,
          amount: Number(formatUnits(h.balance, BASE_DECIMALS)),
          // A fraction of supply net of burns, from the endpoint. Not recomputed — see above.
          share: h.share * 100,
          label: h.label,
          rank: index + 1,
        })),
    [holders]
  );

  /** The largest share in the list, so the bars scale to what is actually here. */
  const top = rows[0]?.share ?? 0;

  const compact = (n: number) =>
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(2)}M`
      : n >= 1_000
        ? `${(n / 1_000).toFixed(1)}K`
        : n.toLocaleString(undefined, { maximumFractionDigits: 2 });

  const shortAddress = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

  if (rows.length === 0) {
    // The same height the populated list occupies, so switching tabs does not resize the deck and
    // move the tab bar out from under the pointer that just clicked it.
    return (
      <div className="grid min-h-0 flex-1 place-items-center">
        <span className="font-numeric text-[12px] text-mute">No holders yet</span>
      </div>
    );
  }

  return (
    /* Fills the deck's fixed tab panel — see the note in `TradeFeed`. */
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="doku-feed-head flex items-center gap-3 px-3 pb-2.5 font-ui font-semibold text-[11px] uppercase leading-none tracking-[0.04em] text-mute">
        <span className="w-[38px] shrink-0 pl-1">Rank</span>
        <span className="min-w-0 flex-1">Holder</span>
        <span className="hidden w-[132px] shrink-0 text-right sm:block">{ticker}</span>
        <span className="w-[104px] shrink-0 text-right" title="Of circulating supply">
          Share
        </span>
      </div>

      <ul className="doku-scrollbar flex min-h-0 flex-1 list-none flex-col gap-1.5 overflow-y-auto pr-1 pt-1.5">
        {rows.map((r) => (
          <li key={r.holder}>
            <button
              type="button"
              onClick={() => router.push(`${ROUTES.wallet}/${r.holder}`)}
              className="doku-feed-row group/row relative flex w-full items-center gap-3 overflow-hidden rounded-[11px] px-3 py-2.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-doku"
            >
              {/* The share, as the row's own ground. Scaled against the largest holder rather than
                  against 100%, or a list where nobody holds more than 4% is a list of empty rows. */}
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-0 left-0 rounded-[11px]"
                style={{
                  width: `${top > 0 ? Math.max(1.5, (r.share / top) * 100) : 0}%`,
                  background:
                    "linear-gradient(90deg, rgb(var(--doku-rgb) / 0.16) 0%, rgb(var(--doku-rgb) / 0.03) 100%)",
                }}
              />

              {/* The rank plate — the same machined tab the card and the runner board rank with. */}
              <span className="doku-holder-rank relative grid h-6 w-[38px] shrink-0 place-items-center rounded-[7px] font-numeric text-[11px] font-medium leading-none tabular-nums text-mute">
                {String(r.rank).padStart(2, "0")}
              </span>

              <span className="relative flex min-w-0 flex-1 items-center gap-2">
                <span className="min-w-0 truncate font-numeric text-[12.5px] tabular-nums text-ash">
                  {shortAddress(r.holder)}
                </span>
                {/* What this address IS, where it is not simply a holder. A large balance with no
                    explanation is the thing this tab exists to raise; naming it answers it. */}
                {r.label && (
                  <span className="shrink-0 rounded-doku-sm border border-solid border-line-2 px-1.5 py-[3px] font-pixel text-[11px] uppercase leading-none tracking-[0.06em] text-mute">
                    {r.label}
                  </span>
                )}
              </span>

              <span className="relative hidden w-[132px] shrink-0 text-right font-numeric text-[13px] font-medium tabular-nums text-ink sm:block">
                {compact(r.amount)}
              </span>

              <span
                className={cn(
                  "relative w-[104px] shrink-0 text-right font-numeric text-[12.5px] font-semibold tabular-nums",
                  r.share >= 10 ? "text-warn-ink" : "text-ash"
                )}
              >
                {`${r.share.toFixed(2)}%`}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default CoinHolders;
