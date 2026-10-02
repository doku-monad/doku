"use client";

import { Panel } from "components/ui/panel";
import { cn } from "lib/utils/class-name";
import { emojisToName } from "lib/utils/emojis-to-name-or-symbol";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Emoji } from "utils/emoji";

import { toNominal } from "@/lib/chain/config";
import { marketPath } from "@/lib/market-path";
import type { MarketModel } from "@/lib/models";
import { symbolToEmojis } from "@/sdk/emoji_data/utils";

import LiquidityPanel from "./components/LiquidityPanel";
import MyLiquidity from "./components/MyLiquidity";

/**
 * Graduated markets, and the liquidity anyone can put into them.
 *
 * This page used to say DOKU had no liquidity to offer, because graduation mints one full-range
 * position and burns the NFT. That conflated two things. The burn makes the *protocol's* position
 * unwithdrawable — which is the point, a market that can never lose its floor — and says nothing
 * about the pool, which takes positions from anyone and gives them back.
 *
 * So the page is a place to do that. One market open at a time: a V3 position is a two-sided
 * commitment at a live price, and a grid of them all expanded invites putting the right amount
 * into the wrong pool.
 *
 * ## The surfaces
 *
 * Rebuilt on the same objects as the rest of the app: `Panel` for every module, the machined
 * recessed track for the sort control, pixel-face eyebrows over mono figures, and the market
 * card's display window around each pool's symbol. Before this it was `border-line bg-surface`
 * throughout — flat rectangles that were legible and looked like a different product.
 */
export interface PoolsPageProps {
  markets: MarketModel[];
}

type Sort = "liquidity" | "volume" | "newest";

const SORTS: { id: Sort; label: string }[] = [
  { id: "liquidity", label: "Raised" },
  { id: "volume", label: "24h vol" },
  { id: "newest", label: "Newest" },
];

const compact = (value: bigint, dp = 2) => {
  const n = toNominal(value);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(dp)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(dp)}K`;
  return n.toFixed(dp);
};

/** The window the market card mounts its emoji in, at row scale. */
const SymbolWindow = ({ symbol }: { symbol: string }) => (
  <span className="relative grid h-[54px] w-[54px] shrink-0 place-items-center overflow-hidden rounded-[12px]">
    <span
      aria-hidden
      className="absolute inset-0 rounded-[12px]"
      style={{
        background: "linear-gradient(180deg, #0a0a0c 0%, #0e0e10 50%, #0c0c0e 100%)",
        boxShadow:
          "inset 0 2px 6px rgba(0,0,0,0.9), inset 0 0 4px rgba(0,0,0,0.6), 0 1px 0 rgba(255,252,225,0.05)",
      }}
    />
    {/* Graduated markets are the only thing on this page, so the light is always the pool blue. */}
    <span
      aria-hidden
      className="absolute left-1/2 top-1/2 h-[46px] w-[52px] -translate-x-1/2 -translate-y-1/2 blur-[10px]"
      style={{
        mixBlendMode: "plus-lighter",
        background:
          "radial-gradient(closest-side, rgba(125,225,255,0.22) 0%, rgba(0,186,226,0.10) 45%, rgba(0,140,200,0) 100%)",
      }}
    />
    <Emoji emojis={symbol} className="relative text-[26px] leading-none" />
  </span>
);

/** A headline figure: pixel eyebrow over a mono number. The pairing used across the app. */
const Stat = ({ label, value, unit }: { label: string; value: string; unit?: string }) => (
  <Panel>
    <span className="block font-pixel text-[11px] uppercase leading-none tracking-[0.2em] text-faint">
      {label}
    </span>
    <p className="mt-2.5 flex items-baseline gap-1.5">
      <span className="font-numeric text-[22px] leading-none tabular-nums text-ink">{value}</span>
      {unit && <span className="font-numeric text-[11px] leading-none text-mute">{unit}</span>}
    </p>
  </Panel>
);

/** A per-row figure. Right-aligned so decimals stack down the list. */
const Figure = ({ label, value, unit }: { label: string; value: string; unit?: string }) => (
  <div className="hidden w-[104px] shrink-0 flex-col items-end lg:flex">
    <span className="font-pixel text-[11px] uppercase leading-none tracking-[0.16em] text-faint">
      {label}
    </span>
    <span className="mt-1.5 flex items-baseline gap-1 font-numeric text-[13px] leading-none tabular-nums text-ash">
      {value}
      {unit && <span className="text-[max(11px,0.8em)] text-mute">{unit}</span>}
    </span>
  </div>
);

export default function ClientPoolsPage({ markets }: PoolsPageProps) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("liquidity");
  const [open, setOpen] = useState<string | null>(null);

  const graduated = useMemo(() => {
    const list = markets
      .filter((m) => m.state.poolAddress !== null)
      .filter((m) => (query ? m.market.symbol.includes(query) : true));

    // Sorted by the column that is shown. Ranking on one figure while displaying another produces
    // an order the page appears to contradict.
    return list.sort((a, b) => {
      if (sort === "volume") return Number(b.state.volume24h - a.state.volume24h);
      if (sort === "newest") return b.market.launchedAt.getTime() - a.market.launchedAt.getTime();
      return Number(b.state.quoteRaised - a.state.quoteRaised);
    });
  }, [markets, query, sort]);

  const totals = useMemo(
    () =>
      graduated.reduce(
        (acc, m) => ({
          raised: acc.raised + m.state.quoteRaised,
          volume: acc.volume + m.state.volume24h,
        }),
        { raised: 0n, volume: 0n }
      ),
    [graduated]
  );

  return (
    <div className="mx-auto w-full max-w-[1240px] px-4 py-8 md:px-6">
      <header className="mb-7 flex flex-col gap-3">
        <span className="font-pixel text-[11px] uppercase leading-none tracking-[0.22em] text-halo-ink">
          Graduated
        </span>
        <h1 className="font-pixel text-[30px] font-medium uppercase leading-none tracking-[0.02em] text-ink">
          Pools
        </h1>
        <p className="max-w-[62ch] font-ui text-[14px] leading-relaxed text-mute">
          Markets that filled their curve and graduated into a permanent 1% pool. The position
          minted at graduation is burned and can never be withdrawn — that is the market&rsquo;s
          floor. Yours is not: you can add liquidity and take it back whenever you like. These
          pools pay liquidity providers nothing, and tokens you deposit stop earning dividends.
        </p>
      </header>

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Stat label="Pools" value={graduated.length.toLocaleString()} />
        <Stat label="Raised into pools" value={compact(totals.raised)} unit="MON" />
        <Stat label="24h volume" value={compact(totals.volume)} unit="MON" />
      </div>

      {/* Every market, not the filtered list: your positions should not disappear because you
          typed something into the search box below. */}
      <MyLiquidity markets={markets} />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="block w-full sm:max-w-xs">
          <span className="sr-only">Search graduated markets</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by emoji"
            autoComplete="off"
            /* A recessed well, the same one a form field sits in everywhere else here. */
            className="h-11 w-full rounded-[12px] px-4 font-ui text-[14px] text-ink transition-shadow placeholder:text-faint focus-visible:outline-none"
            style={{
              background: "rgba(0,0,0,0.35)",
              boxShadow: "inset 0 1px 3px rgba(0,0,0,0.8), inset 0 0 0 1px rgba(255,252,225,0.07)",
            }}
          />
        </label>

        {/*
          The sort control, as a machined track.

          A recessed channel with the selected option raised out of it — the dock's own idiom, so a
          segmented control here reads as the same hardware as the nav rather than as a generic
          button group.
        */}
        <div
          className="flex shrink-0 items-center gap-1 rounded-[13px] p-1"
          style={{
            background: "linear-gradient(180deg, #141416 0%, #111113 50%, #0e0e10 100%)",
            boxShadow:
              "inset 0 2px 8px rgba(0,0,0,0.6), inset 0 1px 2px rgba(0,0,0,0.4), 0 1px 0 rgba(255,252,225,0.04)",
          }}
        >
          {SORTS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSort(s.id)}
              aria-pressed={sort === s.id}
              className={cn(
                "h-9 rounded-[9px] px-3.5 font-ui text-[12px] font-medium transition-colors duration-200",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-doku",
                sort === s.id ? "text-ink" : "text-mute hover:text-ash"
              )}
              style={
                sort === s.id
                  ? {
                      background: "linear-gradient(180deg, #1f2023 0%, #17171a 100%)",
                      boxShadow:
                        "inset 0 0 0 1px rgba(255,252,225,0.10), inset 0 1px 0 rgba(255,252,225,0.10)",
                    }
                  : undefined
              }
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {graduated.length === 0 ? (
        <Panel className="px-6 py-20 text-center">
          <p className="font-ui text-[15px] text-ink">
            {query ? "No graduated market matches that." : "No market has graduated yet."}
          </p>
          <p className="mt-1.5 font-ui text-[13px] text-mute">
            {query
              ? "Try a different emoji."
              : "The first curve to reach its target will show up here."}
          </p>
        </Panel>
      ) : (
        <ul className="flex list-none flex-col gap-3">
          {graduated.map((m) => (
            <PoolRow
              key={m.market.marketAddress}
              market={m}
              open={open === m.market.marketAddress}
              onToggle={() =>
                setOpen(open === m.market.marketAddress ? null : m.market.marketAddress)
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function PoolRow({
  market,
  open,
  onToggle,
}: {
  market: MarketModel;
  open: boolean;
  onToggle: () => void;
}) {
  const emojiData = useMemo(
    () => symbolToEmojis(market.market.symbol).emojis,
    [market.market.symbol]
  );
  const name = emojisToName(emojiData);

  return (
    <li>
      <Panel padded={false} accent={open ? "0,186,226" : undefined} className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-4 p-4 md:px-5">
          <SymbolWindow symbol={market.market.symbol} />

          <div className="min-w-0 flex-1">
            <Link
              href={marketPath(market.market.tokenAddress)}
              className="block truncate font-ui font-semibold text-[14px] uppercase leading-none tracking-[0.04em] text-ink transition-colors hover:text-halo-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku"
            >
              {name}
            </Link>
            <span className="mt-2 block font-numeric text-[11px] leading-none text-faint">
              1% fee · full range
            </span>
          </div>

          <Figure label="Market cap" value={compact(market.state.marketCap)} unit="MON" />
          <Figure label="24h vol" value={compact(market.state.volume24h)} unit="MON" />
          <Figure label="Holders" value={market.state.holders.toLocaleString()} />

          {/*
            Open is a quiet control, closed is the invitation.

            Only one row can be open at a time, so the button's job flips: while closed it is the
            thing to click, and while open it is the way out of a panel you are already reading.
            Dressing both states identically made an open row look like it was still asking.
          */}
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className={cn(
              "h-10 shrink-0 rounded-[11px] px-4 font-ui font-semibold text-[11px] uppercase tracking-[0.14em]",
              "transition-all duration-200 ease-out active:scale-[0.97]",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku",
              open ? "text-mute hover:text-ink" : "text-canvas hover:brightness-110"
            )}
            style={
              open
                ? {
                    background: "rgba(0,0,0,0.35)",
                    boxShadow: "inset 0 0 0 1px rgba(255,252,225,0.09)",
                  }
                : {
                    background: "linear-gradient(135deg, #7DE1FF 0%, #00BAE2 52%, #0AE448 130%)",
                    boxShadow:
                      "inset 0 1px 0 rgba(255,255,255,0.4), 0 6px 18px -8px rgba(0,186,226,0.7)",
                  }
            }
          >
            {open ? "Close" : "Liquidity"}
          </button>
        </div>

        {open && (
          <div
            className="border-t border-[rgba(255,252,225,0.07)] px-4 py-5 md:px-5"
            style={{ background: "rgba(0,0,0,0.22)" }}
          >
            <div className="mx-auto w-full max-w-[420px]">
              <LiquidityPanel market={market} />
            </div>
          </div>
        )}
      </Panel>
    </li>
  );
}
