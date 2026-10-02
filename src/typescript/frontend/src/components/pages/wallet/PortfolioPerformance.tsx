"use client";

import { cn } from "lib/utils/class-name";
import React, { useMemo } from "react";

import type { HoldingRow } from "./PortfolioHoldings";
import { PORTFOLIO_LABEL } from "./PortfolioMasthead";
import type { PortfolioPnl } from "./usePortfolioPnl";

/**
 * How the trading has gone.
 *
 * Four facts, and every one of them is arithmetic on this address's own indexed trades rather than
 * a figure anything stores: the best and worst position it still holds, what it has paid the
 * protocol, and what its liquidity has earned back.
 *
 * ## Fees paid, next to fees earned
 *
 * Deliberately adjacent. They are the two sides of the same relationship with the venue — what
 * trading cost, and what providing liquidity returned — and a page that shows one without the
 * other is arguing a case rather than reporting a position.
 *
 * ## Best and worst are only the ones with a basis
 *
 * A position whose cost cannot be reconstructed has no percentage, so it cannot be ranked and is
 * not considered here. Silently treating an unknown basis as zero would make every transferred
 * token the "best" holding on the page.
 */

const compact = (n: number) =>
  Math.abs(n) >= 1_000_000
    ? `${(n / 1_000_000).toFixed(2)}M`
    : Math.abs(n) >= 1_000
      ? `${(n / 1_000).toFixed(1)}K`
      : n.toLocaleString(undefined, { maximumFractionDigits: 2 });

const Figure = ({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "up" | "down";
}) => (
  <div className="doku-token-cell flex min-w-0 flex-col gap-2.5 px-4 py-3.5">
    <span className={cn(PORTFOLIO_LABEL, "truncate")}>{label}</span>
    <span
      className={cn(
        "truncate font-numeric text-[15px] font-semibold leading-none tabular-nums",
        tone === "up" ? "text-doku-ink" : tone === "down" ? "text-loss-ink" : "text-ink"
      )}
    >
      {value}
    </span>
    {sub && <span className="truncate font-numeric text-[11px] leading-none text-mute">{sub}</span>}
  </div>
);

export const PortfolioPerformance = ({
  rows,
  pnl,
  lpFeesEarned,
}: {
  rows: HoldingRow[];
  pnl?: PortfolioPnl;
  /** Uncollected plus collected is not knowable; this is what is claimable now. */
  lpFeesEarned: number | null;
}) => {
  const { best, worst } = useMemo(() => {
    const ranked = rows.filter((r) => r.pnlPct !== null).sort((a, b) => b.pnlPct! - a.pnlPct!);
    return { best: ranked[0] ?? null, worst: ranked.length > 1 ? ranked[ranked.length - 1] : null };
  }, [rows]);

  const pct = (v: number) =>
    `${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(v <= -100 || v >= 100 ? 0 : 1)}%`;

  /** The largest asset's fee total, and how many other assets were paid fees in. */
  const fees = pnl?.feesPaidByQuote[0] ?? null;
  const otherFeeAssets = Math.max(0, (pnl?.feesPaidByQuote.length ?? 0) - 1);

  return (
    <section className="doku-token-tray relative rounded-[17px] p-[3px]">
      <span
        aria-hidden
        className="doku-token-rim pointer-events-none absolute -inset-[3px] rounded-[20px]"
      />

      <div className="doku-token-face relative overflow-hidden rounded-[14px]">
        <div className="doku-swap-head flex items-center justify-between gap-3 px-4 py-3">
          <span className="font-pixel text-[12px] uppercase leading-none tracking-[0.04em] text-ash">
            Performance
          </span>
          <span className={PORTFOLIO_LABEL}>From your trades</span>
        </div>

        <div className="overflow-hidden">
          <div className="-ml-px -mt-px grid grid-cols-2">
            <Figure
              label="Best position"
              tone={best && best.pnlPct! >= 0 ? "up" : best ? "down" : undefined}
              value={best ? `$${best.ticker}` : "—"}
              sub={best ? pct(best.pnlPct!) : "No priced entry yet"}
            />
            <Figure
              label="Worst position"
              tone={worst && worst.pnlPct! >= 0 ? "up" : worst ? "down" : undefined}
              value={worst ? `$${worst.ticker}` : "—"}
              sub={worst ? pct(worst.pnlPct!) : "Needs two priced positions"}
            />
            {/*
              Fees paid, in the asset they were paid in.

              It read `${compact(pnl.feesPaid)} MON` over a total summed across every market the
              address had traded — MON, USDC, gold — which is not a fee anybody paid. The largest
              asset's total is shown, and the caption says when there are others rather than
              folding them in.
            */}
            <Figure
              label="Fees paid"
              value={fees === null ? "—" : `${compact(fees.total)} ${fees.symbol ?? "—"}`}
              sub={
                pnl === undefined
                  ? undefined
                  : otherFeeAssets > 0
                    ? `+ ${otherFeeAssets} other ${otherFeeAssets === 1 ? "asset" : "assets"}`
                    : `over ${pnl.trades.toLocaleString()} trades`
              }
            />
            <Figure
              label="LP fees claimable"
              tone={lpFeesEarned !== null && lpFeesEarned > 0 ? "up" : undefined}
              value={lpFeesEarned === null ? "—" : `${compact(lpFeesEarned)} MON`}
              sub={lpFeesEarned === null ? "No liquidity" : "uncollected"}
            />
          </div>
        </div>

        {/*
          The caveat, where the figures are.

          The walk is capped at a few thousand trades, and an address past that cap has totals that
          are a floor rather than a sum. Saying so under the numbers is the difference between a
          figure and a claim — and it only appears when it is actually true.
        */}
        {pnl?.truncated && (
          <p className="doku-token-band px-4 py-2.5 font-ui text-[11.5px] leading-snug text-mute">
            Counted over your most recent trades — this address has more history than the page
            reads, so realised and fees are a floor.
          </p>
        )}
      </div>

      <span
        aria-hidden
        className="doku-token-edge pointer-events-none absolute inset-[3px] rounded-[14px]"
      />
    </section>
  );
};

export default PortfolioPerformance;
