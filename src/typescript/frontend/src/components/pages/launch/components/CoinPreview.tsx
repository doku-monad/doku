"use client";

import { CoinCard } from "components/ui/coin-card";
import { CoinMark } from "components/ui/coin-mark";
import { cn } from "lib/utils/class-name";

import { AssetIcon } from "@/components/ui/asset-icon";
import type { QuoteAsset } from "@/lib/assets/quote-assets";

import type { Identity } from "./IdentityFields";

/**
 * What the coin will look like on the board — the real card, drawn from the draft.
 *
 * ## Why it is the card and not an illustration of one
 *
 * Because every question this panel exists to answer is a question about the card. Is the banner
 * crop right? Does the name fit next to the pair badge? Does the ticker read at that size? A
 * bespoke preview panel answers none of those — it answers "did my fields save", which the fields
 * already answer by containing text.
 *
 * So this renders `CoinCard`, the same component the board renders, with placeholder figures where
 * the coin has no history yet. If the two ever diverge, this preview is lying, and the way to keep
 * them honest is for there to be only one of them.
 *
 * ## The figures are obviously fake, on purpose
 *
 * An em dash where every figure goes, a bonding bar at nothing, an address of zeroes. A preview
 * showing a plausible `$12.4K` would be inventing a number on the one screen where somebody is
 * deciding whether to spend money, and the fabricated figure would be the most eye-catching thing
 * on it. A literal `0` is barely better — it is a real number, and a market cap of zero is a
 * claim. The dash says "not yet", which is the truth.
 */
export const CoinPreview = ({
  identity,
  quote,
  className,
}: {
  identity: Identity;
  quote: QuoteAsset;
  className?: string;
}) => (
  /* No caption over it.

     It said "PREVIEW — live, as you type" above a card that is visibly a card and visibly changing
     as you type. A label naming the thing directly under it is the caption a diagram earns and a
     component does not, and it cost the rail a row on the axis the rail has least of. */
  <div className={cn("flex flex-col", className)}>
    <CoinCard
      name={identity.name || "Your coin"}
      ticker={identity.ticker || "TICKER"}
      logo={identity.logo || null}
      banner={identity.banner || null}
      pair={quote}
      marketCap="—"
      delta={null}
      contractAddress="0x0000000000000000000000000000000000000000"
      age="new"
      graduationPercentage={0}
    />
  </div>
);

/**
 * The same coin, as one line.
 *
 * For the widths where there is no rail. Below `lg` the full card is at the foot of the page,
 * after every step that fills it in — which is the right place for it and the wrong place to
 * answer "what am I building" while you are typing. This pins to the top instead: the mark, the
 * name, the ticker and the pair, at 56px, which is small enough to give up to a form on a phone
 * and complete enough to be the answer.
 *
 * It is deliberately not a shrunken `CoinCard`. A card with its figures, its curve and its
 * contract row squeezed into a strip would be four illegible things; this is four legible ones.
 */
export const CoinPreviewStrip = ({
  identity,
  quote,
  className,
}: {
  identity: Identity;
  quote: QuoteAsset;
  className?: string;
}) => (
  <div
    className={cn(
      "doku-edge flex items-center gap-3 rounded-doku-2xl px-3 py-2.5 backdrop-blur-xl",
      className
    )}
    style={{ background: "var(--mat-bezel-bg)" }}
  >
    <CoinMark
      logo={identity.logo || null}
      ticker={identity.ticker || "TICKER"}
      name={identity.name || "Your coin"}
      size={36}
      className="shrink-0 rounded-[11px]"
    />

    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="truncate font-ui font-semibold text-[14px] uppercase leading-none tracking-[0.01em] text-ink">
        {identity.name || "Your coin"}
      </span>
      <span className="truncate font-numeric text-[12px] leading-none text-ash">
        <span className="text-mute">$</span>
        {identity.ticker || "TICKER"}
      </span>
    </div>

    <span className="flex shrink-0 items-center gap-1.5 rounded-doku-lg border border-line py-1.5 pl-1.5 pr-2 font-numeric text-[12px] font-semibold uppercase leading-none tracking-[0.04em] text-ash">
      <AssetIcon asset={quote} size={16} />
      {quote.symbol}
    </span>
  </div>
);

export default CoinPreview;
