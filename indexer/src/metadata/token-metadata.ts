import { signRequest } from "./sigv4.js";

/**
 * The token metadata document, and where it is published.
 *
 * ## Why a document at all
 *
 * A DOKU token's picture, description and links used to exist only inside DOKU's own indexer and
 * CDN, so a wallet, an explorer or a trading terminal that met the token on chain saw a bare
 * ERC-20 and drew a letter in a circle. Every launchpad whose tokens carry a logo on those surfaces
 * does one thing: the token exposes a URI, the URI resolves to a JSON document, the document names
 * the image. Generation 6's `DokuToken.metadataURI()` (and its ERC-7572 twin `contractURI()`)
 * returns `<base>/<token address>.json` on the DOKU CDN. This module is what puts the document
 * there and keeps it current.
 *
 * ## The shape
 *
 * The launchpad ecosystem's de-facto schema — the one pump.fun's metadata established and every
 * terminal parses — with ERC-7572's names alongside, so one document serves both readers:
 *
 *   name, symbol, description, image      what every reader wants
 *   createdOn, launchpad                    the launchpad attribution terminals badge
 *   external_url, external_link             the token's page on the launchpad
 *   website                                 the creator's own site, present only when set
 *   twitter, telegram, discord, github      present only when the creator set them; absent, not ""
 *   banner                                  DOKU's own extension, harmless to everyone else
 *
 * Images are the CDN URLs the creator's upload already produced (content-addressed WebP on
 * cdn.doku.family). Nothing here is on IPFS and nothing here needs to be: no reader of these
 * fields requires it, and the images are on HTTPS already.
 *
 * ## When it is written
 *
 * On every `MetadataSet` the ingester records — the launch's, and every later `setMetadata` by
 * the creator — because the document has to say what the chain says. The write is best-effort and
 * never fails ingestion: a bucket outage costs a stale document, which a re-publish repairs; a
 * failed ingest pass would cost the chain's truth. `scripts/publish-metadata.ts` republishes
 * every served market for a backfill or a repair.
 *
 * ## Storage
 *
 * The same R2 bucket the frontend uploads images to, under `metadata/<token>.json`, `token`
 * lowercase-hex with its `0x` — exactly how `DokuFactory.metadataURIFor` spells it, because the
 * object key and the on-chain string have to agree byte for byte. Cache-control is SHORT (five
 * minutes), unlike the immutable images: the document changes when the creator edits metadata.
 */

export interface TokenMetadataInput {
  tokenAddress: string;
  name: string;
  ticker: string;
  description: string | null;
  logoUri: string | null;
  bannerUri: string | null;
  website: string | null;
  x: string | null;
  telegram: string | null;
}

export interface TokenMetadata {
  name: string;
  symbol: string;
  description: string;
  image: string;
  createdOn: string;
  launchpad: "DOKU";
  website?: string;
  external_url: string;
  external_link: string;
  twitter?: string;
  telegram?: string;
  discord?: string;
  github?: string;
  banner?: string;
}

/** Where the site lives, and therefore what `external_url` and the launchpad attribution say. */
export const DEFAULT_SITE_URL = "https://doku.family";

const trimmed = (v: string | null | undefined): string | undefined => {
  const s = v?.trim();
  return s ? s : undefined;
};

/**
 * A creator's `x` field, as a URL.
 *
 * The launch form accepts a handle or a link; readers of this document expect a link. A bare
 * handle becomes `https://x.com/<handle>`; anything already a URL is passed through.
 */
export const twitterUrl = (v: string | null | undefined): string | undefined => {
  const s = trimmed(v);
  if (!s) return undefined;
  if (/^https?:\/\//i.test(s)) return s;
  return `https://x.com/${s.replace(/^@/, "")}`;
};

export const telegramUrl = (v: string | null | undefined): string | undefined => {
  const s = trimmed(v);
  if (!s) return undefined;
  if (/^https?:\/\//i.test(s)) return s;
  return `https://t.me/${s.replace(/^@/, "")}`;
};

/** The object key under the bucket, and the path under the CDN: `metadata/<token>.json`. */
export const metadataKey = (tokenAddress: string): string => `metadata/${tokenAddress.toLowerCase()}.json`;

/** The document for one market. Pure, so a test can pin it byte for byte. */
export function buildTokenMetadata(m: TokenMetadataInput, siteUrl = DEFAULT_SITE_URL): TokenMetadata {
  const site = siteUrl.replace(/\/+$/, "");
  const token = m.tokenAddress.toLowerCase();
  const doc: TokenMetadata = {
    name: m.name,
    symbol: m.ticker,
    description: trimmed(m.description) ?? "",
    image: trimmed(m.logoUri) ?? "",
    createdOn: site,
    launchpad: "DOKU",
    external_url: `${site}/token/${token}`,
    external_link: `${site}/token/${token}`,
  };
  // The creator's own site only. The launchpad is already named by `createdOn`; repeating it as
  // `website` sent readers to the launchpad's homepage from the coin's globe icon.
  const website = trimmed(m.website);
  if (website) doc.website = website;
  const twitter = twitterUrl(m.x);
  if (twitter) doc.twitter = twitter;
  const telegram = telegramUrl(m.telegram);
  if (telegram) doc.telegram = telegram;
  const banner = trimmed(m.bannerUri);
  if (banner) doc.banner = banner;
  return doc;
}

/** The R2 (or S3-compatible) bucket the documents go to. Same variables the frontend's uploads use. */
export interface MetadataStore {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** Where the bucket is served from — `https://cdn.doku.family` — for the log line only. */
  publicBaseUrl: string | undefined;
}

export function readMetadataStore(env: Record<string, string | undefined>): MetadataStore | null {
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const bucket = env.R2_BUCKET?.trim();
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: "auto",
    publicBaseUrl: env.R2_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") || undefined,
  };
}

/**
 * PUT one document. Throws on a non-2xx so the caller decides whether that is fatal (it is not,
 * inside ingestion). `fetchImpl` is injected so a test exercises the signing and the request
 * shape without a bucket.
 */
export async function publishTokenMetadata(
  store: MetadataStore,
  m: TokenMetadataInput,
  opts: { siteUrl?: string; fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<{ key: string; url: string | null; document: TokenMetadata }> {
  const document = buildTokenMetadata(m, opts.siteUrl);
  const key = metadataKey(m.tokenAddress);
  const body = Buffer.from(JSON.stringify(document, null, 2), "utf8");
  const { host } = new URL(store.endpoint);
  const path = `/${store.bucket}/${key}`;
  const headers = signRequest({
    method: "PUT",
    path,
    host,
    body,
    accessKeyId: store.accessKeyId,
    secretAccessKey: store.secretAccessKey,
    region: store.region,
    now: opts.now,
    extraHeaders: {
      "content-type": "application/json; charset=utf-8",
      // Short, on purpose: this document changes when the creator edits metadata.
      "cache-control": "public, max-age=300",
    },
  });
  const f = opts.fetchImpl ?? fetch;
  const response = await f(`${store.endpoint}${path}`, { method: "PUT", headers, body: new Uint8Array(body) });
  if (!response.ok) {
    throw new Error(`metadata PUT ${key}: ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  return { key, url: store.publicBaseUrl ? `${store.publicBaseUrl}/${key}` : null, document };
}
