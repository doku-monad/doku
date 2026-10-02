"use client";

import { useCallback, useMemo, useState } from "react";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useWalletClient,
} from "wagmi";

import { creatorSinkAbi, curveAbi, factoryAbi, hookAbi } from "@/lib/chain/abis";
import type { CollectStep, CreatorClaimLot, CreatorMarketFees, CreatorRouting } from "@/lib/chain/creator-fees";
import {
  claimRequest,
  creatorClaimLots,
  creatorMarketFees,
  pullRequest,
  SINK_CREATOR,
} from "@/lib/chain/creator-fees";
import { CONTRACTS } from "@/lib/chain/wagmi";

import type { LaunchRow } from "./usePortfolioLaunches";

/**
 * The chain reads behind the creator-fee panel.
 *
 * ## Why these come off the chain rather than off the indexer
 *
 * The indexer knows what every market has EARNED, which is what the launches list shows. It does
 * not know which of the three contracts is holding it right now, and that is the only question a
 * button can be built on: `CreatorSink.claim` pays what is in `claimable` and nothing else, and
 * `claimable` is only ever filled by somebody calling `pull`. A creator with a graduated market
 * can be owed a great deal and have `claimable` read zero, because nobody has pressed the button
 * that has never existed. Reading the hook's own two ledgers is what makes that visible.
 *
 * It also picks up two things the indexer's launch row cannot. `CreatorSink.transferRecipient` can
 * hand a market's FUTURE routed income to another address without the curve changing at all, so
 * `entries(market).routed` and `curve.feeRecipient()` legitimately disagree and both matter. And a
 * market's `sink` is the authority on its routing, where the indexer's `routing` column is a copy.
 *
 * ## Addresses, not configuration
 *
 * The sink comes from `DokuFactory.creatorSink()` and the hook from `CreatorSink.hook()`, which the
 * sink learned from the graduator and therefore cannot disagree with. Two `NEXT_PUBLIC_*` values
 * that nothing fails to boot without are two values that can be wrong for a week.
 */

/** How many reads each market needs, and in what order. Kept beside the batch that builds them. */
const CURVE_CALLS = ["sink", "feeRecipient", "taxRecipient", "pendingFees", "pendingTax"] as const;
const HOOK_CALLS = ["pendingSink", "owedSink", "owedTax"] as const;

/** `DokuHook` and `BondingCurve` name the routings by number; the panel and the indexer by word. */
const routingOf = (sink: number | null): CreatorRouting =>
  sink === null ? null : sink === SINK_CREATOR ? "creator" : sink === 1 ? "holders" : "buyback";

const asAddress = (v: unknown): `0x${string}` | null =>
  typeof v === "string" && v.startsWith("0x") ? (v as `0x${string}`) : null;

/** A failed multicall slot is not a zero. Reading one as zero hides money; this keeps it absent. */
const okBigint = (slot: { status: string; result?: unknown } | undefined): bigint | null =>
  slot?.status === "success" && typeof slot.result === "bigint" ? slot.result : null;

const okAddress = (slot: { status: string; result?: unknown } | undefined): `0x${string}` | null =>
  slot?.status === "success" ? asAddress(slot.result) : null;

export interface CreatorFeesRead {
  /** One entry per launch, in the order the launches arrived. */
  markets: CreatorMarketFees[];
  /** One entry per quote asset the reader has money in, at any of the three hops. */
  lots: CreatorClaimLot[];
  /** `DokuFactory.creatorSink()`. Null until it lands; every write below needs it. */
  sink: `0x${string}` | null;
  /** True while the picture is still incomplete. A half-read page must not draw a zero. */
  isLoading: boolean;
  refetch: () => void;
}

/**
 * What the connected wallet is owed across `launches`, hop by hop.
 *
 * @param launches the reader's own launches. Passed in rather than fetched again so this hook adds
 *        chain reads to a list the page already has, and cannot disagree with it about which
 *        markets exist.
 */
export function useCreatorFees(launches: readonly LaunchRow[]): CreatorFeesRead {
  const { address: connected } = useAccount();
  const viewer = connected ?? null;

  const { data: sinkAddress, refetch: refetchSink } = useReadContract({
    address: CONTRACTS.factory,
    abi: factoryAbi,
    functionName: "creatorSink",
  });
  const sink = asAddress(sinkAddress);

  const { data: hookAddress } = useReadContract({
    address: sink ?? undefined,
    abi: creatorSinkAbi,
    functionName: "hook",
    query: { enabled: Boolean(sink) },
  });
  const hook = asAddress(hookAddress);

  /*
    Wave one: the curve's own state and the sink's entry for each market. `entries` carries the
    pool id, which nothing else on this page knows, so the hook's ledgers cannot be read until it
    lands — hence two waves rather than one.
  */
  const curveContracts = useMemo(
    () =>
      !sink
        ? []
        : launches.flatMap((row) => [
            ...CURVE_CALLS.map((functionName) => ({
              address: row.marketAddress as `0x${string}`,
              abi: curveAbi,
              functionName,
            })),
            {
              address: sink,
              abi: creatorSinkAbi,
              functionName: "entries" as const,
              args: [row.marketAddress as `0x${string}`],
            },
          ]),
    [launches, sink]
  );

  const {
    data: curveData,
    isLoading: curveLoading,
    refetch: refetchCurve,
  } = useReadContracts({
    contracts: curveContracts,
    query: {
      enabled: curveContracts.length > 0,
      // A pending balance grows with every trade, and a claim button showing a stale figure is a
      // button that pays out a different number than it promised.
      refetchInterval: 20_000,
    },
  });

  const perMarket = useMemo(() => {
    const stride = CURVE_CALLS.length + 1;
    return launches.map((row, i) => {
      const base = i * stride;
      const at = (n: number) => curveData?.[base + n];
      const entry = at(CURVE_CALLS.length);
      // `entries` is a struct, so a success comes back as a tuple in declaration order:
      // (id, quote, routed, tax, registered).
      const tuple =
        entry?.status === "success" && Array.isArray(entry.result)
          ? (entry.result as readonly [`0x${string}`, string, string, string, boolean])
          : null;
      const sinkNumber = at(0);
      return {
        row,
        poolId: tuple?.[4] ? tuple[0] : null,
        routing: routingOf(
          sinkNumber?.status === "success" && typeof sinkNumber.result === "number"
            ? sinkNumber.result
            : null
        ),
        feeRecipient: okAddress(at(1)),
        taxRecipient: okAddress(at(2)),
        curvePendingFees: okBigint(at(3)) ?? 0n,
        curvePendingTax: okBigint(at(4)) ?? 0n,
        sinkRegistered: tuple?.[4] ?? false,
        sinkRouted: tuple ? asAddress(tuple[2]) : null,
        sinkTax: tuple ? asAddress(tuple[3]) : null,
      };
    });
  }, [launches, curveData]);

  /*
    Wave two: the hook's ledgers, for the markets the sink has actually registered. An unregistered
    market has no pool, and `pull` on one reverts `NotRegistered` — asking for its ledgers would be
    three calls to learn a zero that is already known.
  */
  const registered = useMemo(
    () => perMarket.filter((m): m is typeof m & { poolId: `0x${string}` } => m.poolId !== null),
    [perMarket]
  );

  const hookContracts = useMemo(
    () =>
      !hook
        ? []
        : registered.flatMap((m) =>
            HOOK_CALLS.map((functionName) => ({
              address: hook,
              abi: hookAbi,
              functionName,
              args: [m.poolId],
            }))
          ),
    [hook, registered]
  );

  const {
    data: hookData,
    isLoading: hookLoading,
    refetch: refetchHook,
  } = useReadContracts({
    contracts: hookContracts,
    query: { enabled: hookContracts.length > 0, refetchInterval: 20_000 },
  });

  /*
    Wave three: what the sink is already holding for the reader, one call per DISTINCT quote asset.
    Per asset and not per market, because `claimable` is keyed `(who, quote)` — a creator with four
    MON markets has one MON balance, and reading it four times would show it four times.
  */
  const quoteAssets = useMemo(() => {
    const seen = new Map<string, `0x${string}`>();
    for (const row of launches) {
      const address = asAddress(row.quoteAsset);
      if (address) seen.set(address.toLowerCase(), address);
    }
    return [...seen.values()];
  }, [launches]);

  const {
    data: claimableData,
    isLoading: claimableLoading,
    refetch: refetchClaimable,
  } = useReadContracts({
    contracts:
      sink && viewer
        ? quoteAssets.map((quote) => ({
            address: sink,
            abi: creatorSinkAbi,
            functionName: "claimable" as const,
            args: [viewer as `0x${string}`, quote],
          }))
        : [],
    query: { enabled: Boolean(sink && viewer) && quoteAssets.length > 0, refetchInterval: 20_000 },
  });

  /** Which block of `hookData` belongs to which market. Only registered markets have one. */
  const hookSlotOf = useMemo(
    () => new Map(registered.map((m, i) => [m.row.marketAddress, i])),
    [registered]
  );

  const markets = useMemo(
    () =>
      perMarket.map((m) => {
        const slot = hookSlotOf.get(m.row.marketAddress);
        const hookAt = (n: number) =>
          slot === undefined ? null : okBigint(hookData?.[slot * HOOK_CALLS.length + n]);
        return creatorMarketFees(
          {
            marketAddress: m.row.marketAddress,
            quoteAsset: m.row.quoteAsset,
            quoteDecimals: m.row.quoteDecimals,
            quoteSymbol: m.row.quoteSymbol,
            routing: m.routing,
            feeRecipient: m.feeRecipient,
            taxRecipient: m.taxRecipient,
            curvePendingFees: m.curvePendingFees,
            curvePendingTax: m.curvePendingTax,
            sinkRegistered: m.sinkRegistered,
            sinkRouted: m.sinkRouted,
            sinkTax: m.sinkTax,
            hookPendingSink: hookAt(0) ?? 0n,
            hookOwedSink: hookAt(1) ?? 0n,
            hookOwedTax: hookAt(2) ?? 0n,
          },
          viewer
        );
      }),
    [perMarket, hookSlotOf, hookData, viewer]
  );

  const lots = useMemo(() => {
    const claimable = new Map<string, bigint>();
    quoteAssets.forEach((quote, i) => {
      const amount = okBigint(claimableData?.[i]);
      // Absent rather than zero: a read that has not landed is not a balance of nothing, and
      // seeding the map with zeros would create an empty lot for every asset before the first
      // response arrives.
      if (amount !== null && amount > 0n) claimable.set(quote.toLowerCase(), amount);
    });
    return creatorClaimLots(markets, claimable);
  }, [markets, quoteAssets, claimableData]);

  const refetch = useCallback(() => {
    void refetchSink();
    void refetchCurve();
    void refetchHook();
    void refetchClaimable();
  }, [refetchSink, refetchCurve, refetchHook, refetchClaimable]);

  return {
    markets,
    lots,
    sink,
    isLoading: curveLoading || hookLoading || claimableLoading,
    refetch,
  };
}

/** The message a wallet returns, cut down to the part a person can act on. */
const shorten = (e: unknown) => {
  const raw = e instanceof Error ? e.message : String(e);
  if (/user rejected|denied transaction/i.test(raw)) return "Rejected in wallet";
  return raw.split("\n")[0].slice(0, 120);
};

export interface CreatorFeeActions {
  /** `CreatorSink.pull(market)` — moves the hook's ledgers into `claimable`. */
  pull: (market: string, onDone?: () => void) => Promise<void>;
  /** `CreatorSink.claim(quote)` — pays the caller everything the sink holds in that asset. */
  claim: (quoteAsset: string, onDone?: () => void) => Promise<void>;
  /**
   * Every step of a `collectPlan`, one wallet prompt each, stopping at the first that fails. What
   * has already landed stays landed: a pull that succeeded has moved money INTO the sink, where
   * the next press finds it as claimable.
   */
  collect: (key: string, steps: readonly CollectStep[], onDone?: () => void) => Promise<void>;
  /** The market address or quote asset currently in flight, so one button at a time is busy. */
  pending: string | null;
  /** Which step of a `collect` is in flight, for the button's label. */
  progress: { step: number; of: number; kind: CollectStep["kind"] } | null;
  error: string | null;
}

/**
 * The two transactions this panel can send.
 *
 * Both are simulated before they are signed, so a revert reads as a line under the button rather
 * than as a wallet refusing something a person has already approved. Neither sets a gas limit:
 * `claim` pays a recipient that may be a contract, and a contract that burns gas on receipt needs
 * more than any cap this file could pick — but on Monad the gas LIMIT is what gets billed, so a
 * generous fixed cap would overcharge every claim to make one unusual one work.
 */
export function useCreatorFeeActions(sink: `0x${string}` | null): CreatorFeeActions {
  const { data: wallet } = useWalletClient();
  const publicClient = usePublicClient();
  const [pending, setPending] = useState<string | null>(null);
  const [progress, setProgress] = useState<CreatorFeeActions["progress"]>(null);
  const [error, setError] = useState<string | null>(null);

  const collect = useCallback(
    async (key: string, steps: readonly CollectStep[], onDone?: () => void) => {
      if (!wallet?.account || !publicClient || !sink || steps.length === 0) return;
      setError(null);
      setPending(key);
      try {
        for (const [i, step] of steps.entries()) {
          setProgress({ step: i + 1, of: steps.length, kind: step.kind });
          // Simulated at its own turn, never up front: a `claim` simulated before the pulls have
          // landed would revert `NothingToClaim` on exactly the balance this exists to collect.
          const { request } = await publicClient.simulateContract({
            ...(step.kind === "pull"
              ? pullRequest(sink, step.market as `0x${string}`)
              : claimRequest(sink, step.quoteAsset as `0x${string}`)),
            account: wallet.account.address,
          });
          const hash = await wallet.writeContract(request);
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          if (receipt.status === "reverted") throw new Error("That step reverted on chain. Nothing after it was sent.");
        }
      } catch (e) {
        setError(shorten(e));
      } finally {
        setPending(null);
        setProgress(null);
        // Refreshed whether or not every step landed: a pull that did has changed what is claimable.
        onDone?.();
      }
    },
    [wallet, publicClient, sink]
  );

  const send = useCallback(
    async (
      key: string,
      build: (
        s: `0x${string}`
      ) => Parameters<NonNullable<typeof publicClient>["simulateContract"]>[0],
      onDone?: () => void
    ) => {
      if (!wallet?.account || !publicClient || !sink) return;
      setError(null);
      setPending(key);
      try {
        const { request } = await publicClient.simulateContract({
          ...build(sink),
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
    [wallet, publicClient, sink]
  );

  const pull = useCallback(
    (market: string, onDone?: () => void) =>
      send(market, (s) => pullRequest(s, market as `0x${string}`), onDone),
    [send]
  );

  const claim = useCallback(
    (quoteAsset: string, onDone?: () => void) =>
      send(quoteAsset, (s) => claimRequest(s, quoteAsset as `0x${string}`), onDone),
    [send]
  );

  return { pull, claim, collect, pending, progress, error };
}
