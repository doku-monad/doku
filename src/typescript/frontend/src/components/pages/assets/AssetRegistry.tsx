"use client";

import { cn } from "lib/utils/class-name";
import { useDeferredValue, useMemo, useRef, useState } from "react";

import { AssetIcon } from "@/components/ui/asset-icon";
import { displaySymbolText } from "@/lib/assets/display-symbol";
import {
  QUOTE_ASSET_KIND_LABELS,
  QUOTE_ASSET_KIND_NAMES,
  QUOTE_ASSET_KIND_ORDER,
  type QuoteAsset,
  type QuoteAssetKind,
  type QuoteAssetStatus,
} from "@/lib/assets/quote-assets";

import { SearchGlyph } from "./asset-chrome";
import LiveAssetCard from "./LiveAssetCard";
import UpcomingAssetTile from "./UpcomingAssetTile";

/**
 * The registry, and the three controls that find things in it.
 *
 * ## What this page is for
 *
 * Nobody reads a quote registry. They arrive holding a coin idea and one question — *what can I
 * pair this against* — and the previous version of this page answered it with two feature cards, a
 * kind filter buried beside a roadmap heading, and four thousand pixels of scroll. There was no
 * search at all, so the only way to find out whether DOKU supports gold was to read thirteen tiles.
 *
 * Three controls, three different questions, and they compose:
 *
 *   1. **The field** — a ticker, a name, a kind, or a contract address pasted out of a wallet. The
 *      address case is the one that justifies a search box on a ten-row list: somebody holding a
 *      token wants to know whether *that* token is a quote asset, and an address is the only
 *      question they can ask precisely.
 *   2. **The kind tray** — the same object the board filters pairs with, down to the class names.
 *      A filter should be one thing in a product, not one thing per page.
 *   3. **The status keys** — can I use it today, or is it a promise. This is the axis the page is
 *      actually about, so it sits at the top right where it is read first and pressed most.
 *
 * ## Cross-counted, on purpose
 *
 * Every count is computed over the *other* two controls' current state — kinds are counted within
 * the active search and status, statuses within the active search and kind. A count that ignores
 * the rest of the form is a promise the next press breaks, and this list is short enough that a
 * chip reading `5` which yields nothing is noticed immediately.
 *
 * ## Why the two sections survived the merge
 *
 * It would be simpler to render one grid of ten identical cells, and it would throw away the
 * answer. Two of ten are usable; a uniform grid makes that ratio something you work out by reading
 * ten status pills, and it forces either a dead `Launch` key on eight cards or a ragged one on two.
 * So the split stays — but it is now a split of *one filtered result set*, not two independent
 * lists with a control attached to the second. Searching `gold` searches both. Pressing
 * `Launchable` hides the other section rather than filtering inside it.
 *
 * @param assets the pickable registry, in the registry's own order. Sorted here, not by the
 *   caller: the order is a property of how this list is read, and the two consumers that render
 *   these assets elsewhere (the board's chips, the launch picker) want the registry's order.
 */

/** A registry row and everything the field can be asked about it, lower-cased once. */
type Haystack = { asset: QuoteAsset; text: string };

type Scope = "any" | "live" | "upcoming";

/** Live first, then deployed-but-not-enabled, then catalogued. The page's own priority order. */
const STATUS_RANK: Record<QuoteAssetStatus, number> = { live: 0, listed: 1, soon: 2 };

/* The board's own chip classes. Written out rather than imported from `PairFilter`, which would
   drag a portal, an anchored-menu hook and the whole registry fetch into this page's bundle for
   two strings. The CSS is shared, which is the half that drifts. */
const CHIP =
  "doku-pair-chip group/chip flex h-[32px] shrink-0 items-center gap-1.5 rounded-[9px] px-2.5 font-numeric text-[12px] leading-none tracking-[0.02em]";
const CHIP_COUNT =
  "doku-pair-count rounded-[4px] px-1.5 py-0.5 font-numeric text-[11.5px] leading-none tabular-nums";

const SCOPES: { key: Scope; label: string }[] = [
  { key: "any", label: "Any" },
  { key: "live", label: "Launchable" },
  { key: "upcoming", label: "On the way" },
];

/**
 * Everything one asset can be found by.
 *
 * Both the raw symbol and the display one: the registry calls Tether Gold `XAUt0` and this app
 * renders it `GOLD`, and somebody who has only ever seen the chip has no way to know the first
 * exists. Kind is in there in both its singular and plural forms for the same reason — "stablecoin"
 * and "stablecoins" are the same query to a person.
 */
const haystack = (asset: QuoteAsset): Haystack => ({
  asset,
  text: [
    asset.symbol,
    displaySymbolText(asset),
    asset.name,
    asset.underlying ?? "",
    QUOTE_ASSET_KIND_NAMES[asset.kind],
    QUOTE_ASSET_KIND_LABELS[asset.kind],
    asset.address ?? "",
  ]
    .join(" ")
    .toLowerCase(),
});

/**
 * A section's name and how many are in it.
 *
 * There was a line of explanation under each — "Enabled on chain — the launch form offers exactly
 * these" and "In the registry, not switched on for launches yet". Both were true and both were
 * telling a reader something the heading above them had already said, in smaller, fainter type. A
 * subtitle that paraphrases its own title is the thing that makes a page feel padded.
 */
const SectionHead = ({ title, count }: { title: string; count: number }) => (
  <div className="flex items-baseline gap-2.5">
    <h2 className="font-ui text-[16px] font-semibold uppercase leading-none tracking-[0.06em] text-ink">
      {title}
    </h2>
    <span className="font-numeric text-[12px] leading-none text-ash">
      {count} {count === 1 ? "asset" : "assets"}
    </span>
  </div>
);

export const AssetRegistry = ({ assets }: { assets: readonly QuoteAsset[] }) => {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<QuoteAssetKind | "all">("all");
  const [scope, setScope] = useState<Scope>("any");
  const fieldRef = useRef<HTMLInputElement>(null);

  /* Ten rows filter in well under a frame, so there is no debounce and no URL write — the field
     owns its value and the list follows it on the keystroke. `useDeferredValue` is the whole
     concession: it keeps the caret responsive if the grid ever grows past what one frame can
     re-render, without putting a timer between a person and their own typing. */
  const needle = useDeferredValue(query).trim().toLowerCase();

  const rows = useMemo(() => assets.map(haystack), [assets]);

  const byQuery = useMemo(
    () => (needle ? rows.filter((r) => r.text.includes(needle)) : rows),
    [rows, needle]
  );

  /*
   * The counts, each blind to its own control.
   *
   * `kindCounts` is measured after the search and the status keys have had their say but before
   * the kind tray has had its — otherwise pressing `Equities` would rewrite every other chip to
   * zero, which is a control that answers only the question you have already asked.
   */
  const inScope = useMemo(
    () =>
      byQuery.filter(({ asset }) =>
        scope === "any"
          ? true
          : scope === "live"
            ? asset.status === "live"
            : asset.status !== "live"
      ),
    [byQuery, scope]
  );

  const kindCounts = useMemo(() => {
    const map = new Map<QuoteAssetKind | "all", number>([["all", inScope.length]]);
    for (const { asset } of inScope) map.set(asset.kind, (map.get(asset.kind) ?? 0) + 1);
    return map;
  }, [inScope]);

  const inKind = useMemo(
    () => byQuery.filter(({ asset }) => kind === "all" || asset.kind === kind),
    [byQuery, kind]
  );

  const scopeCounts = useMemo(() => {
    const live = inKind.filter(({ asset }) => asset.status === "live").length;
    return { any: inKind.length, live, upcoming: inKind.length - live };
  }, [inKind]);

  /*
   * The result, sorted.
   *
   * Status, then how many coins already trade against it, then the registry's own order — which
   * `Array.prototype.sort` preserves for ties, so nothing has to carry an index. The second key is
   * what puts MON above USDC inside the live section without hard-coding either.
   */
  const shown = useMemo(() => {
    const out = inScope
      .filter(({ asset }) => kind === "all" || asset.kind === kind)
      .map((r) => r.asset);
    return out.sort(
      (a, b) =>
        STATUS_RANK[a.status] - STATUS_RANK[b.status] || (b.marketCount ?? 0) - (a.marketCount ?? 0)
    );
  }, [inScope, kind]);

  const live = shown.filter((a) => a.status === "live");
  const upcoming = shown.filter((a) => a.status !== "live");

  /* The kinds present in the whole registry, in its order — not in the filtered set. A tray whose
     chips appear and disappear as you type is a tray you cannot aim at. They carry a zero instead,
     which is a fact rather than a vanishing act. */
  const kinds = useMemo(
    () => QUOTE_ASSET_KIND_ORDER.filter((k) => assets.some((a) => a.kind === k)),
    [assets]
  );

  const filtered = Boolean(needle) || kind !== "all" || scope !== "any";

  const reset = () => {
    setQuery("");
    setKind("all");
    setScope("any");
    fieldRef.current?.focus();
  };

  return (
    <section className="flex flex-col gap-5">
      {/* ================================================================================
          The controls.

          Two rows on every screen, which is a decision rather than a fallback: the field and the
          status keys are the two things somebody arrives wanting, and the kind tray is the one
          they reach for second. Putting all three on one line at `lg` would leave a 200px field
          beside two trays, and a search box you cannot read your own query in is the fastest way
          to make a page feel cheap.
         ================================================================================ */}
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-3">
          {/*
            The field.

            `.doku-searchfield` is the house recess — the same slot the top bar types into — rather
            than a bordered box, which would be the one un-machined object on a page built out of
            trays and wells. It is a `<label>` wrapping its own input, so the whole 40px slot is the
            target and there is no hit zone beside the caret that does nothing.

            No `/` or `⌘K` hint: the header already binds both, globally, to the coin search modal,
            and a second field advertising the same key would steal a shortcut it cannot honour.
          */}
          <label
            role="search"
            className="doku-searchfield flex h-10 w-full min-w-0 items-center gap-2.5 rounded-doku-xl px-3 text-mute sm:max-w-[340px]"
          >
            <SearchGlyph />
            <input
              ref={fieldRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Ticker, name or contract"
              aria-label="Search the quote registry by ticker, name, kind or contract address"
              /* `[&::-webkit-search-cancel-button]:hidden`: Chrome draws its own grey ✕ inside a
                 `type="search"` input, which on the dark stage is a light glyph nobody styled
                 sitting next to the one below that matches the page. */
              className="min-w-0 flex-1 border-transparent bg-transparent p-0 font-ui text-[13.5px] leading-none text-ink outline-none placeholder:text-ash [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  fieldRef.current?.focus();
                }}
                aria-label="Clear the search"
                className="doku-tap shrink-0 font-numeric text-[12px] uppercase leading-none tracking-[0.07em] text-ash transition-colors hover:text-ink"
              >
                Clear
              </button>
            )}
          </label>

          {/*
            Can I use it today.

            A segmented control rather than a third row of chips, and the difference in construction
            is the point: the kind tray below is a set of *categories*, this is a set of *states*,
            and giving two different questions the same control is how a toolbar ends up reading as
            one long undifferentiated row of pills.

            `role="group"` with `aria-pressed`, not a tablist. A tablist obliges every tab to own a
            panel through `aria-controls` and announces "tab 2 of 3" while waiting for arrow keys.
            There are no panels here — it filters one list in place.
          */}
          {/* No `doku-chiprow` here. That class masks its trailing edge so a *cut* chip reads as
              "there is more" — and this control is three keys that fit at every width the page is
              used at, so the mask was permanently fading `On the way` for nothing. A fade belongs
              on a row that actually scrolls; see the kind tray below, which does. */}
          <div
            role="group"
            aria-label="Filter by availability"
            className="flex items-center sm:ml-auto sm:mr-0"
          >
            <div className="doku-seg flex shrink-0 items-center gap-1 rounded-[13px] p-1">
              {SCOPES.map((option) => {
                const selected = scope === option.key;
                return (
                  <button
                    key={option.key}
                    type="button"
                    aria-pressed={selected}
                    data-active={selected}
                    onClick={() => setScope(option.key)}
                    className="doku-seg-key inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[10px] px-3 font-ui text-[12.5px] font-semibold"
                  >
                    {option.label}
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-0.5 font-numeric text-[11.5px] font-medium leading-none tabular-nums",
                        selected ? "bg-[var(--film-3)] text-ash" : "bg-[var(--film-1)] text-mute"
                      )}
                    >
                      {scopeCounts[option.key]}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/*
          `flex-wrap`, and the tally wraps rather than the tray shrinking.

          These two shared one non-wrapping row, and the tray was `max-w-full` — so between roughly
          780px and 1024px the tally won the fight for width, the tray gave ground, and the last
          chip was sliced by the tray's own rounded corner. Letting the row wrap means the tray is
          never squeezed below its content at any viewport: the tally drops to its own line instead,
          which is the honest thing for a count to do.
        */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {/*
            The kind tray, built exactly like the board's pair filter — `doku-pair-tray`, its label
            plate, the snapping scroller and the chips. Two pages, one filter.

            `w-fit max-w-full`, not `flex-1`. A recessed tray is a machined object and has to hug
            what is standing in it: stretched to a 1100px rail it left four hundred pixels of empty
            metal after the last chip, which reads as a control that failed to fill rather than as
            a row of six. `max-w-full` with `min-w-0` on the scroller inside is what lets it give
            ground on a phone instead of shearing its last chip off the page.
          */}
          <div className="doku-pair-tray flex w-fit min-w-0 max-w-full items-stretch rounded-doku-xl p-[3px]">
            <span className="doku-pair-label hidden shrink-0 items-center rounded-[9px] px-2.5 font-numeric text-[11.5px] uppercase leading-none tracking-[0.08em] text-ash sm:flex">
              Kind
            </span>

            {/* `pr-1`: the tray is content-sized, so without it the last chip's right edge lands
                on the tray's 3px wall and its corner is cropped by the tray's 12px radius —
                visible as `Real-world assets` looking sheared at every width where it fits. */}
            <div
              role="group"
              aria-label="Filter by kind"
              className="doku-pair-scroll no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pr-1"
            >
              <button
                type="button"
                aria-pressed={kind === "all"}
                data-active={kind === "all"}
                onClick={() => setKind("all")}
                className={cn(CHIP, "uppercase tracking-[0.08em]")}
              >
                All
                <span className={CHIP_COUNT}>{kindCounts.get("all") ?? 0}</span>
              </button>

              {kinds.map((k) => {
                const count = kindCounts.get(k) ?? 0;
                const sample = assets.find((a) => a.kind === k);
                return (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={kind === k}
                    data-active={kind === k}
                    data-empty={count === 0}
                    onClick={() => setKind(k)}
                    title={`${count} ${QUOTE_ASSET_KIND_LABELS[k].toLowerCase()} in the registry`}
                    className={CHIP}
                  >
                    {/* A mark from the category, at chip size. It is how the board's row reads and
                        it does real work here: `RWA` and `Equities` mean nothing until there is a
                        gold bar or an Apple logo next to them. */}
                    {sample && <AssetIcon asset={sample} size={15} className="doku-pair-mark" />}
                    {QUOTE_ASSET_KIND_LABELS[k]}
                    <span className={CHIP_COUNT}>{count}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* The tally, and the way back. `aria-live` so a filter press is announced rather than
              being a change only a sighted visitor gets told about. */}
          <span
            aria-live="polite"
            className="ml-auto flex shrink-0 items-center gap-2.5 font-numeric text-[12px] uppercase leading-none tracking-[0.07em] text-ash"
          >
            {shown.length}/{assets.length}
            {filtered && (
              <button
                type="button"
                onClick={reset}
                className="doku-token-key rounded-doku-lg px-2 py-1.5 font-numeric text-[12px] uppercase leading-none tracking-[0.07em] text-ash"
              >
                Reset
              </button>
            )}
          </span>
        </div>
      </div>

      {/* ================================================================================
          The result.
         ================================================================================ */}
      {shown.length === 0 ? (
        <div className="doku-asset-void flex flex-col items-center gap-3 rounded-doku-2xl px-6 py-10 text-center">
          <p className="max-w-[42ch] font-ui text-[14px] leading-relaxed text-ash">
            {needle ? (
              <>
                Nothing in the registry matches{" "}
                <span className="font-numeric text-ink">“{query.trim()}”</span>
                {kind !== "all" || scope !== "any" ? " under these filters" : ""}.
              </>
            ) : (
              "No asset in the registry matches these filters."
            )}
          </p>
          <button
            type="button"
            onClick={reset}
            className="doku-ghost inline-flex h-10 items-center rounded-doku-xl px-4 font-numeric text-[12px] uppercase leading-none tracking-[0.07em] text-ash"
          >
            Reset the filters
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-7">
          {live.length > 0 && (
            <section className="flex flex-col gap-3.5">
              <SectionHead title="Launchable now" count={live.length} />
              {/*
                Two across from `md`. One card on an 820px tablet is an 800px-wide object holding a
                nine-word blurb, three figures and a button — the figure cells come out at 260px
                each for values that are eight characters long, and the whole card reads as a
                stretched container rather than as a card.

                Not below `md`: at 640px a pair puts the figure cells at about 96px, and the
                graduation value carries its own ticker.

                `auto-rows-fr` so a pair of cards with blurbs of different lengths share a height —
                the slack lands in the blurb, and the figure bands rule across the row.
              */}
              {/*
                As many cards as fit at 255px, rather than a fixed two.

                `auto-fill` with a `minmax` floor is the honest expression of "compact enough for
                three or four per row": the track count comes from the rail's width instead of from
                a breakpoint somebody guessed, so the same grid gives one card on a phone, two on a
                tablet and four on a 1100px rail — and it keeps giving four as more assets go live
                rather than stretching two of them across the whole page.

                `auto-fill` and not `auto-fit`: `auto-fit` collapses the empty tracks, which would
                stretch two live assets back to half the rail and undo the compacting.
              */}
              <div className="grid auto-rows-fr grid-cols-[repeat(auto-fill,minmax(255px,1fr))] gap-3.5">
                {live.map((asset) => (
                  <LiveAssetCard key={asset.id} asset={asset} />
                ))}
              </div>
            </section>
          )}

          {upcoming.length > 0 && (
            <section className="flex flex-col gap-3.5">
              <SectionHead title="On the way" count={upcoming.length} />
              {/*
                One column on a phone, three from 640px, four on a laptop.

                Two columns at phone width was the wrong trade. Measured at 390px it left the
                tile's foot 53px of content for an 82px `Coming soon` beside the two explorer keys,
                and truncated `Coinbase Wrapped BTC` to `Coinbase Wrapped`. A full-width tile has
                330px there, so the status reads, the name reads, and the mark has room to look
                like something. It costs four rows of scroll in the half of the page that is a
                roadmap rather than a menu — which is the right place to spend them.
              */}
              <div className="grid auto-rows-fr grid-cols-1 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
                {upcoming.map((asset) => (
                  <UpcomingAssetTile key={asset.id} asset={asset} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </section>
  );
};

export default AssetRegistry;
