"use client";

import { cn } from "lib/utils/class-name";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { AssetIcon } from "@/components/ui/asset-icon";
import { displaySymbolText } from "@/lib/assets/display-symbol";
import {
  HIDDEN_QUOTE_IDS,
  pickableQuoteAssets,
  QUOTE_ASSET_KIND_LABELS,
  QUOTE_ASSET_KIND_ORDER,
  type QuoteAsset,
} from "@/lib/assets/quote-assets";
import { useAnchoredMenu } from "@/lib/hooks/use-anchored-menu";
import { useQuoteAssets } from "@/lib/hooks/use-quote-assets";

/**
 * The pair chips — the row that says what a coin on this board is quoted *in*.
 *
 * A board of coins that all show a market cap and none show a denomination is a board of numbers in
 * unstated units. This is the control that states them, and on a launchpad whose whole proposition
 * is "pair against anything" it is also the fastest statement of what that anything currently is:
 * one native quote, a stablecoin, and a shelf of tokenized equities and real-world assets.
 *
 * ## Why it kept disappearing
 *
 * The row was built from `useQuoteAssets()` alone, so when the registry fetch was pending or
 * failing — the indexer down, a cold start, an offline dev environment — `assets` came back `[]`
 * and the component rendered exactly one chip: `All`. Not a spinner, not an error, not a narrower
 * row. The entire filter bar simply was not there, and nothing on screen said why. A control that
 * deletes itself on a network failure is worse than one that fails loudly, because the person
 * looking at it concludes the feature was removed.
 *
 * Three things fix that, and they are the whole of this component's structure:
 *
 *   1. **The chips are a union, not a copy.** The registry is one source; the board's own
 *      `counts` — computed server-side over the current search, keyed by asset id — is the other.
 *      Any pair that actually has markets gets a chip even if the registry never answered, because
 *      the board is already holding proof that the pair exists.
 *   2. **Pending renders the shape.** Placeholder keys at the row's real height, so the toolbar
 *      does not change size when the registry lands and nobody watches the bar pop into being.
 *   3. **Failure says so, and offers the retry.** `isError` with nothing derivable from `counts` is
 *      the one case where there is genuinely nothing to draw, and it draws a sentence and a button
 *      rather than a blank strip.
 *
 * ## Why the counts are on the chips
 *
 * Because most of them are zero, and that is the honest state of the product right now — one live
 * quote asset and eleven on the way. A chip row without counts invites eleven clicks that each
 * return an empty board; a chip row with counts answers the question before the click. When the
 * other assets go live the same row starts carrying real numbers and nothing here changes.
 *
 * Assets with no markets are still rendered rather than filtered out. They are the roadmap, and a
 * launchpad that shows what it is about to support is making a promise it can be held to.
 *
 * ## Why it is a tray of keys
 *
 * It was a row of loose outlined pills on the toolbar's flat ground — the one control on the board
 * built out of colour rather than material, beside a hero rail, a runner board and forty cards that
 * are all built out of trays, rims and raised faces. It is that construction now, at chip scale: a
 * recessed tray with a `PAIR` label plate seamed off at its head and the chips standing proud
 * inside it. Selected takes the brand rim and a lit ground; a pair with no markets yet is held back
 * rather than removed.
 */

/** A chip with no markets behind it yet is dimmed, not hidden — see the note above. */
/*
 * `.doku-pair-chip`, not `.doku-pair-key`.
 *
 * This row and the hero rail are the same 30px object, and the chip class is what carries that
 * treatment. `.doku-pair-key` is something else — the machined bezel key the launch pair picker
 * wears at 56px, along with PayWith, DevBuy, CreatorFee and the slippage keys. While this row
 * shared the name, its `color: mute` and its `::after { inset: -7px 0 }` hit-pad were landing on
 * all of them: every machined key painted its label mute (the SELECTED one included), and on the
 * launch picker's wrapped grid the 7px pads of adjacent rows overlapped, so a press between rows
 * selected the row below. See the note over the block in `global.css`.
 */
const KEY_BASE =
  "doku-pair-chip group/pair flex h-[30px] shrink-0 items-center gap-1.5 rounded-[9px] px-2.5 font-numeric text-[11px] leading-none tracking-[0.02em]";

/** The count, as a small recessed plate rather than as dimmed type beside the ticker. */
const COUNT = "doku-pair-count rounded-[4px] px-1 py-0.5 text-[11px] leading-none tabular-nums";

/**
 * What the row draws, resolved once.
 *
 * The registry in its own order, then anything `counts` knows about that the registry does not.
 * That second half is the whole point: it is what keeps a chip on screen for a live pair while the
 * registry is unreachable, and it also covers the case of a pair enabled on chain that this build's
 * registry read happens to be behind on.
 */
type Chip = { id: string; symbol: string; asset?: QuoteAsset; count: number };

const buildChips = (assets: readonly QuoteAsset[], counts: Record<string, number>): Chip[] => {
  const order = new Map(QUOTE_ASSET_KIND_ORDER.map((kind, i) => [kind, i]));
  /*
   * Live pairs only — what a coin can be launched against today, the launch picker's own filter.
   * The row listed every catalogued asset, so four tokenized equities the factory refuses sat here
   * at "0", offering a filter that could only ever return nothing.
   *
   * With one exception: a pair the board already HAS markets in keeps its chip even if it stops
   * being live. Hiding it from the launch form is a product decision; making somebody's existing
   * coin impossible to filter to is not.
   */
  const known = pickableQuoteAssets(assets)
    .filter((asset) => asset.status === "live" || (counts[asset.id] ?? 0) > 0)
    .sort((a, b) => (order.get(a.kind) ?? 99) - (order.get(b.kind) ?? 99))
    /* `displaySymbolText`, not `asset.symbol`: this row and the launch picker are two views of one
       registry, and a board that says `cbBTC` beside a picker that says `BTC` reads as two
       different assets. The alias is display-only — `chip.id` is still what `onChange` and the
       `?pair=` param carry. */
    .map((asset) => ({
      id: asset.id,
      symbol: displaySymbolText(asset),
      asset,
      count: counts[asset.id] ?? 0,
    }));

  const seen = new Set(known.map((c) => c.id));
  /* Ids the board has markets for but the registry did not describe. The id is URL-safe and lower
     case by construction, so upper-casing it is a reasonable stand-in for a symbol nobody sent. */
  /* `HIDDEN_QUOTE_IDS` has to be applied HERE too, not only to `known`. This branch invents a chip
     from the counts for any pair the registry did not describe — so a market still quoted in a
     withheld asset would come back as a chip labelled from its raw id, with no mark and no name.
     Hiding it from the registry and then resurrecting it from the board is worse than either. */
  const unknown = Object.entries(counts)
    .filter(([id, count]) => count > 0 && !seen.has(id) && !HIDDEN_QUOTE_IDS.has(id))
    .map(([id, count]) => ({ id, symbol: id.toUpperCase(), count }));

  return [...known, ...unknown];
};

const PairFilter = ({
  active,
  counts,
  total,
  onChange,
  className,
}: {
  /** The selected registry id, or `undefined` for every pair. */
  active?: string;
  counts: Record<string, number>;
  total: number;
  onChange: (pair: string | undefined) => void;
  /** How the tray sits in the row it was given. The board's toolbar hands it the line. */
  className?: string;
}) => {
  const { assets, isPending, isError, refetch } = useQuoteAssets();

  const chips = buildChips(assets, counts);
  const [query, setQuery] = useState("");

  /*
   * Grouped by kind, in the registry's own order, narrowed by the search.
   *
   * Kinds are how somebody actually looks for one of these — "the gold one", "a stablecoin" — and
   * the labels already exist for the launch picker and the /assets page. The query matches the
   * ticker, the asset's name and its id, so "tes" finds Tesla and "gold" finds it by name rather
   * than by a ticker nobody has memorised.
   */
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = (c: Chip) =>
      !q ||
      c.symbol.toLowerCase().includes(q) ||
      c.id.toLowerCase().includes(q) ||
      (c.asset?.name ?? "").toLowerCase().includes(q);

    const out: [string, Chip[]][] = [];
    for (const kind of QUOTE_ASSET_KIND_ORDER) {
      const rows = chips.filter((c) => c.asset?.kind === kind && hit(c));
      if (rows.length) out.push([QUOTE_ASSET_KIND_LABELS[kind], rows]);
    }
    /* Pairs the registry never described but the board has markets for — see `buildChips`. */
    const rest = chips.filter((c) => !c.asset && hit(c));
    if (rest.length) out.push(["Other", rest]);
    return out;
  }, [chips, query]);

  /* The panel is capped and scrolls inside, so this estimate only has to be right enough for the
     hook to decide whether to flip above the trigger. 42 is the search field plus its margin. */
  const menuHeight = Math.min(380, 42 + 34 + grouped.length * 22 + chips.length * 40 + 12);
  const { open, setOpen, triggerRef, menuRef, menuStyle } = useAnchoredMenu<HTMLButtonElement>({
    width: 244,
    height: menuHeight,
    align: "right",
  });

  /* A fresh search every time it opens: a query left over from last time hides the row somebody
     came back for. */
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  return (
    <>
      <div
        className={cn(
          "doku-pair-tray flex w-full min-w-0 shrink items-stretch rounded-doku-xl p-[3px] sm:w-auto",
          className
        )}
      >
        {/* The label plate. Names the row without spending a line of type above it. */}
        <span className="doku-pair-label hidden shrink-0 items-center rounded-[9px] px-2.5 font-numeric text-[11px] uppercase leading-none tracking-[0.1em] text-mute sm:flex">
          Pair
        </span>

        {/*
          The spread row, kept.

          A visible row of pairs is worth its width: it answers "what can I filter by" without a
          press, and the common pairs are one tap away. What it cannot do is scale — so it no longer
          has to. It holds what fits and the key at the end holds the rest.
        */}
        <div className="doku-pair-scroll no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          <button
            type="button"
            onClick={() => onChange(undefined)}
            aria-pressed={!active}
            data-active={!active}
            className={cn(KEY_BASE, "uppercase tracking-[0.08em]")}
          >
            All
            <span className={COUNT}>{total}</span>
          </button>

          {chips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              onClick={() => onChange(chip.id)}
              aria-pressed={active === chip.id}
              data-active={active === chip.id}
              data-empty={chip.count === 0}
              title={
                chip.count > 0
                  ? `${chip.count} market${chip.count === 1 ? "" : "s"} quoted in ${chip.symbol}`
                  : `No markets quoted in ${chip.symbol} yet`
              }
              className={KEY_BASE}
            >
              {chip.asset ? (
                <AssetIcon asset={chip.asset} size={16} className="doku-pair-mark" />
              ) : (
                /* A pair the registry has not described. It still gets a slot the size of a mark,
                   so the row's rhythm survives a partial answer. */
                <span
                  aria-hidden
                  className="doku-pair-mark h-4 w-4 rounded-[5px] bg-[var(--film-3)]"
                />
              )}
              {chip.symbol}
              <span className={COUNT}>{chip.count}</span>
            </button>
          ))}

          {/* Pending: the row's shape, held — so the toolbar is the same height before and after
              the registry lands and nothing below it moves. */}
          {isPending &&
            chips.length === 0 &&
            [0, 1, 2].map((i) => (
              <span
                key={`skeleton-${i}`}
                aria-hidden
                className="doku-skeleton h-[30px] w-[86px] shrink-0 rounded-[9px]"
              />
            ))}

          {isError && chips.length === 0 && (
            <span className="flex shrink-0 items-center gap-2 pl-1 font-numeric text-[11px] leading-none text-mute">
              Pairs unavailable
              <button
                type="button"
                onClick={() => refetch()}
                className="doku-pair-chip rounded-[9px] px-2 py-1.5 uppercase tracking-[0.08em]"
              >
                Retry
              </button>
            </span>
          )}
        </div>

        {/*
          The key at the end, outside the scroller.

          `shrink-0` and a sibling of the row rather than its last child, which is the whole point:
          inside, it would scroll away exactly when the row got long enough to need it. It is the
          way to every pair — searchable and grouped — so the row in front of it never has to be
          complete.
        */}
        {chips.length > 0 && (
          <>
            <span aria-hidden className="doku-pair-seam mx-1 w-px shrink-0 self-stretch" />
            <button
              ref={triggerRef}
              type="button"
              aria-haspopup="listbox"
              aria-expanded={open}
              aria-label="Browse all pairs"
              onClick={() => setOpen((v) => !v)}
              data-active={open}
              className={cn(KEY_BASE, "shrink-0 px-2")}
            >
              <svg
                aria-hidden
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={cn("transition-transform duration-200", open && "rotate-180")}
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
          </>
        )}
      </div>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-label="Filter by pair"
            style={menuStyle}
            className="doku-popover z-[200] flex max-h-[min(380px,70dvh)] flex-col rounded-[16px] p-1.5"
          >
            {/*
              The search, built like the top bar's.

              `.doku-searchfield` is the house recess — pressed in, catch-light along the foot,
              hairline all round, and its rim lights on focus without changing size. A plain
              bordered box here would be the one un-machined object inside a machined panel.
            */}
            <label className="doku-searchfield mb-1.5 flex h-9 shrink-0 items-center gap-2 rounded-[11px] px-2.5">
              <svg
                aria-hidden
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                className="shrink-0 text-mute"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.2-3.2" />
              </svg>
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search pairs"
                aria-label="Search pairs"
                className="min-w-0 flex-1 border-transparent bg-transparent p-0 font-ui text-[13px] leading-none text-ink outline-none placeholder:text-mute"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  className="shrink-0 font-numeric text-[11px] leading-none text-mute transition-colors hover:text-ink"
                >
                  Clear
                </button>
              )}
            </label>

            {/* `overscroll-contain`: without it, reaching the end of this list hands the wheel to the
                page behind — so scrolling the pair list scrolled the board out from under the open
                menu. Containing it makes the list the only thing that moves, which is also what a
                touch drag needs on a phone. */}
            <div className="doku-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {!query && (
                <button
                  type="button"
                  role="option"
                  aria-selected={!active}
                  data-selected={!active}
                  onClick={() => {
                    onChange(undefined);
                    setOpen(false);
                  }}
                  className="doku-fund-option flex w-full items-center gap-2.5 rounded-doku-lg px-2 py-2 text-left"
                >
                  <span className="min-w-0 flex-1 truncate font-numeric text-[12.5px] font-semibold uppercase leading-none tracking-[0.04em] text-ink">
                    All pairs
                  </span>
                  <span className={COUNT}>{total}</span>
                </button>
              )}

              {grouped.map(([kind, rows]) => (
                <div key={kind}>
                  <span className="mt-1 block px-2 pb-1 pt-1.5 font-numeric text-[11px] uppercase leading-none tracking-[0.1em] text-faint">
                    {kind}
                  </span>
                  {rows.map((chip) => (
                    <button
                      key={chip.id}
                      type="button"
                      role="option"
                      aria-selected={active === chip.id}
                      data-selected={active === chip.id}
                      onClick={() => {
                        onChange(chip.id);
                        setOpen(false);
                      }}
                      className="doku-fund-option flex w-full items-center gap-2.5 rounded-doku-lg px-2 py-1.5 text-left"
                    >
                      {chip.asset ? (
                        <AssetIcon
                          asset={chip.asset}
                          size={18}
                          className="shrink-0 rounded-[5px]"
                        />
                      ) : (
                        <span
                          aria-hidden
                          className="h-[18px] w-[18px] shrink-0 rounded-[5px] bg-[var(--film-3)]"
                        />
                      )}
                      <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                        {/* No `uppercase`. A tokenized equity's ticker carries a lower-case `x` by
                          convention and the chip row beside this menu keeps it — flattening it
                          here printed `NVDAX`, an asset that does not exist, two inches from a
                          chip reading `NVDAx`. Same argument `UpcomingAssetTile` makes. */}
                        <span className="w-full truncate font-numeric text-[12.5px] font-semibold leading-none tracking-[0.02em] text-ink">
                          {chip.symbol}
                        </span>
                        {chip.asset?.name &&
                          chip.asset.name.toUpperCase() !== chip.symbol.toUpperCase() && (
                            <span className="w-full truncate font-ui text-[11px] leading-none text-mute">
                              {chip.asset.name}
                            </span>
                          )}
                      </span>
                      <span className={COUNT}>{chip.count}</span>
                    </button>
                  ))}
                </div>
              ))}

              {/* A search with no answer says so, rather than leaving an empty panel. */}
              {query && grouped.length === 0 && (
                <p className="px-2 py-6 text-center font-ui text-[13px] leading-snug text-mute">
                  No pair matches &ldquo;{query}&rdquo;.
                </p>
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  );
};

export default PairFilter;
