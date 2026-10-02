"use client";

import { useId, useState } from "react";

import { LaunchCta } from "./LaunchCta";

/**
 * The summary rail: what you are about to create, what is still missing, and the button.
 *
 * ## And nothing else
 *
 * It carried a standing line at the foot — "Liquidity locked forever, burned at graduation" — which
 * is true, is on the launch page's own headline three panels up, and is a row inside `Fixed terms`
 * directly above it. Three statements of one fact in one column, the last of them sitting between
 * the launch button and the bottom of the rail. The terms drawer is where a fact that is identical
 * on every launch belongs.
 *
 * ## Why it is a panel and not a review step
 *
 * A launch form is a list of decisions whose consequences are not visible from the field that made
 * them — picking a quote asset sets the coin's denomination, picking a fee route sets who gets paid
 * forever. A summary that updates as you type keeps all of that on screen at once, so the answer to
 * "what have I actually built" is never more than a glance away, and the button is never the first
 * place you learn something is wrong.
 *
 * ## Your decisions and the protocol's terms are two different lists
 *
 * They used to be one list of eleven rows, distinguished only by the colour of the value — supply,
 * fee tier, LP lock and anti-sniper tax (facts, identical on every launch, unchangeable) sitting
 * between ticker, pair and dev buy (choices, yours, still editable). Eleven rows do not fit beside
 * a card preview on a laptop, so the rail scrolled, and what scrolled out of it first was
 * whichever row you had just changed.
 *
 * So the choices are the list, and the terms are a disclosure under it — closed by default,
 * because they are the same five sentences on every launch and nobody needs to re-read them while
 * picking a ticker. Five rows instead of eleven is the difference between a rail that scrolls on
 * every laptop and one that does not.
 *
 * The disclosure lives *outside* the scrolling list, for the reason written on it: inside, the key
 * was clipped off the bottom of the rail and could not be seen at all.
 *
 * ## The problems list
 *
 * Every unmet requirement, all at once, above the button. Not one at a time as each is fixed, and
 * not hidden behind a disabled button with no explanation — which is the single most common way a
 * launch form wastes somebody's afternoon.
 */
export interface SummaryRow {
  label: string;
  value: string;
  /** Renders the value in the brand hue — for the rows that carry the launcher's own choices. */
  emphasis?: boolean;
  /** Renders the value muted — for rows that are still unanswered. */
  pending?: boolean;
}

/* ---------------------------------------------------------------------------------------------
 * Marks
 *
 * Line art on the product's own icon grid, replacing the `🧾`, `⚠️` and `▸` that were here.
 * An emoji in a panel is somebody else's illustration: it cannot take `currentColor`, so it does
 * not follow the theme or the state it sits in, and it arrives at whatever weight and colour the
 * reader's OS decided — which on the paper canvas meant three small colour pictures scattered down
 * a monochrome summary.
 * ------------------------------------------------------------------------------------------- */

const Stroke = ({ children, size = 15 }: { children: React.ReactNode; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {children}
  </svg>
);

const ReceiptGlyph = () => (
  <Stroke size={14}>
    <path d="M6 3.5h12v17l-2.4-1.6-2.4 1.6-2.4-1.6-2.4 1.6L6 20.5z" />
    <path d="M9.2 8.5h5.6M9.2 12.4h5.6" />
  </Stroke>
);

const AlertGlyph = () => (
  <Stroke size={15}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.6v5M12 16.1h.01" />
  </Stroke>
);

const ChevronGlyph = () => (
  <Stroke size={13}>
    <path d="M9 5.5 15.5 12 9 18.5" />
  </Stroke>
);

/**
 * One line of the summary.
 *
 * ## The leader is gone
 *
 * Each row was label, then a **1px hairline stretched across whatever space was left**, then the
 * value: a dot leader, the device a printed index uses to carry your eye across four inches of
 * blank page. This rail is 320px wide and its rows are eight pixels apart, so the leader was
 * solving a problem the layout does not have — and paying for it with a stack of thin grey rules
 * of six different lengths, one per row, which is the loudest and least meaningful pattern on the
 * page. Six ragged lines drawn *between* the two things you are trying to read.
 *
 * Alignment does the joining. A fixed left edge for the labels and a fixed right edge for the
 * values is a table, and a table needs no leaders — which is why the token page's own spec sheet
 * has never had any.
 *
 * ## And it is the spec sheet, deliberately
 *
 * This panel and `TokenSpecSheet` are the same list at two moments: what a launcher is choosing,
 * and what a buyer reads back off the market it became. Same rule between rows, same label face,
 * same right-aligned figure — so the promise made on this page and the fact shown on that one are
 * visibly the same object, rather than two panels that happen to carry the same words.
 *
 * `pending` prints in `--mute`, because "not chosen yet" and "chosen, and the answer is None" are
 * different states that must not both render as grey text of the same weight.
 */
const Row = ({ row }: { row: SummaryRow }) => (
  <div className="doku-summary-row flex items-baseline justify-between gap-4 px-3 py-2.5">
    <dt className="shrink-0 font-pixel text-[11.5px] uppercase leading-none tracking-[0.05em] text-ash">
      {row.label}
    </dt>
    <dd
      className={[
        "min-w-0 truncate text-right font-numeric text-[13px] font-semibold leading-none tabular-nums",
        row.pending ? "text-mute" : row.emphasis ? "text-doku-ink" : "text-ink",
      ].join(" ")}
      title={row.value}
    >
      {row.value}
    </dd>
  </div>
);

export const LaunchSummary = ({
  rows,
  terms,
  problems,
  children,
}: {
  /** What the launcher has chosen. The list, and the only part that changes as they type. */
  rows: SummaryRow[];
  /** What is true of every launch. Behind a disclosure — read once, not on every keystroke. */
  terms: SummaryRow[];
  problems: string[];
  /** The action. Passed in rather than rendered here so this panel owns no submit logic. */
  children: React.ReactNode;
}) => {
  const [termsOpen, setTermsOpen] = useState(false);
  const termsId = useId();

  return (
    /*
     * Nothing inside this panel scrolls.
     *
     * It used to: the rail was capped to the viewport, so the rows became a scroll container with a
     * `min-height` floor and the terms drawer got a cap of its own — which meant the one surface
     * whose entire job is "your whole configuration, at a glance" answered that question with a
     * scrollbar and three of five rows. A summary you have to scroll is not a summary.
     *
     * So the panel is exactly as tall as what is in it, and the rail above no longer caps it — see
     * `RAIL_MAX_H` in `LaunchBench`. The list is five rows and the drawer is five more; the height
     * that costs is a height this rail can afford, and if a viewport ever cannot, the *page*
     * scrolls, which is a thing people already know how to do.
     */
    <div
      /* The card's edge, and the card's rim with it: this is a top-level object in the rail, not a
         box inside a panel. `--rim-r` is the 20px radius plus the three pixels the rim floats. */
      className="doku-edge doku-rim flex flex-col gap-3.5 rounded-doku-3xl p-4 [--rim-r:23px]"
      style={{ background: "var(--mat-bezel-bg)" }}
    >
      {/*
        The head, as a row rather than a caption.

        The glyph was a bare 14px stroke sitting next to the words at `--mute`, which is a picture
        beside a label rather than a header. Mounted in a well it is the same object as every other
        mark in this product — the pair badge's asset, the routing keys, the reserve notice — and it
        gives the title something to sit against.

        There is no count on the right any more. It used to carry one, to match the plate on the
        terms key below — but the two are not the same case. The terms are COLLAPSED, so their
        number says how much is behind the key; this list is fully visible directly underneath, so
        its number only counted what the reader could already see. A figure that answers a question
        nobody has is furniture, and it sat in the one slot on this panel that could have been
        quiet.
      */}
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="doku-summary-mark grid h-7 w-7 shrink-0 place-items-center rounded-doku-lg text-ash"
        >
          <ReceiptGlyph />
        </span>
        <h2 className="min-w-0 flex-1 truncate font-ui font-semibold text-[12.5px] uppercase leading-none tracking-[0.06em] text-ink">
          Your coin
        </h2>
      </div>

      {/*
        The list, pressed into the panel.

        A recess rather than rows floating on the bezel: this is a *readout* — the one thing on the
        rail you look at rather than operate — and everything operable around it (the terms key, the
        launch button) stands proud. One step down is how this product separates the two, and it is
        also what gives the rules between rows something to be rules *in* rather than six grey lines
        drawn on a card.
      */}
      <dl className="doku-summary-list flex flex-col overflow-hidden rounded-doku-xl">
        {rows.map((row) => (
          <Row key={row.label} row={row} />
        ))}
      </dl>

      <div className="flex flex-col gap-3.5">
        {/*
          The terms, as a key and the drawer under it.

          Both halves were in the wrong place. The control was the last thing *inside* the scrolling
          list — the one place it could not do its job, because the rail is capped to the viewport,
          the rows fill it, and so the button that reveals the protocol's terms was clipped off the
          bottom edge on every laptop. And it was 12px of `--mute` with a chevron in front, which is
          not what a control looks like even when you can see it.

          So the whole disclosure moved into the part of the panel that never scrolls: the key is
          always visible, and what it opens appears directly beneath it. The rows above give up the
          space — they are the flexible part of this panel — so the drawer never pushes the launch
          button out of reach, and it carries its own cap and scroll for the same reason.

          `.doku-token-key` is the machined tab the token page's controls are made of, full width,
          with the count on the right: a disclosure that does not say how much is behind it is one
          people open once to find out and never again.
        */}
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setTermsOpen((v) => !v)}
            aria-expanded={termsOpen}
            aria-controls={termsId}
            className="doku-token-key flex h-10 w-full items-center gap-2 rounded-doku-xl px-3 font-numeric text-[12px] font-semibold uppercase leading-none tracking-[0.08em] text-ash"
          >
            <span
              aria-hidden
              className={`inline-flex text-mute transition-transform duration-200 ${
                termsOpen ? "rotate-90" : ""
              }`}
            >
              <ChevronGlyph />
            </span>
            Fixed terms
            {/* `.doku-summary-count` — the badge's one definition. The head above used the class
                and this key reimplemented the same look inline, so "one badge, two lists" was only
                true in the stylesheet's comment. The head has no count any more (its list is
                visible), which leaves this as the single consumer: a number that says what is
                behind a collapsed key, which is the case a count is actually for. */}
            <span className="doku-summary-count ml-auto rounded-doku-pill px-2 py-1 font-numeric text-[11px] font-medium leading-none tabular-nums text-mute">
              {terms.length}
            </span>
          </button>

          {termsOpen && (
            <dl
              id={termsId}
              className="doku-summary-list flex flex-col overflow-hidden rounded-doku-xl"
            >
              {terms.map((row) => (
                <Row key={row.label} row={row} />
              ))}
            </dl>
          )}
        </div>

        {/*
          What is still missing, as one designed object.

          These were bare coral sentences with an emoji in front of each, stacked under a hairline —
          system output leaking onto the page. They are now a single tinted panel with a heading that
          says how many things are outstanding and the list under it, which does three things the
          loose lines did not: it reads as one state rather than N unrelated complaints, the count
          tells a launcher whether they are one field away or five, and it is unmistakably the same
          object as every other "something is wrong" surface in the product — coral text at
          `loss-ink`, a 10% ground and a 30% rim, the recipe the sell side and the negative delta
          chip already use.
        */}
        {problems.length > 0 && (
          <div className="flex flex-col gap-2 rounded-doku-xl border border-solid border-loss/30 bg-loss/10 p-3">
            <p className="flex items-center gap-2 font-numeric text-[11.5px] font-semibold uppercase leading-none tracking-[0.08em] text-loss-ink">
              <AlertGlyph />
              {problems.length === 1 ? "1 thing left" : `${problems.length} things left`}
            </p>
            <ul className="flex list-none flex-col gap-1.5">
              {problems.map((problem) => (
                <li
                  key={problem}
                  className="flex gap-2 font-ui text-[12.5px] leading-snug text-loss-ink"
                >
                  {/* A bullet rather than a repeated severity mark: the panel has already said what
                      severity this is, and one icon per line says it four more times. */}
                  <span aria-hidden className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-loss" />
                  <span className="min-w-0">{problem}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {children}
      </div>
    </div>
  );
};

export { LaunchCta };
export default LaunchSummary;
