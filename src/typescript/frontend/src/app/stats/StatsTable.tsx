"use client";

import { EcTable, type EcTableColumn } from "components/ui/table/ecTable";
import { useRouter } from "next/navigation";
import { Emoji } from "utils/emoji";

import { marketPath } from "@/lib/market-path";
import { identityFor } from "@/lib/token-identity";

export interface StatsRow {
  marketAddress: string;
  /** The market's page is keyed by this, not by `marketAddress` — see `lib/market-path`. */
  tokenAddress: string;
  symbol: string;
  volume: number;
  raised: number;
  progress: number;
  holders: number;
  trades: number;
  graduated: boolean;
}

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

const COLUMNS: EcTableColumn<StatsRow>[] = [
  {
    /*
     * The coin, named.
     *
     * This column was the bare glyph, which on a table of twenty rows is twenty pictures and no
     * labels — you could not scan it for a coin you were looking for, only recognise one you
     * already knew. Mark plus name plus ticker, resolved through the same function every other
     * surface uses.
     */
    id: "symbol",
    text: "Coin",
    width: 220,
    cellClassName: "pl-6",
    renderCell: (m) => {
      const identity = identityFor({ marketAddress: m.marketAddress, symbol: m.symbol });
      return (
        <div className="flex min-w-0 items-center gap-2.5">
          <Emoji className="shrink-0 text-[1.15em]" emojis={identity.avatarEmoji} />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-[12.5px] leading-none text-ink">{identity.name}</span>
            <span className="truncate font-numeric text-[11px] leading-none text-mute">
              ${identity.ticker}
            </span>
          </span>
        </div>
      );
    },
  },
  {
    id: "volume",
    text: "Volume (MON)",
    width: 150,
    sortFn: (m) => m.volume,
    renderCell: (m) => fmt(m.volume),
  },
  {
    id: "raised",
    text: "Raised (MON)",
    width: 150,
    sortFn: (m) => m.raised,
    renderCell: (m) => fmt(m.raised),
  },
  {
    id: "progress",
    text: "Curve",
    width: 140,
    sortFn: (m) => m.progress,
    renderCell: (m) => (
      <div className="flex items-center gap-2">
        <div className="h-[3px] w-16 overflow-hidden rounded-full bg-sink">
          <div
            className={`h-full rounded-full ${m.graduated ? "bg-halo" : "bg-doku"}`}
            style={{ width: `${m.graduated ? 100 : Math.min(100, m.progress * 100)}%` }}
          />
        </div>
        <span className="font-numeric text-[11px] text-mute">
          {m.graduated ? "Grad" : `${(m.progress * 100).toFixed(0)}%`}
        </span>
      </div>
    ),
  },
  {
    id: "holders",
    text: "Holders",
    width: 110,
    sortFn: (m) => m.holders,
    renderCell: (m) => m.holders,
  },
  {
    id: "trades",
    text: "Trades",
    width: 110,
    sortFn: (m) => m.trades,
    renderCell: (m) => m.trades,
  },
];

export default function StatsTable({ markets }: { markets: StatsRow[] }) {
  const router = useRouter();

  return (
    <div className="doku-edge-over overflow-hidden rounded-doku-2xl bg-surface">
      <EcTable
        className="overflow-auto"
        onClick={(m) => router.push(marketPath(m.tokenAddress))}
        textFormat="body-sm"
        columns={COLUMNS}
        getKey={(m) => m.marketAddress}
        items={markets}
        emptyText="No markets yet"
      />
    </div>
  );
}
