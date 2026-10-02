"use client";

import { translationFunction } from "context/language-context";
import { Info } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { erc20Abi, formatUnits } from "viem";
import { useAccount, useBalance, useBlockNumber, usePublicClient, useReadContract, useReadContracts, useWalletClient } from "wagmi";

import { graduationAbi, rewardVaultAbi, tokenAbi } from "@/lib/chain/abis";
import { CONTRACTS } from "@/lib/chain/addresses";
import { TOKEN_DECIMALS } from "@/lib/chain/config";
import {
  type EpochInput,
  epochRows,
  estimateBlockTime,
  formatQuote,
  formatUsd,
  holderStanding,
  oldestClaimableEpoch,
  openableEpochs,
  usdOf,
  vaultSummary,
} from "@/lib/dividends";

/**
 * The dividends panel: the vault in four figures, and a claim for whoever is owed one.
 *
 * Funded for holders, paid to holders, waiting for holders, awaiting split — read off the market's
 * RewardVault directly: one `sinkOf` on the graduation contract, then `unallocated`, `epochs(k)`
 * and `snapshotBlockFor(k + 1)` for every epoch in one multicall, and for a connected wallet its
 * `weightOf` and `hasClaimed` per epoch. The arithmetic is `lib/dividends`, which is the
 * contract's own integer division. Before graduation there is no vault yet; the holders' share
 * accrues on the curve and the indexer's `pending` says how much.
 *
 * The per-interval and per-epoch tables this replaces were the vault's bookkeeping, not the
 * reader's question. What a holder wants to know is how much has been set aside, how much has
 * been paid, how much is theirs to claim, and when the rest arrives — four numbers and a button.
 */

/** The most recent epochs read; a market older than this shows the newest ones. */
const MAX_EPOCHS = 30;
/** Upcoming intervals read ahead of `epochCount`: the current one and the forward spread. */
const LOOKAHEAD = 8;
const ZERO = "0x0000000000000000000000000000000000000000";

const shorten = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 140 ? `${m.slice(0, 140)}…` : m;
};

/** A token amount at three significant figures, for a sentence rather than a ledger. */
const tokens = (raw: bigint): string => {
  const n = Number(formatUnits(raw, TOKEN_DECIMALS));
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(n >= 1 ? 2 : 4);
};

export function DividendsPanel({
  curve,
  token,
  ticker,
  graduated,
  quoteSymbol,
  quoteDecimals,
  quoteAddress,
  usdPrice,
  pendingOnCurve,
}: {
  curve: `0x${string}`;
  /** The launch token: a holder's standing is read off its balance checkpoints. */
  token: `0x${string}`;
  ticker: string;
  graduated: boolean;
  quoteSymbol: string;
  quoteDecimals: number;
  /** The quote asset; the zero address is the chain's native coin. The vault's balance is read in it. */
  quoteAddress: `0x${string}`;
  /** The quote's dollar price from the catalogue, for the line under each figure; null for none. */
  usdPrice: number | null | undefined;
  /** The indexer's `pending`: routed fees generated and not yet funded, raw quote units. */
  pendingOnCurve: bigint | null;
}) {
  const { t } = translationFunction();
  const { address: holder } = useAccount();
  const { data: blockNumber } = useBlockNumber({ watch: true });

  const {
    data: sink,
    isError: sinkFailed,
    refetch: refetchSink,
  } = useReadContract({
    address: CONTRACTS.graduation,
    abi: graduationAbi,
    functionName: "sinkOf",
    args: [curve],
    // Re-asked on a clock: a read that failed once (a rate-limited RPC, a dropped connection)
    // used to leave the panel on "Reading the reward vault…" until a reload.
    query: { enabled: graduated, refetchInterval: 30_000 },
  });
  const vault = sink && sink !== ZERO ? sink : null;

  const {
    data: count,
    isError: countFailed,
    refetch: refetchCount,
  } = useReadContract({
    address: vault ?? undefined,
    abi: rewardVaultAbi,
    functionName: "epochCount",
    query: { enabled: vault !== null, refetchInterval: 20_000 },
  });
  const total = Number(count ?? 0n);
  const countKnown = count !== undefined;

  /*
   * What the vault holds, in the quote. The figures are derived from this rather than from the
   * epoch rows summed — see `vaultSummary` for the double count that avoids. Native quotes are a
   * balance; every other quote is an ERC-20 `balanceOf`.
   */
  const native = quoteAddress.toLowerCase() === ZERO;
  const { data: nativeBalance } = useBalance({
    address: vault ?? undefined,
    query: { enabled: vault !== null && native, refetchInterval: 20_000 },
  });
  const { data: tokenBalance } = useReadContract({
    address: quoteAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [vault ?? ZERO],
    query: { enabled: vault !== null && !native, refetchInterval: 20_000 },
  });
  const vaultBalance: bigint | undefined = native ? nativeBalance?.value : tokenBalance;

  /*
   * Epochs exist only once somebody calls `createEpochs`; until then everything funded sits in
   * `unallocated` and in `pending(k)` per interval. These are read regardless of `epochCount`, so a
   * vault nobody has opened an epoch on still shows where the money is and when it can be opened.
   */
  const fundingCalls = useMemo(
    () =>
      vault && countKnown
        ? [
            { address: vault, abi: rewardVaultAbi, functionName: "unallocated" } as const,
            { address: vault, abi: rewardVaultAbi, functionName: "currentInterval" } as const,
            ...Array.from({ length: LOOKAHEAD }, (_, i) => total + i).flatMap((k) => [
              { address: vault, abi: rewardVaultAbi, functionName: "pending", args: [BigInt(k)] } as const,
              { address: vault, abi: rewardVaultAbi, functionName: "snapshotBlockFor", args: [BigInt(k + 1)] } as const,
            ]),
          ]
        : [],
    [vault, countKnown, total],
  );
  const { data: fundingData, refetch: refetchFunding } = useReadContracts({
    contracts: fundingCalls,
    query: { enabled: fundingCalls.length > 0, refetchInterval: 20_000 },
  });
  const funding = useMemo(() => {
    if (!fundingData || fundingData.length < 2) return null;
    const ok = (i: number) => (fundingData[i]?.status === "success" ? (fundingData[i]!.result as bigint) : null);
    const unallocated = ok(0);
    const currentInterval = ok(1);
    const upcoming: { k: number; pending: bigint; closes: bigint }[] = [];
    for (let i = 0; i < LOOKAHEAD; i += 1) {
      const pending = ok(2 + i * 2);
      const closes = ok(3 + i * 2);
      if (pending === null || closes === null) break;
      upcoming.push({ k: total + i, pending, closes });
    }
    const openable = blockNumber ? openableEpochs(total, upcoming.map((u) => u.closes), blockNumber) : 0;
    return { unallocated, currentInterval, upcoming, openable };
  }, [fundingData, total, blockNumber]);
  const first = Math.max(0, total - MAX_EPOCHS);
  const indices = useMemo(() => Array.from({ length: total - first }, (_, i) => first + i), [first, total]);

  const epochCalls = useMemo(
    () =>
      vault
        ? indices.flatMap((k) => [
            { address: vault, abi: rewardVaultAbi, functionName: "epochs", args: [BigInt(k)] } as const,
            { address: vault, abi: rewardVaultAbi, functionName: "snapshotBlockFor", args: [BigInt(k + 1)] } as const,
          ])
        : [],
    [vault, indices],
  );
  const { data: epochData, refetch: refetchEpochs } = useReadContracts({
    contracts: epochCalls,
    query: { enabled: epochCalls.length > 0, refetchInterval: 20_000 },
  });

  const holderCalls = useMemo(
    () =>
      vault && holder
        ? indices.flatMap((k) => [
            { address: vault, abi: rewardVaultAbi, functionName: "weightOf", args: [holder, BigInt(k)] } as const,
            { address: vault, abi: rewardVaultAbi, functionName: "hasClaimed", args: [BigInt(k), holder] } as const,
          ])
        : [],
    [vault, holder, indices],
  );
  const { data: holderData, refetch: refetchHolder } = useReadContracts({
    contracts: holderCalls,
    query: { enabled: holderCalls.length > 0, refetchInterval: 20_000 },
  });

  const ledger = useMemo(() => {
    if (!blockNumber || !countKnown) return null;
    if (indices.length === 0) return epochRows({ epochs: [], currentBlock: blockNumber });
    if (!epochData) return null;
    const epochs: EpochInput[] = [];
    indices.forEach((k, i) => {
      const e = epochData[i * 2];
      const opens = epochData[i * 2 + 1];
      if (e?.status !== "success" || opens?.status !== "success") return;
      const [snapshotBlock, amount, eligibleSupply, claimed] = e.result as readonly [bigint, bigint, bigint, bigint];
      epochs.push({ index: k, snapshotBlock, amount, eligibleSupply, claimed, opensAtBlock: opens.result as bigint });
    });
    let holderInput: { weights: Record<number, bigint>; claimed: Record<number, boolean> } | undefined;
    if (holder && holderData) {
      holderInput = { weights: {}, claimed: {} };
      indices.forEach((k, i) => {
        const w = holderData[i * 2];
        const c = holderData[i * 2 + 1];
        if (w?.status === "success") holderInput!.weights[k] = w.result as bigint;
        if (c?.status === "success") holderInput!.claimed[k] = c.result as boolean;
      });
    }
    return epochRows({ epochs, currentBlock: blockNumber, holder: holderInput });
  }, [epochData, holderData, blockNumber, indices, holder, countKnown]);

  /*
   * What the epoch accruing NOW means for the connected wallet.
   *
   * The vault pays an epoch on the lower of a wallet's balance at its opening snapshot and at its
   * closing one, a day apart, so "do I earn anything by holding this?" has an exact answer that a
   * holder cannot get from the four figures above. It takes the two lines of the accruing epoch —
   * `snapshotBlockFor(currentInterval)` and the one after — the wallet's balance now, and its
   * balance at the opening line, which the token only answers once that block is in the past.
   */
  const accruing = funding?.currentInterval ?? null;
  const { data: lines } = useReadContracts({
    contracts:
      vault && accruing !== null
        ? [
            { address: vault, abi: rewardVaultAbi, functionName: "snapshotBlockFor", args: [accruing] } as const,
            { address: vault, abi: rewardVaultAbi, functionName: "snapshotBlockFor", args: [accruing + 1n] } as const,
          ]
        : [],
    query: { enabled: vault !== null && accruing !== null },
  });
  const opensAtBlock = lines?.[0]?.status === "success" ? (lines[0].result as bigint) : null;
  const closesAtBlock = lines?.[1]?.status === "success" ? (lines[1].result as bigint) : null;
  const snapshotPassed = opensAtBlock !== null && blockNumber !== undefined && blockNumber > opensAtBlock;
  const { data: balanceNow } = useReadContract({
    address: token,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [holder ?? ZERO],
    query: { enabled: graduated && holder !== undefined, refetchInterval: 20_000 },
  });
  const { data: balanceAtOpen } = useReadContract({
    address: token,
    abi: tokenAbi,
    functionName: "getPastBalance",
    args: [holder ?? ZERO, opensAtBlock ?? 0n],
    query: { enabled: graduated && holder !== undefined && snapshotPassed },
  });
  const standing = useMemo(() => {
    if (!holder || blockNumber === undefined || opensAtBlock === null || closesAtBlock === null) return null;
    if (balanceNow === undefined) return null;
    return holderStanding({
      currentBlock: blockNumber,
      opensAtBlock,
      closesAtBlock,
      balanceAtOpen: balanceAtOpen ?? null,
      balanceNow,
    });
  }, [holder, blockNumber, opensAtBlock, closesAtBlock, balanceNow, balanceAtOpen]);

  // A claim window is 26 epochs. The oldest claimable epoch's is the one that closes first.
  const oldest = useMemo(() => (ledger ? oldestClaimableEpoch(ledger.rows) : null), [ledger]);
  const { data: claimBy } = useReadContract({
    address: vault ?? undefined,
    abi: rewardVaultAbi,
    functionName: "sweepableFrom",
    args: [BigInt(oldest ?? 0)],
    query: { enabled: vault !== null && oldest !== null },
  });

  // The claim, as the rest of the app sends transactions: simulate, write, wait.
  const { data: wallet } = useWalletClient();
  const publicClient = usePublicClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const claim = useCallback(async () => {
    if (!wallet?.account || !publicClient || !vault || !holder || !ledger?.claimableRange) return;
    setError(null);
    setPending(true);
    try {
      const { request } = await publicClient.simulateContract({
        address: vault,
        abi: rewardVaultAbi,
        functionName: "claim",
        args: [holder, BigInt(ledger.claimableRange.from), BigInt(ledger.claimableRange.to)],
        account: wallet.account.address,
      });
      const hash = await wallet.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === "reverted") throw new Error("The claim reverted on chain. Nothing moved, but the gas was spent.");
      await Promise.all([refetchEpochs(), refetchHolder(), refetchFunding()]);
    } catch (e) {
      setError(shorten(e));
    } finally {
      setPending(false);
    }
  }, [wallet, publicClient, vault, holder, ledger, refetchEpochs, refetchHolder, refetchFunding]);

  // Opening epochs is permissionless: the keeper normally does it, and anyone may.
  const [opening, setOpening] = useState(false);
  const openEpochs = useCallback(async () => {
    if (!wallet?.account || !publicClient || !vault || !funding || funding.openable === 0) return;
    setError(null);
    setOpening(true);
    try {
      const { request } = await publicClient.simulateContract({
        address: vault,
        abi: rewardVaultAbi,
        functionName: "createEpochs",
        args: [BigInt(funding.openable)],
        account: wallet.account.address,
      });
      const hash = await wallet.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === "reverted") throw new Error("Opening the epochs reverted on chain. Nothing moved, but the gas was spent.");
      await Promise.all([refetchCount(), refetchEpochs(), refetchHolder(), refetchFunding()]);
    } catch (e) {
      setError(shorten(e));
    } finally {
      setOpening(false);
    }
  }, [wallet, publicClient, vault, funding, refetchCount, refetchEpochs, refetchHolder, refetchFunding]);

  const now = Date.now();
  const when = (block: bigint) =>
    blockNumber ? estimateBlockTime(block, blockNumber, now).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";

  /** A snapshot lands on a minute, and "hold until Sep 21" is not an instruction: date AND time. */
  const at = (block: bigint) =>
    blockNumber
      ? estimateBlockTime(block, blockNumber, now).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "";

  const Figure = ({
    label: text,
    hint,
    amount,
    tone = "ink",
  }: {
    label: string;
    hint: string;
    amount: bigint;
    tone?: "ink" | "doku";
  }) => {
    const usd = formatUsd(usdOf(amount, quoteDecimals, usdPrice));
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="inline-flex items-center gap-1 font-pixel text-[11px] uppercase leading-none tracking-[0.04em] text-ash">
          {text}
          <span title={hint} className="inline-flex cursor-help text-faint" aria-label={hint}>
            <Info className="h-3 w-3" strokeWidth={2} aria-hidden />
          </span>
        </span>
        <span
          className={`truncate font-numeric text-[17px] font-semibold leading-none tabular-nums ${tone === "doku" ? "text-doku-ink" : "text-ink"}`}
        >
          {formatQuote(amount, quoteDecimals)}
          <span className="ml-1 font-numeric text-[0.7em] font-medium text-mute">{quoteSymbol}</span>
        </span>
        {usd && <span className="font-numeric text-[11px] leading-none tabular-nums text-faint">{usd}</span>}
      </div>
    );
  };

  if (!graduated) {
    return (
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-x-4 gap-y-4">
          <Figure
            label={t("Funded for holders")}
            hint={t("What has reached the reward vault. Nothing does until the curve graduates.")}
            amount={0n}
          />
          <Figure
            label={t("Accruing on the curve")}
            hint={t("The holders' share of trading fees, held by the curve until graduation.")}
            amount={pendingOnCurve ?? 0n}
          />
        </div>
        <p className="font-ui text-[12px] leading-snug text-mute">
          {t(
            "Dividends start at graduation. Until then the holders' share stays on the curve; if this market never graduates it is never paid out. After graduation it is paid over the first daily epochs to wallets holding then, not to whoever held while it built up.",
          )}
        </p>
      </div>
    );
  }

  const retry = (what: () => void) => (
    <button type="button" onClick={what} className="ml-1 text-doku-ink underline-offset-2 hover:underline">
      {t("Try again")}
    </button>
  );

  if (vault === null) {
    return (
      <p className="font-ui text-[12px] leading-snug text-mute">
        {sinkFailed ? t("The reward vault could not be read.") : t("Reading the reward vault…")}
        {sinkFailed && retry(() => void refetchSink())}
      </p>
    );
  }

  if (!ledger || !funding || vaultBalance === undefined) {
    return (
      <p className="font-ui text-[12px] leading-snug text-mute">
        {countFailed ? t("The vault could not be read.") : t("Reading the vault…")}
        {countFailed && retry(() => void refetchCount())}
      </p>
    );
  }

  const summary = vaultSummary(ledger.rows, funding.unallocated ?? 0n, vaultBalance);
  const nextClose = funding.upcoming.find((u) => blockNumber !== undefined && blockNumber <= u.closes)?.closes;
  const epochs = ledger.rows.length;
  const claimable = holder ? ledger.totals.holderClaimable : 0n;
  const holderTotal = holder ? ledger.rows.reduce((acc, r) => acc + (r.holderShare ?? 0n), 0n) : 0n;
  const nextOwn = holder ? ledger.rows.find((r) => r.status === "accruing" && (r.holderShare ?? 0n) > 0n) : undefined;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-x-4 gap-y-4">
        <Figure
          label={t("Funded for holders")}
          hint={t("Everything that has reached the reward vault: paid, waiting and awaiting split.")}
          amount={summary.funded}
        />
        <Figure
          label={t("Paid to holders")}
          hint={t("What holders have claimed out of the vault so far.")}
          amount={summary.paid}
        />
        <Figure
          label={t("Waiting for holders")}
          hint={t(
            "In opened epochs and not yet claimed. It belongs to the holders of record for 26 days after each epoch closes; what is still unclaimed then passes to later holders.",
          )}
          amount={summary.waiting}
        />
        <Figure
          label={t("Awaiting split")}
          hint={t("Funded but not yet in an epoch. It joins the next epochs as their intervals close.")}
          amount={summary.awaitingSplit}
        />
      </div>

      <p className="font-ui text-[12px] leading-snug text-mute">
        {epochs === 0
          ? nextClose !== undefined
            ? `${t("No epoch yet. The first opens after")} ${when(nextClose)}.`
            : t("No epoch yet.")
          : `${epochs} ${epochs === 1 ? t("epoch") : t("epochs")}${nextClose !== undefined ? ` · ${t("next opens")} ${when(nextClose)}` : ""}`}
        {holder && funding.openable > 0 && (
          <>
            {" · "}
            <button type="button" onClick={openEpochs} disabled={opening} className="text-doku-ink underline-offset-2 hover:underline disabled:opacity-60">
              {opening
                ? t("Opening…")
                : `${t("open")} ${funding.openable} ${funding.openable === 1 ? t("closed interval") : t("closed intervals")}`}
            </button>
          </>
        )}
      </p>

      <p className="font-ui text-[12px] leading-snug text-mute">
        {t(
          "An epoch is one day. It pays wallets that held at BOTH its opening and its closing snapshot, on the lower of the two balances. A big day is paid out over the next seven. Tokens placed in the liquidity pool earn nothing.",
        )}
      </p>

      {holder && standing && standing.kind !== "none" && (
        <p className="font-ui text-[12px] leading-snug text-ink" data-standing={standing.kind}>
          {standing.kind === "before-first-snapshot" &&
            `${t("The first snapshot is on")} ${at(standing.snapshotAtBlock)}. ${t("Hold through it and through")} ${at(standing.claimableAtBlock)} ${t("to earn the first epoch; it can be claimed after that.")}`}
          {standing.kind === "bought-after-snapshot" &&
            `${t("You bought after today's snapshot, so this epoch pays you nothing. You start earning at the next snapshot,")} ${at(standing.startsAtBlock)}${t(", and your first claim opens")} ${at(standing.firstClaimAtBlock)}.`}
          {standing.kind === "earning" &&
            `${t("This epoch counts")} ${tokens(standing.counted)} ${ticker} ${t("for you")}${standing.soldSince ? t(": you have sold since the snapshot, and only what you still hold at the close counts") : ""}. ${t("Keep holding until")} ${at(standing.claimableAtBlock)}${t("; selling before then lowers or loses this epoch's share.")}`}
          {standing.kind === "sold-out" &&
            `${t("You held")} ${tokens(standing.heldAtOpen)} ${ticker} ${t("at today's snapshot and hold none now. Unless you hold again at the close on")} ${at(standing.closesAtBlock)}${t(", this epoch pays you nothing.")}`}
          {standing.kind === "unknown" && t("Your balance at today's snapshot could not be read, so what this epoch counts for you is not shown.")}
        </p>
      )}

      {holder && (
        <div className="doku-spec-row flex items-center justify-between gap-3 pt-3">
          <span className="flex min-w-0 flex-col gap-1.5">
            <span className="font-pixel text-[11px] uppercase leading-none tracking-[0.04em] text-ash">{t("Your share")}</span>
            <span className="font-numeric text-[13px] leading-none tabular-nums text-mute">
              {claimable > 0n
                ? `${formatQuote(claimable, quoteDecimals)} ${quoteSymbol} ${t("ready to claim")}`
                : holderTotal > 0n
                  ? nextOwn
                    ? `${t("Claimed. Next share opens")} ${when(nextOwn.opensAtBlock)}.`
                    : t("All claimed.")
                  : nextOwn
                    ? `${formatQuote(nextOwn.holderShare ?? 0n, quoteDecimals)} ${quoteSymbol} ${t("opens")} ${when(nextOwn.opensAtBlock)}`
                    : t("Nothing to claim yet.")}
            </span>
          </span>
          {claimable > 0n && ledger.claimableRange && (
            <button
              type="button"
              onClick={claim}
              disabled={pending}
              className="doku-cta inline-flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-doku-xl px-4 font-numeric text-[12px] font-semibold uppercase tracking-[0.06em] disabled:opacity-60"
            >
              {pending ? t("Claiming…") : `${t("Claim")} ${formatQuote(claimable, quoteDecimals)} ${quoteSymbol}`}
            </button>
          )}
        </div>
      )}
      {holder && claimable > 0n && claimBy !== undefined && (
        <p className="font-ui text-[12px] leading-snug text-mute">
          {`${t("Claim by")} ${at(claimBy)}. ${t("After that anyone may pass what is unclaimed on to later holders. Larger shares are claimed for you automatically; small ones wait here.")}`}
        </p>
      )}
      {error && <p className="font-ui text-[12px] leading-snug text-loss-ink">{error}</p>}
    </div>
  );
}

export default DividendsPanel;
