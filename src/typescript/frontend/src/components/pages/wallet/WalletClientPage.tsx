"use client";

import FEATURE_FLAGS from "lib/feature-flags";
import { useMarketList } from "lib/hooks/use-market-list";
import { cn } from "lib/utils/class-name";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ROUTES } from "router/routes";
import { formatUnits } from "viem";
import { useAccount } from "wagmi";

/* LP positions are valued in the pool's native side, which is eighteen decimals. */
import { TOKEN_DECIMALS as BASE_DECIMALS } from "@/lib/chain/config";
import { isNativeQuote } from "@/lib/chain/writes";
import { useOwnerPositions, usePositionFees } from "@/lib/hooks/doku/use-liquidity";

import PortfolioActivity from "./PortfolioActivity";
import PortfolioAllocation from "./PortfolioAllocation";
import { PortfolioHoldings, useHoldingRows } from "./PortfolioHoldings";
import PortfolioLaunches from "./PortfolioLaunches";
import PortfolioMasthead, { PORTFOLIO_LABEL, Vital } from "./PortfolioMasthead";
import PortfolioPerformance from "./PortfolioPerformance";
import { groupByQuote } from "./quote-groups";
import { usePortfolio } from "./usePortfolio";
import { usePortfolioLaunches } from "./usePortfolioLaunches";
import { usePortfolioPnl } from "./usePortfolioPnl";
import { WalletLiquidityTable } from "./WalletLiquidityTable";

/**
 * The portfolio.
 *
 * ## What it was
 *
 * A glass header carrying two figures, over a three-tab deck of `EcTable`s. Everything on it was
 * *held value* — what the address owns, priced now — and nothing on it was performance: no entry
 * price, no realised figure, no fees paid, no sense of concentration. A portfolio page that cannot
 * say what you paid is a balance sheet with half the sheet missing, and the two facts it did show
 * sat in a material nothing else in the product is made of.
 *
 * ## What it is
 *
 * The token page's own composition, applied to an account: a masthead built from the card's tray,
 * rim, bezel and edge, then two rails split by verb — the record on the left, what it adds up to on
 * the right.
 *
 *   - **Masthead**: the address as a generated mark, its two controls, net worth and unrealised,
 *     over ruled cells for held, liquidity, realised, coins, LP positions and trades.
 *   - **Left**: one deck — holdings, liquidity, activity.
 *   - **Right**: allocation, performance, and the liquidity a wallet can actually collect.
 *
 * ## Where the new figures come from
 *
 * `usePortfolioPnl` walks this address's own indexed swaps and keeps an average-cost basis per
 * market. Nothing stores that, so nothing fetches it; it is arithmetic on measured trades, and it
 * refuses to answer where the trades cannot account for the balance. See that file for why the
 * refusal matters more than the number.
 */

const TABS = [
  { key: "holdings", label: "Holdings" },
  { key: "launches", label: "Launches" },
  { key: "liquidity", label: "Liquidity" },
  { key: "activity", label: "Activity" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const compact = (n: number) =>
  Math.abs(n) >= 1_000_000
    ? `${(n / 1_000_000).toFixed(2)}M`
    : Math.abs(n) >= 1_000
      ? `${(n / 1_000).toFixed(1)}K`
      : n.toLocaleString(undefined, { maximumFractionDigits: 2 });

const signed = (n: number) => `${n < 0 ? "−" : "+"}${compact(Math.abs(n))}`;

/**
 * A figure with the asset it is in, because on this page no figure is in "the" currency.
 *
 * Every masthead cell used to print a hard-coded "MON" beside a number that might have been USDC
 * or troy ounces. The unit is whatever the group it came from is denominated in; `size` only picks
 * the type scale.
 */
const Money = ({
  value,
  symbol,
  size = "lg",
}: {
  value: number | null;
  symbol: string | null;
  size?: "lg" | "sm";
}) =>
  value === null ? (
    <span className="text-mute">—</span>
  ) : (
    <>
      {compact(value)}
      <span
        className={
          size === "lg"
            ? "ml-1.5 text-[0.55em] font-medium text-mute"
            : "ml-1 text-[0.7em] font-medium text-mute"
        }
      >
        {symbol ?? "—"}
      </span>
    </>
  );

/**
 * "and there is more of it, in something else".
 *
 * Shown rather than folded in. Dropping the other assets from a total reports a smaller net worth
 * as a fact; adding them reports a number with no unit.
 */
const OtherAssets = ({ count }: { count: number }) =>
  count === 0 ? null : (
    <span className="ml-2 font-numeric text-[0.5em] font-medium uppercase tracking-[0.06em] text-mute">
      {`+${count} more ${count === 1 ? "asset" : "assets"}`}
    </span>
  );

export const WalletClientPage = ({ address }: { address: string; name?: string }) => {
  const [tab, setTab] = useState<TabKey>("holdings");
  const router = useRouter();

  const { data: positions, isLoading } = usePortfolio(address);
  const { data: pnl } = usePortfolioPnl(address);

  const { address: connected } = useAccount();
  const isOwn = Boolean(connected && connected.toLowerCase() === address.toLowerCase());

  /**
   * Liquidity counts toward the total.
   *
   * It was missing from this page's headline figure entirely, so the page understated every
   * account that provides any — and understated it silently, which is the worst way for a balance
   * to be wrong.
   */
  const { data: markets } = useMarketList();
  const { positions: lp, isLoading: lpLoading } = useOwnerPositions(address, markets);
  const { fees } = usePositionFees(address, lp);
  const liquidityValue = useMemo(() => lp.reduce((sum, p) => sum + (p.valueMon ?? 0), 0), [lp]);

  /** What the wallet could collect right now, across every position it owns. */
  const claimableFees = useMemo(() => {
    if (lp.length === 0) return null;
    let total = 0n;
    for (const p of lp) {
      const f = fees.get(p.tokenId.toString());
      if (f) total += f.feesMon;
    }
    return Number(formatUnits(total, BASE_DECIMALS));
  }, [lp, fees]);

  const rows = useHoldingRows(positions, pnl);

  /**
   * What this address holds, totalled WITHIN each quote asset and never across them.
   *
   * It was one `sum(valueMon)` under a heading that said MON. A portfolio holding a USDC market,
   * a gold market and a MON market added three different currencies into one figure — arithmetic
   * with no unit, rendering as confidently as a real balance. See `quote-groups`.
   */
  const heldGroups = useMemo(
    () =>
      groupByQuote(
        rows,
        (r) => r.position.quoteSymbol,
        (r) => r.position.valueMon
      ),
    [rows]
  );

  /**
   * The asset the page leads with: whichever holds the most.
   *
   * Liquidity is added to it only when it IS the native one — an LP position on a v4 pool is
   * valued in MON, and folding that into a USDC total is the same mistake one level up.
   */
  const primary = heldGroups[0] ?? null;
  const primaryIsNative = Boolean(
    primary && primary.items.every((r) => isNativeQuote(r.position.quoteAsset))
  );
  const primaryLiquidity = primaryIsNative ? liquidityValue : 0;
  const otherAssets = Math.max(0, heldGroups.length - 1);

  /**
   * Unrealised, and the share it represents.
   *
   * Only over the positions that have a basis: adding a token with no entry price into the sum
   * would report its entire value as profit. `costBasis` is therefore the cost of the *priced*
   * part of the portfolio, and the percentage is against that same part.
   */
  const { unrealised, unrealisedPct } = useMemo(() => {
    let value = 0;
    let cost = 0;
    // The leading asset's positions only. Value and cost have to be in the same currency for their
    // difference to mean anything, and across assets they are not.
    for (const r of primary?.items ?? []) {
      const m = pnl?.byMarket.get(r.position.marketAddress.toLowerCase());
      if (!m || !m.basisComplete || m.costRemaining <= 0 || r.position.valueMon === null) continue;
      value += r.position.valueMon;
      cost += m.costRemaining;
    }
    if (cost <= 0)
      return { unrealised: null as number | null, unrealisedPct: null as number | null };
    return { unrealised: value - cost, unrealisedPct: ((value - cost) / cost) * 100 };
  }, [primary, pnl]);

  const {
    rows: launches,
    isLoading: launchesLoading,
    refetch: refetchLaunches,
  } = usePortfolioLaunches(address);

  /** Realised in the asset most of it was realised in; the rest is on the performance panel. */
  const realised = pnl?.realisedByQuote[0] ?? null;

  const counts: Record<TabKey, number | undefined> = {
    holdings: positions?.length,
    launches: launchesLoading ? undefined : launches.length,
    liquidity: lp.length,
    activity: pnl?.trades,
  };

  return (
    <div className="flex w-full flex-col gap-4 pb-4">
      <PortfolioMasthead
        address={address}
        isOwn={isOwn}
        loading={isLoading}
        netWorth={
          <>
            <Money
              value={primary === null ? null : primary.total + primaryLiquidity}
              symbol={primary?.symbol ?? null}
            />
            <OtherAssets count={otherAssets} />
          </>
        }
        unrealised={
          unrealised === null ? (
            <span className="text-mute">—</span>
          ) : (
            <span className={unrealised < 0 ? "text-loss-ink" : "text-doku-ink"}>
              {`${signed(unrealised)} ${primary?.symbol ?? ""}`.trim()}
            </span>
          )
        }
        unrealisedPct={unrealisedPct}
        since={pnl?.firstTradeAt ?? null}
        badge={
          launches.length > 0
            ? {
                label: "Launched",
                value: `${launches.length} ${launches.length === 1 ? "coin" : "coins"}`,
              }
            : { label: "Trades", value: pnl ? pnl.trades.toLocaleString() : "—" }
        }
        vitals={
          <>
            <Vital label="Held">
              <Money value={primary?.total ?? null} symbol={primary?.symbol ?? null} size="sm" />
            </Vital>
            {/* LP positions live in v4 pools and are valued in the pool's native side, so this
                cell really is MON — the only one on the masthead that can say so outright. */}
            <Vital label="Liquidity">
              <Money value={liquidityValue} symbol="MON" size="sm" />
            </Vital>
            <Vital
              label="Realised"
              tone={
                realised && realised.total !== 0 ? (realised.total > 0 ? "up" : "down") : undefined
              }
            >
              {realised === null ? (
                "—"
              ) : (
                <>
                  {signed(realised.total)}
                  <span className="ml-1 text-[0.7em] font-medium text-mute">
                    {realised.symbol ?? "—"}
                  </span>
                </>
              )}
            </Vital>
            <Vital label="Coins held">{positions?.length ?? "—"}</Vital>
            <Vital label="LP positions">{lp.length}</Vital>
            <Vital label="Trades">{pnl ? pnl.trades.toLocaleString() : "—"}</Vital>
          </>
        }
      />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.62fr)_minmax(320px,1fr)]">
        {/* ---- The record ------------------------------------------------------------------ */}
        <section className="doku-token-tray relative order-1 rounded-[19px] p-[3px] lg:order-none">
          <span
            aria-hidden
            className="doku-token-rim pointer-events-none absolute -inset-[3px] rounded-[22px]"
          />
          <div className="doku-token-face relative overflow-hidden rounded-[16px]">
            <div
              role="tablist"
              aria-label="Portfolio"
              className="doku-deck-rail doku-chiprow flex items-center gap-3 overflow-x-auto px-3 py-3 sm:px-4"
            >
              {/*
                Equal quarters on a phone, content-sized from `sm`.

                The four keys plus their count chips measure well past the 358px of rail a 390px
                screen has, so the group overflowed its own scroller and `Activity` sat off the edge
                with nothing to say it was there. A scroller is the wrong shape for a control with
                four fixed options: they all have to be visible at once for the group to read as a
                choice rather than as a list.

                `w-full` with `flex-1` keys divides the rail into four ~78px cells. That fits every
                label — `Liquidity` is the longest at ~61px — but not a label *and* a count chip, so
                the chips are `hidden sm:inline-block`. The count is the one genuinely secondary
                thing in the control: it qualifies a destination the reader has not chosen yet, and
                each panel states its own totals once opened. A visible label with a hidden count
                beats four cramped pairs, and beats a fourth tab nobody can see at all.

                From `sm` the group hugs its content and the chips come back, because a full-width
                segmented control stretched across a 700px rail reads as a navigation bar rather
                than as a filter.
              */}
              <div className="doku-seg flex w-full min-w-0 items-center gap-1 rounded-[13px] p-1 sm:w-auto">
                {TABS.map((item) => {
                  const selected = tab === item.key;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      data-active={selected}
                      onClick={() => setTab(item.key)}
                      className="doku-seg-key inline-flex h-9 min-w-0 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-[10px] px-1 font-ui text-[12.5px] font-semibold sm:flex-initial sm:gap-2 sm:px-3.5 sm:text-[13.5px]"
                    >
                      {item.label}
                      {/* Always rendered, never conditional: a chip that appears when its count
                          lands re-flows the whole rail under the pointer, which is half of what
                          "switching tabs is glitchy" was. A dot holds the space until the number
                          is known. */}
                      <span
                        className={cn(
                          "hidden min-w-[1.5ch] rounded-full px-1.5 py-0.5 text-center font-numeric text-[11px] font-medium leading-none tabular-nums sm:inline-block",
                          selected ? "bg-[var(--film-3)] text-ash" : "bg-[var(--film-1)] text-mute"
                        )}
                      >
                        {counts[item.key] ?? "·"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/*
              One height for every tab, and the scrolling happens inside it.

              The deck used to be as tall as whichever tab was open — a 420-row feed, then a 60px
              empty liquidity table — so every switch moved the right rail, the footer, and on a
              short viewport the tab bar itself out from under the pointer that had just clicked
              it. A fixed box with `min-h-0` children is what makes each list scroll in place
              instead of growing the page.
            */}
            <div
              role="tabpanel"
              aria-label={TABS.find((item) => item.key === tab)?.label}
              className="flex h-[524px] flex-col p-4 sm:p-5"
            >
              {tab === "holdings" && <PortfolioHoldings rows={rows} isLoading={isLoading} />}
              {/* Liquidity keeps its table: it carries a collect action and the amounts that
                  action spends, and half-migrating a table that can move money is worse than
                  leaving it whole. */}
              {tab === "launches" && (
                <PortfolioLaunches
                  rows={launches}
                  isLoading={launchesLoading}
                  isOwn={isOwn}
                  onClaimed={refetchLaunches}
                />
              )}
              {tab === "liquidity" &&
                (lpLoading || lp.length > 0 ? (
                  <div className="doku-scrollbar min-h-0 flex-1 overflow-auto">
                    <WalletLiquidityTable address={address} />
                  </div>
                ) : (
                  // The table's own empty state is a bare line of text in a collapsed frame. An
                  // account with no liquidity is the common case, not an error, so it gets the
                  // same treatment the holdings tab gives an empty wallet: what is missing, and
                  // the one place to go and change that.
                  <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                    <span className={PORTFOLIO_LABEL}>No liquidity</span>
                    <p className="max-w-[42ch] font-ui text-[13px] leading-relaxed text-mute">
                      This address holds no LP position in a graduated market. Positions earn a
                      share of every swap fee in the pool they sit in.
                    </p>
                    {/* `/pools` answers 404 while `FEATURE_FLAGS.Liquidity` is off — see
                        `middleware.ts` — so the empty state offers the route only where it
                        exists. Without it the paragraph above still says what a position is. */}
                    {FEATURE_FLAGS.Liquidity && (
                      <button
                        type="button"
                        onClick={() => router.push(ROUTES.pools)}
                        className="doku-token-key mt-1 inline-flex h-9 items-center rounded-doku-lg px-3.5 font-ui font-semibold text-[11px] uppercase leading-none tracking-[0.04em] text-ash"
                      >
                        Browse pools
                      </button>
                    )}
                  </div>
                ))}
              {tab === "activity" && <PortfolioActivity address={address} />}
            </div>
          </div>
          <span
            aria-hidden
            className="doku-token-edge pointer-events-none absolute inset-[3px] rounded-[16px]"
          />
        </section>

        {/* ---- What it adds up to ---------------------------------------------------------- */}
        {/* Below lg the masthead is already the summary — net worth, unrealised, held,
            realised and the counts — so the record comes next and the two summary panels follow
            it, rather than pushing the holdings a screen and a half down. */}
        <div className="order-2 flex min-w-0 flex-col gap-4 lg:order-none">
          <PortfolioAllocation
            rows={primary?.items ?? []}
            liquidityValue={primaryLiquidity}
            quoteSymbol={primary?.symbol ?? null}
          />
          <PortfolioPerformance rows={rows} pnl={pnl} lpFeesEarned={claimableFees} />
        </div>
      </div>
    </div>
  );
};

export default WalletClientPage;
