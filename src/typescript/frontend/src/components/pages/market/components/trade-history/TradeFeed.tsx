"use client";

import { cn } from "lib/utils/class-name";
import { toExplorerLink } from "lib/utils/explorer-link";
import { useMemo, useState } from "react";
import { formatUnits } from "viem";

import { toNominal } from "@/lib/chain/config";
import { useTicker } from "@/lib/hooks/use-ticker";
import type { SwapModel } from "@/lib/models";

/**
 * The trade feed, as rows rather than a table.
 *
 * ## Why not the `EcTable`
 *
 * A `<table>` is the right control when the columns are the point — when you scan *down* one of
 * them comparing values. Nobody reads a trade feed that way. Each line is a self-contained event
 * ("someone sold 95 MON at this price, two hours ago"), read left to right and then abandoned, and
 * a table's job of holding a column rigid across every row buys nothing for that while costing the
 * layout all of its flexibility below about 900px.
 *
 * These are rows in a flex list. They collapse gracefully, they can carry a colour accent per item
 * without styling seven cells, and the one thing a table really was doing for legibility —
 * decimals landing in the same place — is preserved explicitly with `tabular-nums` and fixed-width
 * columns where it matters.
 *
 * ## The decimals
 *
 * `tabular-nums` on every figure. Without it a proportional font sets `1` narrower than `8`, so a
 * column of prices visibly ripples as it scrolls and two numbers of equal magnitude look unequal.
 */

type Row = {
  id: string;
  txHash: string;
  isSell: boolean;
  venue: "curve" | "pool" | "sink";
  quote: number;
  base: number;
  /** Whole quote units per whole token, or null where the scale could not be resolved. */
  price: number | null;
  trader: string;
  time: Date;
};

type SideFilter = "all" | "buy" | "sell";

/**
 * A resolved price, as a readable one. Small tokens need the extra significant digits.
 *
 * `null` prints an em dash rather than a zero. A price whose generation scale could not be
 * resolved is not a price of nothing, and the two must not look the same in a feed people read to
 * decide what a market is worth.
 */
const formatPrice = (v: number | null) => {
  if (v === null) return "—";
  if (!Number.isFinite(v) || v === 0) return "0";
  if (v >= 1) return v.toFixed(4);
  const exp = Math.floor(Math.log10(Math.abs(v)));
  return v.toFixed(Math.min(18, Math.max(4, -exp + 3)));
};

const compact = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(1)}K`
      : n.toLocaleString(undefined, { maximumFractionDigits: 2 });

const shortAddress = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/**
 * How long ago a trade happened, as the feed shows it: `5s ago`, `3m ago`, `2h ago`, `4d ago`.
 *
 * A clock reading — UTC or local — makes the reader do the subtraction, and on a feed that is the
 * only thing they want to know. The exact moment is still there, in the reader's own zone, as the
 * cell's `title`. The value is relative to `now`, which `useTicker` seeds on the client and
 * advances every second; the server pass and the first client pass render the dash, so the two
 * agree and the column needs no hydration exemption.
 */
const AGE_TICK_MS = 1_000;

const formatAgo = (d: Date, now: number): string => {
  const s = Math.max(0, Math.floor((now - d.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

/** The exact moment, in the reader's own zone, for the hover. */
const formatExact = (d: Date) =>
  d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

export function TradeFeed({
  swaps,
  ticker,
  quoteDecimals,
  quoteSymbol,
  emptyLabel = "No trades yet",
}: {
  swaps: SwapModel[];
  /**
   * The QUOTE ASSET's decimals, from the market this feed belongs to.
   *
   * Required, and required because the alternative was a hard-coded `1e18` in the price column —
   * which is the token's scale, not the quote's, and is wrong for every six- and eight-decimal
   * asset in the registry as well as for every generation-2 market at any decimals.
   */
  quoteDecimals: number;
  /**
   * What the amount column is denominated in.
   *
   * It was the literal string `MON`, next to a figure scaled by a literal eighteen — in a feed on a
   * page whose whole premise is that a market can be priced in anything the registry lists. See the
   * note on `quote` in the row mapping below for what that cost. Null in the catalogue means an
   * asset it has never been told about, and `MON` is the fallback the API and the chart already
   * use for it.
   */
  quoteSymbol: string;
  /**
   * The coin's ticker, not its on-chain symbol.
   *
   * The amount column used to end in the raw emoji glyph, so a row read `20.6K MON → 759.5K 🚀🌕`
   * — the one part of the sentence a person cannot say out loud, in a feed they are scanning for
   * *size*. `MOON` is what the card, the header and the swap widget all call it.
   */
  ticker: string;
  emptyLabel?: string;
}) {
  const [side, setSide] = useState<SideFilter>("all");
  // Client-seeded: 0 on the server and on the first client pass, so both render the dash.
  const now = useTicker(AGE_TICK_MS);

  const rows: Row[] = useMemo(
    () =>
      swaps.map((s) => ({
        id: s.id,
        txHash: s.block.txHash,
        isSell: s.swap.isSell,
        venue: s.swap.venue,
        /*
         * The quote asset's own decimals, not the token's.
         *
         * `toNominal` is `formatUnits(v, TOKEN_DECIMALS)` with a hard-coded eighteen, and
         * `quoteVolume` is raw units of whatever this market is priced in. On a six-decimal asset
         * that is twelve orders of magnitude of error in the safe direction: a real 20,600 USDC buy
         * came out as `0`, so every row of the feed read `0 MON → 759.5K MOON` while the masthead
         * directly above it showed the same trades correctly. The prop to fix it was already here
         * and already used by `price`, one line down.
         *
         * `baseVolume` stays on `toNominal` — that one *is* the token, and the token is eighteen.
         */
        quote: Number(formatUnits(s.swap.quoteVolume, quoteDecimals)),
        base: toNominal(s.swap.baseVolume),
        // `priceQuote` is quote RAW units per whole token — the generation scale is already off
        // it (see `lib/chain/quote-scale`). What remains is the quote asset's own decimals.
        price:
          s.swap.priceQuote === null ? null : Number(formatUnits(s.swap.priceQuote, quoteDecimals)),
        trader: s.swap.trader,
        time: s.block.time,
      })),
    [swaps, quoteDecimals]
  );

  /*
   * Buys and sells, separable.
   *
   * The question people actually bring to a trade feed — "is anyone still buying this?" — cannot
   * be answered by reading a mixed list. Filtering happens over what is already loaded rather than
   * by refetching, so switching is instant.
   */
  const visible = useMemo(
    () => (side === "all" ? rows : rows.filter((r) => (side === "sell" ? r.isSell : !r.isSell))),
    [rows, side]
  );

  return (
    /* `min-h-0 flex-1`: this fills the deck's fixed tab panel, and the list inside fills what
       is left of it. Without `min-h-0` a flex child refuses to shrink below its content and the
       scroll never engages — the panel grows instead, which is the bug this replaced. */
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ---- Filter ---------------------------------------------------------------------- */}
      <div className="flex items-center justify-between gap-3 pb-4">
        <div className="doku-seg flex items-center gap-1 rounded-[11px] p-1">
          {(["all", "buy", "sell"] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setSide(key)}
              aria-pressed={side === key}
              data-active={side === key}
              className="doku-seg-key h-8 rounded-[8px] px-3 font-ui text-[13.5px] font-semibold capitalize"
            >
              {key}
            </button>
          ))}
        </div>
        <span className="font-numeric text-[11px] tabular-nums text-mute">
          {visible.length} {visible.length === 1 ? "trade" : "trades"}
        </span>
      </div>

      {/*
        Column labels.

        The feed had none: five figures per row, in five different weights and greys, and nothing
        saying which was the price and which the trader. A reader worked it out from the shape of
        the number, which is the definition of a layout that has to be decoded rather than read.
        The labels are the same pixel eyebrow the stats strip uses, at the widths the rows below
        set, so each one sits over its own column — and they cost one line to say permanently what
        every row was otherwise implying.
      */}
      {visible.length > 0 && (
        <div className="pr-1">
          <div className="doku-feed-head flex items-center gap-3 px-3 pb-2.5 font-ui font-semibold text-[11px] uppercase leading-none tracking-[0.04em] text-mute">
            <span className="w-[38px] shrink-0 pl-1">{"Side"}</span>
            <span className="min-w-0 flex-1">{"Amount"}</span>
            <span className="hidden w-[112px] shrink-0 text-right sm:block">{"Price"}</span>
            <span className="hidden w-[100px] shrink-0 text-right md:block">{"Trader"}</span>
            <span className="w-[62px] shrink-0 text-right">{"Time"}</span>
          </div>
        </div>
      )}

      {visible.length === 0 ? (
        // The same height the list occupies with its header, so an empty tab does not collapse
        // the deck — which moves the tab bar out from under the pointer that just clicked it.
        <div className="grid min-h-0 flex-1 place-items-center">
          <span className="font-numeric text-[12px] text-mute">{emptyLabel}</span>
        </div>
      ) : (
        // A fixed height rather than a max, and the same one the holders and my-trades tables use.
        // Switching tabs used to resize the deck — a 40-row feed at 440px collapsing to a 330px
        // table and back — which moved the footer, and on a short viewport moved the tab bar out
        // from under the pointer that had just clicked it.
        <ul className="doku-scrollbar flex min-h-0 flex-1 list-none flex-col gap-1.5 overflow-y-auto pr-1 pt-1.5">
          {visible.map((r) => {
            const tone = r.isSell
              ? { text: "text-loss-ink", bar: "var(--loss)", label: "Sell" }
              : { text: "text-doku-ink", bar: "var(--doku)", label: "Buy" };

            return (
              <li key={r.id}>
                <a
                  href={toExplorerLink({ value: r.txHash, linkType: "transaction" })}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="doku-feed-row group/row relative flex items-center gap-3 overflow-hidden rounded-[11px] px-3 py-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-doku"
                >
                  {/* The direction, as a colour on the leading edge — readable before any text. */}
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 w-[3px] rounded-r-[2px]"
                    style={{ background: tone.bar, opacity: 0.85 }}
                  />

                  <span
                    className={cn(
                      "w-[38px] shrink-0 pl-1 font-ui text-[14px] font-semibold",
                      tone.text
                    )}
                  >
                    {tone.label}
                  </span>

                  {/* Quote in, tokens out — the substance of the event. */}
                  <span className="flex min-w-0 flex-1 items-baseline gap-1.5 font-numeric text-[13px] font-medium tabular-nums text-ink">
                    {compact(r.quote)}
                    <span className="text-[max(11px,0.76em)] font-normal tracking-[0.05em] text-mute">
                      {quoteSymbol}
                    </span>
                    <span aria-hidden className="px-0.5 text-mute">
                      →
                    </span>
                    <span className="truncate text-ash">{compact(r.base)}</span>
                    <span className="shrink-0 text-[max(11px,0.76em)] font-normal uppercase tracking-[0.05em] text-mute">
                      {ticker}
                    </span>
                  </span>

                  <span
                    className={cn(
                      "hidden w-[112px] shrink-0 text-right font-numeric text-[12px] font-medium tabular-nums sm:block",
                      tone.text
                    )}
                  >
                    {formatPrice(r.price)}
                  </span>

                  <span className="hidden w-[100px] shrink-0 text-right font-numeric text-[11px] tabular-nums text-mute md:block">
                    {shortAddress(r.trader)}
                  </span>

                  <span
                    title={now ? formatExact(r.time) : undefined}
                    className="w-[62px] shrink-0 text-right font-numeric text-[11px] tabular-nums text-mute"
                  >
                    {now ? formatAgo(r.time, now) : "—"}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default TradeFeed;
