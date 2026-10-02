"use client";

import { useCallback, useState } from "react";
import { usePublicClient, useWalletClient } from "wagmi";

import { CONTRACTS, NATIVE_CURRENCY, poolKeyOf } from "@/lib/chain/addresses";
import { positionManagerAbi } from "@/lib/chain/liquidity-abis";
import {
  buildCollectFees,
  buildRemoveLiquidity,
  type LiquidityPlan,
} from "@/lib/chain/liquidity-calls";
import type { PoolKeyLike } from "@/lib/chain/pool-key";
import { shorten } from "@/lib/chain/revert-reason";
import { deadlineFrom } from "@/lib/chain/writes";

/**
 * The two writes that act on a position which already exists.
 *
 * These lived inside `LiquidityPanel`, which also owns the range picker, the amount maths and the
 * mint. Three surfaces need withdraw and collect now — the panel, the pools-page section and the
 * portfolio — so they move here. Minting stays in the panel: it is the one write that depends on
 * the panel's own state, and pulling it out would mean threading a range and two amounts through
 * an interface for no gain.
 */

const SLIPPAGE_BPS = 100;
const DEADLINE_SECS = 300;

export interface ActionPosition {
  tokenId: bigint;
  liquidity: bigint;
  amountToken: bigint;
  amountMon: bigint;
}

export function useLiquidityActions(): {
  withdraw: (a: {
    position: ActionPosition;
    token: string;
    poolKey?: PoolKeyLike | null;
    onDone?: () => void;
  }) => Promise<void>;
  collect: (a: {
    tokenId: bigint;
    token: string;
    poolKey?: PoolKeyLike | null;
    onDone?: () => void;
  }) => Promise<void>;
  pending: string | null;
  error: string | null;
  clearError: () => void;
} {
  const { data: wallet } = useWalletClient();
  const publicClient = usePublicClient();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(
    async (label: string, plan: LiquidityPlan, onDone?: () => void) => {
      if (!wallet?.account || !publicClient) return;
      setError(null);
      setPending(label);
      try {
        // Simulated first, so a revert surfaces as a message here rather than as a wallet
        // rejecting a transaction the person has already been asked to sign.
        const { request } = await publicClient.simulateContract({
          address: CONTRACTS.positionManager,
          abi: positionManagerAbi,
          functionName: "modifyLiquidities",
          args: [plan.unlockData, plan.deadline],
          value: plan.value,
          account: wallet.account.address,
        });
        const hash = await wallet.writeContract(request);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        // `waitForTransactionReceipt` RESOLVES for a reverted transaction. Unchecked, a failed
        // withdrawal closed the dialog and refreshed a list that had not changed.
        if (receipt.status === "reverted") {
          throw new Error(`${label} reverted on chain. Nothing moved, but the gas was spent.`);
        }
        onDone?.();
      } catch (e) {
        setError(shorten(e));
      } finally {
        setPending(null);
      }
    },
    [wallet, publicClient],
  );

  const withdraw = useCallback(
    async ({
      position,
      token,
      quoteAsset = NATIVE_CURRENCY,
      poolKey,
      onDone,
    }: {
      position: ActionPosition;
      token: string;
      /**
       * The pool's other side. It decides the `PoolKey`'s sort order, and therefore which pool
       * this write addresses.
       *
       * Defaulted to native MON rather than required, because that is what every caller means
       * today and what this hook silently assumed before the parameter existed. A caller holding a
       * market row should pass `market.market.quote.asset`; one that does not, and is looking at a
       * pool quoted in something else, would otherwise build a key for a pool that was never
       * initialised — which reverts rather than mis-sending, but reverts with nothing to read.
       */
      quoteAsset?: `0x${string}`;
      poolKey?: PoolKeyLike | null;
      onDone?: () => void;
    }) => {
      if (!wallet?.account) return;
      const floor = (v: bigint) => (v * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;
      const plan = buildRemoveLiquidity({
        tokenId: position.tokenId,
        liquidity: position.liquidity,
        poolKey: poolKeyOf(token as `0x${string}`, quoteAsset, poolKey),
        recipient: wallet.account.address,
        minToken: floor(position.amountToken),
        minMon: floor(position.amountMon),
        deadline: deadlineFrom(Date.now(), DEADLINE_SECS),
        // The whole position goes, so the emptied NFT goes with it. A position left at zero
        // liquidity is a row that looks like something and is nothing.
        burnPosition: true,
      });
      await send("Removing liquidity", plan, onDone);
    },
    [wallet, send],
  );

  const collect = useCallback(
    async ({
      tokenId,
      token,
      quoteAsset = NATIVE_CURRENCY,
      poolKey,
      onDone,
    }: {
      tokenId: bigint;
      token: string;
      /** The pool's other side — see `withdraw`. Defaulted to native MON for the same reason. */
      quoteAsset?: `0x${string}`;
      poolKey?: PoolKeyLike | null;
      onDone?: () => void;
    }) => {
      if (!wallet?.account) return;
      const plan = buildCollectFees({
        tokenId,
        poolKey: poolKeyOf(token as `0x${string}`, quoteAsset, poolKey),
        recipient: wallet.account.address,
        deadline: deadlineFrom(Date.now(), DEADLINE_SECS),
      });
      await send("Collecting fees", plan, onDone);
    },
    [wallet, send],
  );

  const clearError = useCallback(() => setError(null), []);

  return { withdraw, collect, pending, error, clearError };
}

// Re-exported: it lived here, and every call site imports it from here.
export { shorten };
