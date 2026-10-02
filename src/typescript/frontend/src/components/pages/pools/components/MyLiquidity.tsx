"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Emoji } from "utils/emoji";
import { useAccount } from "wagmi";

import { toNominal } from "@/lib/chain/config";
import type { MarketRef } from "@/lib/chain/position-matching";
import { type OwnerPosition, useOwnerPositions } from "@/lib/hooks/doku/use-liquidity";
import { useLiquidityActions } from "@/lib/hooks/doku/use-liquidity-actions";
import { marketPath } from "@/lib/market-path";
import type { MarketModel } from "@/lib/models";

/**
 * Every position the connected wallet holds, above the pool list.
 *
 * Before this, a position was only visible inside the one market whose row was expanded, under a
 * tab — so seeing what you held across four pools meant expanding four rows and clicking a tab in
 * each. The reads were already being done; only the discard was in the way.
 *
 * Absent entirely when there is nothing to show. Most people arriving here have no positions, and
 * an empty "My liquidity" card on every first visit is chrome for its own sake.
 */

const fmt = (value: bigint, dp = 4) => {
  const n = toNominal(value);
  if (n === 0) return "0";
  if (n < 0.0001) return n.toExponential(2);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(dp).replace(/\.?0+$/, "");
};

const label = "font-forma text-[11px] uppercase tracking-[0.08em] text-faint";
const secondary =
  "h-9 shrink-0 rounded-doku-lg border border-line bg-surface px-3.5 font-forma text-[11px] " +
  "uppercase tracking-[0.08em] text-ash transition-colors hover:border-doku hover:text-doku-ink " +
  "disabled:opacity-40 disabled:hover:border-line disabled:hover:text-ash " +
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-doku";

const Figure = ({ label: l, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex min-w-[88px] flex-col">
    <span className={label}>{l}</span>
    <span className="font-numeric text-[13px] tabular-nums text-ink">{children}</span>
  </div>
);

export default function MyLiquidity({ markets }: { markets: MarketModel[] }) {
  const { address } = useAccount();

  const marketRefs = useMemo<MarketRef[]>(
    () =>
      markets.map((m) => ({
        marketAddress: m.market.marketAddress,
        tokenAddress: m.market.tokenAddress,
        poolAddress: m.state.poolAddress,
        symbol: m.market.symbol,
      })),
    [markets]
  );

  const { positions, isLoading, refetch } = useOwnerPositions(address, marketRefs);
  const { withdraw, pending, error } = useLiquidityActions();

  const total = useMemo(
    () => positions.reduce((sum, p) => sum + (p.valueMon ?? 0), 0),
    [positions]
  );

  // Nothing to say, so nothing is said. Rendering a skeleton here would flash an empty card onto
  // every visitor's first paint and then take it away again, which is worse than arriving late.
  if (!address || isLoading || positions.length === 0) return null;

  const onDone = () => {
    refetch();
  };

  return (
    <section
      aria-labelledby="my-liquidity-heading"
      className="doku-edge-over mb-6 overflow-hidden rounded-doku-2xl bg-surface"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3.5 md:px-5">
        <h2
          id="my-liquidity-heading"
          className="font-forma text-[12px] uppercase tracking-[0.08em] text-ink"
        >
          My liquidity
        </h2>
        <p className="font-numeric text-[12px] tabular-nums text-mute">
          {positions.length} position{positions.length === 1 ? "" : "s"} ·{" "}
          <span className="text-ink">{total.toFixed(4).replace(/\.?0+$/, "")} MON</span>
        </p>
      </header>

      {/*
        Stated once, plainly, because it is the thing an LP most needs to know and the least likely
        to guess: these pools pay their liquidity providers nothing. The pool's own fee is zero by
        construction — the market's levy is taken by the hook rather than accrued to positions — so
        a position here earns no fee from any source while still carrying impermanent loss.
      */}
      <p className="border-b border-line px-4 py-2.5 font-ui text-[12px] leading-relaxed text-mute md:px-5">
        These pools charge no LP fee, so a position earns nothing and is exposed to impermanent
        loss. Liquidity here is a way to hold both sides of a market, not a yield.
      </p>

      <ul className="flex list-none flex-col">
        {positions.map((p) => (
          <Row
            key={p.tokenId.toString()}
            position={p}
            pending={pending}
            onWithdraw={() => withdraw({ position: p, token: p.tokenAddress, onDone })}
          />
        ))}
      </ul>

      {error && (
        <p
          role="alert"
          className="border-t border-line bg-[rgb(198_45_52_/_0.06)] px-4 py-2.5 text-[12px] text-loss-ink md:px-5"
        >
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * A position, and deliberately WITHOUT a fees column or a collect button.
 *
 * A DOKU pool's own LP fee is zero, and it has to be: the market's levy is skimmed by the hook out
 * of the singleton's flash accounting, and a non-zero pool fee would re-arm exactly the
 * JIT-liquidity recapture that the levy exists to escape. So a position here accrues no fee, ever,
 * from any source.
 *
 * That means a "Fees" figure could only ever read 0 and a "Collect" button could only ever be
 * disabled — a zero yield column beside a dead button is the interface confessing the deposit was
 * pointless while still inviting the next one. Better to say it once, plainly, above the list.
 */
function Row({
  position: p,
  pending,
  onWithdraw,
}: {
  position: OwnerPosition;
  pending: string | null;
  onWithdraw: () => void;
}) {
  /** No price means no slippage floor can be computed, so withdrawing has to wait. */
  const priced = p.valueMon !== null;

  return (
    <li className="flex flex-wrap items-center gap-4 border-b border-line px-4 py-3.5 last:border-b-0 md:px-5">
      <Link
        href={marketPath(p.tokenAddress)}
        className="flex min-w-0 shrink-0 items-center gap-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku"
      >
        <Emoji emojis={p.symbol} className="text-[26px] leading-none" />
      </Link>

      <div className="flex flex-1 flex-wrap items-center gap-x-6 gap-y-2">
        <Figure label="MON">{priced ? fmt(p.amountMon) : "—"}</Figure>
        <Figure label="Tokens">{priced ? fmt(p.amountToken, 2) : "—"}</Figure>
        <Figure label="Value">
          {priced ? `${p.valueMon!.toFixed(4).replace(/\.?0+$/, "")} MON` : "—"}
        </Figure>

        {priced ? (
          <span
            className={
              "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-doku-pill px-2.5 font-numeric text-[11px] uppercase tracking-[0.09em] " +
              (p.inRange
                ? "border border-doku/25 bg-doku/10 text-doku-ink"
                : "border border-line bg-raise text-mute")
            }
          >
            <span
              aria-hidden
              className={`h-1.5 w-1.5 rounded-full ${p.inRange ? "bg-doku" : "bg-faint"}`}
            />
            {p.inRange ? "In range" : "Out of range"}
          </span>
        ) : (
          /* The row stays. A position that vanishes because a pool read failed looks exactly like
             a position that is gone. */
          <span className="font-numeric text-[11px] text-warn-ink">
            Pool unavailable — amounts can&rsquo;t be read right now
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          className={secondary}
          disabled={!priced || pending !== null}
          onClick={onWithdraw}
        >
          {pending ?? "Withdraw"}
        </button>
      </div>
    </li>
  );
}
