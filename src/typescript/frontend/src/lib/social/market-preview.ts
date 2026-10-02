import { SOCIAL_PREVIEW_IMAGE } from "configs/meta";
import type { Metadata } from "next";

import { CDN_URL } from "@/lib/env";

/**
 * What a market link looks like when somebody pastes it somewhere else.
 *
 * Every card the product has ever served for a market has been the same one: the site's own
 * `/social-preview.png`, under a title made out of the URL. A launchpad's most-shared link is a
 * market, and it was sharing a picture of the launchpad.
 *
 * ## Why this is a module and not four lines in `generateMetadata`
 *
 * Because the two rules below are the kind that are quietly wrong for months. Neither is visible
 * from inside the app — the only way to see either is to paste a link into Slack and look at it —
 * so both are asserted in `tests/unit/market-social-image.test.ts` instead.
 */

/**
 * An image URL a CRAWLER can fetch, or null.
 *
 * Three cases, and the first is the one that motivates the function:
 *
 *   1. **`ipfs://`** — the URI every market launched before the CDN carries. No crawler resolves
 *      the scheme, so emitting it raw is strictly worse than emitting nothing: the card renders
 *      with a broken image where the site preview would have been. It is pointed at the configured
 *      CDN, or at a public gateway where a deployment has none.
 *   2. **`http(s)`** — already fetchable, passed through.
 *   3. **Anything else** — `data:` URLs, relative paths, and whatever else a launcher typed into
 *      the field. A bot has no origin to resolve a path against and cannot render a data URL, so
 *      all of them are `null` and the caller falls back to the site card.
 *
 * @param cdn injected so a test can exercise both the configured and unconfigured deployment
 *        rather than whichever one the environment happens to be in
 */
export const crawlableImage = (
  uri: string | null | undefined,
  cdn: string = CDN_URL
): string | null => {
  const trimmed = uri?.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("ipfs://")) {
    const base = (cdn || "https://ipfs.io/ipfs").replace(/\/+$/, "");
    return `${base}/${trimmed.slice("ipfs://".length)}`;
  }

  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
};

/** What the card needs to know about the coin. Resolved by `identityFor` at the call site. */
export interface MarketPreview {
  name: string;
  /**
   * The ticker, or `null` where nothing names the coin.
   *
   * Null happens for exactly one URL shape: an address the indexer cannot answer for. A hex string
   * is not a ticker, and "Trade $0x1f3a… on DOKU" is worse than saying nothing about it.
   */
  ticker: string | null;
  /** The launcher's `logoUri`, exactly as the row carries it. May be an `ipfs://` URI. */
  logo: string | null;
}

/**
 * The metadata for one market's page.
 *
 * ## `images` is always set, and that is not belt-and-braces
 *
 * Next merges metadata SHALLOWLY: an `openGraph` object returned from a page REPLACES the layout's
 * entire `openGraph`, images included. The page used to return `openGraph: { title, description }`
 * and therefore served a market card with no image at all — not the site preview it looks like it
 * would fall back to. So the fallback is written out rather than left to an inheritance that does
 * not happen.
 */
export const marketPreviewMetadata = ({ name, ticker, logo }: MarketPreview): Metadata => {
  const title = `${name} market`;
  const description = ticker
    ? `Trade $${ticker} on DOKU`
    : "Trade coins paired with anything on DOKU";
  /* The RESOLVED image decides both the card's picture and its shape: a logo the crawler cannot
     fetch falls back to the site banner, and a banner in a square card is two grey bars. */
  const resolved = crawlableImage(logo);
  const images = [resolved ?? SOCIAL_PREVIEW_IMAGE];

  return {
    title,
    description,
    openGraph: { title, description, images, type: "website" },
    // A coin logo is square, so it is a 1:1 thumbnail beside the text rather than a 1200x630
    // banner. `summary_large_image` on a square image is a card with two grey bars either side.
    twitter: { card: resolved ? "summary" : "summary_large_image", title, description, images },
  };
};
