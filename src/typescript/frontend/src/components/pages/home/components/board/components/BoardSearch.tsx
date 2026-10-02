"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The board's search box.
 *
 * Text — a name, a ticker, or a contract address. It replaces the emoji picker that used to filter
 * this grid, which was the right control for a product whose coins *were* emoji and the wrong one
 * for a launchpad where a coin has a name someone typed.
 *
 * ## Why it holds its own value
 *
 * The committed query lives in the URL, and the URL is what the server filters on — so typing
 * straight into it would push a route per keystroke. The field owns the draft; the parent is told
 * once, on submit or after the typing stops.
 *
 * The re-sync from the prop is narrower than it looks, and has to be. It used to be
 * `useEffect(() => setDraft(value), [value])` — every change of the committed value overwrote the
 * draft, *including the field's own echo coming back through the URL*.
 *
 * The debounce restarts on each keystroke, so continuous typing never commits mid-word and the
 * echo is usually harmless. The window that is not harmless is the one right after a commit does
 * fire: `onChange` pushes the route, and until that push comes back as a new `value` the field is
 * holding a draft the parent has not heard about. A keystroke landing in there was then undone by
 * the echo — the draft was reset to what had been committed a moment earlier, and the letter was
 * gone. Measured against this component on a local dev server, that window was 0–20ms wide: a
 * keystroke at +0ms and +10ms after the commit was lost, one at +25ms survived. It is the round
 * trip that closes it, so it is widest exactly where it is least affordable — a slow connection, a
 * slow render, a phone.
 *
 * `committed` records what this field last asked for, so the effect can tell the echo of its own
 * commit from a change it did not make. Only the second kind — the back button, or a filter
 * cleared somewhere else on the page — is allowed to replace what somebody is typing.
 *
 * ## It is a field at every width
 *
 * On a phone this used to be a 36px magnifier key that slid open across the chip row on
 * `:focus-within`, absolutely placed so the open state covered the chips rather than displacing
 * them. It saved a row, and it cost more than it saved:
 *
 *   - `[data-filled]` held it open for as long as a query was committed, and the chips stayed
 *     faded out and `visibility: hidden` underneath it. So the state after a search was a field
 *     that looked focused, sitting on top of a filter row that had disappeared — with no way back
 *     to the chips but the ✕. That is the "stays selected" complaint, and it was working exactly
 *     as designed.
 *   - Blurring inside the 260ms debounce window collapsed the key and then re-opened it when the
 *     commit landed, because `:focus-within` had gone and `data-filled` had not yet arrived.
 *   - An absolutely-placed control in a row whose only other child is a horizontal scroller is a
 *     thing that reads as "below and slightly off" the moment anything around it changes height.
 *
 * So it is an ordinary item on the row now, narrow on a phone and 260px from `sm` up. The width is
 * fixed rather than flexed at both sizes: the other item on that line is a scroller that will give
 * up as much width as it is asked for, and a field with a zero basis beside it resolves to about
 * 30px. Two rows on a phone, which is what the collapse was for, and nothing overlaps anything.
 */
const SearchGlyph = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    className="doku-search-glyph shrink-0 text-mute"
    aria-hidden
  >
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);

/** How long the field waits after the last keystroke before filtering. */
const DEBOUNCE_MS = 260;

const BoardSearch = ({ value, onChange }: { value: string; onChange: (query: string) => void }) => {
  const [draft, setDraft] = useState(value);

  /**
   * The last query this field asked for.
   *
   * Not state: nothing renders from it, and it has to be readable by the commit that sets it
   * without waiting for a render, or the effect below would compare against a stale value for one
   * tick — which is the whole bug it exists to prevent.
   */
  const committed = useRef(value);

  const commit = (next: string) => {
    committed.current = next;
    onChange(next);
  };

  // A change that did not come from here: the back button, or the query cleared elsewhere. The
  // field's own echo is filtered out above, so typing is never interrupted by its own commit.
  useEffect(() => {
    if (value === committed.current) return;
    committed.current = value;
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (draft === committed.current) return;
    const t = setTimeout(() => commit(draft), DEBOUNCE_MS);
    return () => clearTimeout(t);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [draft]);

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        commit(draft);
      }}
      /* An ordinary item on the toolbar row. See the note above on why the width is fixed at both
         sizes rather than flexed against the chip scroller beside it. */
      className="doku-board-search w-[124px] shrink-0 grow-0 sm:w-[260px]"
    >
      {/* The label is the control: the glyph and the padding either side of it focus the input. */}
      <label className="doku-searchfield flex h-9 w-full cursor-text items-center gap-2 rounded-doku-lg px-2.5 sm:px-3">
        <SearchGlyph />
        <input
          type="search"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Search name, ticker, CA…"
          aria-label="Search coins by name, ticker or contract address"
          /* Chrome draws its own cancel glyph inside `type="search"`, which put a second ✕ half a
             centimetre from the one below — two clear buttons, one of them unstyled. Hidden here
             rather than by dropping the type, which is what gives the field its search semantics.
             `AssetRegistry`'s field does the same. */
          className="doku-board-search-input min-w-0 flex-1 bg-transparent font-ui text-[14px] text-ink placeholder:text-mute focus:outline-none [&::-webkit-search-cancel-button]:hidden"
        />
        {draft && (
          <button
            type="button"
            onClick={() => {
              setDraft("");
              commit("");
            }}
            aria-label="Clear search"
            className="doku-tap shrink-0 font-numeric text-[11px] leading-none text-mute transition-colors hover:text-ink"
          >
            ✕
          </button>
        )}
      </label>
    </form>
  );
};

export default BoardSearch;
