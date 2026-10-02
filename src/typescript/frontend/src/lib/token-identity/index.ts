import { emojisToName } from "lib/utils/emojis-to-name-or-symbol";

import { getQuoteAssetByAddress, type QuoteAsset } from "@/lib/assets/quote-assets";
import type { MarketMetadata } from "@/lib/models";
import { safeImageUrl } from "@/lib/models/safe-url";
import { symbolToEmojis } from "@/sdk/emoji_data/utils";

import { metadataFor, type TokenMetadata } from "./metadata";

/**
 * What a coin is called, what it trades against, and what it charges — resolved once.
 *
 * Every surface that shows a coin — the board card, the market header, the search result, the
 * portfolio row, the tape — goes through this function, so all of them agree. The alternative is
 * what the app had before: each component deriving a label from the symbol its own way, which is
 * how the same market ends up as "CRESCENT MOON" in the hero and "🌙💎" in the table.
 *
 * ## What this used to return, for every market
 *
 * MON. Always. Plus `feeRouting: null` and `creatorFeePct: 0`, always — because the resolution
 * read a hard-coded metadata map that was **empty in production**, and the quote came from a
 * constant naming the one live asset.
 *
 * All three are columns on every market row now. `quote_asset` / `quote_decimals` /
 * `quote_symbol`, `routing`, `creator_tax_bps` — and the launcher's own `ticker`, `logo_uri`,
 * `banner_uri`, `description` and socials beside them. This function reads the row.
 *
 * ## The resolution order
 *
 * 1. **The row's own metadata columns.** What the launcher put on chain. The real answer, and the
 *    one every generation-2 market takes.
 * 2. **The card-preview fixture**, for a `0xdeaddead…` address and nothing else — see `metadata.ts`.
 * 3. **The chain's `name`**, when it is not simply the symbol wearing a different hat.
 * 4. **Derived from the emoji sequence**, and *only for a generation-1 market*. That is the honest
 *    reading: a gen-1 market's name genuinely is its emoji, because the factory wrote the joined
 *    sequence into `name` and there was nowhere else to put one. A generation-2 market with an
 *    empty ticker is a market whose metadata has not arrived, and rendering "Rocket Full Moon" for
 *    it invents a name its launcher never chose.
 *
 * The emoji is kept in every case as `avatarEmoji`. Not out of nostalgia: a coin with no logo
 * needs *something* square to draw, and a generated glyph beats a grey circle with a letter in it.
 */
export interface TokenIdentity {
  /** Display name. Title case, already trimmed — render as given. */
  name: string;
  /** Ticker without the leading `$`. Callers add the sigil so it can be styled separately. */
  ticker: string;
  /** Square logo, or `null` when the coin has none and the avatar glyph should be drawn instead. */
  logo: string | null;
  /** The wide card image, or `null`. */
  banner: string | null;
  /** The glyph to draw when `logo` is null. Never empty. */
  avatarEmoji: string;
  /** The symbol the chain knows this market by. Shown only where the chain's own key belongs. */
  symbol: string;
  description: string | null;
  links: NonNullable<TokenMetadata["links"]>;
  /**
   * What the coin trades against, from the market's own row.
   *
   * `null` only where the caller had no row to give — the command palette's list item and the
   * portfolio's balance rows carry an address and a symbol and nothing else. Those surfaces do not
   * render a pair today, and the honest value for them is "not known here" rather than MON.
   * Callers that hold a `MarketMetadata` get the non-null overload and never see this.
   */
  quote: QuoteAsset | null;
  /**
   * Where the creator's share of the protocol fee goes, from `routing` on the row.
   *
   * `null` where the market recorded no choice. The market page renders its rewards module only
   * when this is `holders` or `buyback`; "you keep them" and "not recorded" both correctly render
   * nothing, because neither is a promise anybody made to a holder — and inventing one is the one
   * thing a launchpad interface must never do.
   */
  feeRouting: "creator" | "holders" | "buyback" | null;
  /** The creator's own tax on every trade, as a percentage. `0` when there is none. */
  creatorFeePct: number;
}

/** An identity resolved from a full market row, where the quote is known. */
export type MarketIdentity = TokenIdentity & { quote: QuoteAsset };

/**
 * Title case for a `SymbolEmojiData` name.
 *
 * The emoji dataset stores names in lower case with spaces — "crescent moon", "money-mouth face".
 * Hyphens are word boundaries too, or "money-mouth" comes back as "Money-mouth".
 */
const titleCase = (words: string) =>
  words
    .toLowerCase()
    .replace(
      /(^|[\s-])([a-z])/g,
      (_, boundary: string, letter: string) => boundary + letter.toUpperCase()
    );

/**
 * A ticker from an emoji name.
 *
 * First segment only, letters and digits only, upper case. `emojisToName` joins every emoji in a
 * symbol with commas, so a two-emoji market comes back as "CRESCENT MOON,GEM STONE" — thirty
 * characters where a ticker belongs.
 */
const tickerFromEmojiNames = (names: string) =>
  names
    .split(",")[0]
    .replace(/[^a-zA-Z0-9]+/g, "")
    .toUpperCase()
    .slice(0, 12);

/** The full name from an emoji symbol: "🌙💎" becomes "Crescent Moon Gem Stone". */
const nameFromEmojiNames = (names: string) =>
  names
    .split(",")
    .map((part) => titleCase(part.trim()))
    .filter(Boolean)
    .join(" ");

/** A column that is present but empty is absent. An all-whitespace ticker is not a ticker. */
const text = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/**
 * The subset `identityFor` can work from.
 *
 * A full `MarketMetadata` is what every surface that renders a pair supplies. The narrow form —
 * an address, a symbol, maybe a name — is what the command palette's list item and the portfolio's
 * balance rows have, because the endpoints behind them return neither a quote nor a routing.
 * Typed as one input so the same coin resolves to the same label everywhere; two resolvers is how
 * it ends up with two names.
 */
export type IdentityInput = Pick<MarketMetadata, "marketAddress" | "symbol"> &
  Partial<MarketMetadata>;

/**
 * The quote a market is priced in, built from its own row.
 *
 * The row is authoritative for everything the contracts agree on — the address, the decimals, the
 * symbol and the catalogue id — and says nothing about presentation. The registry supplies the
 * name, the kind, the blurb and the issuer's domain, and is allowed to supply **only** those: a
 * catalogue row is editable by an admin, while `quote_decimals` is what the token itself reported
 * at registration, and if the two disagree the one that scales money has to win.
 *
 * Resolving without a registry is a first-class case, not a degraded one. `/quotes` is a second
 * request that may not have landed, and a market page that will not render because a blurb is
 * missing is a worse failure than an asset shown under its own ticker.
 */
const quoteFromRow = (
  row: Pick<MarketMetadata, "quote">,
  quotes?: readonly QuoteAsset[]
): QuoteAsset => {
  const known = quotes ? getQuoteAssetByAddress(quotes, row.quote.asset) : undefined;
  const symbol = text(row.quote.symbol) ?? known?.symbol ?? "—";

  return {
    id: row.quote.id ?? known?.id ?? row.quote.asset.toLowerCase(),
    symbol,
    // The ticker stands in for the name. It is a true statement about the asset; inventing a
    // company name for an address the catalogue has never heard of would not be.
    name: known?.name ?? symbol,
    kind: known?.kind ?? "crypto",
    // A market is quoted in it, so the registry enabled it. `known` still wins where it exists,
    // because an asset can be disabled after markets were launched against it.
    status: known?.status ?? "live",
    decimals: row.quote.decimals,
    address: row.quote.asset.toLowerCase() as `0x${string}`,
    blurb: known?.blurb ?? "",
    underlying: known?.underlying,
    iconDomain: known?.iconDomain,
    quoteTarget: known?.quoteTarget,
    usdPrice: known?.usdPrice,
    usdPriceAt: known?.usdPriceAt,
    marketCount: known?.marketCount,
  };
};

/**
 * @param market the market row, or as much of it as the caller has
 * @param quotes the registry from `/quotes`, where the caller has it. Optional: it only enriches
 *        the quote's presentation, and every figure that matters comes off the row.
 */
export function identityFor(
  market: MarketMetadata,
  quotes?: readonly QuoteAsset[]
): MarketIdentity;
export function identityFor(
  market: IdentityInput,
  quotes?: readonly QuoteAsset[]
): TokenIdentity;
export function identityFor(
  market: IdentityInput,
  quotes?: readonly QuoteAsset[]
): TokenIdentity {
  // The fixture, and only for an address in its own namespace — see `metadata.ts`.
  const preview = metadataFor(market.marketAddress);
  const meta = market.metadata;

  const emojis = symbolToEmojis(market.symbol).emojis;
  const emojiNames = emojisToName(emojis);
  const avatarEmoji = emojis.map((e) => e.emoji).join("") || market.symbol;

  // The chain's `name` is only useful when it is not the symbol wearing a different hat. Every
  // generation-1 market fails this test, which is correct — it has no real name.
  const chainName =
    market.name && market.name !== market.symbol && market.name.trim().length > 0
      ? market.name.trim()
      : null;

  /*
   * The emoji derivation is a GENERATION-1 answer.
   *
   * `generation` is absent on the narrow input, and absence is treated as generation 1: the
   * surfaces that pass a narrow row — the palette, the portfolio — are looking at markets that
   * predate the metadata columns as often as not, and a market with an emoji symbol and no ticker
   * is a gen-1 market whatever the row omitted. What must not happen is the reverse: a
   * generation-2 market whose metadata has not arrived being given a name out of its symbol.
   */
  const derivable = (market.generation ?? 1) === 1;
  const derivedName = derivable ? nameFromEmojiNames(emojiNames) || null : null;
  const derivedTicker = derivable ? tickerFromEmojiNames(emojiNames) || null : null;

  /*
   * Links, with the empty keys removed rather than set to `undefined`.
   *
   * A card that spreads this into props renders an anchor for every key it finds, and
   * `{ telegram: undefined }` is a key. The absent ones have to be absent.
   */
  const links: NonNullable<TokenMetadata["links"]> = {};
  const website = text(meta?.website) ?? preview?.links?.website;
  const x = text(meta?.x) ?? preview?.links?.x;
  const telegram = text(meta?.telegram) ?? preview?.links?.telegram;
  if (website) links.website = website;
  if (x) links.x = x;
  if (telegram) links.telegram = telegram;
  // Collected by the launch form and carried by no on-chain field, so it can only ever come from
  // the fixture. Task F5 says so in the form rather than dropping it silently.
  if (preview?.links?.discord) links.discord = preview.links.discord;

  return {
    name: preview?.name ?? chainName ?? derivedName ?? market.symbol,
    // Falls back to the chain's SYMBOL, not to a literal "COIN". A ticker invented from nothing is
    // the one string on a card that a person will type into a search box and a block explorer.
    ticker: text(meta?.ticker) ?? preview?.ticker ?? derivedTicker ?? market.symbol,
    // Chain metadata is creator-written; only an https URL is drawn. See `safeImageUrl`.
    logo: safeImageUrl(text(meta?.logoUri)) ?? preview?.logo ?? null,
    banner: safeImageUrl(text(meta?.bannerUri)) ?? preview?.banner ?? null,
    avatarEmoji,
    symbol: market.symbol,
    description: text(meta?.description) ?? preview?.description ?? null,
    links,
    // `null` only where the caller had no row to give — see the field's own note.
    quote: market.quote ? quoteFromRow({ quote: market.quote }, quotes) : null,
    feeRouting: market.routing ?? preview?.feeRouting ?? null,
    /*
     * Basis points to a percentage. 250 bps is 2.5%, and the form holds a percent to one decimal,
     * so `bps / 100` always lands on a value the form can round-trip.
     *
     * Zero falls through to the fixture rather than winning, because zero and "this row did not
     * carry the column" are the same value here and only one of them is a statement.
     */
    creatorFeePct: market.creatorTaxBps ? market.creatorTaxBps / 100 : (preview?.creatorFeePct ?? 0),
  };
}

export { type TokenMetadata } from "./metadata";
