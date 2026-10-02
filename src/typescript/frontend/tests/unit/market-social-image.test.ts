/**
 * @jest-environment node
 */
import { SOCIAL_PREVIEW_IMAGE } from "../../src/configs/meta";
import { crawlableImage, marketPreviewMetadata } from "../../src/lib/social/market-preview";

/**
 * What a crawler is handed when somebody pastes a market link into Slack, X or Discord.
 *
 * A preview card is fetched ONCE, by a bot, from outside the app: no wallet, no JavaScript, no
 * second chance. So every rule here is about the ways an image that renders perfectly well inside
 * the product is useless to that bot.
 */
describe("a market's social preview image", () => {
  it("uses an https logo as it stands", () => {
    expect(crawlableImage("https://cdn.doku.family/bafylogo.webp")).toBe(
      "https://cdn.doku.family/bafylogo.webp"
    );
  });

  /**
   * `ipfs://` is not a scheme any crawler resolves. Markets launched before the CDN carry one, and
   * emitting it raw is a card with a broken image rather than a card with no image.
   */
  it("resolves an ipfs uri to a gateway a crawler can fetch", () => {
    expect(crawlableImage("ipfs://bafylogo", "https://cdn.doku.family")).toBe(
      "https://cdn.doku.family/bafylogo"
    );
    expect(crawlableImage("ipfs://bafylogo", "")).toBe("https://ipfs.io/ipfs/bafylogo");
  });

  /// No logo, an empty column, and whitespace are all the same thing: there is no artwork.
  it.each([[null], [undefined], [""], ["   "]])("has no image for %p", (uri) => {
    expect(crawlableImage(uri)).toBeNull();
  });

  /**
   * A crawler has no origin to resolve against and no way to render a data URL, so both are worse
   * than nothing — they replace the site card with a blank one.
   */
  it.each([["data:image/png;base64,iVBOR"], ["/logo.png"], ["javascript:alert(1)"]])(
    "refuses %s, which no crawler can fetch",
    (uri) => {
      expect(crawlableImage(uri)).toBeNull();
    }
  );

  it("puts the coin's own artwork on both cards", () => {
    const meta = marketPreviewMetadata({
      name: "Goldy",
      ticker: "GOLDY",
      logo: "https://cdn.doku.family/goldy.webp",
    });
    expect(meta.openGraph?.images).toEqual(["https://cdn.doku.family/goldy.webp"]);
    expect(meta.twitter?.images).toEqual(["https://cdn.doku.family/goldy.webp"]);
  });

  /**
   * The site card, explicitly, for a coin with no artwork.
   *
   * Next merges metadata SHALLOWLY: an `openGraph` object returned here replaces the layout's
   * whole `openGraph`, image included. So omitting the key does not inherit the site preview, it
   * deletes it — a shared link for an emoji market would have had no card at all.
   */
  it("falls back to the site preview rather than dropping the key", () => {
    const meta = marketPreviewMetadata({ name: "🐳", ticker: "WHALE", logo: null });
    expect(meta.openGraph?.images).toEqual([SOCIAL_PREVIEW_IMAGE]);
    expect(meta.twitter?.images).toEqual([SOCIAL_PREVIEW_IMAGE]);
  });

  it("titles the tab with the coin and prices the description in its ticker", () => {
    const meta = marketPreviewMetadata({ name: "Goldy", ticker: "GOLDY", logo: null });
    expect(meta.title).toBe("Goldy market");
    expect(meta.description).toBe("Trade $GOLDY on DOKU");
  });

  /// An address the indexer cannot answer for names no coin, and a hex string is not a ticker.
  it("says nothing about a ticker it does not have", () => {
    expect(marketPreviewMetadata({ name: "DOKU", ticker: null, logo: null }).description).toBe(
      "Trade coins paired with anything on DOKU"
    );
  });
});
