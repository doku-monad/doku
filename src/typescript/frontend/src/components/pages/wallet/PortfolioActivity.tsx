"use client";

import { useQuery } from "@tanstack/react-query";
import { CoinMark } from "components/ui/coin-mark";
import { cn } from "lib/utils/class-name";
import { toExplorerLink } from "lib/utils/explorer-link";
import { useMemo, useState } from "react";
import { formatUnits } from "viem";

import type { SwapModel } from "@/lib/models";
import { identityFor } from "@/lib/token-identity";

/**
 * Every trade this address has made, across markets.
 *
 * ## Why this replaced the table
 *
 * It was an `EcTable` with seven fixed-width columns, built when this tab had the whole page to
 * spread across. In the deck it now lives in — the left rail of a two-rail layout — those columns
 * did not fit: the amount column ran under the panel edge and the price column was cut off
 * entirely. A trade feed is not read down its columns anyway; each row is one event, read across
 * and then abandoned, which is the argument the market page's own feed makes at length.
 *
 * So this is that feed with one column added: **which coin**. On a market page every row is the
 * same coin and naming it would be noise; on an account page it is the first thing you need, so it
 * leads the row with its mark, and the rest of the line reads exactly as it does over there.
 */

/**
 * One trade, with the asset it was priced in.
 *
 * The feed spans markets, so the quote is a property of the ROW. Every amount below scales by
 * `quoteDecimals` and is labelled `quoteSymbol` — it used to divide by a global eighteen and print
 * "MON" beside the result, which mislabels a USDC trade and misplaces a gold one by a factor of a
 * trillion.
 */
type Row = SwapModel & { symbol: string; quoteSymbol: string | null; quoteDecimals: number };

type WireRow = Omit<Row, "swap" | "block"> & {
  swap: Record<keyof SwapModel["swap"], string | boolean>;
  block: { number: string; txHash: string; time: string };
};

type SideFilter = "all" | "buy" | "sell";

const compact = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(1)}K`
      : n.toLocaleString(undefined, { maximumFractionDigits: 2 });

/** The quote side, at THIS row's market's decimals. */
const quoteAmount = (r: Row) => Number(formatUnits(r.swap.quoteVolume, r.quoteDecimals));
/** The base side. Every launched token is eighteen decimals. */
const baseAmount = (v: bigint) => Number(formatUnits(v, 18));

/** Small tokens need the extra significant digits; four is never enough at 1e-7. */
const formatPrice = (v: number) => {
  if (!Number.isFinite(v) || v === 0) return "0";
  if (v >= 1) return v.toFixed(4);
  const exp = Math.floor(Math.log10(Math.abs(v)));
  return v.toFixed(Math.min(18, Math.max(4, -exp + 3)));
};

/**
 * A date, not a clock time.
 *
 * The market feed prints `14:32`, because every row there happened today. An account's history
 * runs back months, and a column of times with no days in it says nothing about when.
 */
const formatWhen = (d: Date) => {
  const days = (Date.now() - d.getTime()) / 86_400_000;
  if (days < 1) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
};

export const PortfolioActivity = ({ address }: { address: string }) => {
  const [side, setSide] = useState<SideFilter>("all");

  const { data, isLoading } = useQuery({
    queryKey: ["account-swaps", address],
    queryFn: async (): Promise<Row[]> => {
      const res = await fetch(`/api/accounts/${address}/swaps?limit=100`);
      if (!res.ok) throw new Error(`account swaps: ${res.status}`);
      const body = (await res.json()) as { items: WireRow[] };
      return body.items.map((item) => ({
        ...item,
        quoteSymbol: item.quoteSymbol ?? null,
        quoteDecimals: item.quoteDecimals ?? 18,
        swap: {
          ...item.swap,
          isSell: Boolean(item.swap.isSell),
          venue: item.swap.venue as SwapModel["swap"]["venue"],
          trader: item.swap.trader as SwapModel["swap"]["trader"],
          quoteVolume: BigInt(item.swap.quoteVolume as string),
          baseVolume: BigInt(item.swap.baseVolume as string),
          price: BigInt(item.swap.price as string),
          // Resolved against this row's OWN market's generation now — see `getAccountSwaps`. It
          // is null only where that market could not be reached.
          priceQuote:
            item.swap.priceQuote === null || item.swap.priceQuote === undefined
              ? null
              : BigInt(item.swap.priceQuote as string),
          fee: BigInt(item.swap.fee as string),
          tax: BigInt(item.swap.tax as string),
          quoteRaised: BigInt(item.swap.quoteRaised as string),
        },
        block: {
          number: BigInt(item.block.number),
          txHash: item.block.txHash,
          time: new Date(item.block.time),
        },
      }));
    },
  });

  const rows = useMemo(() => {
    const all = data ?? [];
    return side === "all"
      ? all
      : all.filter((r) => (side === "sell" ? r.swap.isSell : !r.swap.isSell));
  }, [data, side]);

  return (
    <div className="flex h-full min-h-0 flex-col">
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
          {rows.length} {rows.length === 1 ? "trade" : "trades"}
        </span>
      </div>

      {rows.length > 0 && (
        <div className="pr-1">
          <div className="doku-feed-head flex items-center gap-3 px-3 pb-2.5 font-ui font-semibold text-[11px] uppercase leading-none tracking-[0.04em] text-mute">
            <span className="min-w-0 flex-1 pl-1">Coin</span>
            <span className="w-[38px] shrink-0">Side</span>
            <span className="hidden w-[184px] shrink-0 sm:block">Amount</span>
            <span className="w-[54px] shrink-0 text-right">When</span>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="grid h-full place-items-center">
          <span className="font-numeric text-[12px] text-mute">
            {isLoading ? "Loading trades…" : "No trades yet"}
          </span>
        </div>
      ) : (
        <ul className="doku-scrollbar flex min-h-0 flex-1 list-none flex-col gap-1.5 overflow-y-auto pr-1 pt-1.5">
          {rows.map((r) => {
            const identity = identityFor({
              marketAddress: r.market.marketAddress,
              symbol: r.symbol,
            });
            const sell = r.swap.isSell;
            const tone = sell
              ? { text: "text-loss-ink", bar: "var(--loss)", label: "Sell" }
              : { text: "text-doku-ink", bar: "var(--doku)", label: "Buy" };

            return (
              <li key={r.id}>
                <a
                  href={toExplorerLink({ value: r.block.txHash, linkType: "transaction" })}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`${tone.label}${
                    r.swap.priceQuote === null
                      ? ""
                      : ` at ${formatPrice(Number(formatUnits(r.swap.priceQuote, r.quoteDecimals)))} ${r.quoteSymbol ?? ""}`
                  } — ${r.block.time.toLocaleString()}`}
                  className="doku-feed-row group/row relative flex items-center gap-3 overflow-hidden rounded-[11px] px-3 py-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-doku"
                >
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 w-[3px] rounded-r-[2px]"
                    style={{ background: tone.bar, opacity: 0.85 }}
                  />

                  <span className="flex min-w-0 flex-1 items-center gap-2.5 pl-1">
                    <CoinMark
                      logo={identity.logo}
                      ticker={identity.ticker}
                      name={identity.name}
                      size={26}
                      className="rounded-[7px]"
                    />
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="truncate font-ui text-[13px] font-medium leading-none text-ink">
                        {identity.name}
                      </span>
                      <span className="truncate font-numeric text-[11px] leading-none text-mute">
                        <span className="text-mute">$</span>
                        {identity.ticker}
                      </span>
                    </span>
                  </span>

                  <span
                    className={cn(
                      "w-[38px] shrink-0 font-ui text-[13.5px] font-semibold",
                      tone.text
                    )}
                  >
                    {tone.label}
                  </span>

                  {/* MON in, tokens out — or the other way round on a sell, which is what the
                      arrow is for: the row reads as the trade actually happened. */}
                  <span className="hidden w-[184px] shrink-0 items-baseline gap-1.5 font-numeric text-[12.5px] font-medium tabular-nums text-ink sm:flex">
                    {compact(sell ? baseAmount(r.swap.baseVolume) : quoteAmount(r))}
                    <span className="shrink-0 text-[max(11px,0.76em)] font-normal uppercase tracking-[0.05em] text-mute">
                      {sell ? identity.ticker : (r.quoteSymbol ?? "—")}
                    </span>
                    <span aria-hidden className="px-0.5 text-mute">
                      →
                    </span>
                    <span className="truncate text-ash">
                      {compact(sell ? quoteAmount(r) : baseAmount(r.swap.baseVolume))}
                    </span>
                    <span className="shrink-0 text-[max(11px,0.76em)] font-normal uppercase tracking-[0.05em] text-mute">
                      {sell ? (r.quoteSymbol ?? "—") : identity.ticker}
                    </span>
                  </span>

                  <span className="w-[54px] shrink-0 text-right font-numeric text-[11px] tabular-nums text-mute">
                    {formatWhen(r.block.time)}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default PortfolioActivity;
