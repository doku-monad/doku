import {
  defineDokuChain,
  optionalAddress,
  POOL_FEE_TIER,
  POOL_TICK_SPACING,
  requireAddress,
  requireChainId,
} from "./config";
import { sortCurrencies } from "./pool-key";

/**
 * Contract addresses, read once at module load.
 *
 * Split from `config.ts` so that file stays PURE — validators and a chain definition, no
 * environment. Anything importing `config.ts` used to trigger these reads on load, which meant a
 * test harness that only wanted `defineDokuChain` had to satisfy every `NEXT_PUBLIC_*` variable
 * the app has, or fail at import time with a message about a chain id it never asked for.
 *
 * They live HERE rather than in `wagmi.ts` because `wagmi.ts` imports the wagmi library, which is
 * ESM — so anything that reached these through it dragged a browser-oriented ESM package into
 * every consumer, including Node test runners that cannot parse it. Addresses are not a wagmi
 * concern; the connector configuration is.
 *
 * Reading configuration at load rather than at first use means a misconfigured deployment fails to
 * boot instead of rendering a working-looking app whose buttons quietly do nothing.
 */
/** The chain's own public endpoint: the fallback when the proxy is unreachable, and the default without one. */
export const PUBLIC_RPC_URL = "https://rpc.monad.xyz";
export const RPC_URL = process.env.NEXT_PUBLIC_MONAD_RPC_URL ?? PUBLIC_RPC_URL;

/**
 * Which Monad.
 *
 * It was a constant set to mainnet's value, which made a testnet deployment inexpressible and —
 * worse — made forgetting to configure it indistinguishable from configuring it correctly. Read
 * here beside the addresses, because everything in this block shares one property: wrong is
 * invisible until money moves.
 */
export const CHAIN_ID = requireChainId(
  process.env.NEXT_PUBLIC_MONAD_CHAIN_ID,
  "NEXT_PUBLIC_MONAD_CHAIN_ID",
);

/**
 * Native MON, as a v4 `Currency`.
 *
 * There is no wrapper any more. A v4 pool holds the native token directly and spells it
 * `address(0)` inside a `PoolKey`, so `NEXT_PUBLIC_WMON_ADDRESS` is gone — every DOKU pool's
 * `currency0` is this, on every network, which is also why the market's token is always
 * `currency1` and the sort order the indexer once computed is now a constant.
 */
export const NATIVE_CURRENCY = "0x0000000000000000000000000000000000000000" as const;

/**
 * The zap router, or `null` where a deployment has none.
 *
 * The one address in this file that is OPTIONAL, and the only one whose absence is a normal state
 * rather than a misconfiguration. It buys a market's token with native MON on a market priced in
 * something else, by swapping through Uniswap v4 first — periphery, not protocol. Nothing in the
 * app needs it, no market behaves differently without it, and it is not deployed on any network
 * today.
 *
 * `null` therefore means the "pay with MON" option is ABSENT — not disabled, not erroring. A
 * disabled control on a feature with no contract behind it is a promise to a trader that somebody
 * will have to break, and it is also how an address gets hardcoded later "just to see it work".
 * `sideAssetOptions` in `zap-plan.ts` is the single gate; see the note there.
 */
export const ZAP_ROUTER = optionalAddress(
  process.env.NEXT_PUBLIC_ZAP_ROUTER,
  "NEXT_PUBLIC_ZAP_ROUTER"
);

export const dokuChain = defineDokuChain(RPC_URL, CHAIN_ID);

export const CONTRACTS = {
  factory: requireAddress(process.env.NEXT_PUBLIC_DOKU_FACTORY, "NEXT_PUBLIC_DOKU_FACTORY"),
  graduation: requireAddress(
    process.env.NEXT_PUBLIC_DOKU_GRADUATION,
    "NEXT_PUBLIC_DOKU_GRADUATION",
  ),
  registry: requireAddress(process.env.NEXT_PUBLIC_DOKU_REGISTRY, "NEXT_PUBLIC_DOKU_REGISTRY"),
  /**
   * The hook. Required, and not only for the levy.
   *
   * It is a field of every `PoolKey`, so a swap cannot even be addressed without it — which is a
   * change from V3, where the pool was a contract you looked up by its pair.
   */
  hook: requireAddress(process.env.NEXT_PUBLIC_DOKU_HOOK, "NEXT_PUBLIC_DOKU_HOOK"),

  /**
   * Uniswap's, not ours. Canonical singletons the protocol integrates with rather than deploys.
   *
   * Required, not optional: without them a graduated market cannot be traded at all, and a market
   * that graduates is the successful case.
   */
  poolManager: requireAddress(
    process.env.NEXT_PUBLIC_V4_POOL_MANAGER,
    "NEXT_PUBLIC_V4_POOL_MANAGER",
  ),
  quoter: requireAddress(process.env.NEXT_PUBLIC_V4_QUOTER, "NEXT_PUBLIC_V4_QUOTER"),
  /**
   * UniversalRouter, and WHICH one is a decision rather than a lookup.
   *
   * Two are live on Monad mainnet. Sampling 400 blocks of real v4 `Swap` logs from the PoolManager
   * and tallying the indexed `sender` — which is the contract that called `swap` — settled it:
   *
   *     0x0d97dc33264bfc1c226207428a79b26757fb9dc3   14 of 55 swaps
   *     0xFdf682F51FE81Aa4898F0AE2163d8A55c127fbC7    0
   *
   * The rest were aggregators and bots routing through their own contracts. So the older
   * v1.2/v2.0 router is the one that actually carries wallet traffic, and the newer v2.1.1 the
   * plan assumed was canonical carries none of it. Read from configuration rather than hardcoded
   * because that balance can move, and the answer is a deployment fact, not a code fact.
   */
  universalRouter: requireAddress(
    process.env.NEXT_PUBLIC_UNIVERSAL_ROUTER,
    "NEXT_PUBLIC_UNIVERSAL_ROUTER",
  ),
  permit2: requireAddress(process.env.NEXT_PUBLIC_PERMIT2, "NEXT_PUBLIC_PERMIT2"),
  /**
   * v4 exposes pool state through `extsload` rather than getters, so reading a price means
   * computing a storage slot. This lens is what does it.
   */
  stateView: requireAddress(process.env.NEXT_PUBLIC_V4_STATE_VIEW, "NEXT_PUBLIC_V4_STATE_VIEW"),
  positionManager: requireAddress(
    process.env.NEXT_PUBLIC_V4_POSITION_MANAGER,
    "NEXT_PUBLIC_V4_POSITION_MANAGER",
  ),
} as const;

/**
 * The `PoolKey` of a graduated market, which is how v4 addresses a pool at all.
 *
 * Two fields are protocol constants and each is load-bearing: the LP fee is ZERO because the levy
 * is skimmed from the swap and a non-zero fee would make that impossible, and the hook is what
 * makes the pool ours. The two currencies are the market's own pair, SORTED — `currency0` was
 * native MON on every pool while every market was priced in MON, and a market quoted in USDC or in
 * gold can put its token on either side. Built here, once, so no caller assembles it by hand — a
 * key that hashes to a `PoolId` no pool is at fails silently, as a market that simply looks
 * untraded.
 */
/**
 * The pool key for a market, preferring the one recorded when its pool was created.
 *
 * There is more than one hook deployed. Markets graduated before the LP-paying hook carry the old
 * one, and a `PoolKey` assembled from the configured hook address hashes to a pool that does not
 * exist — every read then returns zeros, which reads as "this pool has never been initialised"
 * rather than as a wrong address. So the recorded key wins whenever there is one.
 *
 * The fallback is for the gap between a market graduating and the indexer recording it: in that
 * window the newest hook is the right guess, because it is the one that just created the pool.
 */
export function poolKeyOf(
  token: `0x${string}`,
  quoteAsset: `0x${string}`,
  recorded: {
    currency0: `0x${string}`;
    currency1: `0x${string}`;
    fee: number;
    tickSpacing: number;
    hooks: `0x${string}`;
  } | null | undefined,
) {
  return recorded ?? poolKeyFor(token, quoteAsset);
}

/**
 * @param quoteAsset what the market is priced in — `NATIVE_CURRENCY` for MON, and defaulted to it
 *        so a generation-1 caller that has no quote column is still correct. The two currencies
 *        are SORTED: the token is not always `currency1`, and assuming it is builds a key that
 *        hashes to a pool nothing has ever initialised.
 */
export function poolKeyFor(
  token: `0x${string}`,
  quoteAsset: `0x${string}` = NATIVE_CURRENCY,
) {
  const [currency0, currency1] = sortCurrencies(quoteAsset, token);
  return {
    currency0,
    currency1,
    fee: POOL_FEE_TIER,
    tickSpacing: POOL_TICK_SPACING,
    hooks: CONTRACTS.hook,
  } as const;
}
