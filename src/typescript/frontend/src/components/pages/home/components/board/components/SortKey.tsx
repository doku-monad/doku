"use client";

import { cn } from "lib/utils/class-name";
import { createPortal } from "react-dom";

import { useAnchoredMenu } from "@/lib/hooks/use-anchored-menu";
import { SortMarketsBy } from "@/sdk/sorting";

/**
 * How the board is ordered.
 *
 * ## Why this is not the shared `SingleSelect` any more
 *
 * It was, and the select brought three problems that were all really one problem — it is a control
 * from the terminal theme, dropped onto a machined toolbar:
 *
 *   1. **Material.** A flat `var(--surface)` capsule with a single hairline, standing beside a pair
 *      row built out of a recessed tray with keys pressed into it. Two controls on one strip, two
 *      constructions, and the one that looked pasted on was the one naming what you are looking at.
 *   2. **Type.** It renders its label with `med-pixel-text`, which is **20px** below `sm` — a
 *      display size. `global.css` carried a block of `!important` overrides whose entire job was to
 *      shrink it back down to a control size on a phone, plus a `#emoji-grid-header svg path` rule
 *      to dim the chevron the select draws at full contrast. Both are gone with the select.
 *   3. **The menu.** It hung off `useTooltip`, which mounts and unmounts its panel — the source of
 *      the open/close blink this toolbar has been fixed for twice. `useAnchoredMenu` portals to the
 *      body, positions against the viewport, flips above the trigger when a phone has no room
 *      below, and dismisses on outside press and Escape.
 *
 * The key is the same object as a pair chip in the same tray, so the two controls in the toolbar
 * are visibly one family: a `SORT` plate seamed off at the head, the current value standing proud
 * beside it. On a phone the plate goes and the value carries it alone — the row it shares with the
 * heading has about 150px to spend and the word "sort" is the least informative thing in it.
 */

/**
 * What each ordering is called, and what it is called when there is no room.
 *
 * Two labels rather than one truncated with an ellipsis: "Market Cap" clipped to the width a
 * 360px bar can spare is "Market…", which says nothing the full phrase does not say in half the
 * characters. The short forms are chosen to stay distinct from each other, which an ellipsis
 * cannot promise.
 */
const SORTS: { value: SortMarketsBy; label: string; short: string; note: string }[] = [
  {
    value: SortMarketsBy.MarketCap,
    label: "Market Cap",
    short: "Mkt Cap",
    note: "Biggest first",
  },
  {
    value: SortMarketsBy.BumpOrder,
    label: "Bump Order",
    short: "Bumped",
    note: "Most recently traded",
  },
  {
    value: SortMarketsBy.DailyVolume,
    label: "24h Volume",
    short: "24h Vol",
    note: "Busiest today",
  },
  {
    value: SortMarketsBy.Newest,
    label: "Newest",
    short: "Newest",
    note: "Latest launches first",
  },
];

const Chevron = ({ open }: { open: boolean }) => (
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
    className={cn(
      "-mr-0.5 shrink-0 opacity-70 transition-transform duration-200",
      open && "rotate-180"
    )}
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
);

const SortKey = ({
  value,
  onChange,
}: {
  value: SortMarketsBy;
  onChange: (value: SortMarketsBy) => void;
}) => {
  const selected = SORTS.find((s) => s.value === value) ?? SORTS[0];

  /* 20px a row plus the rows' own padding, the panel's padding and the heading. Only has to be
     right enough for the hook to decide whether to flip above the trigger on a short screen. */
  const { open, setOpen, triggerRef, menuRef, menuStyle } = useAnchoredMenu<HTMLButtonElement>({
    width: 236,
    height: 30 + SORTS.length * 44 + 12,
    align: "right",
  });

  return (
    <>
      <div className="doku-pair-tray flex shrink-0 items-stretch rounded-doku-xl p-[3px]">
        <span className="doku-pair-label hidden shrink-0 items-center rounded-[9px] px-2.5 font-numeric text-[11px] uppercase leading-none tracking-[0.1em] text-mute sm:flex">
          Sort
        </span>

        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`Sort by ${selected.label}`}
          onClick={() => setOpen((v) => !v)}
          data-active={open}
          className="doku-pair-chip flex h-[30px] shrink-0 items-center gap-1.5 rounded-[9px] px-2.5 font-numeric text-[11px] uppercase leading-none tracking-[0.04em]"
        >
          <span className="sm:hidden">{selected.short}</span>
          <span className="hidden sm:inline">{selected.label}</span>
          <Chevron open={open} />
        </button>
      </div>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-label="Sort the board"
            style={menuStyle}
            className="doku-popover z-[200] flex flex-col rounded-[16px] p-1.5"
          >
            <span className="px-2 pb-1 pt-1 font-numeric text-[11px] uppercase leading-none tracking-[0.1em] text-faint">
              Order by
            </span>
            {SORTS.map((sort) => (
              <button
                key={sort.value}
                type="button"
                role="option"
                aria-selected={sort.value === value}
                data-selected={sort.value === value}
                onClick={() => {
                  onChange(sort.value);
                  setOpen(false);
                }}
                className="doku-fund-option flex w-full flex-col items-start gap-1 rounded-doku-lg px-2 py-2 text-left"
              >
                <span className="font-numeric text-[12.5px] font-semibold uppercase leading-none tracking-[0.04em] text-ink">
                  {sort.label}
                </span>
                {/* What the ordering actually does, because "Bump Order" is a word this product
                    invented and nobody arrives knowing it. */}
                <span className="font-ui text-[11px] leading-none text-mute">{sort.note}</span>
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
};

export default SortKey;
