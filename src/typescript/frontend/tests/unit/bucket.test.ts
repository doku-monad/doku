/**
 * @jest-environment node
 */
import {
  objectKey,
  objectUrl,
  publicImageUrl,
  readStoreConfig,
} from "../../src/lib/uploads/bucket";

const R2: Record<string, string | undefined> = {
  R2_ACCOUNT_ID: "abc123account",
  R2_BUCKET: "doku-images",
  R2_ACCESS_KEY_ID: "r2-id",
  R2_SECRET_ACCESS_KEY: "r2-secret",
};

const RAILWAY: Record<string, string | undefined> = {
  BUCKET_ENDPOINT: "https://t3.storageapi.dev",
  BUCKET_NAME: "doku-uploads-abc123",
  BUCKET_ACCESS_KEY_ID: "id",
  BUCKET_SECRET_ACCESS_KEY: "secret",
};

describe("choosing a store", () => {
  it("prefers R2, which serves from a CDN edge rather than through this app", () => {
    const config = readStoreConfig({ ...RAILWAY, ...R2 })!;
    expect(config.kind).toBe("r2");
    expect(config.endpoint).toBe("https://abc123account.r2.cloudflarestorage.com");
    expect(config.name).toBe("doku-images");
  });

  it("falls back to the platform bucket when R2 is not configured", () => {
    expect(readStoreConfig(RAILWAY)?.kind).toBe("bucket");
  });

  it("is absent when neither is configured", () => {
    expect(readStoreConfig({})).toBeNull();
  });

  it("needs every part of a store, never some of it", () => {
    for (const missing of Object.keys(R2)) {
      // A half-configured store signs with a missing secret and fails at the provider with an
      // authentication error, which reads as a revoked credential rather than an unset one.
      expect(readStoreConfig({ ...R2, [missing]: "" })).toBeNull();
    }
    for (const missing of Object.keys(RAILWAY)) {
      expect(readStoreConfig({ ...RAILWAY, [missing]: "" })).toBeNull();
    }
  });

  it("pins R2's region to auto, which is the only value R2 accepts", () => {
    // Region is part of the signature's scope, so a wrong one is a 403 that says nothing useful.
    expect(readStoreConfig({ ...R2, R2_REGION: "us-east-1" })?.region).toBe("auto");
  });
});

describe("addressing, which the signature has to agree with", () => {
  it("uses PATH style for R2, where the bucket is a path segment", () => {
    // Virtual-host style is not enabled on an R2 account endpoint. Getting this wrong signs one
    // resource and requests another, which answers 403 rather than 404 and looks like a bad key.
    const config = readStoreConfig(R2)!;
    expect(objectUrl(config, "abc.webp")).toEqual({
      url: "https://abc123account.r2.cloudflarestorage.com/doku-images/abc.webp",
      host: "abc123account.r2.cloudflarestorage.com",
      path: "/doku-images/abc.webp",
    });
  });

  it("uses SUBDOMAIN style for the platform bucket, which is what that provider serves", () => {
    const config = readStoreConfig(RAILWAY)!;
    expect(objectUrl(config, "abc.webp")).toEqual({
      url: "https://doku-uploads-abc123.t3.storageapi.dev/abc.webp",
      host: "doku-uploads-abc123.t3.storageapi.dev",
      path: "/abc.webp",
    });
  });
});

describe("the URL a browser fetches, and the chain records", () => {
  const ORIGIN = "https://web-production-0d5f2.up.railway.app";

  it("points straight at the public bucket when there is one", () => {
    // The whole reason to prefer R2: the image comes off Cloudflare's edge, not through a Next
    // route on one container in one region.
    const config = readStoreConfig({ ...R2, R2_PUBLIC_BASE_URL: "https://img.doku.family" })!;
    expect(publicImageUrl(config, "abc.webp", ORIGIN)).toBe("https://img.doku.family/abc.webp");
  });

  it("trims a trailing slash off that base, so the URL has no double slash", () => {
    const config = readStoreConfig({ ...R2, R2_PUBLIC_BASE_URL: "https://img.doku.family/" })!;
    expect(publicImageUrl(config, "abc.webp", ORIGIN)).toBe("https://img.doku.family/abc.webp");
  });

  it("proxies through this app when the store has no public URL", () => {
    // Correct but slower, and the fallback is what keeps a private bucket usable at all.
    expect(publicImageUrl(readStoreConfig(R2)!, "abc.webp", ORIGIN)).toBe(
      `${ORIGIN}/api/img/abc.webp`
    );
  });

  it("never returns the credentialed endpoint, which nobody but this server may call", () => {
    const url = publicImageUrl(readStoreConfig(R2)!, "abc.webp", ORIGIN);
    expect(url).not.toContain("r2.cloudflarestorage.com");
  });

  it("stays inside the 128-byte logoURI the factory enforces", () => {
    const digest = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    const config = readStoreConfig({ ...R2, R2_PUBLIC_BASE_URL: "https://img.doku.family" })!;
    expect(publicImageUrl(config, objectKey(digest), ORIGIN).length).toBeLessThan(128);
    expect(publicImageUrl(readStoreConfig(R2)!, objectKey(digest), ORIGIN).length).toBeLessThan(
      128
    );
  });
});

describe("the object key", () => {
  const digest = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

  it("is content-addressed, so the same picture twice is one object", () => {
    expect(objectKey(digest)).toBe("9f86d081884c7d659a2feaa0c55ad015.webp");
  });

  it("distinguishes two different images", () => {
    expect(objectKey(digest)).not.toBe(objectKey("0".repeat(64)));
  });
});
