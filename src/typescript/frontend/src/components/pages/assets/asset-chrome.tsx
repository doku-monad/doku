"use client";

import { cn } from "lib/utils/class-name";
import { toExplorerLink } from "lib/utils/explorer-link";
import { formatUnits } from "viem";

import { useAddressCopy } from "@/components/pages/market/components/main-info/CopyAddress";
import { NATIVE_QUOTE_ADDRESS, type QuoteAsset } from "@/lib/assets/quote-assets";

/**
 * The parts every registry card is made of.
 *
 * Two card shapes share this file — the live card and the upcoming tile — and they share it
 * because they are the same object at two densities. A glyph, a status lamp or an explorer link
 * drawn twice drifts twice, and the last version of this page had exactly that: two components
 * with two ideas of what "soon" looks like and two copies of an arrow.
 */

/* ================================================================================================
 * Glyphs
 *
 * Stroke-only, 24-box, `currentColor`. They inherit the tone of whatever they sit in, which is what
 * lets one arrow serve a brand CTA, a mute figure cell and a ghost key without three fills.
 * ============================================================================================= */

export const ArrowGlyph = ({ size = 14 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="shrink-0 transition-transform duration-200 ease-out group-hover/act:translate-x-[3px] motion-reduce:transition-none motion-reduce:group-hover/act:translate-x-0"
    aria-hidden
  >
    <path d="M5 12h13M12.5 5.5 19 12l-6.5 6.5" />
  </svg>
);

/** Out of the app and onto the explorer. The corner arrow, not the right arrow — they mean
    different things and this product has been careful about the difference everywhere else. */
export const ExternalGlyph = ({ size = 13 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="shrink-0"
    aria-hidden
  >
    <path d="M7 17 17 7M9 7h8v8" />
  </svg>
);

export const CopyGlyph = ({ size = 13 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="shrink-0"
    aria-hidden
  >
    <rect x="9" y="9" width="12" height="12" rx="2.5" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);

export const TickGlyph = ({ size = 13 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="shrink-0"
    aria-hidden
  >
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

export const SearchGlyph = ({ size = 15 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    className="shrink-0"
    aria-hidden
  >
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.2-3.2" />
  </svg>
);

/* ================================================================================================
 * Availability
 * ============================================================================================= */

/**
 * What the chain says about an asset — as a tooltip, and as nothing else.
 *
 * ## There was a badge here, and it was the worst thing on the page
 *
 * Every card carried a plate reading `LIVE` or `COMING SOON`. Restyling it — a bar instead of a
 * dot, a 6px corner instead of a pill — missed the point entirely, which is that **the label was
 * redundant before it was ugly**. A section headed `LAUNCHABLE NOW · 2 assets` followed by two
 * cards each stamped `LIVE`, and `ON THE WAY · 8 assets` followed by eight stamped `COMING SOON`.
 * A label that is identical on every card in a section carries no information; it is decoration
 * wearing the costume of data, which is exactly what makes a layout read as generated.
 *
 * So the state is encoded in things that are already there and already true:
 *
 *   - **Which section a card is in** is the primary statement, and it is made once.
 *   - **The `Launch` key** exists on a launchable card and on no other. An affordance that is
 *     present or absent is a stronger signal than a word, and it cannot be misread.
 *   - **The explorer rail** exists when there is a contract to point at. So a deployed-but-not-
 *     enabled asset differs visibly from a catalogued one *by having a link*, which is the same
 *     distinction the old amber-versus-hollow dot was drawing, drawn by something useful.
 *   - **The brand rim and wash** on the live cards, which is material rather than a caption.
 *
 * The sentence survives on every card's `title`, where it costs no pixels and no visual noise.
 */
export const assetStatusSentence = (asset: QuoteAsset): string =>
  asset.status === "live"
    ? "Enabled on the launchpad — you can launch against this today"
    : asset.address
      ? "Deployed on Monad, not enabled for launches yet"
      : "Not deployed yet";

/**
 * One quiet key: this token, on MonadVision.
 *
 * The tiles used the two-segment rail with its address hidden, which is a channel built to hold
 * three things holding one. This is the single target it actually needs, at 28px, sitting in the
 * tile's top-right corner where a secondary affordance belongs.
 *
 * Returns `null` when there is no contract — and on a roadmap tile that absence is the state, so
 * the caller renders the gap rather than a disabled control. See `UpcomingAssetTile`.
 */
export const ExplorerKey = ({ asset, className }: { asset: QuoteAsset; className?: string }) => {
  const address = asset.address && asset.address !== NATIVE_QUOTE_ADDRESS ? asset.address : null;
  if (!address) return null;

  return (
    <a
      href={toExplorerLink({ linkType: "coin", value: address })}
      target="_blank"
      rel="noopener noreferrer"
      title={`${asset.symbol} on MonadVision`}
      aria-label={`${asset.name} on MonadVision, the block explorer`}
      className={cn(
        "doku-token-key grid h-7 w-7 place-items-center rounded-doku-lg text-mute transition-colors hover:text-doku-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku",
        className
      )}
    >
      <ExternalGlyph size={13} />
    </a>
  );
};

/* ================================================================================================
 * The way out to the chain
 * ============================================================================================= */

/**
 * The contract, as a data strip across the card.
 *
 * ## No `CONTRACT` label
 *
 * It had one, and it cost 70px of a band that is 226px wide once the cards are narrow enough to sit
 * three or four to a row. A mono hex string with a copy key and an explorer key beside it is
 * unmistakably a contract address; the word was belt-and-braces, and it was the first thing to go
 * when the space had to come from somewhere. The copy control still names it in full on its
 * `title` and its `aria-label`, where a screen reader gets the whole sentence.
 *
 * ## Why it is a band and not a chip
 *
 * It was a small machined pill floating under the asset's name — a 146px object in a 500px row,
 * with nothing to align to on either side. A card built out of full-width bands had one element
 * that was not one, so it read as something dropped on rather than part of the object.
 *
 * A band is also how this page's own masthead prints its figures, and how the board card prints
 * its two: label on the left, value in mono, controls closed up on the right. It costs the same
 * eight pixels of height the pill did and it rules with the plateau above it.
 *
 * ## `CONTRACT` earns its caps
 *
 * It is a column heading for the value beside it, which is the one job this page keeps uppercase
 * mono for — see the note in `UpcomingAssetTile` about the sixteen that did not earn it.
 *
 * ## Native MON shows nothing
 *
 * `address(0)` is what a v4 `PoolKey` carries for the chain's own asset, and it was rendered here
 * for a while on the reasoning that a launcher might want to copy it. On a page whose subject is
 * "what can I pair against" that is the wrong audience: to everyone reading it, `0x0000…0000` is a
 * contract address that looks broken. MON does not have one, and the band says nothing rather than
 * saying a row of zeroes.
 *
 * A `null` address — a catalogue row with nothing deployed — renders nothing for the same reason.
 */
export const AssetContractBand = ({
  asset,
  className,
}: {
  asset: QuoteAsset;
  className?: string;
}) => {
  /* The zero address is not an address anybody wants printed at them; see the note above. */
  const address = asset.address && asset.address !== NATIVE_QUOTE_ADDRESS ? asset.address : null;

  /* Called unconditionally: a hook cannot sit behind the early return below. */
  const { copied, copy } = useAddressCopy(address ?? "");

  if (!address) return null;

  return (
    <div
      className={cn(
        "doku-token-band relative flex items-center gap-2 px-3.5 py-[9px] sm:px-4",
        className
      )}
    >
      <span className="min-w-0 flex-1 truncate font-numeric text-[13px] leading-none text-ink">
        {`${address.slice(0, 6)}…${address.slice(-4)}`}
      </span>

      <span className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={copy}
          title={address}
          aria-label={copied ? "Address copied" : `Copy the ${asset.symbol} contract ${address}`}
          className="doku-token-key grid h-7 w-7 place-items-center rounded-doku-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku"
        >
          <span className={copied ? "text-doku" : "text-doku-ink/80"}>
            {copied ? <TickGlyph /> : <CopyGlyph />}
          </span>
        </button>

        <ExplorerKey asset={asset} />
      </span>
    </div>
  );
};

/* ================================================================================================
 * Figures
 * ============================================================================================= */

/**
 * Dollars per whole token.
 *
 * Three bands rather than one format string. A quote registry holds a $1.00 stablecoin, a $2.50
 * native asset and — the moment gold or an equity is enabled — a four-figure one, and a single
 * `maximumFractionDigits` is wrong for at least one of them. `null` is a data gap with a name and
 * renders as a dash; it is never 0, which would mean the asset is worthless.
 */
export const assetPriceText = (usd: number | null | undefined): string => {
  if (usd == null) return "—";
  if (usd >= 1000) return `$${usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (usd >= 1)
    return `$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
};

/**
 * What a coin has to raise in this asset before it graduates, in whole units.
 *
 * Scaled by the QUOTE ASSET'S decimals — 1000e18 MON and 10000e6 USDC are the same shape of number
 * and six orders of magnitude apart, and the registry is the one place in the app where both are
 * on screen at once. Returns `null` where no target is configured, which is every asset that is
 * not enabled: a figure invented for a curve that does not exist would be the worst kind of wrong
 * on a page whose whole argument is that its facts come from the chain.
 *
 * Compacted from ten thousand up rather than from one thousand, which is where `compactQuote` in
 * the swap widget draws the line. The cell this lands in is 86px wide on a phone and the value
 * carries its ticker, so `10,000 USDC` elides and `10K USDC` does not — while `1,000 MON` fits and
 * is worth more exact than `1.0K MON`. Different widths, different thresholds.
 */
export const assetTargetText = (asset: QuoteAsset): string | null => {
  if (!asset.quoteTarget) return null;
  try {
    const whole = Number(formatUnits(BigInt(asset.quoteTarget), asset.decimals));
    if (!Number.isFinite(whole) || whole <= 0) return null;
    if (whole >= 1_000_000)
      return `${(whole / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}M`;
    if (whole >= 10_000)
      return `${(whole / 1_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}K`;
    return whole.toLocaleString(undefined, { maximumFractionDigits: whole >= 1 ? 0 : 2 });
  } catch {
    /* A target that is not a decimal string. The cell falls back to the dash rather than to
       `NaN`, which is what `Number(formatUnits(...))` would otherwise put on the card. */
    return null;
  }
};
