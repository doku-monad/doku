"use client";

import { AssetIcon } from "@/components/ui/asset-icon";
import type { QuoteAsset } from "@/lib/assets/quote-assets";
import type { SideAsset } from "@/lib/chain/zap-plan";

/**
 * What the buy is funded with: the market's own quote asset, or native MON.
 *
 * Rendered only when there are genuinely two choices — `sideAssetOptions` returns a single-entry list
 * whenever MON is not on offer, and a control with one option in it is furniture that implies a
 * setting exists. On a market already priced in MON, or on a deployment with no zap router, that
 * list is always single and this component renders nothing at all.
 *
 * ## Why it is two keys and not two pills
 *
 * This is the single most consequential control on a market that is *not* priced in MON, and it was
 * two 28px text chips floating to the right of a 11px grey caption — the same object the panel uses
 * for a slippage preset. Somebody arriving at `INU/NVDAx` with a wallet full of MON has to notice
 * it to trade at all, and what they were being asked to notice was a pill that said `MON` next to a
 * pill that said `NVDAx`, with no statement anywhere of what pressing either one *did*.
 *
 * So each option says it: a mounted asset mark, a verb, and the ticker. Two keys of equal width, in
 * the same material as the launch bench's pair picker — the control that chose this market's
 * denomination in the first place — with the chosen one lit and ticked. The caption is gone,
 * because a key that states its own verb does not need a heading to introduce it.
 *
 * ## The verb is a prop, because this control is two questions
 *
 * It was the literal string **Buy using**, written into the key and into its `aria-label`. That was
 * true while the sell side had no way out to MON — `sideAssetOptions` returned a single option for
 * every sell, so the control never rendered on one. It does now: a curve sells into its quote asset
 * and the swap carries that on to MON. So on a sell the panel was offering a real choice about what
 * you are HANDED BACK, in a key that said "Buy using MON" over a field holding the coin you are
 * selling — describing a trade that is not on offer, in the one control where being confused about
 * which side is which costs money.
 *
 * The quote asset is first and is the default: it is what the market is priced in, what the receipt
 * is denominated in, and the only route that involves no swap. MON is the shortcut, not the norm.
 */
export const PayWithControl = ({
  options,
  value,
  onChange,
  quoteSymbol,
  quoteAsset,
  nativeAsset,
  label,
  verb,
  nativeHint,
  unavailable,
}: {
  options: readonly SideAsset[];
  value: SideAsset;
  onChange: (next: SideAsset) => void;
  quoteSymbol: string;
  /** The market's quote, for its mark. Absent only where the caller has no registry row. */
  quoteAsset?: QuoteAsset | null;
  /** Native MON, from the same registry. */
  nativeAsset?: QuoteAsset | null;
  /** The group's accessible name — "Pay with", "Fund the buy with" — translated by the caller. */
  label: string;
  /**
   * The verb printed on every key, and read out as part of each key's accessible name.
   *
   * "Buy using" on a buy, "Receive in" on a sell, "Fund with" on the launch bench. Two or three
   * words: it sits above a ticker in an 11px eyebrow and is the whole of what tells somebody which
   * direction this control acts in. Translated by the caller, like `label`.
   */
  verb: string;
  /**
   * Options that exist but cannot be picked yet, each with the reason.
   *
   * The key stays on screen, greyed, with a badge — an option that is *missing* teaches nothing,
   * while one that is visibly not ready yet says both what the product intends and what it cannot
   * do today.
   *
   * The launch bench used to be the only caller: it funded a dev buy on a non-MON pair in MON only,
   * because the app read no ERC-20 balances and so could neither show what the wallet held of the
   * quote asset nor tell a launcher their buy was affordable before the wallet reverted. Both keys
   * are live there now. This stays for the trade panel, which still has funding assets it can only
   * describe.
   */
  unavailable?: Partial<Record<SideAsset, string>>;
  /** One phrase saying what choosing MON does. Absent while nothing needs explaining. */
  nativeHint?: string;
}) => {
  /* One option and nothing held back is not a choice; one option *plus* one that is coming is
     worth showing, because it says the product intends more than it currently offers. */
  if (options.length < 2 && !unavailable) return null;

  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-2 gap-2">
      {options.map((option) => {
        const native = option === "native";
        const active = option === value;
        const symbol = native ? "MON" : quoteSymbol;
        const asset = native ? nativeAsset : quoteAsset;
        const blocked = unavailable?.[option];
        return (
          /*
           * The reason sits on the wrapper, because a disabled button cannot show it.
           *
           * `unavailable`'s whole documented purpose is "each with the reason", and the reason was
           * delivered through `title` on a button that `global.css` gives `pointer-events: none` —
           * so the greyed key with the "Soon" badge answered "why?" with nothing at all, in both
           * this panel and the launch bench's dev buy. The button is transparent to hit-testing, so
           * the pointer lands on the span. `grid` so the button still fills its cell.
           */
          <span
            key={option}
            title={blocked ?? (native ? nativeHint : undefined)}
            className={`grid min-w-0${blocked ? " cursor-not-allowed" : ""}`}
          >
            <button
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={`${verb} ${symbol}${blocked ? ` — ${blocked}` : ""}`}
              disabled={Boolean(blocked)}
              onClick={() => onChange(option)}
              data-selected={active && !blocked}
              /* `.doku-pair-key` — the machined key the launch bench picks a pair with, so choosing
               what to *fund* a buy with and choosing what a market is *priced* in are visibly the
               same kind of decision. */
              className={[
                /* `pr-4` always, selected or not: the tick is pinned in that corner, and a key that
                 changes width when you press it makes the row twitch. */
                "doku-pair-key relative flex h-12 min-w-0 items-center gap-2.5 rounded-doku-xl pl-2.5 pr-4",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku",
                blocked ? "text-mute" : active ? "text-doku-ink" : "text-ash hover:text-ink",
              ].join(" ")}
            >
              {/* The mark, in the recess every asset in this product sits in. */}
              <span
                className={[
                  "doku-well grid h-8 w-8 shrink-0 place-items-center rounded-doku-lg transition-shadow duration-200",
                  active ? "shadow-[inset_0_0_0_1px_rgb(var(--doku-rgb)/0.45)]" : "",
                ].join(" ")}
              >
                {asset ? (
                  <AssetIcon asset={asset} size={20} className="rounded-[5px]" />
                ) : (
                  <span className="font-numeric text-[11px] font-semibold leading-none text-mute">
                    {symbol.slice(0, 2).toUpperCase()}
                  </span>
                )}
              </span>

              <span className="flex min-w-0 flex-col items-start gap-1.5">
                <span className="font-ui font-semibold text-[11px] uppercase leading-none tracking-[0.05em] text-mute">
                  {verb}
                </span>
                <span className="min-w-0 truncate font-numeric text-[13px] font-semibold leading-none">
                  {symbol}
                </span>
              </span>

              {/* The badge sits where the tick would, because the two states are mutually exclusive:
                a key you cannot pick is never the picked one. */}
              {blocked && (
                <span className="doku-pay-soon absolute right-1.5 top-1.5 rounded-doku-sm px-1.5 py-0.5 font-pixel text-[11px] uppercase leading-none tracking-[0.06em] text-warn-ink">
                  Soon
                </span>
              )}

              {/* The tick, in the corner — the same mark `PairSelect` puts on a chosen asset. Pinned
                rather than in the flow, so a selected key is not a different width from an
                unselected one. */}
              {active && !blocked && (
                <span
                  aria-hidden
                  className="absolute right-1.5 top-1.5 grid h-[15px] w-[15px] place-items-center rounded-full bg-doku text-[var(--mat-cta-ink)]"
                >
                  <svg
                    width="9"
                    height="9"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M5 12.5 10 17.5 19 7" />
                  </svg>
                </span>
              )}
            </button>
          </span>
        );
      })}
    </div>
  );
};
