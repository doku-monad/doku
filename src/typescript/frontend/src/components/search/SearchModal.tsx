"use client";

import { PixelSearch } from "components/svg";
import { Keycap } from "components/ui/keycap";
import { identityInputFor, useMarketList } from "lib/hooks/use-market-list";
import { cn } from "lib/utils/class-name";
import { formatCompact } from "lib/utils/format-compact";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { CoinMark } from "@/components/ui/coin-mark";
import { useMarketChanges } from "@/lib/hooks/doku/use-market-change";
import { capFigure } from "@/lib/market-cap";
import { marketPath } from "@/lib/market-path";
import { priceFigure } from "@/lib/price-figure";
import { identityFor } from "@/lib/token-identity";

/**
 * Global search, modelled on DOKU's command palette
 * (`~/doku-launchpad/components/chrome/command-palette.tsx`).
 *
 * Mounted only while open, so every invocation starts from a clean slate. The market list is
 * fetched once per opening and cached by TanStack Query, so reopening within the cache window is
 * instant. It used to read a registered-market map held by the websocket store; that store is
 * gone, and a list this small is cheaper to fetch than to keep in memory on every page.
 *
 * Keyboard: ↑/↓ move, Enter opens, Escape closes. ⌘K / Ctrl+K and `/` open it from anywhere; that
 * lives in the header so the shortcut works without this component mounted.
 */

/** How many hits the palette will show. Also the ceiling on the change requests it fires. */
const MAX_RESULTS = 8;

/**
 * A figure and the label above it, in the app's stat idiom.
 *
 * The label is what makes three numbers side by side readable rather than a row of digits; it is
 * pixel-cased and mute so it never competes with the value it names.
 */
const Stat = ({
  label,
  children,
  className,
  containerClassName,
}: {
  label: string;
  children: ReactNode;
  /** On the value. */
  className?: string;
  /** On the pair, for the breakpoint at which a stat drops out of the row entirely. */
  containerClassName?: string;
}) => (
  <div className={cn("flex min-w-0 flex-col items-end gap-1.5", containerClassName)}>
    <span className="font-numeric text-[11px] uppercase leading-none tracking-[0.1em] text-mute">
      {label}
    </span>
    <span
      className={cn(
        "truncate font-numeric text-[13px] font-semibold leading-none tabular-nums text-ink",
        className
      )}
    >
      {children}
    </span>
  </div>
);

export function SearchModal({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const { data: markets } = useMarketList();

  /*
   * Every coin, resolved once, then filtered.
   *
   * The identity is attached here rather than looked up per row, so the same object drives both the
   * match and the label — a palette that matches on one string and displays another is one where
   * the top hit looks like it does not contain what you typed.
   *
   * Four fields are searched: name, ticker, the on-chain symbol, and the address. Whoever opens
   * this has exactly one of those in their head, and which one depends entirely on where they
   * came from.
   */
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = (markets ?? []).map((m) => ({
      market: m,
      identity: identityFor(identityInputFor(m)),
    }));
    const filtered = q
      ? all.filter(
          ({ market, identity }) =>
            identity.name.toLowerCase().includes(q) ||
            identity.ticker.toLowerCase().includes(q) ||
            market.symbol.includes(q) ||
            market.marketAddress.toLowerCase().startsWith(q)
        )
      : all;
    return filtered.slice(0, MAX_RESULTS);
  }, [markets, query]);

  /*
   * The 24-hour change, for the rows on screen and no others.
   *
   * A request per market, so the address list is the bound: at most eight, cached for ten minutes,
   * and narrowed further by whatever the person has typed. See the hook for why the figure cannot
   * come off the market row itself.
   */
  const changes = useMarketChanges(
    useMemo(() => results.map(({ market }) => market.marketAddress), [results])
  );

  /*
   * Focus on mount, and hand it back on close.
   *
   * The palette declared `role="dialog" aria-modal="true"` and then did neither of the two things
   * that claim commits it to: focus could Tab straight out of the panel and onto the board behind
   * the scrim (verified — six tabs reached a pair chip), and closing left focus wherever it had
   * wandered rather than on the control that opened it. `aria-modal` also tells a screen reader the
   * rest of the page is inert, which was not true.
   *
   * `BaseModal` (headlessui) does all of this; this palette is hand-built because it is a command
   * list rather than a dialog with content, so it gets the same three behaviours by hand: restore
   * on unmount, and the Tab cycle below.
   */
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => previous?.focus?.();
  }, []);
  useEffect(() => {
    setIndex(0);
  }, [query]);

  // Keep the highlighted row in view when the keyboard walks past the fold.
  useEffect(() => {
    listRef.current?.children[index]?.scrollIntoView({ block: "nearest" });
  }, [index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
      /*
       * The Tab cycle.
       *
       * Collected on each press rather than on mount: the result rows are the focusable elements
       * here and they change with every keystroke, so a list captured once would send Tab to a row
       * that no longer exists. The set is small (a field, a clear key and at most eight rows), and
       * this runs only on Tab.
       */
      if (e.key === "Tab") {
        const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (!focusable?.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !panelRef.current?.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !panelRef.current?.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setIndex((i) => (i + 1) % Math.max(1, results.length));
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setIndex((i) => (i - 1 + results.length) % Math.max(1, results.length));
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const hit = results[index];
        if (hit) {
          router.push(marketPath(hit.market.tokenAddress));
          onClose();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [results, index, router, onClose]);

  return (
    <div
      /* `dvh`, not `vh`. On a phone `vh` resolves to the LARGE viewport — the height the page would
         have with the browser chrome hidden — so the offset above the field and the list's own cap
         were both measured against space that is not there while the toolbar is showing. Add the
         on-screen keyboard, which this palette raises the moment it opens, and the bottom of the
         list and the hint row under it fell below the fold. */
      className="fixed inset-0 z-[100] flex items-start justify-center px-5 pt-[9dvh] sm:px-8 sm:pt-[12dvh]"
      role="dialog"
      aria-modal="true"
      aria-label="Search markets"
    >
      {/*
        Scrim.

        `rounded-none` is load-bearing. `global.css` gives every button a pill radius by default —
        which is right for a control and absurd for a element that covers the viewport: at
        1440x900 a 9999px radius is a giant grey ellipse with the page showing through its corners,
        which is exactly what this looked like. The base rule is `:where(button, [role="button"])`
        and so contributes no specificity, so one class is enough to opt out.

        The fill is `--veil-3`, not `bg-canvas/80`. `tailwind.config.js` maps BOTH `black` and
        `canvas` onto the canvas role, which on paper is `rgb(237 240 238)` — so 80% of it over a
        white page dimmed nothing at all, on the one overlay in the product that covers the entire
        viewport. `--veil-3` is the token stated per theme for a scrim over content (65% black on
        the stage, 38% ink on paper), and `BaseModal` already went through this exact fix.
      */}
      <button
        aria-label="Close search"
        onClick={onClose}
        className="absolute inset-0 cursor-default rounded-none bg-[var(--veil-3)] backdrop-blur-[3px]"
      />

      {/*
        The panel, built the way `Panel` builds one: a floating rim just outside the glass edge, so
        the palette reads as lifted off the page rather than drawn on it. The rim is a hairline at
        low alpha — the reference's depth is surface steps and outlines, never a drop shadow, and
        the one real shadow here is the float the whole dialog casts.
      */}
      {/* `panelRef` bounds the Tab cycle above: everything focusable inside this box is the
          palette, everything outside it is the page the scrim covers. */}
      <div ref={panelRef} className="relative w-full max-w-[600px]">
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-[3px] rounded-[23px] opacity-70"
          style={{
            background: "linear-gradient(180deg, var(--film-3), var(--film-1) 40%, var(--film-1))",
          }}
        />
        <div
          className="relative overflow-hidden rounded-[20px] bg-surface shadow-doku-float"
          style={{
            boxShadow: "inset 0 0 0 1px var(--film-2), 0 20px 48px -24px #000000b3",
          }}
        >
          {/*
            The field.

            Focus is expressed on the whole row rather than the bare input: the icon warms, the
            well lightens and a green hairline appears under the field. A focus ring drawn around a
            56px input inside a 20px panel fights the panel's own corner; a rule under it does not.
          */}
          <div className="group/field relative flex items-center gap-3 px-4 sm:px-5">
            <PixelSearch
              aria-hidden
              className="shrink-0 text-mute transition-colors duration-150 group-focus-within/field:text-doku"
            />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search coins by name, ticker or address"
              aria-label="Search markets"
              className="h-[60px] w-full border-none bg-transparent text-[15px] text-ink outline-none placeholder:text-mute"
            />
            {query.length > 0 && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setQuery("");
                  inputRef.current?.focus();
                }}
                className="shrink-0 rounded-full px-2 py-1 font-numeric text-[11px] text-mute transition-colors hover:bg-raise hover:text-ink"
              >
                Clear
              </button>
            )}
            <Keycap className="hidden sm:inline-grid">Esc</Keycap>
            {/* The rule under the field, and the green half of it that grows on focus. */}
            <span aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-line" />
            <span
              aria-hidden
              className="absolute inset-x-0 bottom-0 h-px origin-left scale-x-0 bg-doku transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-focus-within/field:scale-x-100"
            />
          </div>

          <div className="doku-scrollbar max-h-[58dvh] overflow-y-auto p-2">
            {results.length === 0 ? (
              <p className="px-3 py-10 text-center text-[13px] text-mute">
                {markets === undefined
                  ? "Loading markets…"
                  : markets.length === 0
                    ? "No markets have launched yet."
                    : `No market matches “${query}”.`}
              </p>
            ) : (
              <ul ref={listRef} className="flex list-none flex-col gap-1">
                {results.map(({ market: m, identity }, i) => {
                  const active = i === index;
                  /* Dollars where the quote has a price, the quote's own units otherwise — never
                     eighteen decimals and never "MON" on a market that holds none. */
                  const cap = capFigure(m.marketCap, m.marketCapUsd, {
                    decimals: m.quoteDecimals,
                    symbol: m.quoteSymbol,
                  });
                  /* Resolved against THIS market's generation, and labelled with the asset it is
                     denominated in — a bare "0.0001124" beside a cap in dollars says nothing
                     about which of the five quote assets it is one ten-thousandth of. */
                  const price = priceFigure(m.lastPrice, m.generation, {
                    decimals: m.quoteDecimals,
                    symbol: m.quoteSymbol,
                  });
                  const change = changes[m.marketAddress];
                  const up = change !== null && change !== undefined && change >= 0;

                  return (
                    <li key={m.marketAddress}>
                      <button
                        type="button"
                        onMouseEnter={() => setIndex(i)}
                        onClick={() => {
                          router.push(marketPath(m.tokenAddress));
                          onClose();
                        }}
                        className={cn(
                          "relative flex w-full items-center gap-4 rounded-[14px] px-3 py-3 text-left",
                          "transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)]",
                          active ? "bg-doku-hover" : "hover:bg-doku-hover/60"
                        )}
                        style={active ? { boxShadow: "inset 0 0 0 1px var(--film-2)" } : undefined}
                      >
                        {/* The selected row's marker. A 2px green bar reads at a glance from the
                            keyboard, where a background tint alone does not. */}
                        <span
                          aria-hidden
                          className={cn(
                            "absolute left-0 top-1/2 h-7 w-[2px] -translate-y-1/2 rounded-full bg-doku transition-opacity duration-150",
                            active ? "opacity-100" : "opacity-0"
                          )}
                        />

                        {/*
                          The mark, drawn by the same component the board draws.

                          It used to be an `<img>` here with the market's emoji behind it, which
                          made a coin with no artwork unrecognisable between the palette and the
                          grid it navigates to — an emoji in one and its ticker's monogram in the
                          other. `CoinMark` is the one place that decides what a coin looks like
                          when it has no logo.
                        */}
                        <CoinMark
                          logo={identity.logo}
                          ticker={identity.ticker}
                          name={identity.name}
                          size={44}
                          className="rounded-[13px]"
                        />

                        {/*
                          Name over ticker, left-aligned and flexible.

                          This column was a fixed 76px stack under the glyph holding a derived
                          ticker, which was the right shape when a coin's whole identity was one
                          emoji. A coin with a name needs the name to be the thing you read first,
                          at a width that can hold one.
                        */}
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          <span className="truncate font-numeric text-[13px] uppercase leading-none tracking-[0.02em] text-ink">
                            {identity.name}
                          </span>
                          <span className="truncate font-numeric text-[11px] leading-none tracking-[0.04em] text-mute">
                            <span className="text-mute">$</span>
                            {identity.ticker}
                            <span className="ml-2 uppercase tracking-[0.08em] text-mute">
                              {m.graduated ? "Graduated" : "Bonding"}
                            </span>
                          </span>
                        </div>

                        {/* Right column: price, 24h change, market cap. */}
                        <div className="ml-auto flex shrink-0 items-start gap-5 sm:gap-7">
                          <Stat
                            label="Price"
                            className={price.value === null ? "text-mute" : undefined}
                          >
                            {price.label}
                          </Stat>

                          <Stat
                            label="24h"
                            className={
                              change === null || change === undefined
                                ? "text-mute"
                                : up
                                  ? "text-doku-ink"
                                  : "text-loss-ink"
                            }
                          >
                            {change === null || change === undefined
                              ? "—"
                              : `${up ? "+" : "−"}${Math.abs(change).toFixed(1)}%`}
                          </Stat>

                          <Stat
                            label="Mcap"
                            className="text-ash"
                            containerClassName="hidden mobile-lg:flex"
                          >
                            {cap.isUsd
                              ? `$${formatCompact(cap.value)}`
                              : `${formatCompact(cap.value)} ${cap.currency}`}
                          </Stat>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* The keys the panel answers to, as keys — the same caps as the top bar's shortcut. They
              were loose glyphs in the caption's own mute ink, the one line of the panel that reads
              as an afterthought. */}
          <div className="flex items-center gap-4 border-t border-line px-4 py-2.5 font-numeric text-[11px] text-mute">
            <span className="flex items-center gap-1.5">
              <Keycap>↑</Keycap>
              <Keycap>↓</Keycap>
              <span className="ml-0.5">navigate</span>
            </span>
            <span className="flex items-center gap-1.5">
              <Keycap>↵</Keycap>
              <span className="ml-0.5">open</span>
            </span>
            <span className="hidden items-center gap-1.5 sm:flex">
              <Keycap>Esc</Keycap>
              <span className="ml-0.5">close</span>
            </span>
            {results.length > 0 && (
              <span className="ml-auto font-numeric tabular-nums">
                {results.length} {results.length === 1 ? "market" : "markets"}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default SearchModal;
