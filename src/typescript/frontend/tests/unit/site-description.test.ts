/** @jest-environment node */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getDefaultMetadata } from "../../src/configs/meta";

/**
 * The one sentence the site says about itself, and the three tags it has to reach.
 *
 * `description`, `openGraph.description` and `twitter.description` are three separate fields fed
 * from one constant, and nothing downstream compares them. Update one and miss the others and the
 * page description, the Discord/Slack unfurl and the Twitter card each say something different,
 * with no build error and no visible defect on the site itself — only on other people's surfaces.
 */
describe("site description", () => {
  /** Verbatim, from the owner. The dash is a plain hyphen, exactly as they wrote it. */
  const OWNER_LINE =
    "Launch your own coin on Monad in minutes - Paired with crypto, stablecoins, stocks, or RWAs. " +
    "No complexity. Just create, pair, and launch.";

  const meta = getDefaultMetadata();

  it("says the owner's line, word for word, as the page description", () => {
    expect(meta.description).toBe(OWNER_LINE);
  });

  it("says the same thing to link unfurlers as it does to search engines", () => {
    expect(meta.openGraph?.description).toBe(OWNER_LINE);
    expect(meta.twitter).toMatchObject({ description: OWNER_LINE });
  });

  /**
   * The dash stays a plain hyphen.
   *
   * An editor's "smart dashes" setting, or a paste through a word processor, silently promotes `-`
   * to an en or em dash. That is a change to copy the owner wrote by hand, and it is invisible in
   * review because the two characters look almost identical at body size. Pinned in both
   * directions: the hyphen is present, and no typographic dash has crept in beside it.
   */
  it("keeps the owner's plain hyphen rather than a typographic dash", () => {
    expect(meta.description).toContain(" - ");
    expect(meta.description).not.toMatch(/[—–]/);
  });

  it("carries no HTML entity that would be double-escaped into the tag", () => {
    expect(meta.description).not.toMatch(/&[a-z]+;|&#\d+;/i);
  });

  /**
   * Google truncates a description at roughly 155-160 characters. The owner's line is 138, so it
   * survives whole; this pins that, because the failure mode of a description that grows past the
   * budget is a snippet cut off mid-clause, which nothing reports.
   */
  it("fits in a search snippet without being truncated", () => {
    expect(meta.description!.length).toBeLessThanOrEqual(160);
  });

  /**
   * The line this replaced opened with a rocket emoji. An emoji is a surrogate pair that spends
   * two of those 160 characters to say nothing a crawler can index.
   */
  it("spends none of that budget on emoji", () => {
    expect(meta.description).toMatch(/^[\x20-\x7E]+$/);
  });

  /**
   * `/` redirects to `/explore`, so that route is the card a pasted link unfurls to and the page a
   * crawler indexes for the bare domain. `/launch` is the page the sentence is *about*. Both had
   * their own copy once, and the launch form's still ended in a party popper months after this
   * constant existed, so the drift this guards against is the drift that already happened.
   *
   * Read as text rather than imported: both modules pull in the server's data layer on the way in,
   * which a unit test has no business starting. What matters is that neither file writes the words
   * out again, and that is a question about the source.
   */
  it.each(["src/app/explore/page.tsx", "src/app/launch/page.tsx"])(
    "%s quotes the constant rather than repeating the sentence",
    (file) => {
      const src = readFileSync(join(__dirname, "../..", file), "utf8");
      expect(src).toMatch(/description:\s*SITE_DESCRIPTION/);
      expect(src).not.toContain("Launch your own coin on Monad");
    }
  );
});
