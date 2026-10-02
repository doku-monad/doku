"use client";

import { AssetIcon } from "@/components/ui/asset-icon";
import { displaySymbol } from "@/lib/assets/display-symbol";
import { QUOTE_ASSET_KIND_NAMES, type QuoteAsset } from "@/lib/assets/quote-assets";

import { assetStatusSentence, ExplorerKey } from "./asset-chrome";
import { AssetCardShell } from "./AssetCardShell";

/**
 * An asset in the registry that cannot be launched against yet.
 *
 * ## What it stopped being
 *
 * A card with a footer band and a `COMING SOON` badge in it. Eight of them, each stamped with the
 * same two words, under a heading that already read `ON THE WAY · 8 assets`. The badge was the
 * thing that made this grid read as generated, and no amount of restyling it was going to help —
 * see the note over `assetStatusSentence`.
 *
 * Without it the tile is what it should always have been: an entry in a catalogue. Four facts, one
 * affordance, no chrome.
 *
 *   - the issuer's **mark**, which is how anyone recognises `NVDAx` without reading it;
 *   - the **ticker**, in the accent face `brand.md` names for tickers;
 *   - the **name**, so the ticker is not a puzzle;
 *   - **what kind of thing it is** — one of the two axes this page filters on, and something no
 *     tile said anywhere before.
 *
 * ## The link is the state
 *
 * An asset deployed on Monad has a contract to look at; a catalogued one does not. The explorer key
 * is present on the first and absent on the second, and that difference *is* the distinction the
 * amber-versus-hollow dot used to draw — drawn by something a reader can use rather than something
 * they have to decode. The sentence stays on the tile's `title`.
 *
 * ## Sentence case, on purpose
 *
 * The kind is set in the UI sans at 12px, not in 11px tracked mono caps. This page carried sixteen
 * separate pieces of small uppercase type and they were most of why it read as hard to see: caps
 * have no ascenders or descenders to give a word its shape, so a tracked line of them at 11px is
 * texture rather than language. Caps are kept where they are genuinely a table header — the figure
 * labels on the live card — and dropped everywhere they were only a costume.
 */
export const UpcomingAssetTile = ({ asset }: { asset: QuoteAsset }) => {
  const { base, suffix } = displaySymbol(asset);

  return (
    <AssetCardShell
      title={`${asset.name} — ${QUOTE_ASSET_KIND_NAMES[asset.kind].toLowerCase()}, ${assetStatusSentence(asset).toLowerCase()}`}
      className="min-w-0"
    >
      <div className="relative flex h-full min-w-0 items-start gap-3 p-3.5">
        <span aria-hidden className="doku-token-hearth pointer-events-none absolute inset-0" />

        {/* The same raised mount the live card gives its mark, one size down. */}
        <span className="doku-token-mount relative grid h-[42px] w-[42px] shrink-0 place-items-center overflow-hidden rounded-doku-xl">
          <AssetIcon asset={asset} size={26} className="relative z-10 rounded-[7px]" />
          <span
            aria-hidden
            className="doku-token-mount-gloss pointer-events-none absolute inset-0"
          />
        </span>

        <div className="relative flex min-w-0 flex-1 flex-col gap-[7px] pt-[3px]">
          {/* No `uppercase`: `NVDAx` upper-cased is a ticker that does not exist, and the lower-case
              `x` is load-bearing — it tracks Tesla, it is not Tesla. See `display-symbol`. */}
          <span className="min-w-0 truncate font-pixel text-[16px] font-medium leading-none tracking-[0.01em] text-ink">
            {base}
            {suffix && <span className="text-mute">{suffix}</span>}
          </span>
          <span className="min-w-0 truncate font-ui text-[13px] leading-none text-ash">
            {asset.name}
          </span>
          <span className="min-w-0 truncate font-ui text-[12px] leading-none text-mute-ink">
            {QUOTE_ASSET_KIND_NAMES[asset.kind]}
          </span>
        </div>

        {/* Present when there is a contract, absent when there is not — which is the whole of the
            state this tile has to carry. */}
        <ExplorerKey asset={asset} className="relative -mr-1 -mt-1 shrink-0" />
      </div>
    </AssetCardShell>
  );
};

export default UpcomingAssetTile;
