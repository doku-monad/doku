import type { Metadata } from "next";

/**
 * The full title, and the short name that suffixes every other page.
 *
 * They are two strings deliberately. The landing title says what this is to somebody meeting it in
 * a search result or a shared link, where "DOKU" alone names nothing. The template suffix stays
 * short because it is appended to a page's own title — "launch | Doku | A Launchpad on Monad"
 * pushes the part that identifies the page out of a browser tab.
 */
const SITE_NAME = "Doku";
const DEFAULT_TITLE = "Doku | A Launchpad on Monad";
/**
 * The one sentence the site says about itself, in the owner's words, verbatim.
 *
 * Kept as one constant because it feeds three separate tags — `description`,
 * `openGraph.description` and `twitter.description` — and nothing downstream compares them, so
 * three literals would drift into three different claims with no build error and no defect visible
 * anywhere on this site. `app/explore/page.tsx` carries the same sentence for the reason given
 * there.
 *
 * 138 characters, inside the ~155-160 a search snippet shows before it truncates, so it is used
 * whole rather than shortened. The dash is a plain hyphen, as written; no emoji, unlike the line
 * this replaced, which spent two characters on a rocket no crawler indexes.
 */
export const SITE_DESCRIPTION =
  "Launch your own coin on Monad in minutes - Paired with crypto, stablecoins, stocks, or RWAs. " +
  "No complexity. Just create, pair, and launch.";
/**
 * The site's own card, used wherever a page has no picture of its own.
 *
 * Exported because a market page falls back to it BY NAME: Next replaces a parent's `openGraph`
 * wholesale when a page returns one, so "inherit the site image" is not something a page can do by
 * omitting the key. See `lib/social/market-preview`.
 */
export const SOCIAL_PREVIEW_IMAGE = "/social-preview.png";
const OG_TYPE = "website";
/** The preview is a 1200x630 card, so it gets the large card rather than the 1:1 thumbnail. */
const TWITTER_CARD = "summary_large_image";
const TWITTER_IMAGES = SOCIAL_PREVIEW_IMAGE;

export const getDefaultMetadata = (): Metadata => {
  /**
   * @see https://nextjs.org/docs/app/api-reference/functions/generate-metadata#default-value
   */
  /**
   * `SITE_URL` first, because this does not only run on Vercel.
   *
   * The Vercel variables below are the platform's own and are unset everywhere else — on Railway,
   * which is where this has actually been deployed, none of them exists. Without an explicit
   * override the chain falls through to localhost, and every link preview the site has ever served
   * advertises `http://localhost:3000/social-preview.png`: the card renders, the image 404s for
   * everyone but the developer, and nothing errors. Set `SITE_URL` to the origin the site is served
   * from, with or without a scheme. `RAILWAY_PUBLIC_DOMAIN` is read too, because that is the
   * platform this actually runs on and it supplies the domain without being asked.
   */
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim() || process.env.SITE_URL?.trim();
  const railwayDefault = process.env.RAILWAY_PUBLIC_DOMAIN;
  const productionDefault = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const previewDefault = process.env.VERCEL_BRANCH_URL ?? process.env.VERCEL_URL;
  const localDefault = `http://localhost:${process.env.PORT || 3000}`;

  const withScheme = (host: string) => (/^https?:\/\//.test(host) ? host : `https://${host}`);

  let metadataBase: URL;
  if (explicit) {
    metadataBase = new URL(withScheme(explicit));
  } else if (railwayDefault || productionDefault || previewDefault) {
    metadataBase = new URL(withScheme((railwayDefault ?? productionDefault ?? previewDefault)!));
  } else {
    metadataBase = new URL(localDefault);
  }

  return {
    metadataBase,
    alternates: {
      canonical: "/",
    },
    title: {
      default: DEFAULT_TITLE,
      template: `%s | ${SITE_NAME}`,
    },
    description: SITE_DESCRIPTION,
    keywords:
      "doku, monad, launchpad, token launch, bonding curve, stablecoin, tokenized stocks, RWA",
    openGraph: {
      title: DEFAULT_TITLE,
      description: SITE_DESCRIPTION,
      images: SOCIAL_PREVIEW_IMAGE,
      type: OG_TYPE,
    },
    twitter: {
      card: TWITTER_CARD,
      title: DEFAULT_TITLE,
      description: SITE_DESCRIPTION,
      images: TWITTER_IMAGES,
    },
    manifest: "/manifest.json",
  };
};
