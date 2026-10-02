/**
 * The marks this app serves itself, one file per quote asset, under `public/marks`.
 *
 * ## Why files, when `iconDomain` was meant to make them unnecessary
 *
 * The favicon route (`lib/utils/favicon`) needs a domain, and the rows the board card, the
 * masthead and the swap widget hold carry none — so on those surfaces it answered `null` every
 * time and the chip fell through to its monogram. It is also a third-party request at render
 * time, to a host most content blockers drop. A file served from this origin resolves from the
 * row the UI already has and cannot be blocked, rate-limited or redirected away.
 *
 * ## What is in the folder
 *
 * Official marks, as their owners publish them, sorted by kind:
 *
 *   - `crypto/`   — the chain's native asset and the tokens paired against. `mon.svg` is Monad's
 *                   logomark from https://monad.xyz/brand-and-media-kit, unrecoloured. `usdt0.svg`
 *                   is a drawn glyph (a tether T) kept until the issuer's own mark is added.
 *                   `btc.webp` is Bitcoin's orange mark, and it is the one file both wrapped
 *                   bitcoins wear — see the note on `BY_KEY`.
 *   - `equities/` — the tokenized stocks, keyed by the tokenized symbol (`aaplx`, not `aapl`).
 *
 * A mark drawn on a transparent ground (Apple's, AMD's, Ethereum's) is set on a light disc so it
 * reads on the dark theme; the rest come on their own discs. Everything is an SVG except the four
 * raster marks the brand kits only publish as bitmaps, which are 500 px WebP.
 *
 * ## Both keys, because either one can be the one that arrived
 *
 * A quote resolves with `id` from the catalogue (`usdt` for a token whose symbol is `USDT0`) or,
 * for an asset the catalogue has never been told about, with its lowercased address. The symbol
 * comes off the market row itself and is the more reliable of the two. Looking under both means a
 * mark appears whichever field the row carried.
 */

/** Every mark on disk, keyed by the name of its file. Public so a test can assert each exists. */
export const ASSET_MARK_FILES = {
  // Chain and crypto quotes.
  mon: "/marks/crypto/mon.svg",
  usdc: "/marks/crypto/usdc.webp",
  usdt0: "/marks/crypto/usdt0.svg",
  weth: "/marks/crypto/weth.svg",
  btc: "/marks/crypto/btc.webp",
  xaut0: "/marks/crypto/xaut0.webp",
  hype: "/marks/crypto/hype.svg",
  zec: "/marks/crypto/zec.webp",
  // Tokenized equities. SPYx and TBILLx have no mark: an index and a bill are not companies.
  aaplx: "/marks/equities/aaplx.svg",
  nvdax: "/marks/equities/nvdax.svg",
  tslax: "/marks/equities/tslax.svg",
  googlx: "/marks/equities/googlx.svg",
  metax: "/marks/equities/metax.svg",
  msftx: "/marks/equities/msftx.svg",
  amdx: "/marks/equities/amdx.svg",
  orclx: "/marks/equities/orclx.svg",
  adbex: "/marks/equities/adbex.svg",
  mstrx: "/marks/equities/mstrx.svg",
  pfex: "/marks/equities/pfex.svg",
} as const;

/**
 * Which lookup keys reach which file.
 *
 * The catalogue id and the token symbol disagree for two of the crypto quotes — `usdt`/`USDT0` and
 * `xaut`/`XAUt0` — so both spellings are listed rather than one being normalised into the other,
 * and each equity answers to its bare ticker as well as its tokenized symbol. A map rather than an
 * object literal because a lookup must be able to MISS: an index into a `Record<string, string>`
 * is typed `string` and would hide an unknown asset behind a URL that 404s, which is the
 * broken-image glyph this whole module exists to avoid.
 *
 * WBTC and cbBTC share one file. The picker names cbBTC `BTC` (see `display-symbol`), and it wore a
 * hand-drawn blue B while the real Bitcoin mark sat under `wbtc` — an asset the launch form hides.
 * Both are bitcoin, wrapped by different custodians, and the mark a launcher recognises is the
 * orange one; a second file drawing the same coin would only be a second place to get it wrong.
 */
const BY_KEY = new Map<string, string>([
  ...Object.entries(ASSET_MARK_FILES),
  ["usdt", ASSET_MARK_FILES.usdt0],
  ["xaut", ASSET_MARK_FILES.xaut0],
  ["wbtc", ASSET_MARK_FILES.btc],
  ["cbbtc", ASSET_MARK_FILES.btc],
  ...(
    ["aapl", "nvda", "tsla", "googl", "meta", "msft", "amd", "orcl", "adbe", "mstr", "pfe"] as const
  ).map((ticker) => [ticker, ASSET_MARK_FILES[`${ticker}x`]] as [string, string]),
]);

/**
 * Case and punctuation are not identity: the same asset arrives as `cbBTC` from the chain, `cbbtc`
 * from the catalogue and `CBBTC` from anything that upper-cased a ticker for display.
 */
const normalise = (value: string | null | undefined) =>
  value ? value.toLowerCase().replace(/[^a-z0-9]/g, "") : "";

/**
 * The mark this app ships for an asset, or `null` when it ships none.
 *
 * Null is a real answer and the caller must have one for it — `assetIconUrl` tries the issuer's
 * favicon next, and `AssetIcon` draws the monogram after that.
 */
export const assetMarkUrl = (asset: {
  id?: string | null;
  symbol?: string | null;
}): string | null => BY_KEY.get(normalise(asset.id)) ?? BY_KEY.get(normalise(asset.symbol)) ?? null;

export default assetMarkUrl;
