/**
 * @jest-environment node
 */
import { safeCoinWebsite, safeExternalUrl,safeImageUrl } from "../../src/lib/models/safe-url";

/*
 * These links are written by whoever launched the market. `DokuFactory` validates them for BYTE
 * LENGTH AND NOTHING ELSE, and they land in an `href` on the market masthead and the board card.
 * React 18 renders a `javascript:` href after merely warning about it, so this function is the only
 * thing between a market creator and script running for every visitor to their page.
 */
describe("what must never reach an href", () => {
  it.each([
    ["javascript:alert(1)"],
    ["JavaScript:alert(1)"],
    ["  javascript:alert(1)  "],
    ["data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="],
    ["vbscript:msgbox(1)"],
    ["file:///etc/passwd"],
    ["blob:https://doku.family/x"],
  ])("refuses %s", (hostile) => {
    expect(safeExternalUrl(hostile)).toBeNull();
  });

  it("refuses a scheme split by a control character, which some parsers forgive", () => {
    // The reason this is an ALLOWLIST. A blocklist has to anticipate every spelling; an allowlist
    // only has to know two strings.
    expect(safeExternalUrl("java\tscript:alert(1)")).toBeNull();
    expect(safeExternalUrl("java\nscript:alert(1)")).toBeNull();
  });

  it("refuses anything that is not a URL at all", () => {
    for (const v of ["", "   ", "not a url", "example.com", "//evil.test"]) {
      expect(safeExternalUrl(v)).toBeNull();
    }
  });

  it("refuses a non-string, because chain data arrives as `unknown` more often than not", () => {
    expect(safeExternalUrl(null)).toBeNull();
    expect(safeExternalUrl(undefined)).toBeNull();
    expect(safeExternalUrl(123 as unknown as string)).toBeNull();
  });
});

describe("what a creator may legitimately link to", () => {
  it("keeps ordinary links", () => {
    expect(safeExternalUrl("https://doku.family")).toBe("https://doku.family/");
    expect(safeExternalUrl("http://example.com/path?a=1#b")).toBe("http://example.com/path?a=1#b");
    expect(safeExternalUrl("https://x.com/ligerdotfun")).toBe("https://x.com/ligerdotfun");
  });

  it("trims, because a launch form leaves whitespace", () => {
    expect(safeExternalUrl("  https://doku.family/  ")).toBe("https://doku.family/");
  });

  it("returns the PARSED href, so what was checked is what will be followed", () => {
    // A string checked in one form and followed in another is the gap this closes.
    expect(safeExternalUrl("https://EXAMPLE.com")).toBe("https://example.com/");
  });

  it("is not simply refusing everything", () => {
    // The test that keeps the rest of this file honest.
    expect(safeExternalUrl("https://a.test")).not.toBeNull();
  });
});

describe("safeCoinWebsite", () => {
  it("passes a coin's own site through the same safety rules", () => {
    expect(safeCoinWebsite("https://moon.example")).toBe("https://moon.example/");
    expect(safeCoinWebsite("javascript:alert(1)")).toBeNull();
    expect(safeCoinWebsite("moon.example")).toBeNull();
  });

  it("refuses the launchpad's own domain, which is never a coin's website", () => {
    // The GEN8 canary launched with this value and its globe icon opened the homepage.
    expect(safeCoinWebsite("https://doku.family")).toBeNull();
    expect(safeCoinWebsite("https://doku.family/market/0xabc")).toBeNull();
    expect(safeCoinWebsite("https://cdn.doku.family/x.webp")).toBeNull();
    expect(safeCoinWebsite("https://DOKU.FAMILY")).toBeNull();
    expect(safeCoinWebsite("https://notdoku.family")).toBe("https://notdoku.family/");
  });
});

describe("safeImageUrl", () => {
  it("draws only https images and refuses everything else a creator could write into setMetadata", () => {
    expect(safeImageUrl("https://cdn.doku.family/images/0xabc.png")).toBe("https://cdn.doku.family/images/0xabc.png");
    expect(safeImageUrl("ipfs://bafylogo")).toBe("ipfs://bafylogo");
    expect(safeImageUrl("http://tracker.example/pixel.gif")).toBeNull();
    expect(safeImageUrl("javascript:alert(1)")).toBeNull();
    expect(safeImageUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBeNull();
    expect(safeImageUrl("cdn.doku.family/x.png")).toBeNull();
    expect(safeImageUrl(null)).toBeNull();
  });
});
