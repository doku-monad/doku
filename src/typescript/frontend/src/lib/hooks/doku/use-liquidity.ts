"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useAccount, useBalance, useReadContract, useReadContracts } from "wagmi";

import { CONTRACTS, NATIVE_CURRENCY, poolKeyFor, poolKeyOf } from "@/lib/chain/addresses";
import { positionAmounts, positionValueMon } from "@/lib/chain/liquidity";
import { dokuHookAbi, erc20Abi, positionManagerAbi, stateViewAbi } from "@/lib/chain/liquidity-abis";
import { type MakerLevy, makerLevyBps, NO_LEVY } from "@/lib/chain/maker-levy";
import { poolIdFrom } from "@/lib/chain/pool-id";
import type { PoolKeyLike } from "@/lib/chain/pool-key";
import { priceFromSqrtX96 } from "@/lib/chain/pool-price";
import { quoteFees } from "@/lib/chain/position-fees";
import { decodePositionInfo } from "@/lib/chain/position-info";
import {
  DOKU_FEE_TIER,
  type MarketRef,
  type MatchedPosition,
  matchRecordsToMarkets,
  type PositionRecord,
} from "@/lib/chain/position-matching";

/**
 * Reading a pool and the caller's positions in it.
 *
 * Both are needed before anything can be shown: the pool's price sets the ratio a deposit must
 * match, and a position's liquidity is what a withdrawal is denominated in. Neither is derivable
 * from the indexer — the indexer records trades, and a position is not a trade.
 */

export interface PoolState {
  sqrtPriceX96: bigint;
  /** The tick the pool is currently in. What a range is centred on and compared against. */
  tickCurrent: number;
  /** Whether the market's token is the pool's token0. V3 sorts by address, so this varies. */
  marketTokenIsToken0: boolean;
  /**
   * The pool's `liquidity` at the current tick.
   *
   * NOT DEPTH, and it must never be presented as such. It is the liquidity in range right now, so
   * anyone can mint a one-tick position around spot for a small fraction of a full-range position's
   * capital, inflate this number, and remove it in the next block. Under v4 third-party LPs are
   * admitted, which turns that from a hypothetical into something anyone can do.
   *
   * Use it for range and withdrawal maths, which is what it is correct for. Any figure a user reads
   * as "how deep is this market" has to be computed from the locked position's own amounts.
   */
  liquidity: bigint;
}

export function usePoolState(poolId: `0x${string}` | null, token: string | null): PoolState | null {
  const enabled = Boolean(token) && Boolean(poolId);

  /**
   * StateView, not the pool.
   *
   * There is no pool contract in v4 to call `slot0()` on — every pool is a row inside the one
   * PoolManager, addressed by a `PoolId`. That id comes from the MARKET, not from configuration:
   * more than one hook is deployed, and a key rebuilt from the configured one hashes to a pool
   * that does not exist, which reads as "never initialised" rather than as a wrong address.
   */
  const { data } = useReadContracts({
    contracts: enabled && poolId
      ? [
          { address: CONTRACTS.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [poolId] },
          { address: CONTRACTS.stateView, abi: stateViewAbi, functionName: "getLiquidity", args: [poolId] },
        ]
      : [],
    query: { enabled: enabled && Boolean(poolId), refetchInterval: 12_000 },
  });

  return useMemo(() => {
    if (!enabled || !data) return null;
    const [slot0, liquidity] = data;
    // Both entries, and both succeeded. A multicall read returns a slot per request whether or not
    // the call worked, so a pool that has never been initialised comes back shaped correctly and
    // full of failures.
    if (!slot0 || !liquidity) return null;
    if (slot0.status !== "success" || liquidity.status !== "success") return null;
    const raw = slot0.result as readonly [bigint, number, number, number];
    const sqrtPriceX96 = raw[0];
    if (sqrtPriceX96 <= 0n) return null;
    return {
      sqrtPriceX96,
      tickCurrent: Number(raw[1]),
      // Always false, and stated rather than computed: `currency0` is native MON — the zero
      // address, which sorts below every possible token — so the market's token is `currency1` in
      // every DOKU pool. Under V3 this was a genuine coin flip decided by whichever addresses a
      // deployment happened to get, and `sortPair` existed to resolve it.
      marketTokenIsToken0: false,
      liquidity: liquidity.result as bigint,
    };
  }, [enabled, data]);
}

/**
 * The hook's maker levy for one pool, read from the hook that pool actually carries.
 *
 * A deposit's cost is the paired amount plus this, so the panel cannot price one without it. Null
 * until the read lands, and null is not zero: pretending a market is unlevied while its
 * configuration is in flight is how the panel came to ask for a person's whole balance and have
 * the mint fail on the seventy-five basis points it had not counted.
 *
 * `hooks` comes from the MARKET's pool key rather than from configuration. Two hooks are live and
 * a curve stores its graduator at initialize, so the configured one answers for the wrong pool on
 * every market that graduated before the upgrade — with zeros, which read as "no levy".
 */
export function useMakerLevy(
  poolId: `0x${string}` | null,
  hooks: `0x${string}` | null,
): MakerLevy | null {
  const enabled = Boolean(poolId) && Boolean(hooks);

  const { data } = useReadContract({
    address: (hooks ?? undefined) as `0x${string}` | undefined,
    abi: dokuHookAbi,
    functionName: "markets",
    args: poolId ? [poolId] : undefined,
    query: { enabled },
  });

  return useMemo(() => {
    if (!enabled || !data) return null;
    const [registered, sink, protocolBps] = data as readonly [boolean, number, number, ...unknown[]];
    // An unregistered market is the hook's documented fail-open: zero rates, nothing levied. It is
    // a real answer, so it returns a levy rather than null — unlike a read that has not happened.
    if (!registered) return NO_LEVY;
    return makerLevyBps({ sink: Number(sink), protocolBps: Number(protocolBps) });
  }, [enabled, data]);
}

/** One position as the indexer recorded it, before the chain has confirmed anything about it. */
interface IndexedPosition {
  token_id: string;
  market_address: string;
  token_address: string;
}

export interface UserPosition {
  tokenId: bigint;
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
  /**
   * Whether the price is inside this position's range. On the hook a market graduates under now,
   * nothing here earns either way (see `position-fees.ts`) — in range only means the position is
   * presently two-sided rather than holding a single currency.
   */
  inRange: boolean;
  /** What withdrawing the whole position would return, at the price right now. */
  amountToken: bigint;
  amountMon: bigint;
}

/**
 * Every Uniswap position an address owns, as the position manager reports them.
 *
 * The manager is an enumerable ERC-721 with no per-pool index: a position knows its pair, a pool
 * does not know its positions. So finding one position means walking all of them — which is why
 * this is shared rather than done per pool. `useUserPositions` was performing this exact walk and
 * then keeping a single pool's worth, so the all-pools view is the same walk without the discard.
 *
 * `owner` is an argument rather than `useAccount()`. Enumeration is per owner address and needs no
 * signature, which is what lets the portfolio page show liquidity for whichever address is in its
 * URL, the same way it already shows that address's tokens.
 */
export function useOwnedPositionRecords(owner: string | null | undefined): {
  records: PositionRecord[];
  isLoading: boolean;
  truncated: boolean;
  refetch: () => void;
} {
  const enabled = Boolean(owner);

  /**
   * Which positions to even ask about, from the indexer.
   *
   * There is no chain-side alternative. v4's PositionManager is ERC-721 but NOT
   * ERC-721Enumerable, so nothing can list an owner's positions — and on Monad it is the CANONICAL
   * manager shared by every v4 protocol, with over six hundred thousand positions minted in it, so
   * the obvious fallback of walking the ids and checking each owner is not slow but impossible.
   * An earlier revision of this hook did exactly that, capped at the newest few hundred ids, which
   * would have found a DOKU position only by coincidence.
   *
   * The indexer watches the PoolManager's `ModifyLiquidity`, whose pool id and sender are both
   * indexed topics, so it can answer this from the handful of logs that touched our pools.
   *
   * It watched `ModifyPosition` at the PositionManager until this was fixed. That event exists on
   * the vendored periphery the testnet deploys, and not on the canonical PositionManager mainnet
   * uses — so this list was empty for every account on mainnet, and the emptiness was
   * indistinguishable from having no positions.
   */
  const {
    data: candidates,
    isLoading: loadingCandidates,
    refetch: refetchCandidates,
  } = useQuery({
    queryKey: ["owned-positions", owner ?? null],
    enabled,
    staleTime: 12_000,
    queryFn: async (): Promise<IndexedPosition[]> => {
      const response = await fetch(`/api/accounts/${owner}/positions`);
      if (!response.ok) throw new Error(`positions: ${response.status}`);
      const body = (await response.json()) as { items: IndexedPosition[] };
      return body.items ?? [];
    },
  });

  const tokenIds = useMemo(
    () => (candidates ?? []).map((p) => BigInt(p.token_id)),
    [candidates],
  );

  /**
   * The chain confirms what the index suggested.
   *
   * The indexer's `owner` is the `sender` of the event, which is the end user for a normal deposit
   * but goes stale the moment a position is minted to somebody else or transferred as an NFT. So
   * the index is treated as a set of CANDIDATES and the chain decides — cheap over a handful of
   * ids, and impossible over every id in the manager, which is the whole reason for the split.
   */
  const {
    data: onchain,
    isLoading: loadingOnchain,
    refetch: refetchOnchain,
  } = useReadContracts({
    contracts: tokenIds.flatMap((id) => [
      {
        address: CONTRACTS.positionManager,
        abi: positionManagerAbi,
        functionName: "ownerOf" as const,
        args: [id],
      },
      {
        address: CONTRACTS.positionManager,
        abi: positionManagerAbi,
        functionName: "getPositionLiquidity" as const,
        args: [id],
      },
      {
        address: CONTRACTS.positionManager,
        abi: positionManagerAbi,
        functionName: "getPoolAndPositionInfo" as const,
        args: [id],
      },
    ]),
    query: { enabled: tokenIds.length > 0, refetchInterval: 12_000 },
  });

  const records = useMemo(() => {
    if (!candidates || !onchain || !owner) return [];
    const mine = owner.toLowerCase();
    const out: PositionRecord[] = [];

    candidates.forEach((candidate, i) => {
      const ownerResult = onchain[i * 3];
      const liquidityResult = onchain[i * 3 + 1];
      const infoResult = onchain[i * 3 + 2];
      if (!ownerResult || !liquidityResult || !infoResult) return;
      // A burned position reverts on `ownerOf` rather than returning zero, so a failure here is
      // ordinary — it means the position is gone, not that anything is broken.
      if (ownerResult.status !== "success" || liquidityResult.status !== "success") return;
      if (infoResult.status !== "success") return;
      if (String(ownerResult.result).toLowerCase() !== mine) return;

      /**
       * Ticks from the CHAIN, not from the index.
       *
       * The indexer has them — `ModifyPosition` carries both — and they would almost always agree.
       * But the range is what the withdrawal amounts and therefore the withdrawal MINIMUMS are
       * computed from, so an index that was stale or subtly wrong would set a floor against a
       * position that does not exist. The index is trusted to say WHICH positions to look at,
       * which is a claim nothing financial rests on, and the chain is asked for everything else.
       */
      const [, packed] = infoResult.result as readonly [unknown, bigint];
      const { tickLower, tickUpper } = decodePositionInfo(packed);

      // The pool key, not the indexed row, decides which side is which — the key is what the
      // position was actually minted against.
      const key = poolKeyFor(candidate.token_address as `0x${string}`);
      out.push({
        tokenId: BigInt(candidate.token_id),
        token0: key.currency0,
        token1: key.currency1,
        fee: key.fee,
        tickLower,
        tickUpper,
        liquidity: liquidityResult.result as bigint,
      });
    });
    return out;
  }, [candidates, onchain, owner]);

  const refetch = useCallback(() => {
    void refetchCandidates();
    void refetchOnchain();
  }, [refetchCandidates, refetchOnchain]);

  return {
    // Not `loadingOnchain` alone: an address with no positions has no second read to wait on, and
    // reporting "loading" forever would hide the empty state behind a spinner.
    isLoading: enabled && (loadingCandidates || loadingOnchain),
    records,
    // The indexer pages at its own limit rather than truncating silently; nothing here caps.
    truncated: false,
    refetch,
  };
}

/**
 * The caller's positions in one pool.
 *
 * A filter over `useOwnedPositionRecords`, which does the walking. Positions with zero liquidity
 * are dropped: they are ones already withdrawn but not burned, and showing an empty position
 * beside a real one invites withdrawing from the wrong row.
 */
export function useUserPositions(
  pool: string | null,
  token: string | null,
  poolState: PoolState | null,
): { positions: UserPosition[]; refetch: () => void } {
  const { address } = useAccount();
  const { records, refetch } = useOwnedPositionRecords(address);

  const positions = useMemo(() => {
    if (!token || !pool || !poolState) return [];
    // No sorting: native MON is `currency0` in every DOKU pool, so the market's token is
    // `currency1`. V3 had to work this out from the addresses; v4 fixes it by construction.
    const key = poolKeyFor(token as `0x${string}`);

    return records
      .filter(
        (r) =>
          r.liquidity > 0n &&
          r.fee === DOKU_FEE_TIER &&
          r.token0.toLowerCase() === key.currency0.toLowerCase() &&
          r.token1.toLowerCase() === key.currency1.toLowerCase(),
      )
      .map((r): UserPosition => {
        const { amount0, amount1 } = positionAmounts(
          poolState.sqrtPriceX96,
          r.liquidity,
          r.tickLower,
          r.tickUpper,
        );
        return {
          tokenId: r.tokenId,
          liquidity: r.liquidity,
          tickLower: r.tickLower,
          tickUpper: r.tickUpper,
          inRange: poolState.tickCurrent >= r.tickLower && poolState.tickCurrent < r.tickUpper,
          amountToken: poolState.marketTokenIsToken0 ? amount0 : amount1,
          amountMon: poolState.marketTokenIsToken0 ? amount1 : amount0,
        };
      });
  }, [records, token, pool, poolState]);

  return { positions, refetch };
}

/**
 * The caller's spendable balances for one pool.
 *
 * Shown beside each field because the alternative is a wallet rejecting a transaction the panel
 * had already accepted — and a rejection at signing time reads as the app being broken.
 *
 * MON is the native balance, not WMON: that is what the panel spends, and what comes back out.
 */
export function useBalances(token: string | null): { mon: bigint; token: bigint } {
  const { address } = useAccount();

  const { data: native } = useBalance({
    address,
    query: { enabled: Boolean(address), refetchInterval: 15_000 },
  });

  const { data: erc20 } = useReadContract({
    address: (token ?? undefined) as `0x${string}` | undefined,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && token), refetchInterval: 15_000 },
  });

  return { mon: native?.value ?? 0n, token: (erc20 as bigint | undefined) ?? 0n };
}

export interface OwnerPosition extends MatchedPosition {
  inRange: boolean;
  amountMon: bigint;
  amountToken: bigint;
  /** MON per token, from the pool. `null` when the pool could not be read. */
  monPerToken: number | null;
  /** `null` when there is no price to value against — render a dash, never a zero. */
  valueMon: number | null;
}

/**
 * Every DOKU position an address holds, across every pool, valued.
 *
 * A pool whose `slot0` will not read leaves its positions in the list with null amounts rather
 * than removing them. A list that silently shortens when an RPC call fails is indistinguishable
 * from "you have no liquidity", which is the worst confusion available on a page about money
 * somebody has deposited — so the row stays and says it cannot price itself.
 */
export function useOwnerPositions(
  owner: string | null | undefined,
  markets: MarketRef[] | undefined,
): { positions: OwnerPosition[]; isLoading: boolean; refetch: () => void } {
  const { records, isLoading, refetch } = useOwnedPositionRecords(owner);

  const matched = useMemo(
    () => (markets ? matchRecordsToMarkets(records, markets, NATIVE_CURRENCY) : []),
    [records, markets],
  );

  /**
   * One entry per distinct MARKET TOKEN, not per pool address.
   *
   * Under V3 each pool was a contract, so `poolAddress` distinguished them. Under v4 every market
   * records the same PoolManager, so grouping by that address would collapse every position in
   * every market into one pool and price them all against whichever answered first. The token is
   * what actually identifies the pool, through its key.
   */
  const pools = useMemo(
    () => Array.from(new Set(matched.map((p) => p.tokenAddress.toLowerCase()))),
    [matched],
  );

  /**
   * One id per market, taken from what `markets` recorded rather than rebuilt here.
   *
   * `matched` carries the market each position belongs to, and each of those knows the key its pool
   * was created with — which matters because markets graduated under the older hook have a
   * different one.
   */
  const poolIds = useMemo(() => {
    const byToken = new Map<string, `0x${string}`>();
    for (const p of matched) {
      const key = (p as unknown as { poolKey?: PoolKeyLike | null }).poolKey ?? null;
      /*
       * `NATIVE_CURRENCY`, stated rather than assumed.
       *
       * `MarketRef` does not carry the quote asset, so this walk cannot know it — and the pair's
       * sort order, hence the `PoolId`, depends on it. The recorded key wins wherever the market
       * row supplied one, which is every graduated market the indexer has seen, so this fallback
       * only decides pools the client had to rebuild. Threading the quote through
       * `matchRecordsToMarkets` is what makes this right for a non-MON pool; until then a
       * non-native pool without a recorded key reads as uninitialised rather than as MON.
       */
      byToken.set(
        p.tokenAddress.toLowerCase(),
        poolIdFrom(poolKeyOf(p.tokenAddress as `0x${string}`, NATIVE_CURRENCY, key)),
      );
    }
    return pools.map((token) => byToken.get(token)!);
  }, [matched, pools]);

  const { data: slots, refetch: refetchSlots } = useReadContracts({
    contracts: poolIds.map((poolId) => ({
      address: CONTRACTS.stateView,
      abi: stateViewAbi,
      functionName: "getSlot0" as const,
      args: [poolId] as const,
    })),
    query: { enabled: poolIds.length > 0, refetchInterval: 12_000 },
  });

  const positions = useMemo(() => {
    const byPool = new Map<string, { sqrtPriceX96: bigint; tickCurrent: number }>();
    (slots ?? []).forEach((r, i) => {
      if (r.status !== "success") return;
      const raw = r.result as readonly [bigint, number, number, number];
      // A pool that was never initialised comes back shaped correctly and priced at zero.
      if (raw[0] <= 0n) return;
      byPool.set(pools[i]!, { sqrtPriceX96: raw[0], tickCurrent: Number(raw[1]) });
    });

    return matched.map((p): OwnerPosition => {
      const slot = byPool.get(p.tokenAddress.toLowerCase());
      if (!slot) {
        return { ...p, inRange: false, amountMon: 0n, amountToken: 0n, monPerToken: null, valueMon: null };
      }

      const { amount0, amount1 } = positionAmounts(
        slot.sqrtPriceX96,
        p.liquidity,
        p.tickLower,
        p.tickUpper,
      );
      const amountToken = p.marketTokenIsToken0 ? amount0 : amount1;
      const amountMon = p.marketTokenIsToken0 ? amount1 : amount0;
      // `priceFromSqrtX96` needs to know which side is the wrapper, which it reads off token0.
      const token0 = p.marketTokenIsToken0 ? p.tokenAddress : NATIVE_CURRENCY;
      const monPerToken = priceFromSqrtX96(slot.sqrtPriceX96, token0, NATIVE_CURRENCY);

      return {
        ...p,
        inRange: slot.tickCurrent >= p.tickLower && slot.tickCurrent < p.tickUpper,
        amountMon,
        amountToken,
        monPerToken,
        valueMon: positionValueMon(amountMon, amountToken, monPerToken),
      };
    });
  }, [matched, slots, pools]);

  const refetchAll = useCallback(() => {
    refetch();
    void refetchSlots();
  }, [refetch, refetchSlots]);

  return { positions, isLoading, refetch: refetchAll };
}

export interface PositionFees {
  feesMon: bigint;
  feesToken: bigint;
}

/**
 * What each position has earned and not yet taken.
 *
 * Its own hook and its own query, so a failure here costs the fee column and nothing else. Fees
 * are the least important number on these screens and they must never take the withdraw button
 * down with them.
 *
 * See `position-fees.ts` for why this is a simulated `collect` rather than a read of `tokensOwed`.
 */
export function usePositionFees(
  _owner: string | null | undefined,
  positions: { tokenId: bigint; marketTokenIsToken0: boolean }[],
): { fees: Map<string, PositionFees>; refetch: () => void } {
  /**
   * No RPC, because there is no question to ask.
   *
   * This used to simulate a `collect` through the manager's `multicall`, which was the right way
   * to read V3's lazily-written `tokensOwed`. Neither function exists on v4's PositionManager, and
   * more to the point neither is needed: a DOKU pool's LP fee is zero by construction — the levy
   * is skimmed from the swap's flash accounting, which a non-zero fee makes impossible — so no fee
   * ever accrues to a position. `position-fees.ts` carries the guard that makes this fail loudly
   * rather than silently understate if that ever changes.
   */
  const fees = useMemo(() => {
    const quoted = quoteFees(positions.map((p) => p.tokenId));
    const out = new Map<string, PositionFees>();
    for (const p of positions) {
      const raw = quoted.get(p.tokenId.toString());
      if (!raw) continue;
      out.set(p.tokenId.toString(), {
        feesToken: p.marketTokenIsToken0 ? raw.amount0 : raw.amount1,
        feesMon: p.marketTokenIsToken0 ? raw.amount1 : raw.amount0,
      });
    }
    return out;
  }, [positions]);

  // Nothing to refetch; kept so callers keep their shape.
  const refetch = useCallback(() => {}, []);

  return { fees, refetch };
}
