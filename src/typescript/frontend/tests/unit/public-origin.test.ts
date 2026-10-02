/**
 * @jest-environment node
 */
import { publicOrigin } from "../../src/lib/uploads/public-origin";

const REQUEST = "https://internal.railway.internal/api/uploads/image";

describe("the origin a chain-written link uses", () => {
  it("prefers the deliberate override", () => {
    expect(publicOrigin(REQUEST, { SITE_URL: "https://doku.family" })).toBe("https://doku.family");
    expect(publicOrigin(REQUEST, { NEXT_PUBLIC_SITE_URL: "https://a.example" })).toBe(
      "https://a.example"
    );
  });

  it("accepts a bare domain, which is how the platform supplies one", () => {
    expect(publicOrigin(REQUEST, { RAILWAY_PUBLIC_DOMAIN: "web.up.railway.app" })).toBe(
      "https://web.up.railway.app"
    );
  });

  it("falls back to the request only when nothing was configured", () => {
    // The internal host is exactly what must not end up on chain, so this is last, not first.
    expect(publicOrigin(REQUEST, {})).toBe("https://internal.railway.internal");
  });

  it("ignores a malformed override rather than failing the upload", () => {
    expect(publicOrigin(REQUEST, { SITE_URL: "not a url" })).toBe(
      "https://internal.railway.internal"
    );
  });

  it("drops a path and a trailing slash, because an origin is not a URL", () => {
    expect(publicOrigin(REQUEST, { SITE_URL: "https://doku.family/board/" })).toBe(
      "https://doku.family"
    );
  });

  it("is null when there is nothing usable at all", () => {
    expect(publicOrigin("::not a url::", {})).toBeNull();
  });
});
