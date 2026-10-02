import { getDefaultMetadata } from "../../src/configs/meta";

/**
 * Where link previews say their images live.
 *
 * Getting this wrong does not look broken. Next resolves the relative image paths against
 * `metadataBase`, so a wrong base still emits a perfectly well-formed `<meta property="og:image">`
 * — pointing at a host the crawler cannot reach. The page is fine, the tags are fine, and the link
 * unfurls with no image, on every platform, with nothing anywhere reporting an error.
 *
 * It read only `VERCEL_*` while the app runs on Railway, so every branch fell through to the
 * localhost default and every share advertised `http://localhost:3000/social-preview.png`.
 */
describe("metadata base", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  const clear = () => {
    for (const key of [
      "NEXT_PUBLIC_SITE_URL",
      "RAILWAY_PUBLIC_DOMAIN",
      "VERCEL_PROJECT_PRODUCTION_URL",
      "VERCEL_BRANCH_URL",
      "VERCEL_URL",
    ]) {
      delete process.env[key];
    }
  };

  it("uses Railway's public domain when that is where it runs", () => {
    clear();
    process.env.RAILWAY_PUBLIC_DOMAIN = "doku.family";
    expect(getDefaultMetadata().metadataBase?.origin).toBe("https://doku.family");
  });

  /** A custom domain is the one thing the platform variable can be wrong about. */
  it("prefers an explicit site URL over the platform's guess", () => {
    clear();
    process.env.RAILWAY_PUBLIC_DOMAIN = "web-production-13f50.up.railway.app";
    process.env.NEXT_PUBLIC_SITE_URL = "https://doku.family";
    expect(getDefaultMetadata().metadataBase?.origin).toBe("https://doku.family");
  });

  it("still understands Vercel, which is where this came from", () => {
    clear();
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "doku.vercel.app";
    expect(getDefaultMetadata().metadataBase?.origin).toBe("https://doku.vercel.app");
  });

  /** Only when there is genuinely no deployment host — `next dev`, and nothing else. */
  it("falls back to localhost only when nothing says otherwise", () => {
    clear();
    expect(getDefaultMetadata().metadataBase?.hostname).toBe("localhost");
  });

  it("advertises the landscape card to link unfurlers", () => {
    clear();
    process.env.RAILWAY_PUBLIC_DOMAIN = "doku.family";
    const meta = getDefaultMetadata();
    expect(meta.openGraph?.images).toBe("/social-preview.png");
    /* `Metadata["twitter"]` is a union of card shapes and only some of them carry `card`, so the
       field cannot be read off the union directly. The assertion is the same one. */
    expect(meta.twitter).toMatchObject({ card: "summary_large_image" });
  });
});
