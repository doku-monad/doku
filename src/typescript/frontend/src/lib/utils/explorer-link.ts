import { dokuChain } from "@/lib/chain/addresses";

/**
 * A link into the block explorer.
 *
 * The base URL comes from the chain definition rather than an environment variable, so it cannot
 * disagree with the chain the app is actually talking to.
 *
 * Imported from `chain/addresses` rather than `chain/wagmi`, which re-exports the same value: the
 * wagmi barrel is ESM and drags a browser-shaped module graph in with it, so anything reaching
 * `dokuChain` through it cannot be loaded by a node test runner at all. Addresses are not a wagmi
 * concern.
 */
const linkTypes = {
  coin: "token",
  acc: "address",
  account: "address",
  transaction: "tx",
  version: "tx",
  txn: "tx",
} as const;

/**
 * The explorer to fall back to when the chain definition somehow carries none.
 *
 * It matters that this stays in step with `defineDokuChain`'s mainnet entry: a stale fallback is a
 * dead link that only appears in the one configuration nobody tests.
 */
const FALLBACK_EXPLORER = "https://monadscan.com";

/**
 * Path assembly, separated from the module-level chain read purely so it can be tested.
 *
 * The three segments are Etherscan's and Blockscout's convention and are what MonadVision serves;
 * see the note in `chain/config.ts` for how that was verified through the redirect from the old
 * host.
 */
export const explorerLink = (
  base: string,
  linkType: keyof typeof linkTypes,
  value: string | number | bigint
) => `${base}/${linkTypes[linkType] ?? "tx"}/${value}`;

export const toExplorerLink = ({
  value,
  linkType,
}: {
  value: string | number | bigint;
  linkType: keyof typeof linkTypes;
}) => explorerLink(dokuChain.blockExplorers?.default.url ?? FALLBACK_EXPLORER, linkType, value);
