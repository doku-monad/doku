import { describe, expect, it } from "vitest";
import {
  buildTokenMetadata,
  metadataKey,
  publishTokenMetadata,
  readMetadataStore,
  telegramUrl,
  twitterUrl,
} from "../src/metadata/token-metadata.js";

/**
 * The token metadata document: what `DokuToken.metadataURI()` resolves to.
 *
 * The document is what every third-party reader parses, so its shape is pinned here field by
 * field; the object key is pinned because it has to agree byte for byte with the string the
 * factory writes into the token (`DokuFactory.metadataURIFor`: lowercase hex, `0x`, `.json`).
 */

const TOKEN = "0x3B93906762727B050bD12983Ad8D909139C60E7A";

const moon = {
  tokenAddress: TOKEN,
  name: "MOON",
  ticker: "MOON",
  description: "to the moon",
  logoUri: "https://cdn.doku.family/464644ea6de170b882c2a0ecf475f772.webp",
  bannerUri: null,
  website: null,
  x: "@moonad",
  telegram: "https://t.me/moonad",
};

describe("the document", () => {
  it("carries the launchpad schema and the ERC-7572 names, and no website unless the creator set one", () => {
    expect(buildTokenMetadata(moon)).toEqual({
      name: "MOON",
      symbol: "MOON",
      description: "to the moon",
      image: "https://cdn.doku.family/464644ea6de170b882c2a0ecf475f772.webp",
      createdOn: "https://doku.family",
      launchpad: "DOKU",
      external_url: "https://doku.family/token/0x3b93906762727b050bd12983ad8d909139c60e7a",
      external_link: "https://doku.family/token/0x3b93906762727b050bd12983ad8d909139c60e7a",
      twitter: "https://x.com/moonad",
      telegram: "https://t.me/moonad",
    });
  });

  /** Absent, not empty string: a reader that sees `"twitter": ""` renders a broken link. */
  it("omits the optional links the creator did not set", () => {
    const doc = buildTokenMetadata({ ...moon, x: null, telegram: "  ", bannerUri: null });
    expect(doc).not.toHaveProperty("twitter");
    expect(doc).not.toHaveProperty("telegram");
    expect(doc).not.toHaveProperty("banner");
    expect(doc).not.toHaveProperty("discord");
  });

  it("keeps a creator's own website and banner when set", () => {
    const doc = buildTokenMetadata({ ...moon, website: "https://moon.example", bannerUri: "https://cdn.doku.family/b.webp" });
    expect(doc.website).toBe("https://moon.example");
    expect(doc.banner).toBe("https://cdn.doku.family/b.webp");
  });

  it("turns handles into links and passes links through", () => {
    expect(twitterUrl("@doku")).toBe("https://x.com/doku");
    expect(twitterUrl("doku")).toBe("https://x.com/doku");
    expect(twitterUrl("https://twitter.com/doku")).toBe("https://twitter.com/doku");
    expect(telegramUrl("dokuchat")).toBe("https://t.me/dokuchat");
    expect(telegramUrl(null)).toBeUndefined();
  });

  it("honours a different site for staging", () => {
    const doc = buildTokenMetadata(moon, "https://staging.doku.family/");
    expect(doc.createdOn).toBe("https://staging.doku.family");
    expect(doc.external_url).toBe("https://staging.doku.family/token/0x3b93906762727b050bd12983ad8d909139c60e7a");
  });
});

describe("the key and the store", () => {
  /** Byte for byte what `DokuFactory.metadataURIFor` appends to the base. */
  it("spells the key as the factory does: lowercase hex with 0x, .json", () => {
    expect(metadataKey(TOKEN)).toBe("metadata/0x3b93906762727b050bd12983ad8d909139c60e7a.json");
  });

  it("reads the same R2 variables the frontend's uploads use, and is off without them", () => {
    expect(readMetadataStore({})).toBeNull();
    expect(readMetadataStore({ R2_ACCOUNT_ID: "acc", R2_BUCKET: "b" })).toBeNull();
    expect(
      readMetadataStore({
        R2_ACCOUNT_ID: "acc",
        R2_BUCKET: "doku-uploads",
        R2_ACCESS_KEY_ID: "k",
        R2_SECRET_ACCESS_KEY: "s",
        R2_PUBLIC_BASE_URL: "https://cdn.doku.family/",
      }),
    ).toEqual({
      endpoint: "https://acc.r2.cloudflarestorage.com",
      bucket: "doku-uploads",
      accessKeyId: "k",
      secretAccessKey: "s",
      region: "auto",
      publicBaseUrl: "https://cdn.doku.family",
    });
  });
});

describe("publishing", () => {
  const store = {
    endpoint: "https://acc.r2.cloudflarestorage.com",
    bucket: "doku-uploads",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "auto",
    publicBaseUrl: "https://cdn.doku.family",
  };

  it("PUTs the document at the key, signed, as JSON with a short cache", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await publishTokenMetadata(store, moon, { fetchImpl, now: new Date("2026-09-13T00:00:00Z") });
    expect(r.key).toBe("metadata/0x3b93906762727b050bd12983ad8d909139c60e7a.json");
    expect(r.url).toBe("https://cdn.doku.family/metadata/0x3b93906762727b050bd12983ad8d909139c60e7a.json");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://acc.r2.cloudflarestorage.com/doku-uploads/metadata/0x3b93906762727b050bd12983ad8d909139c60e7a.json",
    );
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(headers["cache-control"]).toBe("public, max-age=300");
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20260913\/auto\/s3\/aws4_request, SignedHeaders=/);
    const body = JSON.parse(Buffer.from(calls[0]?.init.body as Uint8Array).toString("utf8")) as unknown;
    expect(body).toEqual(r.document);
  });

  it("throws on a refused PUT so the caller can count it", async () => {
    const fetchImpl = (async () => new Response("SignatureDoesNotMatch", { status: 403 })) as unknown as typeof fetch;
    await expect(publishTokenMetadata(store, moon, { fetchImpl })).rejects.toThrow(/403/);
  });
});
