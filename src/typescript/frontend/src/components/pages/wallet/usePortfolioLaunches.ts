"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { formatUnits } from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";

import type { LaunchRow as LaunchWire, RoutingName } from "@/lib/api/markets";
import { curveAbi } from "@/lib/chain/abis";

/**
 * The markets an address launched, and what they have earned.
 *
 * ## Where each number comes from
 *
 * All of them from `GET /accounts/:address/launches`, which reads the service's fee ledger — sums
 * over the fee EVENTS, in raw units of each market's own quote asset, with `quoteDecimals` on the
 * row to scale them by.
 *
 * What that replaces: `volume × 1%` for what a market had generated, and a two-call multicall per
 * market for `pendingFees()` and `feeRecipient()`. The arithmetic was right only while every
 * market charged the same fee and none of it was a creator tax; the multicall never asked about
 * the creator tax at all, so a launcher owed one saw nothing. Both figures also came back at
 * eighteen decimals, which understates a six-decimal market by a factor of a trillion.
 *
 * ## Two charges, two claims, two recipients
 *
 * A market can owe its creator money on two separate counts, and they are not interchangeable:
 *
 *   - **The routed share** of the protocol fee, paid to `feeRecipient`. `collectFees()`.
 *   - **The creator's own tax**, paid to `taxRecipient`. `collectTax()`.
 *
 * They are set at launch, they need not be the same address, and either can be somebody else's.
 * The button offers each one only when the chain says that money is the connected wallet's — a
 * claim button that spends a creator's gas to pay a treasury is the kind of interface that earns
 * somebody's trust exactly once.
 *
 * Neither call carries a gas limit. `collectFees` pushes to a recipient that may be a contract,
 * and a recipient that burns gas on receipt needs more than any cap this file could pick; the
 * money is never at risk, but a fixed limit makes the button fail for a reason nobody can see.
 */

export interface LaunchRow {
  marketAddress: string;
  tokenAddress: string;
  symbol: string;
  name: string;
  ticker: string | null;
  logoUri: string | null;
  launchedAt: Date;
  graduated: boolean;
  /** 0–1 along the bonding curve. Meaningless once graduated. */
  progress: number;
  holders: number;
  tradeCount: number;
  /** What this market is priced in. Every figure below is in it, and none is addable across rows. */
  quoteSymbol: string | null;
  /**
   * The quote ERC-20, or the zero address for native MON.
   *
   * Carried because `CreatorSink.claimable` is keyed `(who, quote)` and `claim(quote)` takes it —
   * a creator's claim is per ASSET, and this is the only place the address is known.
   */
  quoteAsset: string;
  /** That asset's own decimals. Six for USDC and gold, eight for the wrapped bitcoins, 18 for MON. */
  quoteDecimals: number;
  /** Where the 70bps routed share goes. Only `"creator"` puts it anywhere a wallet can claim. */
  routing: RoutingName | null;
  /** Lifetime turnover, in the market's quote asset. */
  volume: number;
  /** Routed fees this market has generated, all recipients, from the ledger. */
  feesGenerated: number;
  /** Uncollected routed fees. Always zero on a buyback market, by construction. */
  pending: number;
  /** Uncollected creator tax. */
  pendingTax: number;
  /** Who `collectFees()` would pay. `null` where the market never named one. */
  recipient: string | null;
  /** Who `collectTax()` would pay. */
  taxRecipient: string | null;
  /** Whether the routed share is the connected wallet's. */
  yours: boolean;
  /** Whether the creator tax is the connected wallet's. */
  taxYours: boolean;
}

export function usePortfolioLaunches(address: string): {
  rows: LaunchRow[];
  isLoading: boolean;
  refetch: () => void;
} {
  const { address: connected } = useAccount();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["account-launches", address],
    // A pending balance grows with every trade, and a claim button showing a stale figure is a
    // claim button that pays out a different number than it promised.
    refetchInterval: 20_000,
    staleTime: 10_000,
    queryFn: async (): Promise<LaunchWire[]> => {
      const res = await fetch(`/api/accounts/${address}/launches`);
      if (!res.ok) throw new Error(`launches: ${res.status}`);
      const body = (await res.json()) as { items: LaunchWire[] };
      return body.items;
    },
  });

  const rows = useMemo<LaunchRow[]>(() => {
    const me = connected?.toLowerCase() ?? null;
    return (data ?? []).map((r) => {
      // Each amount at THIS market's quote decimals — six for USDC and gold, eight for the
      // wrapped bitcoins, eighteen for MON. There is no global here.
      const q = (raw: string) => Number(formatUnits(BigInt(raw), r.quoteDecimals));
      const recipient = r.feeRecipient?.toLowerCase() ?? null;
      const taxRecipient = r.taxRecipient?.toLowerCase() ?? null;

      return {
        marketAddress: r.marketAddress,
        tokenAddress: r.tokenAddress,
        symbol: r.symbol,
        name: r.name,
        ticker: r.ticker,
        logoUri: r.logoUri,
        launchedAt: new Date(r.launchedAt),
        graduated: r.graduated,
        progress: r.progress,
        holders: r.holders,
        tradeCount: r.tradeCount,
        quoteSymbol: r.quoteSymbol,
        quoteAsset: r.quoteAsset,
        quoteDecimals: r.quoteDecimals,
        routing: r.routing,
        volume: q(r.volumeQuote),
        feesGenerated: q(r.feesGenerated),
        pending: q(r.pending),
        pendingTax: q(r.pendingTax),
        recipient,
        taxRecipient,
        yours: Boolean(me && recipient && recipient === me),
        taxYours: Boolean(me && taxRecipient && taxRecipient === me),
      };
    });
  }, [data, connected]);

  // Wrapped rather than passed through: a click handler that returns a floating promise is a
  // rejection nobody catches.
  return { rows, isLoading, refetch: () => void refetch() };
}

/** The message a wallet returns, cut down to the part a person can act on. */
const shorten = (e: unknown) => {
  const raw = e instanceof Error ? e.message : String(e);
  if (/user rejected|denied transaction/i.test(raw)) return "Rejected in wallet";
  return raw.split("\n")[0].slice(0, 120);
};

/** Which of a market's two charges a claim is for. */
export type ClaimKind = "fees" | "tax";

/**
 * `collectFees()` and `collectTax()` on one curve.
 *
 * The sink's own two calls — `pull` and `claim` — live in `useCreatorFees`, because neither is
 * about one market's curve: a pull drains a pool's hook ledgers and a claim is per quote asset.
 *
 * Simulated before it is signed, so a revert reads as a message under the button rather than as a
 * wallet refusing a transaction somebody has already approved. No gas limit — see the note at the
 * top of this file.
 */
export function useClaimFees(): {
  claim: (market: string, kind: ClaimKind, onDone?: () => void) => Promise<void>;
  /** The market currently being claimed. */
  pending: string | null;
  error: string | null;
} {
  const { data: wallet } = useWalletClient();
  const publicClient = usePublicClient();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const claim = useCallback(
    async (market: string, kind: ClaimKind, onDone?: () => void) => {
      if (!wallet?.account || !publicClient) return;
      setError(null);
      setPending(market);
      try {
        const { request } = await publicClient.simulateContract({
          address: market as `0x${string}`,
          abi: curveAbi,
          functionName: kind === "tax" ? "collectTax" : "collectFees",
          account: wallet.account.address,
        });
        const hash = await wallet.writeContract(request);
        await publicClient.waitForTransactionReceipt({ hash });
        onDone?.();
      } catch (e) {
        setError(shorten(e));
      } finally {
        setPending(null);
      }
    },
    [wallet, publicClient]
  );

  return { claim, pending, error };
}
