"use client";

import React, { useMemo } from "react";

import type { HoldingRow } from "./PortfolioHoldings";
import { PORTFOLIO_LABEL } from "./PortfolioMasthead";

/**
 * Where the money is, as a share of the whole.
 *
 * ## The form
 *
 * A stacked bar, not a donut. The question this answers is "how concentrated am I" — a comparison
 * of parts against one total — and a bar reads that in one horizontal sweep where a ring makes the
 * reader compare angles. It is also the shape the rest of this product already uses for a
 * proportion, so it needs no new visual vocabulary.
 *
 * ## The palette, and why it is not the brand's
 *
 * The app's own six card hues — brand green, halo, lilac, blush, warn, loss — fail as a
 * categorical set on this ground, and not by opinion: run through the six checks they sit outside
 * the lightness band, blush drops under the chroma floor, and lilac against halo separates by only
 * ΔE 5.4 under deuteranopia, which is invisible to roughly one man in twelve. These four passed
 * every check against the dark surface, and their light-mode steps against paper.
 *
 * Two hues are deliberately absent: red and amber are this product's *status* colours — a losing
 * position, a market about to graduate — and a slice of a pie chart wearing "loss" red is a
 * portfolio that looks like it is on fire when it is merely diversified.
 *
 * Identity is never colour alone: every segment is named in the legend beside its share, so the
 * chart is readable in greyscale, in print, and to anybody the palette would otherwise fail.
 */

/** The categorical order. Fixed, never cycled — a fifth holding folds into "others". */
const SERIES = ["var(--alloc-1)", "var(--alloc-2)", "var(--alloc-3)", "var(--alloc-4)"] as const;

const REST = "var(--alloc-rest)";

/** How many holdings get their own colour before the tail is grouped. */
const NAMED = 4;

const compact = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(1)}K`
      : n.toLocaleString(undefined, { maximumFractionDigits: 2 });

/**
 * Slices of one whole, which is why the rows have to share a quote asset.
 *
 * A share is `value / total`, and a total over positions priced in MON, in USDC and in troy ounces
 * is a number with no unit — so every percentage drawn from it is meaningless, and meaningless in
 * a way that looks exactly like a normal donut. The caller passes the rows of a SINGLE asset and
 * names it; the panel says which asset it is drawing, so a portfolio spanning several is not
 * mistaken for the whole of one.
 */
export const PortfolioAllocation = ({
  rows,
  liquidityValue,
  quoteSymbol,
}: {
  /** Holdings priced in ONE asset. See above. */
  rows: HoldingRow[];
  /** Liquidity is part of the allocation — an LP position is money that is in this market too. */
  liquidityValue: number;
  /** The asset every row above is priced in. */
  quoteSymbol: string | null;
}) => {
  const slices = useMemo(() => {
    const named = rows.slice(0, NAMED).map((r, i) => ({
      key: r.position.tokenAddress,
      label: `$${r.ticker}`,
      // An unpriced position contributes nothing to a share-of-value chart; it is still in the
      // holdings list, where it renders as a dash rather than as an absence.
      value: r.position.valueMon ?? 0,
      color: SERIES[i],
    }));

    const tailValue =
      rows.slice(NAMED).reduce((sum, r) => sum + (r.position.valueMon ?? 0), 0) + liquidityValue;
    const tailCount = Math.max(0, rows.length - NAMED);

    // One row for everything that did not earn a colour, named for what it actually contains —
    // "others" alone would hide the fact that liquidity is in there too.
    const tailLabel =
      tailCount > 0 && liquidityValue > 0
        ? `${tailCount} more + liquidity`
        : liquidityValue > 0
          ? "Liquidity"
          : `${tailCount} more`;

    const all =
      tailValue > 0
        ? [...named, { key: "rest", label: tailLabel, value: tailValue, color: REST }]
        : named;
    const total = all.reduce((sum, s) => sum + s.value, 0);
    return { all: all.filter((s) => s.value > 0), total };
  }, [rows, liquidityValue]);

  if (slices.total <= 0) return null;

  const pct = (v: number) => (v / slices.total) * 100;

  return (
    <section className="doku-token-tray relative rounded-[17px] p-[3px]">
      <span
        aria-hidden
        className="doku-token-rim pointer-events-none absolute -inset-[3px] rounded-[20px]"
      />

      <div className="doku-token-face relative overflow-hidden rounded-[14px]">
        <div className="doku-swap-head flex items-center justify-between gap-3 px-4 py-3">
          <span className="font-pixel text-[12px] uppercase leading-none tracking-[0.04em] text-ash">
            Allocation
          </span>
          <span className={PORTFOLIO_LABEL}>{`By value · ${quoteSymbol ?? "—"}`}</span>
        </div>

        <div className="flex flex-col gap-3.5 px-4 py-4">
          {/* The bar. A 2px gap between segments, which is what keeps two adjacent shares from
              reading as one longer one. */}
          <div
            role="img"
            aria-label={`Allocation by value: ${slices.all
              .map((s) => `${s.label} ${pct(s.value).toFixed(0)} percent`)
              .join(", ")}`}
            className="doku-alloc-bar flex h-[34px] gap-[2px] overflow-hidden rounded-[8px] p-[3px]"
          >
            {slices.all.map((s) => (
              <span
                key={s.key}
                className="rounded-[5px]"
                style={{ flex: `${Math.max(0.6, pct(s.value))} 0 0`, background: s.color }}
              />
            ))}
          </div>

          <div className="flex flex-col">
            {slices.all.map((s) => (
              <div
                key={s.key}
                className="doku-alloc-row grid grid-cols-[10px_minmax(0,1fr)_auto_auto] items-center gap-2.5 py-2"
              >
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 rounded-[3px]"
                  style={{ background: s.color, boxShadow: "inset 0 0 0 1px rgb(0 0 0 / 0.25)" }}
                />
                <span className="truncate font-numeric text-[12.5px] font-medium text-ink">
                  {s.label}
                </span>
                <span className="font-numeric text-[12.5px] tabular-nums text-ash">
                  {`${pct(s.value).toFixed(1)}%`}
                </span>
                <span className="w-[74px] text-right font-numeric text-[11.5px] tabular-nums text-mute">
                  {compact(s.value)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <span
        aria-hidden
        className="doku-token-edge pointer-events-none absolute inset-[3px] rounded-[14px]"
      />
    </section>
  );
};

export default PortfolioAllocation;
