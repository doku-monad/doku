/**
 * The card-preview fixture's coin metadata, and nothing else.
 *
 * ## What this file used to be
 *
 * An interface for off-chain coin metadata — the name, ticker, logo, links, fee routing and
 * creator tax a launcher chose — backed by `TOKEN_METADATA`, a map that was **empty in
 * production**. Every real market missed it, fell through to deriving a name from its emoji
 * sequence, and reported `feeRouting: null` and `creatorFeePct: 0` no matter what it had recorded
 * on chain.
 *
 * That was honest while the factory took indices, emojis, proofs and a name, and there was nowhere
 * to put an image. It is not now. `DokuFactory.launch` takes a `meta` struct with a name, a
 * ticker, two URIs, a description and three links; the curve carries a routing sink and a creator
 * tax in basis points; and the indexer serves all of it as columns on **every market row**. So
 * `identityFor` reads the row, and this file no longer stands between it and the answer.
 *
 * ## Why the fixture map survives, and why it is address-gated
 *
 * The card-preview route builds twelve markets at `0xdeaddead…` addresses and needs them to render
 * with chosen names and real tickers — otherwise it exercises the fallback path and nothing else,
 * which is not what a preview of the *card* is for.
 *
 * It is reached only for an address in that fixture's own namespace. Not behind
 * `DOKU_CARD_PREVIEW`: that is a server-side runtime read, the browser evaluates the same module
 * without it, and a metadata map that differs between the two is a hydration mismatch on every
 * card. An address test is a pure function of its argument, identical on both sides, and — unlike
 * "the keys happen to be unreachable", which was the previous argument — it is a boundary rather
 * than an observation about address space.
 */

import { PREVIEW_METADATA } from "@/lib/dev/dummy-markets";

/**
 * What a launcher supplies about a coin, off chain.
 *
 * Retained as the fixture's shape. A real market's copy of this arrives on its row —
 * `ticker`, `logo_uri`, `banner_uri`, `description`, `website`, `x`, `telegram`, `routing`,
 * `creator_tax_bps` — and `lib/models` maps it onto `MarketMetadata`.
 */
export interface TokenMetadata {
  /** The display name the launcher typed. Rendered as given. */
  name: string;
  /** Ticker without the leading `$`; the UI adds it. */
  ticker: string;
  /** Square logo. A remote URL or a path under `public/`. */
  logo?: string;
  /** The wide image at the top of a card, if the launcher supplied one. */
  banner?: string;
  description?: string;
  links?: {
    website?: string;
    x?: string;
    telegram?: string;
    /**
     * Collected by the form and NOT carried on chain — `LaunchParams.meta` has no field for it.
     * Kept in the shape so the fixture can exercise a four-link card, and dropped at the launch
     * boundary rather than silently: see task F5.
     */
    discord?: string;
  };
  /** Where the creator's share of the protocol fee is pointed. */
  feeRouting?: "creator" | "holders" | "buyback";
  /** The creator's own tax on every trade, as a percentage, on top of the protocol's 1%. */
  creatorFeePct?: number;
}

/**
 * The fixture's namespace: `0xdeaddead…` repeated to a full 20-byte address, then an index.
 *
 * Matched in full rather than by prefix. A real deployment could in principle produce an address
 * beginning `0xdead`; it cannot produce this one, and a prefix test would be the same
 * "unreachable in practice" argument this change exists to replace.
 */
const PREVIEW_ADDRESS = /^0xdeaddeaddeaddeaddeaddeaddeaddead[0-9a-f]{8}$/;

export const isPreviewMarketAddress = (marketAddress: string): boolean =>
  PREVIEW_ADDRESS.test(marketAddress.toLowerCase());

/**
 * The fixture's metadata for one preview market, or `undefined` for anything else.
 *
 * Keys are lowercased, because an address arrives from four places — the indexer, the URL, wagmi,
 * a paste — in three different casings, and a map that misses on checksum casing fails silently.
 */
export const metadataFor = (marketAddress: string): TokenMetadata | undefined =>
  isPreviewMarketAddress(marketAddress)
    ? PREVIEW_METADATA[marketAddress.toLowerCase()]
    : undefined;
