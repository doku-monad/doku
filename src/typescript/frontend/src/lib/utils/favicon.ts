/**
 * A third party's own mark, fetched from its domain.
 *
 * ## Why a domain and not an image file
 *
 * Because this app shows other companies' logos in three places — the quote-asset registry, the
 * card's lookup links, and the assets page — and the alternative is a folder of other people's
 * trademarks committed to this repository, kept current by hand, one file per brand. A domain is
 * the one identifier that is already in the data (`iconDomain` on a quote asset, the host of a
 * link), never goes stale, and ships no artwork.
 *
 * ## Every caller must have a fallback
 *
 * This is a request to a third party at render time, so it can be slow, blocked by an extension,
 * cached as a 404, or simply wrong. Nothing that calls this may treat the image as guaranteed:
 * `AssetIcon` falls back to a monogram, the card's venue links fall back to their two-letter
 * label. There is never a broken-image glyph, and never an empty square where a mark should be.
 *
 * ## It is the SECOND choice for a quote asset
 *
 * `assetIconUrl` tries `lib/assets/asset-marks` first, which is a file this app serves itself. The
 * reasoning above holds for a mark nobody has shipped — a wallet's, a venue link's, an index's —
 * and stopped holding for the quote assets: the row those surfaces hold carries no `iconDomain`
 * at all, and content blockers eat this provider outright.
 *
 * ## One provider, one place
 *
 * The provider is an implementation detail and it is behind this function precisely so it is a
 * one-line change. It was inlined in `assetIconUrl`, which meant the card's links could not use it
 * without a second copy of the URL template.
 */
export const faviconUrl = (domain: string | undefined, size: 32 | 64 = 64): string | null =>
  domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=${size}` : null;

export default faviconUrl;
