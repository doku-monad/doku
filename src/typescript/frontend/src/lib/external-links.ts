import { dokuChain } from "@/lib/chain/wagmi";

/**
 * Where a coin can be looked up outside DOKU.
 *
 * Every one of these is a URL pattern owned by somebody else, which is exactly why they are here
 * rather than assembled inside a card: a template that lives in a component is a template nobody
 * finds the day the third party changes it, and there are three of them on every one of forty
 * cards.
 *
 * ## The chain slug
 *
 * DexScreener and GMGN both key their token pages on a chain slug, and both use the chain's own
 * short name rather than its id. It is derived from the chain definition so it cannot drift from
 * the chain the app is actually talking to — the same reasoning as `toExplorerLink`.
 */
const CHAIN_SLUG = (dokuChain.name ?? "monad").toLowerCase().split(" ")[0];

export interface CoinExternalLinks {
  /** The pair's chart and liquidity, as the rest of the market sees it. */
  dexscreener: string;
  /** Wallet-level flow: who is holding, who is selling, and how early they were. */
  gmgn: string;
  /**
   * The coin's page on Fomo, the third venue in the group.
   *
   * The route is Fomo's own — `tokens/:chain/:tokenAddress` in its Remix manifest, with `monad`
   * as a registered chain slug — read from the live site on 2026-09-22. It used to point at this
   * coin's own `#holders` tab, which is not Fomo at all.
   */
  fomo: string;
}

export const coinExternalLinks = (tokenAddress: string): CoinExternalLinks => ({
  dexscreener: `https://dexscreener.com/${CHAIN_SLUG}/${tokenAddress}`,
  gmgn: `https://gmgn.ai/${CHAIN_SLUG}/token/${tokenAddress}`,
  fomo: `https://fomo.family/tokens/${CHAIN_SLUG}/${tokenAddress}`,
});
