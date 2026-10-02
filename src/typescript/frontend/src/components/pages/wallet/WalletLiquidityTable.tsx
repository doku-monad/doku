"use client";

import { EcTable, type EcTableColumn } from "components/ui/table/ecTable";
import { useMarketList } from "lib/hooks/use-market-list";
import { useRouter } from "next/navigation";
import { Emoji } from "utils/emoji";
import { useAccount } from "wagmi";

import { toNominal } from "@/lib/chain/config";
import {
  type OwnerPosition,
  useOwnerPositions,
  usePositionFees,
} from "@/lib/hooks/doku/use-liquidity";
import { useLiquidityActions } from "@/lib/hooks/doku/use-liquidity-actions";
import { marketPath } from "@/lib/market-path";
import { identityFor } from "@/lib/token-identity";

/**
 * The liquidity an address has provided.
 *
 * Reads positions for the address in the URL rather than the connected wallet, because this page
 * has always been viewable for anybody — enumerating an owner's positions needs no signature, so
 * their liquidity is as public as their tokens already were.
 *
 * The actions are the exception: withdrawing and collecting belong to whoever owns the position,
 * so they appear only when you are looking at your own page.
 */

const fmt = (value: bigint, dp = 4) => {
  const n = toNominal(value);
  if (n === 0) return "0";
  if (n < 0.0001) return n.toExponential(2);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(dp).replace(/\.?0+$/, "");
};

const dash = <span className="text-mute">—</span>;

export const WalletLiquidityTable = ({ address }: { address: string }) => {
  const router = useRouter();
  const { data: markets } = useMarketList();
  const { positions, isLoading, refetch } = useOwnerPositions(address, markets);
  const { fees, refetch: refetchFees } = usePositionFees(address, positions);
  const { withdraw, collect, pending, error } = useLiquidityActions();

  const { address: connected } = useAccount();
  const isOwnPage = Boolean(connected && connected.toLowerCase() === address.toLowerCase());

  const onDone = () => {
    refetch();
    refetchFees();
  };

  const columns: EcTableColumn<OwnerPosition>[] = [
    {
      id: "emoji",
      text: "Coin",
      width: 80,
      cellClassName: "pl-6",
      renderCell: (p) => {
        const identity = identityFor({ marketAddress: p.marketAddress, symbol: p.symbol });
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
      id: "mon",
      text: "MON",
      width: 120,
      sortFn: (p) => toNominal(p.amountMon),
      renderCell: (p) => (p.valueMon === null ? dash : fmt(p.amountMon)),
    },
    {
      id: "tokens",
      text: "Tokens",
      width: 130,
      sortFn: (p) => toNominal(p.amountToken),
      renderCell: (p) => (p.valueMon === null ? dash : fmt(p.amountToken, 2)),
    },
    {
      id: "fees",
      text: "Fees (MON)",
      width: 130,
      renderCell: (p) => {
        const f = fees.get(p.tokenId.toString());
        return f ? fmt(f.feesMon) : dash;
      },
    },
    {
      id: "value",
      text: "Value (MON)",
      width: 130,
      sortFn: (p) => p.valueMon ?? 0,
      renderCell: (p) => (p.valueMon === null ? dash : p.valueMon.toFixed(4).replace(/\.?0+$/, "")),
    },
    {
      id: "range",
      text: "Range",
      width: 140,
      renderCell: (p) =>
        p.valueMon === null ? (
          // The row stays even when its pool cannot be read. A row that disappears on an RPC
          // failure is indistinguishable from a position that is gone.
          <span className="font-numeric text-[11px] text-warn-ink">Pool unavailable</span>
        ) : (
          <span className="font-numeric text-[11px] uppercase tracking-[0.09em] text-mute">
            {p.inRange ? "In range" : "Out of range"}
          </span>
        ),
    },
  ];

  if (isOwnPage) {
    columns.push({
      id: "actions",
      text: "",
      width: 190,
      renderCell: (p) => {
        const f = fees.get(p.tokenId.toString());
        const hasFees = f !== undefined && (f.feesMon > 0n || f.feesToken > 0n);
        const cls =
          "h-8 rounded-doku-lg border border-line bg-surface px-3 font-forma text-[11px] uppercase " +
          "tracking-[0.08em] text-ash transition-colors hover:border-doku hover:text-doku-ink " +
          "disabled:opacity-40 disabled:hover:border-line disabled:hover:text-ash";
        return (
          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className={cls}
              disabled={!hasFees || pending !== null}
              onClick={() => collect({ tokenId: p.tokenId, token: p.tokenAddress, onDone })}
            >
              Collect
            </button>
            <button
              type="button"
              className={cls}
              disabled={p.valueMon === null || pending !== null}
              onClick={() => withdraw({ position: p, token: p.tokenAddress, onDone })}
            >
              {pending ?? "Withdraw"}
            </button>
          </div>
        );
      },
    });
  }

  return (
    <>
      <EcTable
        className="overflow-auto"
        onClick={(p) => router.push(marketPath(p.tokenAddress))}
        textFormat="body-sm"
        columns={columns}
        getKey={(p) => p.tokenId.toString()}
        items={positions}
        isLoading={isLoading}
        emptyText="No liquidity yet"
      />
      {error && (
        <p
          role="alert"
          className="border-t border-line bg-[rgb(198_45_52_/_0.06)] px-4 py-2.5 text-[12px] text-loss-ink"
        >
          {error}
        </p>
      )}
    </>
  );
};

export default WalletLiquidityTable;
