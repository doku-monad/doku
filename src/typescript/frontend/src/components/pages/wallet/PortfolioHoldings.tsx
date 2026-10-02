"use client";

import { CoinMark } from "components/ui/coin-mark";
import { cn } from "lib/utils/class-name";
import { useRouter } from "next/navigation";
import React, { useMemo } from "react";
import { ROUTES } from "router/routes";
import { formatUnits } from "viem";

import { TOKEN_DECIMALS } from "@/lib/chain/config";
import { marketPath } from "@/lib/market-path";
import { identityFor } from "@/lib/token-identity";

import { PORTFOLIO_LABEL } from "./PortfolioMasthead";
import type { Position } from "./usePortfolio";
import type { PortfolioPnl } from "./usePortfolioPnl";

/**
 * What the address holds.
 *
 * ## Why rows and not the table component
 *
 * It was an `EcTable` — a bordered grid with its own cell components and its own type scale — one
 * tab away from a liquidity table and a trade table built the same way, on a page whose sibling
 * routes are made of soft-edged rows. The market page made this argument first for its trade feed
 * and its holders list; this is the same argument, applied to the page those two link back to.
 *
 * ## The two columns that are new
 *
 * **Avg entry** and **P&L**. Everything else here was already on the page, badly set. These two
 * are what a portfolio is *for* — a list of what you own with no notion of what you paid is a
 * balance sheet with half the sheet missing — and they come from `usePortfolioPnl`, which walks
 * the address's own indexed trades.
 *
 * A position whose basis those trades cannot account for renders a dash in both, never a number.
 * See `usePortfolioPnl` for why that flag exists: tokens arrive by transfer, and an entry price
 * computed from half a history is worse than no entry price at all.
 */

const compact = (n: number) =>
  n >= 1_000_000_000
    ? `${(n / 1_000_000_000).toFixed(2)}B`
    : n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(2)}M`
      : n >= 1_000
        ? `${(n / 1_000).toFixed(1)}K`
        : n.toLocaleString(undefined, { maximumFractionDigits: 2 });

/** A price at the precision a small token needs, without printing eighteen decimals. */
const price = (v: number) => {
  if (!Number.isFinite(v) || v === 0) return "0";
  if (v >= 1) return v.toFixed(4);
  const exp = Math.floor(Math.log10(Math.abs(v)));
  return v.toFixed(Math.min(18, Math.max(4, -exp + 3)));
};

const dash = <span className="text-mute">—</span>;

export interface HoldingRow {
  position: Position;
  name: string;
  ticker: string;
  logo: string | null;
  amount: number;
  avgEntry: number | null;
  pnlPct: number | null;
}

/**
 * The rows, ready to render — built once and shared, because the allocation panel beside this list
 * needs exactly the same set in exactly the same order and must not compute its own.
 */
export function useHoldingRows(
  positions: Position[] | undefined,
  pnl?: PortfolioPnl
): HoldingRow[] {
  return useMemo(() => {
    return (
      (positions ?? [])
        .map((p) => {
          const identity = identityFor({ marketAddress: p.marketAddress, symbol: p.symbol });
          const m = pnl?.byMarket.get(p.marketAddress.toLowerCase());
          const amount = Number(formatUnits(p.balance, TOKEN_DECIMALS));

          // No basis, or a basis the trades cannot account for, means no entry price and no P&L.
          const avgEntry = m && m.basisComplete && m.avgEntry !== null ? m.avgEntry : null;
          // No live price is the same refusal as no basis: a percentage against a missing price is
          // a percentage against zero, which renders as -100% on a position that is perfectly fine.
          const pnlPct =
            avgEntry !== null && avgEntry > 0 && p.lastPrice !== null
              ? (p.lastPrice / avgEntry - 1) * 100
              : null;

          return {
            position: p,
            name: identity.name,
            ticker: identity.ticker,
            logo: identity.logo,
            amount,
            avgEntry,
            pnlPct,
          };
        })
        // Unpriced positions sort last rather than being dropped — a row nobody can value is still
        // a coin this address holds.
        .sort((a, b) => (b.position.valueMon ?? -1) - (a.position.valueMon ?? -1))
    );
  }, [positions, pnl]);
}

export const PortfolioHoldings = ({
  rows,
  isLoading,
}: {
  rows: HoldingRow[];
  isLoading: boolean;
}) => {
  const router = useRouter();

  if (isLoading) {
    return (
      <div className="grid h-full place-items-center">
        <span className="font-numeric text-[12px] text-mute">Loading holdings…</span>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <span className={PORTFOLIO_LABEL}>No coins held</span>
        <p className="max-w-[40ch] font-ui text-[13px] leading-relaxed text-mute">
          Nothing this address holds is a DOKU market yet.
        </p>
        <button
          type="button"
          onClick={() => router.push(ROUTES.explore)}
          className="doku-token-key mt-1 inline-flex h-9 items-center rounded-doku-lg px-3.5 font-ui font-semibold text-[11px] uppercase leading-none tracking-[0.04em] text-ash"
        >
          Browse launches
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="doku-feed-head grid grid-cols-[minmax(0,1.5fr)_92px_88px] items-center gap-3 px-3 pb-2.5 font-ui font-semibold text-[11px] uppercase leading-none tracking-[0.04em] text-mute sm:grid-cols-[minmax(0,1.5fr)_96px_104px_104px_92px]">
        <span>Coin</span>
        <span className="hidden text-right sm:block">Amount</span>
        <span className="hidden text-right sm:block">Avg entry</span>
        <span className="text-right">Value</span>
        <span className="text-right">P&amp;L</span>
      </div>

      <ul className="doku-scrollbar flex min-h-0 flex-1 list-none flex-col gap-1.5 overflow-y-auto pr-1 pt-1.5">
        {rows.map((r) => (
          <li key={r.position.tokenAddress}>
            <button
              type="button"
              onClick={() => router.push(marketPath(r.position.tokenAddress))}
              className="doku-feed-row group/row grid w-full grid-cols-[minmax(0,1.5fr)_92px_88px] items-center gap-3 rounded-[11px] px-3 py-2.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-doku sm:grid-cols-[minmax(0,1.5fr)_96px_104px_104px_92px]"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <CoinMark
                  logo={r.logo}
                  ticker={r.ticker}
                  name={r.name}
                  size={30}
                  className="rounded-[8px]"
                />
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="truncate font-ui text-[13.5px] font-medium leading-none text-ink">
                    {r.name}
                  </span>
                  <span className="truncate font-numeric text-[11px] leading-none text-mute">
                    <span className="text-mute">$</span>
                    {r.ticker}
                  </span>
                </span>
              </span>

              <span className="hidden text-right font-numeric text-[13px] tabular-nums text-ash sm:block">
                {compact(r.amount)}
              </span>

              <span className="hidden text-right font-numeric text-[12px] tabular-nums text-mute sm:block">
                {r.avgEntry === null ? dash : price(r.avgEntry)}
              </span>

              <span className="text-right font-numeric text-[13px] font-medium tabular-nums text-ink">
                {r.position.valueMon === null ? dash : compact(r.position.valueMon)}
                {/* The row's OWN asset. It said "MON" on every row, which on a USDC market
                    mislabels the figure and on a gold market mislabels it by a factor of a
                    thousand-odd — and it invites the reader to add the column up. */}
                <span className="ml-1 text-[max(11px,0.78em)] font-normal text-mute">
                  {r.position.quoteSymbol ?? "—"}
                </span>
              </span>

              <span className="text-right">
                {r.pnlPct === null ? (
                  <span
                    title="No entry price: some of this balance did not come from a trade DOKU indexed"
                    className="font-numeric text-[12px] text-mute"
                  >
                    —
                  </span>
                ) : (
                  <span
                    className={cn(
                      "inline-flex shrink-0 rounded-doku-sm border border-solid px-1.5 py-[3px] font-numeric text-[11.5px] font-semibold leading-none tabular-nums",
                      r.pnlPct < 0
                        ? "border-loss/30 bg-loss/10 text-loss-ink"
                        : "border-doku/30 bg-doku/10 text-doku-ink"
                    )}
                  >
                    {`${r.pnlPct < 0 ? "−" : "+"}${Math.abs(r.pnlPct).toFixed(r.pnlPct >= 100 ? 0 : 1)}%`}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default PortfolioHoldings;
