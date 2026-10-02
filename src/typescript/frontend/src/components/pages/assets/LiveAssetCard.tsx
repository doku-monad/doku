"use client";

import Link from "next/link";
import { ROUTES } from "router/routes";

import { AssetIcon } from "@/components/ui/asset-icon";
import { displaySymbol, displaySymbolText } from "@/lib/assets/display-symbol";
import { QUOTE_ASSET_KIND_NAMES, type QuoteAsset } from "@/lib/assets/quote-assets";

import { ArrowGlyph, AssetContractBand, assetPriceText, assetStatusSentence } from "./asset-chrome";
import { AssetCardShell } from "./AssetCardShell";

/**
 * A quote asset you can launch against **today**.
 *
 * ## It is the product's own object, not a box with a border
 *
 * Tray, rim, bezel, edge — the four layers the market masthead, the coin card and the footer are
 * all built from. This card spent a version as a single raised face on the page ground, which is
 * the one construction nothing else in this app uses: beside a masthead made of machined layers it
 * read as an outlined rectangle that had been pasted on.
 *
 * The layers are not decoration, they are what makes the thing look *milled* rather than drawn. A
 * hairline on a surface is a border; the same hairline floating three pixels off it is an edge
 * catching light. The radii are concentric for the same reason — 19 for the tray, 22 for the rim
 * three pixels outside it, 16 for the bezel three pixels inside. Two rounded rectangles at equal
 * radius three pixels apart converge through every corner and read as one shape with a fault in
 * it; see the note over `.doku-token-rim`.
 *
 * ## Three steps of relief, top to bottom
 *
 *   1. **The identity band is flush** with the bezel, lit by the hearth — a single soft ellipse
 *      behind the mark's shoulder that separates the mount from the face without a hard edge.
 *   2. **The figures are a plateau**: a band that catches the light, with a lit lip along its top
 *      and milled grooves between the cells. They are the three numbers somebody choosing a
 *      denomination actually weighs, so they are the part of the object that stands up.
 *   3. **The floor is sunk** — the contract rail and the launch key sit one step down, shaded along
 *      their top lip where the plateau's foot overhangs them.
 *
 * Raised, then flush, then sunk is what gives an object a *section* rather than a stack of rules.
 *
 * ## The mark stands on a mount
 *
 * Not in a well. A recess says "cut into the face"; these marks are the issuers' own logos and they
 * belong on something, not in something. `.doku-token-mount` is the same raised mount the market
 * masthead gives a quote asset, gloss and all — so an asset is the same physical object on both
 * pages.
 */

/** One cell of the figure plateau. A plain cell unless it has somewhere to go. */
const Figure = ({
  label,
  value,
  tone,
  href,
  title,
  linkLabel,
  seam,
}: {
  label: string;
  value: string;
  /** `brand` for the figure that is the reason to pick this asset. One per card, at most. */
  tone?: "brand";
  /** Present when the figure is also a door — see `.doku-asset-figure-link`. */
  href?: string;
  title?: string;
  linkLabel?: string;
  /** The milled groove on this cell's left wall. Every cell but the first. */
  seam?: boolean;
}) => {
  const body = (
    <>
      <span className="flex min-w-0 items-center gap-1.5 font-numeric text-[11.5px] font-semibold uppercase leading-none tracking-[0.06em] text-ash">
        <span className="truncate">{label}</span>
        {/* Visible at rest, brighter under the pointer. It was `opacity-0` until hover, which on a
            touch screen means the one figure on this card that goes somewhere advertised itself to
            nobody. */}
        {href && (
          <span className="shrink-0 opacity-45 transition-opacity duration-200 group-hover/act:opacity-100 motion-reduce:transition-none">
            <ArrowGlyph size={10} />
          </span>
        )}
      </span>
      <span
        className={`min-w-0 truncate font-numeric text-[18px] font-semibold leading-none tracking-[-0.02em] tabular-nums ${
          tone === "brand" ? "text-doku-ink" : "text-ink"
        }`}
      >
        {value}
      </span>
    </>
  );

  /* `min-w-0` on the cell and `truncate` on both children: a three-track grid divides the card
     evenly, so on a 360px phone each cell owns about 87px of content and `1,000 MON` is 85 of
     them. The padding and the value's size both step down one tier for exactly that case —
     `tests/unit/ui-readability` holds an 11px floor and these are well clear of it. */
  const shell = `flex min-w-0 flex-col justify-center gap-1.5 px-3 py-2.5 sm:px-4 ${
    seam ? "doku-token-channel" : ""
  }`;

  return href ? (
    <Link
      href={href}
      title={title}
      aria-label={linkLabel}
      className={`doku-asset-figure-link group/act ${shell}`}
    >
      {body}
    </Link>
  ) : (
    <div title={title} className={shell}>
      {body}
    </div>
  );
};

export const LiveAssetCard = ({ asset }: { asset: QuoteAsset }) => {
  const markets = asset.marketCount ?? 0;
  const { base, suffix } = displaySymbol(asset);
  const ticker = displaySymbolText(asset);

  return (
    <AssetCardShell live title={assetStatusSentence(asset)}>
      {/* The bloom behind the mark's shoulder — see `.doku-token-hearth`. */}
      <span aria-hidden className="doku-token-hearth pointer-events-none absolute inset-0" />
      {/* The brand wash, falling out of the top edge. It stops short of the figures so the
            plateau below reads as metal rather than as tinted glass. */}
      <span
        aria-hidden
        className="doku-asset-wash pointer-events-none absolute inset-x-0 top-0 h-[110px]"
      />

      {/* ---- Identity: flush with the bezel ---------------------------------------------- */}
      <div className="relative flex items-center gap-2.5 px-3.5 pt-3 sm:px-4">
        {/* The mark on a mount, with its own specular. It identifies the asset faster than the
              ticker does — the Apple mark reads instantly where `AAPLx` takes a beat. */}
        <span className="doku-token-mount relative grid h-[42px] w-[42px] shrink-0 place-items-center overflow-hidden rounded-doku-lg">
          <AssetIcon asset={asset} size={26} className="relative z-10 rounded-[7px]" />
          <span
            aria-hidden
            className="doku-token-mount-gloss pointer-events-none absolute inset-0"
          />
        </span>

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {/* No `uppercase`, and the suffix a step down. `cbBTC` and the `x`-suffixed equities
                are cased deliberately in the registry — transforming them renders tickers that do
                not exist — and the lower-case `x` is load-bearing: `TSLAx` tracks Tesla, it is not
                Tesla. See `lib/assets/display-symbol`. */}
          <h3 className="min-w-0 truncate font-pixel text-[18px] font-medium leading-none tracking-[0.01em] text-ink">
            {base}
            {suffix && <span className="text-mute">{suffix}</span>}
          </h3>
          <p className="min-w-0 truncate font-ui text-[12.5px] leading-none text-ash">
            {asset.name}
            <span className="text-mute-ink"> · {QUOTE_ASSET_KIND_NAMES[asset.kind]}</span>
          </p>
        </div>
      </div>

      {/*
          The contract, under the identity it belongs to.

          It used to sit in the floor beside the `Launch` key, and that is what made the two cards'
          keys different sizes: MON is `address(0)` and renders no rail, so its key filled the band
          while USDC's was pushed into the corner by one. A primary action that changes shape from
          card to card in the same row is the kind of inconsistency you cannot un-see once it is
          pointed out.

          Up here it reads as what it is — small print qualifying the name above it, which is
          exactly where the market masthead puts the same object — and the floor is left holding one
          thing, so both keys are identical at every width.
        */}
      {/*
        The blurb — the only prose on the page, and the only thing that says why you would pick one
        asset over another. Two lines at most; the full text stays on the `title`.

        `flex-1` rather than a fixed margin, and this is where the cards' slack goes. Under
        `auto-rows-fr` every card in a row is as tall as the tallest, and MON has one band fewer
        than USDC because it has no contract to print. With `mt-auto` on the bands below, that
        difference showed up as a hard 90px gap between the blurb and the figures — a void bounded
        by two rules, which reads as an element that failed to render. Letting the prose own the
        space puts the same pixels *under a sentence*, where they read as breathing room, and the
        bands stay flush across the row. A grid of figures that does not line up is the untidier
        failure of the two.
      */}
      <p
        title={asset.blurb || undefined}
        className="relative line-clamp-2 min-h-0 flex-1 px-3.5 pb-4 pt-2.5 font-ui text-[12.5px] leading-[1.45] text-ash sm:px-4"
      >
        {asset.blurb}
      </p>

      {/* ---- The figures: the plateau ---------------------------------------------------- */}
      {/*
          Two figures, not three.

          `Graduates at 1,000 MON` was the third, and it was the wrong number for this page: the
          graduation target is a property of a curve that does not exist yet, it is set by the
          launch form rather than chosen here, and at three-to-a-card it was the cell that forced
          the whole plateau to step its type down a size on a phone. Price and how many coins
          already trade against the asset are the two a person actually weighs when picking a
          denomination. `assetTargetText` stays in `asset-chrome` — the launch bench is where that
          figure belongs if it is ever wanted.
        */}
      <div className="doku-token-figures relative grid grid-cols-2">
        <Figure label="Price" value={assetPriceText(asset.usdPrice)} />

        {/*
            The count is the link.

            The registry has twice been a dead end here: it told you sixteen coins trade against MON
            and gave you no way to look at them. `/explore?pair=<id>` is the board's own filter — the
            same parameter its chips write — so the figure goes into the product rather than being
            restated beside it.
          */}
        <Figure
          seam
          label="Coins"
          value={markets.toLocaleString()}
          tone={markets > 0 ? "brand" : undefined}
          href={markets > 0 ? `${ROUTES.explore}?pair=${asset.id}` : undefined}
          title={
            markets > 0
              ? `See the ${markets === 1 ? "coin" : `${markets} coins`} quoted in ${ticker}`
              : `No coins are quoted in ${ticker} yet`
          }
          linkLabel={
            markets === 1 ? "View 1 market" : `View ${markets} markets quoted in ${ticker}`
          }
        />
      </div>

      {/* ---- The contract: flush, between the figures and the action -------------------- */}
      {/* Raised plateau, then this flush band, then the sunk floor. Three steps of relief is
            what gives the object a section rather than a stack of rules. */}
      <AssetContractBand asset={asset} />

      {/* ---- The floor: one step down ---------------------------------------------------- */}
      <div className="doku-token-vitals relative flex items-center px-3.5 py-2.5 sm:px-4">
        {/*
            The pair travels with the press.

            This said `Launch against USDC` and then opened a form whose pair step was on whatever
            the registry happened to list first — so the one decision the card had already taken on
            the launcher's behalf was the one the next screen threw away. `?pair=` is the id the
            launch bench reads on mount; see the note beside `PAIR_PARAM` in `LaunchBench`.

            The label is the verb alone. The card names the asset three times above this line, so
            `Launch against MON` bought nothing and wrapped inside a 330px card; `aria-label`
            carries the full phrase for anyone who arrives at the button without the card round it.
          */}
        <Link
          href={`${ROUTES.launch}?pair=${asset.id}`}
          aria-label={`Launch a coin against ${ticker}`}
          className="doku-cta group/act inline-flex h-10 w-full items-center justify-center gap-2 whitespace-nowrap rounded-doku-xl px-4 font-numeric text-[12px] font-semibold uppercase tracking-[0.06em]"
        >
          Launch
          <ArrowGlyph />
        </Link>
      </div>
    </AssetCardShell>
  );
};

export default LiveAssetCard;
