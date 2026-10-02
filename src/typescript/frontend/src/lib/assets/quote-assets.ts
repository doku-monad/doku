import { assetMarkUrl } from "@/lib/assets/asset-marks";
import { faviconUrl } from "@/lib/utils/favicon";

/**
 * The quote-asset registry.
 *
 * DOKU is a launchpad for coins paired against *something* — a stablecoin, a major, a tokenized
 * equity, a real-world asset. This module is the list of those somethings, and it is the single
 * source for the pair chips on the board, the `/assets` page, and the pair selector in the launch
 * form.
 *
 * ## It used to be a constant, and the constant was wrong
 *
 * Twelve rows were written by hand here, with `address: null` on every one of them and every
 * status but MON's hard-coded `soon`. Against the registry the chain actually holds:
 *
 *   - gold was `xaux` / `XAUx` / 18 decimals; it is `xaut0` / `XAUt0` / **6**, and one token is one
 *     troy ounce — so an amount written at 18 decimals reads as a trillion ounces;
 *   - MON's address was `null`, meaning "not on the launchpad yet". It is `address(0)`, which is
 *     what a v4 `PoolKey` carries and what `DokuFactory.launch` must be sent;
 *   - cbBTC was missing altogether;
 *   - the stablecoin is USDT0, not USDT;
 *   - `status` was stored. It is **derived** on chain — `registered && enabled` is live, registered
 *     alone is listed, neither is soon — and a stored copy disagrees with the chain the first time
 *     a registration is missed.
 *
 * So the rows are gone rather than kept behind the fetch as a fallback. A fallback that disagrees
 * with the chain is exactly how gold ended up at 18 decimals: every consumer went on rendering a
 * plausible number that no contract would have accepted.
 *
 * ## Where it comes from now
 *
 * The indexer's `GET /quotes`, proxied by `src/app/api/quotes/route.ts` so the browser never needs
 * the indexer's origin. `useQuoteAssets()` in `lib/hooks/use-quote-assets` is the client read;
 * `getQuoteAssets()` in `lib/queries/doku` is the server one.
 *
 * This module carries no `"use client"` and no hook on purpose: `/assets` renders on the server,
 * and a client-boundary module's exports cannot be *called* from a server component — only passed
 * across it. Putting `useQuery` here would turn `quoteAssetsByKind` into a reference proxy that
 * throws the first time that page tried to group a row.
 */

/**
 * Native MON as a v4 `Currency`.
 *
 * Spelled out here rather than imported from `lib/chain/addresses`, which reads six `NEXT_PUBLIC_*`
 * variables at module load and throws without them — a registry helper must not require a
 * configured deployment to answer what the zero address is. This is the ERC-20 sentinel, not a
 * catalogue row: `address(0)` is what a `PoolKey` carries for the chain's own asset on every
 * network, and it is the same value `NATIVE_CURRENCY` holds.
 */
export const NATIVE_QUOTE_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export type QuoteAssetKind = "native" | "stablecoin" | "crypto" | "stock" | "rwa";

/**
 * How far along an asset is, as the chain answers it.
 *
 * Three states rather than a boolean, because "not tradable" collapses two situations a launcher
 * cares about telling apart: an asset the launchpad knows but has not enabled, and one it has
 * never been told about.
 *
 * ## This one DOES gate the form
 *
 * It used to be documentation — "every quote asset is selectable at launch", with the status shown
 * as a note. That was honest while nothing was on chain and no launch could revert. It is not now:
 * `DokuFactory.launch` reverts `QuoteNotEnabled()` for anything but `live`, and a form that lets a
 * launcher fill in a name, a ticker, two images and a dev buy against an asset the factory will
 * refuse is a form that wastes the whole session and then blames the wallet. `launchableQuoteAssets`
 * is the gate; `/assets` still renders all three states, because that page is the registry.
 */
export type QuoteAssetStatus = "live" | "listed" | "soon";

export interface QuoteAsset {
  /** URL-safe, stable. Used in `?pair=` and as the React key; never render it. */
  id: string;
  /** The ticker as displayed. Tokenized equities carry the `x` suffix by convention. */
  symbol: string;
  name: string;
  kind: QuoteAssetKind;
  status: QuoteAssetStatus;
  decimals: number;
  /**
   * The ERC-20 on Monad, or `null` where the asset is catalogued but not deployed.
   *
   * Native MON is `address(0)` and **not** null — that is what a `PoolKey` carries and what the
   * launch form sends. Null here means there is no token to name, not "native".
   */
  address: `0x${string}` | null;
  /** One line, sentence case, no trailing period. Shown under the name on `/assets`. */
  blurb: string;
  /** What a tokenized asset tracks. Absent for native and crypto quotes, which track themselves. */
  underlying?: string;
  /**
   * The issuer's domain, used to fetch its mark.
   *
   * A domain rather than an image URL, so a row needs no artwork to carry a mark; the marks this
   * app does ship live in `lib/assets/asset-marks` and are tried first. `assetIconUrl` is the
   * single place that decides how the mark is resolved.
   */
  iconDomain?: string;
  /** The curve's graduation target in this asset, raw units. Null where none is configured. */
  quoteTarget?: string | null;
  /**
   * Dollars per whole token. A JSON **number** and one of the four exceptions to the
   * everything-is-a-decimal-string rule: it is a price, not a token amount, and never approaches
   * the range where a float64 stops being exact. Null when nothing has priced the asset — which is
   * a data gap with a name, and never 0, which would mean "worth nothing".
   */
  usdPrice?: number | null;
  usdPriceAt?: string | null;
  /** How many markets are quoted in this asset. The board's chips render it. */
  marketCount?: number;
}

/** The wire shape, mirroring the indexer's `QuoteAssetWire` exactly. camelCase, as it arrives. */
export interface QuoteAssetWire {
  id: string;
  symbol: string;
  name: string;
  kind: QuoteAssetKind;
  status: QuoteAssetStatus;
  decimals: number;
  address: string | null;
  blurb: string;
  underlying: string | null;
  iconDomain: string | null;
  quoteTarget: string | null;
  usdPrice: number | null;
  usdPriceAt: string | null;
  marketCount: number;
}

/**
 * The name of a *group* of assets: filter chips, section headings, anything counting a set.
 *
 * Plural on purpose, and therefore wrong on a single asset — a card labelling USDC "Stablecoins"
 * is this map used one row at a time. `QUOTE_ASSET_KIND_NAMES` is the singular form for that.
 */
export const QUOTE_ASSET_KIND_LABELS: Record<QuoteAssetKind, string> = {
  native: "Native",
  stablecoin: "Stablecoins",
  crypto: "Crypto",
  stock: "Equities",
  rwa: "Real-world assets",
};

/** What one asset *is*, said beside its name. The singular of {@link QUOTE_ASSET_KIND_LABELS}. */
export const QUOTE_ASSET_KIND_NAMES: Record<QuoteAssetKind, string> = {
  native: "Native asset",
  stablecoin: "Stablecoin",
  crypto: "Crypto",
  stock: "Tokenized equity",
  rwa: "Real-world asset",
};

/** Order matters: this is the order the chips and the `/assets` sections render in. */
export const QUOTE_ASSET_KIND_ORDER: QuoteAssetKind[] = [
  "stablecoin",
  "native",
  "crypto",
  "stock",
  "rwa",
];

/**
 * One wire row as the app's own shape.
 *
 * The only translation is `null` to `undefined` on the two optional presentational columns: the
 * wire is explicit about absence and `faviconUrl` takes `string | undefined`. Nothing is defaulted
 * — an asset with no blurb gets an empty one, not an invented sentence.
 */
export const quoteAssetFromWire = (row: QuoteAssetWire): QuoteAsset => ({
  id: row.id,
  symbol: row.symbol,
  name: row.name,
  kind: row.kind,
  status: row.status,
  decimals: row.decimals,
  address: row.address ? (row.address.toLowerCase() as `0x${string}`) : null,
  blurb: row.blurb,
  underlying: row.underlying ?? undefined,
  iconDomain: row.iconDomain ?? undefined,
  quoteTarget: row.quoteTarget,
  usdPrice: row.usdPrice,
  usdPriceAt: row.usdPriceAt,
  marketCount: row.marketCount,
});

/**
 * Read the registry.
 *
 * Throws on anything but a 200 rather than returning an empty list. An empty registry renders as
 * "there is nothing to pair against", which is a product statement; a 502 from the indexer is an
 * outage, and the two must not look the same. Callers decide what to draw while it is failing.
 *
 * `fetchImpl` and `baseUrl` are injected so a test exercises this code rather than a mock of it,
 * and so a server component can point straight at the indexer instead of at its own proxy.
 */
export const fetchQuoteAssets = async (
  opts: { fetchImpl?: typeof fetch; baseUrl?: string } = {}
): Promise<QuoteAsset[]> => {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${(opts.baseUrl ?? "").replace(/\/+$/, "")}/api/quotes`;

  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`quotes: ${response.status}`);

  const body = (await response.json()) as { items: QuoteAssetWire[] };
  return body.items.map(quoteAssetFromWire);
};

/** Lookup by id. Returns `undefined` for an unknown id rather than falling back to MON. */
export const getQuoteAsset = (
  assets: readonly QuoteAsset[],
  id: string | null | undefined
): QuoteAsset | undefined => (id ? assets.find((a) => a.id === id) : undefined);

/** Lookup by the address the chain carries. Lowercased both sides; casing arrives four ways. */
export const getQuoteAssetByAddress = (
  assets: readonly QuoteAsset[],
  address: string | null | undefined
): QuoteAsset | undefined => {
  if (!address) return undefined;
  const key = address.toLowerCase();
  return assets.find((a) => a.address?.toLowerCase() === key);
};

/**
 * The chain's own asset.
 *
 * Found by `address(0)` rather than by the id `mon`, because the id is a presentational column an
 * admin can edit and the address is what the contracts agree on. Returns `undefined` if the
 * registry somehow has no native row — a caller renders nothing, rather than asserting MON.
 */
export const nativeQuoteAsset = (assets: readonly QuoteAsset[]): QuoteAsset | undefined =>
  getQuoteAssetByAddress(assets, NATIVE_QUOTE_ADDRESS);

/**
 * Whether a registry row IS the chain's own asset.
 *
 * The address decides. `null` does not qualify: it means catalogued but not deployed, which has no
 * contract behind it and is a different thing from native — a caller about to read a balance would
 * otherwise be handed the MON balance for an asset that does not exist.
 *
 * `isNativeQuote` in `lib/launch/submit` folds `null` into native deliberately, because a `PoolKey`
 * has to carry an address and `address(0)` is the one it carries. The two are not interchangeable
 * and this is the one to reach for outside the launch call itself.
 */
export const isNativeQuoteAsset = (
  asset: Pick<QuoteAsset, "address"> | null | undefined
): boolean => asset?.address?.toLowerCase() === NATIVE_QUOTE_ADDRESS;

export const quoteAssetsByKind = (assets: readonly QuoteAsset[], kind: QuoteAssetKind) =>
  assets.filter((a) => a.kind === kind);

/**
 * Assets a coin can actually be launched against.
 *
 * `live` only. This filter was removed once, on the reasoning that a picker showing one option and
 * eleven greyed-out ones is a screen of things you cannot have — which was right while `status`
 * was a curated guess and no launch could revert. Now `status` is `registered && enabled` read off
 * the quote registry, and `DokuFactory.launch` reverts `QuoteNotEnabled()` for everything else. The
 * choice is between a picker that is honest about what it offers and a form that accepts a whole
 * draft and fails in the wallet, and only one of those respects the launcher's time.
 */
export const launchableQuoteAssets = (assets: readonly QuoteAsset[]) =>
  assets.filter((a) => a.status === "live");

/**
 * Assets withheld from every surface where somebody PICKS a pair.
 *
 * A filter rather than a deletion, and that is forced rather than chosen. USDT0 and WBTC are
 * registered and enabled on chain, and the indexer re-inserts any on-chain asset it sees — so
 * removing their catalogue rows just brings them back without names. TBILLx has no address and
 * could go at the source, but one mechanism for all three is easier to reason about than two.
 *
 * `spyx` joins them for a different reason: it is being replaced by Pfizer in the registry, and
 * this set is the only lever the frontend has over that. Adding the Pfizer row and removing the
 * S&P one are **indexer changes** — the registry is served from `/quotes` and the indexer
 * re-inserts any on-chain asset it sees, so a frontend deletion would simply come back. Until that
 * lands, this hides the outgoing row everywhere somebody picks a pair; the local fixture in
 * `lib/dev/dummy-markets` already carries `PFEx` so the page can be designed against it.
 *
 * It is deliberately NOT applied to anything that reads an existing market. A coin already quoted
 * in one of these keeps its page, its swap widget and its feed: hiding an asset from the menu is a
 * product decision, and confiscating somebody's market is not. For the same reason this must never
 * reach `lib/prices/quote-prices.ts` (which is what keeps live WBTC markets priced in dollars) or
 * `lib/chain/zap-routes.ts` (where USDT0 is gold's only path onto the chain).
 */
export const HIDDEN_QUOTE_IDS: ReadonlySet<string> = new Set(["usdt", "wbtc", "tbillx", "spyx"]);

export const pickableQuoteAssets = (assets: readonly QuoteAsset[]) =>
  assets.filter((a) => !HIDDEN_QUOTE_IDS.has(a.id));

/**
 * Where an asset's mark comes from.
 *
 * One place, now two sources, in this order:
 *
 *   1. **The mark this app ships**, for the assets that have markets on the chain. It resolves
 *      from the id or the symbol, both of which are on a market row, and it is served from this
 *      origin — so it works on the surfaces that never had `iconDomain` in the first place, and it
 *      survives the content blockers that eat the favicon provider. See `lib/assets/asset-marks`.
 *   2. **The issuer's favicon**, for the catalogue rows this app ships no mark for — an index, a
 *      bill, an asset added to the catalogue before its mark was; a domain is still the right way
 *      to carry those.
 *
 * `size` reaches only the favicon — an SVG has no size to ask for — and is passed through rather
 * than fixed because the same asset is drawn at 18px in a chip and at 40px in a registry row.
 *
 * Returns `null` when neither answers. The caller draws a monogram, which is a real answer rather
 * than a broken image.
 */
export const assetIconUrl = (asset: QuoteAsset, size: 32 | 64 = 64): string | null =>
  assetMarkUrl(asset) ?? faviconUrl(asset.iconDomain, size);
