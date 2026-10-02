/**
 * @jest-environment node
 */
import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";

import { ASSET_MARK_FILES, assetMarkUrl } from "../../src/lib/assets/asset-marks";
import { assetIconUrl, type QuoteAsset } from "../../src/lib/assets/quote-assets";

/**
 * A quote asset as `lib/token-identity` builds one from a MARKET ROW.
 *
 * This is the shape the board card, the masthead and the swap widget actually hold, and the whole
 * point of the fixture is what it omits: `iconDomain` is undefined on every one of them. The
 * registry supplies that column, `identityFor` is never handed the registry by any of its twenty
 * call sites, so the favicon URL those surfaces asked for was always `null` and the chip fell
 * through to its monogram — WET, WBT, USD.
 */
const fromRow = (over: Partial<QuoteAsset>): QuoteAsset => ({
  id: "usdc",
  symbol: "USDC",
  name: "USDC",
  kind: "crypto",
  status: "live",
  decimals: 6,
  address: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
  blurb: "",
  ...over,
});

/** The assets with a market on the chain, as `id` and `symbol` reach the UI, and the file each wears. */
const LIVE: Array<[string, string, keyof typeof ASSET_MARK_FILES]> = [
  ["mon", "MON", "mon"],
  ["usdc", "USDC", "usdc"],
  // The catalogue's id for this row is `usdt` while the token's symbol is `USDT0`. Both have to
  // resolve or gold's neighbour on the board loses its mark depending on which field arrived.
  ["usdt", "USDT0", "usdt0"],
  ["weth", "WETH", "weth"],
  // Two custodians, one coin: both wrapped bitcoins wear Bitcoin's own mark.
  ["wbtc", "WBTC", "btc"],
  ["cbbtc", "cbBTC", "btc"],
  ["xaut0", "XAUt0", "xaut0"],
];

describe("quote-asset marks", () => {
  it.each(LIVE)(
    "resolves a mark for %s from the row alone, with no iconDomain",
    (id, symbol, file) => {
      expect(assetIconUrl(fromRow({ id, symbol }))).toBe(ASSET_MARK_FILES[file]);
    }
  );

  /* cbBTC is the bitcoin the launch picker offers, under the name BTC. It wore a hand-drawn blue B
     while Bitcoin's real mark was reachable only through WBTC, which the picker hides. */
  it("draws cbBTC with the Bitcoin mark, by id or by symbol", () => {
    expect(assetMarkUrl({ id: "cbbtc" })).toBe("/marks/crypto/btc.webp");
    expect(assetMarkUrl({ symbol: "cbBTC" })).toBe("/marks/crypto/btc.webp");
  });

  /// Either field is enough. A row whose catalogue id never arrived still carries its symbol.
  it("resolves by symbol when the catalogue id is an unknown address", () => {
    expect(assetMarkUrl({ id: "0xee8c0e9f1bffb4eb878d8f15f368a02a35481242", symbol: "WETH" })).toBe(
      ASSET_MARK_FILES.weth
    );
  });

  /**
   * A mark that 404s is a broken-image glyph in a 17px chip, which is worse than the monogram it
   * replaced. Every path this module can return has to be a file that is actually deployed.
   */
  it.each(Object.entries(ASSET_MARK_FILES))("ships %s as a real file", (_key, url) => {
    expect(existsSync(join(__dirname, "../../public", url))).toBe(true);
  });

  /**
   * The issuer's favicon is still the answer for the catalogue rows this app draws no mark for —
   * the tokenized equities, whose logos are their companies'. It is second, not first, because it
   * is a third-party request at render time.
   */
  it("falls back to the issuer's favicon for an asset with no shipped mark", () => {
    const url = assetIconUrl(
      // SPYx: no shipped mark on purpose — its site's favicon is 226 bytes (see asset-marks.ts).
      fromRow({ id: "spyx", symbol: "SPYx", iconDomain: "spglobal.com" }),
      32
    );
    expect(url).toBe("https://www.google.com/s2/favicons?domain=spglobal.com&sz=32");
  });

  /// Neither a mark nor a domain is a monogram, not an empty square and not a broken image.
  it("returns null when there is nothing to draw", () => {
    expect(assetIconUrl(fromRow({ id: "0xdead", symbol: "???" }))).toBeNull();
  });
});

describe("every self-hosted mark file is reachable through assetMarkUrl", () => {
  /* The file table and the lookup table are two lists. On 2026-09-12 four marks were added to the
     first and not the second, and the hero kept fetching from google.com while the files sat
     unused in public/marks. A mark that exists but cannot be looked up is the silent version of
     that bug, so the two are held equal here. */
  it("resolves each key of ASSET_MARK_FILES by id", () => {
    for (const [key, file] of Object.entries(ASSET_MARK_FILES)) {
      expect(assetMarkUrl({ id: key })).toBe(file);
    }
  });

  /** An equity answers to its bare ticker too, for a catalogue id written without the x. */
  it("resolves an equity by its bare ticker and by its tokenized symbol", () => {
    expect(assetMarkUrl({ symbol: "METAx" })).toBe(ASSET_MARK_FILES.metax);
    expect(assetMarkUrl({ id: "meta" })).toBe(ASSET_MARK_FILES.metax);
  });

  /* The other direction: a file nobody can reach is dead weight shipped on every deploy, and the
     folder is sorted by kind on purpose, so a stray file at the top level is wrong twice. */
  it("ships no file under public/marks that the table does not name", () => {
    const root = join(__dirname, "../../public/marks");
    const walk = (dir: string, prefix: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory()
          ? walk(full, `${prefix}/${name}`)
          : [`${prefix}/${name}`];
      });
    const onDisk = walk(root, "/marks").sort();
    expect(onDisk).toEqual([...Object.values(ASSET_MARK_FILES)].sort());
    for (const file of onDisk)
      expect(file).toMatch(/^\/marks\/(crypto|equities)\/[a-z0-9]+\.(svg|webp)$/);
  });
});
