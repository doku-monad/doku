import { createHash, createHmac } from "node:crypto";

// Ported verbatim from frontend/src/lib/uploads/sigv4.ts (checked there against Amazon's published
// vectors). Two copies because the two packages share no source tree; keep them identical.

/**
 * AWS Signature Version 4, in the little of it that talking to one bucket needs.
 *
 * Written rather than installed. The AWS SDK is forty packages to sign two request shapes, and
 * this route runs inside a Next server bundle where every dependency is weight on a cold start.
 * What makes that safe is the test file beside it: the functions here are checked against Amazon's
 * own published vectors, so a mistake fails against the reference rather than against a reading of
 * the specification.
 *
 * A wrong signature is otherwise a bad thing to debug. The service answers `SignatureDoesNotMatch`
 * and says nothing about which of the canonical request's nine lines was wrong.
 */

const sha256Hex = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) =>
  createHmac("sha256", key).update(data).digest();

export const hashPayload = (body: Buffer | string) => sha256Hex(body);

/**
 * Percent-encoding for a URI PATH, which is not `encodeURIComponent`.
 *
 * The unreserved set is exactly `A-Za-z0-9-._~`; everything else is encoded, including `+`, which
 * `encodeURIComponent` leaves alone and which S3 would read as a space. Slashes are preserved by
 * the caller splitting on them, because a path's separators are structure rather than content.
 */
const encodeSegment = (segment: string): string =>
  segment.replace(/[^A-Za-z0-9\-._~]/g, (c) =>
    Array.from(Buffer.from(c, "utf8"))
      .map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`)
      .join("")
  );

export const encodePath = (path: string): string =>
  path.split("/").map(encodeSegment).join("/") || "/";

/**
 * The derived signing key: HMAC applied four times, narrowing from the secret to one service on
 * one day in one region.
 *
 * The narrowing is the point — a signature captured from one request cannot be replayed against a
 * different service or a later date — and it is why the key is derived per request rather than
 * cached.
 */
export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

export interface CanonicalInput {
  method: string;
  /** Already absolute, beginning with a slash. Encoded here, so pass it raw. */
  path: string;
  /** The query string, already sorted and encoded, or empty. */
  query: string;
  headers: Record<string, string>;
  payloadHash: string;
}

/**
 * The canonical request and the list of headers it signs.
 *
 * Header names are lowercased and sorted, and their values trimmed, because the signature is over
 * this exact text: a header the client sends in a different case, or with a stray space, produces
 * a different signature for the same request.
 */
export function canonicalRequest(input: CanonicalInput): {
  canonical: string;
  signedHeaders: string;
} {
  const entries = Object.entries(input.headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const signedHeaders = entries.map(([name]) => name).join(";");
  const canonical = [
    input.method.toUpperCase(),
    encodePath(input.path),
    input.query,
    ...entries.map(([name, value]) => `${name}:${value}`),
    "",
    signedHeaders,
    input.payloadHash,
  ].join("\n");

  return { canonical, signedHeaders };
}

export function stringToSign(input: { amzDate: string; scope: string; canonical: string }): string {
  return ["AWS4-HMAC-SHA256", input.amzDate, input.scope, sha256Hex(input.canonical)].join("\n");
}

/** `20150830T123600Z` and `20150830`, which the signature needs in both forms. */
export function amzDates(now: Date): { amzDate: string; date: string } {
  const amzDate = `${now.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
  return { amzDate, date: amzDate.slice(0, 8) };
}

/**
 * The `Authorization` header for one request.
 *
 * Returns the headers to send rather than performing the request, so the caller owns the fetch and
 * this stays a pure function the tests above can pin.
 */
export function signRequest(params: {
  method: string;
  path: string;
  query?: string;
  host: string;
  body: Buffer | string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
  now?: Date;
  extraHeaders?: Record<string, string>;
}): Record<string, string> {
  const service = params.service ?? "s3";
  const { amzDate, date } = amzDates(params.now ?? new Date());
  const payloadHash = hashPayload(params.body);

  const headers: Record<string, string> = {
    host: params.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(params.extraHeaders ?? {}),
  };

  const { canonical, signedHeaders } = canonicalRequest({
    method: params.method,
    path: params.path,
    query: params.query ?? "",
    headers,
    payloadHash,
  });

  const scope = `${date}/${params.region}/${service}/aws4_request`;
  const signature = createHmac(
    "sha256",
    signingKey(params.secretAccessKey, date, params.region, service)
  )
    .update(stringToSign({ amzDate, scope, canonical }))
    .digest("hex");

  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
