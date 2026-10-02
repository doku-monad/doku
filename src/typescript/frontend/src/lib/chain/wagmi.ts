import { createConfig, fallback, http } from "wagmi";

import { CHAIN_ID, CONTRACTS, dokuChain, NATIVE_CURRENCY, poolKeyFor, PUBLIC_RPC_URL, RPC_URL } from "./addresses";

/**
 * Chain wiring, read once at module load.
 *
 * Reading configuration here rather than at first use means a misconfigured deployment fails to
 * boot instead of rendering a working-looking app whose buttons quietly do nothing.
 */

export const EXPECTED_CHAIN_ID = CHAIN_ID;

/**
 * The indexer's live feed, as the browser can reach it.
 *
 * Public and separate from `DOKU_INDEXER_URL`, which is server-side and may be a private address.
 * Unset means no socket and polling only — a working app with slower updates, which is the right
 * default for a deployment that has not exposed the feed yet.
 */
export const LIVE_FEED_URL: string | undefined = process.env.NEXT_PUBLIC_DOKU_LIVE_URL;

/**
 * Whether this deployment is showing generated markets.
 *
 * Set alongside the indexer's own `DOKU_SEED`. It exists purely so the interface can say so: a
 * preview is indistinguishable from the real thing by design, which is what makes it useful and
 * what makes it worth labelling.
 */
export const PREVIEW_MODE = process.env.NEXT_PUBLIC_PREVIEW_MODE === "true";

/**
 * Wallets are discovered, not listed.
 *
 * No `connectors` array: wagmi's EIP-6963 discovery is on by default and finds every injected
 * wallet the browser announces, with the name and icon each one publishes. A hardcoded
 * `injected()` connector would collapse them into a single generic "Injected" entry — and
 * importing it pulls in the whole `wagmi/connectors` barrel, which drags Coinbase's CDP SDK and
 * its broken transitive dependencies into the bundle and fails the build outright.
 *
 * WalletConnect and the hosted connectors are deliberately absent: they need a project id and a
 * relay, both external services with their own outages. `@wagmi/connectors` is already on disk as
 * one of wagmi's own dependencies, so the missing piece is not a package — it is the id. There is
 * no `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` in any environment this repository knows about, and a
 * `walletConnect()` connector built without one does not degrade: it throws on the relay handshake,
 * which in the dialog reads as a wallet that is listed and cannot connect. Register one at
 * cloud.reown.com, set the variable, and wire it here — that order, and not before.
 */
/**
 * Two layers of batching, because they catch different things. `batch.multicall` folds contract
 * reads that fire in the same 16 ms window into one Multicall3 `eth_call` (declared on the chain in
 * `config.ts`); the transport's `batch` folds whatever is left — balances, block numbers, reads on
 * chains without multicall — into one JSON-RPC batch request. Either alone leaves a class of calls
 * paying a full round trip each; on the market page that was three ~1.3 s requests where one does.
 */
/**
 * Two transports, in order: the proxy, then the chain's public endpoint.
 *
 * Every read the browser makes went through `rpc.doku.family` alone, so the proxy being down or
 * rate-limited took every balance, quote and simulation on the site down with it. `fallback`
 * moves to the public RPC when the proxy errors and moves back when it recovers; the public
 * endpoint is slower and shared, which is exactly the right place to be during an outage and
 * the wrong place to be by default.
 */
export const CHAIN_TRANSPORT = fallback(
  [http(RPC_URL, { batch: { wait: 16 } }), ...(RPC_URL === PUBLIC_RPC_URL ? [] : [http(PUBLIC_RPC_URL, { batch: { wait: 16 } })])],
  { rank: false }
);

export const wagmiConfig = createConfig({
  chains: [dokuChain],
  transports: { [dokuChain.id]: CHAIN_TRANSPORT },
  batch: { multicall: { wait: 16 } },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}

/**
 * Re-exported so existing callers keep working and new ones have one obvious place to import from.
 * The definitions live in `config.ts`; see the note there on why.
 */
export { CHAIN_ID, CONTRACTS, dokuChain, NATIVE_CURRENCY, poolKeyFor };
