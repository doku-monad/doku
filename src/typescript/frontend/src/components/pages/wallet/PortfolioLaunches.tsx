"use client";

import { CoinMark } from "components/ui/coin-mark";
import { cn } from "lib/utils/class-name";
import { formatAge } from "lib/utils/format-compact";
import { useRouter } from "next/navigation";
import React, { useMemo } from "react";
import { ROUTES } from "router/routes";

import { marketPath } from "@/lib/market-path";
import { identityFor } from "@/lib/token-identity";

import { PortfolioCreatorFees } from "./PortfolioCreatorFees";
import { PORTFOLIO_LABEL } from "./PortfolioMasthead";
import { groupByQuote } from "./quote-groups";
import { type LaunchRow, useClaimFees } from "./usePortfolioLaunches";

/**
 * What this address launched, and the fees those launches have made.
 *
 * ## The shape of a row
 *
 * Three columns, not six. A coin, what it has earned, and the one control that acts on it —
 * everything else a row has to say (the ticker, the age, whether it migrated) is metadata about
 * the coin, so it sits under the coin's own name the way it does on a board card. Six fixed
 * columns in a 500px rail is how the activity tab ended up truncating the figure it existed to
 * show.
 *
 * ## The claims, and why most of them are inert
 *
 * A market can owe its creator on two counts: the routed share of the protocol fee, paid to
 * `feeRecipient` by `collectFees()`, and the creator's own tax, paid to `taxRecipient` by
 * `collectTax()`. They are set at launch, they need not be the same address, and either can be
 * somebody else's — so each button is live exactly when the chain says that money is the reader's,
 * and the row states plainly where it goes when it is not.
 *
 * The alternative — a claim button on every row that spends the creator's gas to pay a treasury —
 * is the kind of interface that gets somebody's trust exactly once.
 *
 * ## And the money that never reached either of them
 *
 * A routed payment whose push to the recipient fails lands in `CreatorSink`, and a GRADUATED
 * market's fees accrue in the hook, which pushes to nobody at all. Neither belongs to a single
 * market's row — a claim is per quote asset and a pull is per pool — so both live in
 * `PortfolioCreatorFees` above the list. Not summed: a creator owed USDC and MON is owed two
 * amounts of two different things.
 *
 * ## Nothing on this tab is added across quote assets
 *
 * The strip totals within each asset and shows the largest, saying how many others there are. A
 * single "Fees generated · MON" over markets priced in MON, USDC and troy ounces was a number with
 * no unit.
 */

const compact = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(1)}K`
      : n.toLocaleString(undefined, { maximumFractionDigits: n >= 1 ? 2 : 4 });

/** Migrated, or how far up the curve. The one fact that changes what a launch *is*. */
const StatusPill = ({ row }: { row: LaunchRow }) => {
  const pct = row.progress * 100;
  const graduating = !row.graduated && pct >= 90;
  const [dot, text, ring, label] = row.graduated
    ? ["bg-halo", "text-halo-ink", "border-halo/35 bg-halo/10", "Migrated"]
    : graduating
      ? ["bg-warn", "text-warn-ink", "border-warn/40 bg-warn/10", `Curve ${pct.toFixed(0)}%`]
      : ["bg-doku", "text-doku-ink", "border-doku/30 bg-doku/8", `Curve ${pct.toFixed(0)}%`];

  return (
    <span
      className={cn(
        "inline-flex h-[19px] shrink-0 items-center gap-1.5 rounded-doku-sm border border-solid px-1.5 font-numeric text-[11px] font-semibold uppercase leading-none tracking-[0.06em]",
        ring,
        text
      )}
    >
      <span className={cn("h-1 w-1 rounded-full", dot)} aria-hidden />
      {label}
    </span>
  );
};

/** One figure in the strip above the list. */
const Cell = ({
  label,
  children,
  tone,
}: {
  label: string;
  children: React.ReactNode;
  tone?: "up";
}) => (
  <div className="doku-token-cell flex min-w-0 flex-col gap-2.5 px-3.5 py-3">
    <span className={cn(PORTFOLIO_LABEL, "truncate")}>{label}</span>
    <span
      className={cn(
        "truncate font-numeric text-[15px] font-semibold leading-none tabular-nums",
        tone === "up" ? "text-doku-ink" : "text-ink"
      )}
    >
      {children}
    </span>
  </div>
);

export const PortfolioLaunches = ({
  rows,
  isLoading,
  isOwn,
  onClaimed,
}: {
  rows: LaunchRow[];
  isLoading: boolean;
  /** The claim column only exists on your own page — it is your money or it is nobody's. */
  isOwn: boolean;
  onClaimed: () => void;
}) => {
  const router = useRouter();
  const { claim, pending, error } = useClaimFees();

  /**
   * Two different sums, because the cell means two different things.
   *
   * On your own page it is **claimable** — what you could collect right now, so only the markets
   * whose recipient is you. On anybody else's it is **uncollected**, the MON sitting on those
   * curves whoever it belongs to. Summing only "yours" under an "Uncollected" heading is how a
   * visitor's page reads a confident zero over four markets holding real balances.
   */
  const generatedGroups = useMemo(
    () =>
      groupByQuote(
        rows,
        (r) => r.quoteSymbol,
        (r) => r.feesGenerated
      ),
    [rows]
  );

  /**
   * Two different sums, because the cell means two different things.
   *
   * On your own page it is **claimable** — what you could collect right now, so only the markets
   * whose recipient is you, counting both charges. On anybody else's it is **uncollected**,
   * whatever is sitting on those curves whoever it belongs to. Summing only "yours" under an
   * "Uncollected" heading is how a visitor's page reads a confident zero over four markets holding
   * real balances.
   *
   * Both are grouped by quote asset. Neither is one number.
   */
  const claimableGroups = useMemo(
    () =>
      groupByQuote(
        rows,
        (r) => r.quoteSymbol,
        (r) =>
          isOwn
            ? (r.yours ? r.pending : 0) + (r.taxYours ? r.pendingTax : 0)
            : r.pending + r.pendingTax
      ),
    [rows, isOwn]
  );

  const generated = generatedGroups[0] ?? null;
  const claimableTotal = claimableGroups[0] ?? null;

  /** True when at least one launch pays somebody else — the note below only earns its space then. */
  const routedAway = rows.some((r) => r.recipient !== null && !r.yours);

  if (isLoading) {
    return (
      <div className="grid h-full place-items-center">
        <span className="font-numeric text-[12px] text-mute">Loading launches…</span>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <span className={PORTFOLIO_LABEL}>No launches</span>
        <p className="max-w-[42ch] font-ui text-[13px] leading-relaxed text-mute">
          This address has not launched a coin. A launch earns a share of every trade its market
          makes, and the fees show up here.
        </p>
        <button
          type="button"
          onClick={() => router.push(ROUTES.launch)}
          className="doku-token-key mt-1 inline-flex h-9 items-center rounded-doku-lg px-3.5 font-ui font-semibold text-[11px] uppercase leading-none tracking-[0.04em] text-ash"
        >
          Launch a coin
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ---- What the launches add up to ------------------------------------------------- */}
      <div className="doku-launch-strip overflow-hidden rounded-[12px]">
        <div className="-ml-px -mt-px grid grid-cols-3">
          <Cell label="Launched">{rows.length}</Cell>
          <Cell label="Fees generated">
            {generated === null ? (
              <span className="text-mute">—</span>
            ) : (
              <>
                {compact(generated.total)}
                <span className="ml-1 text-[max(11px,0.7em)] font-medium text-mute">
                  {generated.symbol ?? "—"}
                </span>
                {generatedGroups.length > 1 && (
                  <span className="ml-1.5 text-[max(11px,0.62em)] font-medium uppercase tracking-[0.06em] text-mute">
                    {`+${generatedGroups.length - 1}`}
                  </span>
                )}
              </>
            )}
          </Cell>
          <Cell
            label={isOwn ? "Claimable" : "Uncollected"}
            tone={isOwn && (claimableTotal?.total ?? 0) > 0 ? "up" : undefined}
          >
            {claimableTotal === null ? (
              <span className="text-mute">—</span>
            ) : (
              <>
                {compact(claimableTotal.total)}
                <span className="ml-1 text-[max(11px,0.7em)] font-medium text-mute">
                  {claimableTotal.symbol ?? "—"}
                </span>
              </>
            )}
          </Cell>
        </div>
      </div>

      {/*
        What the creator sink is holding, what a pull would add to it, and the two buttons that
        move each. Read off the chain rather than off the ledger, because the question a button
        needs answered is not "what has this market earned" but "which of the three contracts is
        holding it right now" — and a graduated market's fees sit in the hook until somebody calls
        `pull`, which nothing in this app used to offer. Own page only: it is your money or it is
        nobody's, and the panel's every figure is keyed on the connected wallet.
      */}
      {isOwn && <PortfolioCreatorFees rows={rows} onClaimed={onClaimed} />}

      {error && (
        <p role="alert" className="pt-3 font-ui text-[12px] leading-snug text-loss-ink">
          {error}
        </p>
      )}

      {/* ---- The launches ---------------------------------------------------------------- */}
      <div className="pr-1 pt-4">
        <div className="doku-feed-head flex items-center gap-3 px-3 pb-2.5 font-ui font-semibold text-[11px] uppercase leading-none tracking-[0.04em] text-mute">
          <span className="min-w-0 flex-1 pl-1">Coin</span>
          <span className="w-[96px] shrink-0 text-right">Fees earned</span>
          {isOwn && <span className="w-[116px] shrink-0 text-right">Claim</span>}
        </div>
      </div>

      <ul className="doku-scrollbar flex min-h-0 flex-1 list-none flex-col gap-1.5 overflow-y-auto pr-1 pt-1.5">
        {rows.map((r) => {
          const identity = identityFor({ marketAddress: r.marketAddress, symbol: r.symbol });
          /*
            Which claim, if either. The routed share first — it is the larger of the two on almost
            every market — and the creator's own tax where that is what is owed. Offering both
            buttons in a 116px column would put two irreversible actions a pixel apart.
          */
          const kind: "fees" | "tax" | null =
            r.yours && r.pending > 0 ? "fees" : r.taxYours && r.pendingTax > 0 ? "tax" : null;
          const owed = kind === "tax" ? r.pendingTax : r.pending;
          const busy = pending === r.marketAddress;

          return (
            <li key={r.marketAddress}>
              <div className="doku-feed-row group/row relative flex items-center gap-3 rounded-[11px] px-3 py-2.5">
                {/* The coin, with everything a row says about it beneath its own name. */}
                <button
                  type="button"
                  onClick={() => router.push(marketPath(r.tokenAddress))}
                  className="flex min-w-0 flex-1 items-center gap-2.5 pl-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku"
                >
                  <CoinMark
                    logo={identity.logo}
                    ticker={identity.ticker}
                    name={identity.name}
                    size={32}
                    className="rounded-[9px]"
                  />
                  <span className="flex min-w-0 flex-col gap-1.5">
                    <span className="truncate font-ui text-[13.5px] font-medium leading-none text-ink">
                      {identity.name}
                    </span>
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="shrink-0 font-numeric text-[11px] leading-none text-mute">
                        <span className="text-mute">$</span>
                        {identity.ticker}
                      </span>
                      <span aria-hidden className="text-[11px] leading-none text-line-2">
                        ·
                      </span>
                      <span
                        className="shrink-0 font-numeric text-[11px] leading-none text-mute"
                        title={r.launchedAt.toLocaleString()}
                      >
                        {formatAge(r.launchedAt)}
                      </span>
                      <StatusPill row={r} />
                    </span>
                  </span>
                </button>

                <span className="flex w-[96px] shrink-0 flex-col items-end gap-1.5">
                  <span className="font-numeric text-[13px] font-medium tabular-nums text-ink">
                    {compact(r.feesGenerated)}
                    {/* The market's OWN quote asset. It said MON on every row. */}
                    <span className="ml-1 text-[max(11px,0.78em)] font-normal text-mute">
                      {r.quoteSymbol ?? "—"}
                    </span>
                  </span>
                  {/* The derivation is gone with the arithmetic: this is the ledger's own sum over
                      the fee events, not one percent of turnover. */}
                  <span className="font-numeric text-[11px] leading-none text-mute">
                    {`on ${compact(r.volume)} traded`}
                  </span>
                </span>

                {isOwn && (
                  <span className="flex w-[116px] shrink-0 justify-end">
                    {kind !== null ? (
                      /* On the wrapper, not the button: a disabled button has
                         `pointer-events: none` and can never draw its own tooltip — and this key
                         is disabled for every row on the page while any one claim is in flight. */
                      <span
                        title={
                          kind === "tax"
                            ? "Your creator tax on this market"
                            : "Your routed share of the protocol fee"
                        }
                        className="inline-flex"
                      >
                        <button
                          type="button"
                          disabled={pending !== null}
                          onClick={() => claim(r.marketAddress, kind, onClaimed)}
                          className="doku-launch-claim inline-flex h-8 items-center gap-1.5 rounded-doku-lg px-2.5 font-ui font-semibold text-[11px] uppercase leading-none tracking-[0.04em] text-doku-ink disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku"
                        >
                          {busy ? (
                            "Claiming…"
                          ) : (
                            <>
                              Claim
                              <span className="font-numeric text-[11px] font-semibold tabular-nums">
                                {compact(owed)}
                              </span>
                            </>
                          )}
                        </button>
                      </span>
                    ) : r.recipient === null && r.taxRecipient === null ? (
                      <span className="font-numeric text-[11px] text-mute">—</span>
                    ) : r.yours || r.taxYours ? (
                      <span className="font-numeric text-[11px] text-mute">Nothing yet</span>
                    ) : (
                      <span
                        title={`Fees from this market pay ${r.recipient}, which is not the connected wallet.`}
                        className="font-numeric text-[11px] text-mute"
                      >
                        Routes elsewhere
                      </span>
                    )}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {/*
        Why a row can say "routes elsewhere".

        Stated once, at the foot, and only when a row actually says it. This is the single fact
        that explains an inert claim button, and leaving somebody to guess at it is how a page
        earns a support ticket.
      */}
      {isOwn && routedAway && (
        <p className="doku-token-band -mx-4 mt-4 px-4 py-2.5 font-ui text-[11.5px] leading-snug text-mute sm:-mx-5 sm:px-5">
          The 1% trade fee is written into each market at launch. Where it names an address other
          than yours, the claim is that address&rsquo;s to make — a creator share is recorded off
          chain and is not yet something a curve can pay out.
        </p>
      )}
    </div>
  );
};

export default PortfolioLaunches;
