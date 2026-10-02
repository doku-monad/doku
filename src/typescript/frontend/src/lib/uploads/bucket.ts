import { signRequest } from "./sigv4";

/**
 * The object store a launcher's artwork lives in.
 *
 * It replaces pinning to IPFS through Pinata, which needed a third-party account this deployment
 * does not have — so the upload route answered "Image upload is not configured on this deployment"
 * and every coin launched without a picture.
 *
 * Two stores are supported and BOTH speak S3, which is why one signer serves them:
 *
 *   **Cloudflare R2**, preferred. Objects can be published on a bucket domain, so a browser fetches
 *   an image from the nearest Cloudflare edge instead of from one container in one region — the
 *   image never touches this app after it is uploaded. That is the difference between a picture
 *   that appears with the card and one that appears after it.
 *
 *   **The platform's own bucket**, as a fallback. Correct, private, and served through
 *   `/api/img/<key>`, which costs a round trip to this app and back.
 *
 * Configuration, all-or-nothing within a store:
 *
 *   R2_ACCOUNT_ID            the Cloudflare account the bucket belongs to
 *   R2_BUCKET                the bucket name
 *   R2_ACCESS_KEY_ID         an R2 API token's access key
 *   R2_SECRET_ACCESS_KEY     its secret
 *   R2_PUBLIC_BASE_URL       optional; the r2.dev subdomain or a custom domain. Without it the
 *                            bucket stays private and images are proxied.
 *
 *   BUCKET_ENDPOINT / BUCKET_NAME / BUCKET_ACCESS_KEY_ID / BUCKET_SECRET_ACCESS_KEY / BUCKET_REGION
 */

export interface StoreConfig {
  /** Which provider, because they address objects differently and only this decides how. */
  kind: "r2" | "bucket";
  endpoint: string;
  name: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /**
   * Where the public may fetch an object, when the bucket publishes one.
   *
   * Never the credentialed endpoint. That host answers only to a signed request, so putting it on
   * chain would write a permanent link that nobody but this server can follow.
   */
  publicBaseUrl?: string;
}

/**
 * The store to use, or null when none is configured.
 *
 * All or nothing WITHIN a store, on purpose. A half-configured one would sign requests with a
 * missing secret and fail at the provider with an authentication error, which reads as a credential
 * that has been revoked rather than one that was never set.
 *
 * R2 wins when both are present. A deployment that has gone to the trouble of configuring a CDN
 * store did so to be served from it, and silently preferring the slower one would be a decision
 * nothing announces.
 */
export function readStoreConfig(
  env: Record<string, string | undefined> = process.env
): StoreConfig | null {
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const r2Bucket = env.R2_BUCKET?.trim();
  const r2Key = env.R2_ACCESS_KEY_ID?.trim();
  const r2Secret = env.R2_SECRET_ACCESS_KEY?.trim();
  if (accountId && r2Bucket && r2Key && r2Secret) {
    const publicBaseUrl = env.R2_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
    return {
      kind: "r2",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      name: r2Bucket,
      accessKeyId: r2Key,
      secretAccessKey: r2Secret,
      /* R2 accepts exactly one region in a signature's scope, whatever the bucket's location hint
         says. Reading it from the environment would let a plausible "us-east-1" produce a 403 that
         names nothing. */
      region: "auto",
      ...(publicBaseUrl ? { publicBaseUrl } : {}),
    };
  }

  const endpoint = env.BUCKET_ENDPOINT?.trim();
  const name = env.BUCKET_NAME?.trim();
  const accessKeyId = env.BUCKET_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.BUCKET_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !name || !accessKeyId || !secretAccessKey) return null;
  return {
    kind: "bucket",
    endpoint: endpoint.replace(/\/+$/, ""),
    name,
    accessKeyId,
    secretAccessKey,
    region: env.BUCKET_REGION?.trim() || "auto",
  };
}

/**
 * Where one object lives, and the path the signature must cover.
 *
 * The two providers disagree, and this is the disagreement that costs an afternoon: the platform
 * bucket is addressed as a SUBDOMAIN (`bucket.endpoint/key`), while R2's account endpoint takes the
 * bucket as a PATH SEGMENT (`endpoint/bucket/key`) and does not serve the subdomain form at all.
 * The path returned here is the one that gets signed, so a mismatch signs one resource and requests
 * another — which answers 403 rather than 404, and reads as a bad credential rather than a bad URL.
 */
export function objectUrl(
  config: StoreConfig,
  key: string
): { url: string; host: string; path: string } {
  const { protocol, host: endpointHost } = new URL(config.endpoint);
  if (config.kind === "r2") {
    const path = `/${config.name}/${key}`;
    return { url: `${protocol}//${endpointHost}${path}`, host: endpointHost, path };
  }
  const host = `${config.name}.${endpointHost}`;
  return { url: `${protocol}//${host}/${key}`, host, path: `/${key}` };
}

/**
 * The URL a browser fetches and the chain records.
 *
 * A published bucket is answered directly, which is the entire point of preferring R2: the bytes
 * come from the nearest edge and never touch this app again. Without one the image is proxied
 * through `/api/img`, which is correct and slower.
 *
 * Both forms are absolute. `logoURI` is read by this site, by anything indexing the chain, and by
 * whatever renders a token list years from now, so a relative path would be a broken image
 * everywhere but here.
 */
export function publicImageUrl(config: StoreConfig, key: string, origin: string): string {
  if (config.publicBaseUrl) return `${config.publicBaseUrl}/${key}`;
  return `${origin.replace(/\/+$/, "")}/api/img/${key}`;
}

/** Stores one object. Throws with the provider's own message, which names the actual fault. */
export async function putObject(
  config: StoreConfig,
  key: string,
  body: Buffer,
  contentType: string
): Promise<void> {
  const { url, host, path } = objectUrl(config, key);
  const headers = signRequest({
    method: "PUT",
    path,
    host,
    body,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    extraHeaders: {
      "content-type": contentType,
      // Immutable by construction: the key is a hash of the bytes, so a given key's content can
      // never change and a cache may hold it forever.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });

  const response = await fetch(url, { method: "PUT", headers, body: new Uint8Array(body) });
  if (!response.ok) {
    throw new Error(
      `bucket PUT ${key}: ${response.status} ${(await response.text()).slice(0, 300)}`
    );
  }
}

/** Reads one object back, or null where there is no such key. */
export async function getObject(
  config: StoreConfig,
  key: string
): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  const { url, host, path } = objectUrl(config, key);
  const headers = signRequest({
    method: "GET",
    path,
    host,
    body: "",
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
  });

  const response = await fetch(url, { method: "GET", headers });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`bucket GET ${key}: ${response.status}`);
  }
  return {
    body: await response.arrayBuffer(),
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
  };
}

/**
 * The key an image is stored under: the first 32 hex characters of its SHA-256.
 *
 * Content-addressed, so re-uploading the same picture is free and cannot produce a second copy.
 * Truncated because the key travels ON CHAIN inside the market's `logoURI`, which the factory caps
 * at 128 bytes — a full 64-character digest plus the origin and path leaves too little margin for
 * a longer domain later. 128 bits is far past any collision that matters here.
 */
export const objectKey = (sha256: string): string => `${sha256.slice(0, 32)}.webp`;
