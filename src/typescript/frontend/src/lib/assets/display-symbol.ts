import type { QuoteAsset } from "./quote-assets";

/**
 * What an asset is CALLED on screen, which is not always what its symbol says.
 *
 * Three rules, and all three are display-only. Nothing in this app routes, persists or looks up on
 * `symbol`: `?pair=` carries the id (`lib/routes/home-page-params.ts`), the launch draft persists
 * `quoteId` in `LaunchBench` state, and every lookup goes by id or address
 * (`getQuoteAsset`, `getQuoteAssetByAddress`). So renaming here cannot break a link, a saved draft
 * or a contract call — which is exactly why it is done here and not in the registry.
 *
 * **One place it must NOT be applied: `components/pages/wallet/quote-groups.ts`.** That keys the
 * wallet's per-asset totals on the symbol STRING. Alias before grouping and two assets that share
 * a display name would be summed into one wrong number. Alias at render, always.
 *
 * ## The aliases
 *
 * `XAUt0 → GOLD` and `cbBTC → BTC`. Keyed by **id**, never by symbol, so a registry edit to either
 * ticker cannot silently detach the alias. The hero rail already types "gold" for this asset
 * (`pair-cycle.ts`), so this makes the rest of the product agree with the fold.
 *
 * ## The equity suffix
 *
 * A tokenized equity's ticker carries a lower-case `x`, and it is load-bearing: `TSLAx` is a
 * derivative that tracks Tesla, not Tesla stock. `UpcomingAssetTile` makes that argument and it is
 * right, so the `x` is kept — but split out, so a caller can set the base at full strength and the
 * suffix a step down. It reads as TSLA at a glance and stays literally true on inspection, which
 * is what stripping it would have cost.
 */

const ALIAS_BY_ID: Readonly<Record<string, string>> = {
  xaut0: "GOLD",
  cbbtc: "BTC",
};

export type DisplaySymbol = {
  /** The part to set at full strength. */
  base: string;
  /** The tokenized-equity marker, if this asset has one. Set it a step down from `base`. */
  suffix: string | null;
};

export const displaySymbol = (asset: Pick<QuoteAsset, "id" | "symbol" | "kind">): DisplaySymbol => {
  const alias = ALIAS_BY_ID[asset.id.toLowerCase()];
  if (alias) return { base: alias, suffix: null };

  if (asset.kind === "stock" && /x$/.test(asset.symbol)) {
    return { base: asset.symbol.slice(0, -1), suffix: asset.symbol.slice(-1) };
  }

  return { base: asset.symbol, suffix: null };
};

/** The same answer as one string, for `title`, `aria-label` and anywhere markup is not available. */
export const displaySymbolText = (asset: Pick<QuoteAsset, "id" | "symbol" | "kind">): string => {
  const { base, suffix } = displaySymbol(asset);
  return suffix ? `${base}${suffix}` : base;
};
