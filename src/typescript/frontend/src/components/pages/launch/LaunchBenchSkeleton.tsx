"use client";

import { Skeleton, SkeletonRegion } from "components/ui/skeleton";
import { cn } from "lib/utils/class-name";

import { FieldGroup } from "./components/Field";
import {
  WINDOW_H as PAIR_WINDOW_H,
  WINDOW_H_PHONE as PAIR_WINDOW_H_PHONE,
} from "./components/PairSelect";
import { StepCard } from "./components/StepCard";

/**
 * The bench, before the quote registry has answered.
 *
 * ## What this replaces
 *
 * A centred box with `READING THE QUOTE REGISTRY` set in it and a sentence underneath explaining
 * what a quote registry is. Three things were wrong with it, and only the first is cosmetic:
 *
 *   1. It told a launcher about the *implementation*. Nobody pressed `Launch a coin` in order to
 *      learn that this product keeps a registry of assets, and a status line naming an internal
 *      component is the interface asking its user to care about its plumbing.
 *   2. It was the wrong size. Measured at 1280px the page was **948px** tall while that box was on
 *      screen and **2684px** a moment later — so the footer, which had been sitting mid-viewport,
 *      was thrown seventeen hundred pixels down the page as the form arrived. That is the whole of
 *      the "squeezing and expanding": a one-line box standing in for a five-step form.
 *   3. It threw away the fact that almost none of this page is waiting. The step numbers, their
 *      titles, the field labels and every box those fields sit in are known before the first byte
 *      comes back; only the *pair* needs the chain. Drawing none of it made a one-second wait look
 *      like a page that had not started.
 *
 * ## So the chrome is real and only the data shimmers
 *
 * The five `StepCard`s below are the real component with the real numbers and the real titles, and
 * the group headings inside them are the real `FieldGroup`. What is a `Skeleton` is exactly what a
 * launcher is actually waiting for — the controls. The result is a page that arrives already
 * legible, where the form fills in rather than appears.
 *
 * ## The rule this file exists to enforce
 *
 * Every block here is sized from the same number as the thing it stands in for: 44px for a field
 * because `FIELD_CLASS` is a 44px well, 116px for the artwork row because `ARTWORK_H` is 116,
 * `PAIR_WINDOW_H` for the pair grid because `PairSelect` pins it there so the step cannot resize
 * while you browse it. Where a height is arbitrary here it is arbitrary there too.
 *
 * When one of those numbers changes, change it here. A skeleton that has drifted from its content
 * reintroduces the shift it was added to prevent, while looking like the problem was handled.
 */

/**
 * A run of prose, as words that wrap where the sentence would.
 *
 * ## Why this is not two long bars
 *
 * Because the blocks it stands in for are sentences, and a sentence's height is a function of the
 * width it is given. `FeeRoutingPicker`'s three blurbs are two lines at 1280px and four at 390 —
 * measured, the same key is 86px and 123px — so a placeholder of N fixed bars is the right height
 * at exactly one breakpoint and wrong at every other. Which is how a skeleton ends up causing the
 * shift it was added to prevent, having looked like the problem was handled.
 *
 * Word-shaped bars in a wrapping row re-flow the way the text does, at any width, with nothing to
 * keep in sync. They also simply read as prose, where two full-width bars read as two bars.
 *
 * The widths are a fixed cycle rather than `Math.random`: a random paragraph gives the server one
 * layout and the browser another, which React reports as a hydration mismatch — on a placeholder.
 */

/** A cycle of word lengths, in characters. Long enough not to visibly repeat down three keys. */
const WORD_CHARS = [4, 7, 3, 9, 5, 2, 8, 6, 4, 11, 3, 6, 9, 4, 7, 5, 10, 3, 8, 4, 6, 12, 5, 3, 7];

const TextSkeleton = ({
  chars,
  bar = 11,
  line = 18.75,
  className,
}: {
  /** Roughly how many characters the real sentence runs to. */
  chars: number;
  /** The bar's height. Under the type it stands in for, the way a lowercase x-height is. */
  bar?: number;
  /** The real line box, so a wrapped word lands on the line the text would have. */
  line?: number;
  className?: string;
}) => {
  /* ~0.55 of the bar's height per character, which is about the advance width of this product's UI
     face at the sizes this file uses. It only has to be close: the point is that the run breaks
     near where the sentence breaks, not that it matches glyph for glyph. */
  const charW = bar * 0.55;
  const words: number[] = [];
  for (let n = 0, i = 0; n < chars; i += 1) {
    const len = WORD_CHARS[i % WORD_CHARS.length];
    words.push(Math.round(len * charW));
    n += len + 1;
  }

  return (
    <span className={cn("flex flex-wrap items-center", className)} style={{ columnGap: charW }}>
      {words.map((w, i) => (
        /*
          Each word sits in a box the height of a LINE, with the bar centred in it — rather than
          bars separated by a row gap of the leading.

          The two look identical and measure differently. A wrapping row of N bars with a gap of
          `line - bar` is `N * line - (line - bar)` tall: the leading under the last line is
          missing, so a two-line blurb came out 8px short and three keys of it took 24px off the
          step. A line box per word makes an N-line run exactly `N * line`, which is what text is.
        */
        <span key={i} className="flex items-center" style={{ height: line }}>
          <Skeleton className="rounded-[3px]" style={{ width: w, height: bar }} />
        </span>
      ))}
    </span>
  );
};

/**
 * One labelled control: the label row, then the well it sits in.
 *
 * `gap-2` and a 44px box are `Field` and `FIELD_CLASS`; the label row is 12px of `LABEL_CLASS`.
 * `w` is the label's own width, because a column of identical grey bars reads as a table and a
 * form's labels are not the same length.
 */
const FieldSkeleton = ({
  w,
  h = 44,
  className,
}: {
  w: number;
  /** The control's height, where it is not the standard well — a textarea, say. */
  h?: number;
  className?: string;
}) => (
  <div className={cn("flex min-w-0 flex-col gap-2", className)}>
    <Skeleton className="h-[12px]" style={{ width: w }} />
    <Skeleton className="w-full rounded-doku-xl" style={{ height: h }} />
  </div>
);

/**
 * Step 01. The seven controls of `IdentityFields`, in its three groups.
 *
 * The outer `gap-7` and the inner grids are that component's, so this collapses to one column on a
 * phone exactly where the real step does — which is what keeps the two the same height at every
 * width rather than only at the one the numbers were measured at.
 */
const IdentitySkeleton = () => (
  <div className="flex flex-col gap-7">
    <FieldGroup title="The basics">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <FieldSkeleton w={46} />
        <FieldSkeleton w={54} />
      </div>
      {/* The description's well is `min-h-[92px]`, and empty is what it opens at. */}
      <FieldSkeleton w={82} h={92} />
    </FieldGroup>

    <FieldGroup title="Artwork">
      {/* `ARTWORK_H` — a square target for the logo and the rest of the row for the banner. */}
      <div
        className="grid items-start gap-3 sm:gap-4"
        style={{ gridTemplateColumns: "116px minmax(0,1fr)" }}
      >
        <div className="flex flex-col gap-2">
          <Skeleton className="h-[12px] w-[38px]" />
          <Skeleton className="h-[116px] w-full rounded-doku-2xl" />
        </div>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-[12px] w-[52px]" />
          <Skeleton className="h-[116px] w-full rounded-doku-2xl" />
        </div>
      </div>
    </FieldGroup>

    {/* The socials are a closed dropdown key now, 60px: a 40px well in `py-2.5`. See `LinkFields`. */}
    <div className="doku-links-key flex h-[60px] items-center gap-3 rounded-doku-xl py-2.5 pl-2.5 pr-3.5">
      <Skeleton className="h-10 w-10 shrink-0 rounded-doku-lg" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Skeleton className="h-[12px] w-[132px]" />
        <Skeleton className="h-[10px] w-[168px] max-w-full" />
      </div>
    </div>
  </div>
);

/**
 * Step 02. The one step that is genuinely waiting on the chain.
 *
 * The same bed `PairSelect` draws: a head row of 36px category keys, and under it a window exactly
 * `PAIR_WINDOW_H` tall (`PAIR_WINDOW_H_PHONE` on a phone) — the height the picker holds at thirteen
 * assets and at forty. The window and grid take the picker's own classes, so the column count and
 * the height switch at the same widths. Six tiles fill two rows of the widest grid; the window
 * clips whatever a narrower one does not show.
 */
const PairSkeleton = () => (
  <div className="doku-pair-bed flex flex-col rounded-[22px] p-1.5">
    <div className="flex items-center gap-1 overflow-hidden px-0.5 pb-1.5 pt-0.5">
      {[54, 108, 80, 76, 88].map((w, i) => (
        <Skeleton key={i} className="h-9 shrink-0 rounded-[12px]" style={{ width: w }} />
      ))}
    </div>

    <div
      className="doku-pair-window overflow-hidden p-1.5"
      style={
        {
          "--pair-window-h": `${PAIR_WINDOW_H}px`,
          "--pair-window-h-phone": `${PAIR_WINDOW_H_PHONE}px`,
        } as React.CSSProperties
      }
    >
      <div className="doku-pair-grid grid auto-rows-[68px] content-start gap-2">
        {Array.from({ length: 6 }, (_, i) => (
          /* The tile's own furniture rather than one grey rectangle: the socket, the two lines of
             type beside it and the state at the end. A placeholder that is the right height and the
             wrong construction still reads as a hole in the page. */
          <div
            key={i}
            className="doku-pair-tile flex items-center gap-3 rounded-[16px] py-2.5 pl-2.5 pr-3.5"
          >
            <Skeleton className="h-12 w-12 shrink-0 rounded-full" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Skeleton className="h-[13px] w-[46%]" />
              <Skeleton className="h-[10px] w-[72%]" />
            </div>
            <Skeleton className="h-5 w-5 shrink-0 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  </div>
);

/** Step 03. The gauge, then the three destinations a trade fee can be routed to. */
const FeeRoutingSkeleton = () => (
  <div className="flex flex-col gap-4">
    <div className="doku-route-gauge flex flex-col gap-2.5 rounded-doku-2xl px-4 py-3.5">
      <Skeleton className="h-[12px] w-[150px]" />
      {/* The track is `h-[10px]` and it is drawn, not shimmered — it is the step's one piece of
          furniture that carries no data: the split is fixed by the protocol. */}
      <div className="doku-route-track flex h-[10px] w-full gap-[3px] rounded-doku-pill p-[2px]">
        <span className="doku-route-fill shrink-0 rounded-doku-pill" style={{ width: "70%" }} />
        <span className="doku-route-rest flex-1 rounded-doku-pill" />
      </div>
      {/* `flex-wrap` and the two labels' real widths, so this breaks onto two lines at the same
          width `70% yours to route` and `30% the protocol keeps` stop fitting side by side — which
          on a 390px phone is 12px of the gauge's height. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-px">
        <Skeleton className="h-[12px] w-[138px]" />
        <Skeleton className="h-[12px] w-[152px]" />
      </div>
    </div>

    <div className="grid grid-cols-1 gap-2.5">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="doku-route-key flex items-start gap-3.5 rounded-doku-2xl px-3.5 py-3.5"
        >
          <Skeleton className="h-[34px] w-[34px] shrink-0 rounded-doku-lg" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-[13px] w-[132px]" />
            {/* `FEE_ROUTING`'s blurbs run 135–158 characters and are set at 12.5px on a 1.5 line —
                two lines on a desktop, four on a phone, and this follows them to both. */}
            <TextSkeleton chars={148} bar={11} line={18.75} />
          </div>
        </div>
      ))}
    </div>
  </div>
);

/** Step 04. The ten percentage keys, then the well the amount is typed into. */
const DevBuySkeleton = () => (
  <div className="flex flex-col gap-4">
    <div className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <Skeleton className="h-[12px] w-[168px]" />
        <Skeleton className="h-[12px] w-[104px]" />
      </div>
      {/* Five across, two deep — the grid divides exactly, which is why the real one is ten keys. */}
      <div className="grid grid-cols-5 gap-2">
        {Array.from({ length: 10 }, (_, i) => (
          <Skeleton key={i} className="h-9 rounded-doku-lg" />
        ))}
      </div>

      {/* `closedReason` — the line explaining why the percentages are inert. It is drawn because
          the state this skeleton is standing in for is always the same one: nobody has connected a
          wallet in the second between the route resolving and the registry answering. 120
          characters of `HINT_CLASS`, which is 13px on a snug line. */}
      <TextSkeleton chars={120} bar={11} line={17.9} />
    </div>

    <div className="doku-swap-field flex flex-col gap-3 rounded-[16px] px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <Skeleton className="h-[12px] w-[72px]" />
        <Skeleton className="h-[12px] w-[92px]" />
      </div>
      <div className="flex items-center justify-between gap-3">
        {/* The amount is set at 26px, and it is the largest thing in the step. */}
        <Skeleton className="h-[26px] w-[128px]" />
        {/* 46px, the plate's own height: a 28px mark in a `p-[3px]` well inside a `py-1.5` face. */}
        <Skeleton className="h-[46px] w-[124px] shrink-0 rounded-doku-xl sm:w-[152px]" />
      </div>
    </div>
  </div>
);

/**
 * The rail's card.
 *
 * `CoinCard`'s own construction at rail width: the rim floating 3px proud, the bezel, a 124px
 * cover, the mark straddling its lower edge on a `-mt-[42px]` band, then the two seamed rows. It
 * is built from the parts rather than from one 307px rectangle for the reason the board's card
 * skeleton is — the 3px inset and the radii are part of the box, and a placeholder that is the
 * right height but the wrong shape still moves the page when the real one lands.
 */
const PreviewCardSkeleton = () => (
  <div className="relative shrink-0">
    <span
      aria-hidden
      className="pointer-events-none absolute -inset-[3px] rounded-[17px] border border-solid border-[var(--film-2)]"
    />
    <div className="relative flex flex-col overflow-hidden rounded-[14px] border border-solid border-[var(--film-2)]">
      <Skeleton className="h-[92px] w-full rounded-none sm:h-[124px]" />

      {/* `--coin-mark` is 84px on a phone and 104 above `sm`, and this band's bottom padding is the
          clearance under the half of it that hangs past the cover. Measured, the band contributes
          56px of flow at 390 and 82 above `sm`. */}
      <div className="relative -mt-[42px] flex items-end gap-2.5 px-3 pb-3.5 sm:px-3.5 sm:pb-5">
        <Skeleton className="h-[84px] w-[84px] shrink-0 rounded-[19px] sm:h-[104px] sm:w-[104px] sm:rounded-[23px]" />
        <div className="flex min-w-0 flex-1 flex-col gap-2 pb-1">
          <Skeleton className="h-[15px] w-[64%]" />
          <Skeleton className="h-[11px] w-[46%]" />
        </div>
      </div>

      {/* The card's two seamed rows, at the heights they measure: 54/62 for the figure and 40/48
          for the contract line. Given as heights rather than rebuilt out of padding — the real rows
          are `py-1.5 sm:py-2.5` around content of two different kinds, and a placeholder only has
          to land on the same line. */}
      <div className="flex h-[54px] items-center justify-between gap-3 border-t border-solid border-[var(--film-2)] px-3 sm:h-[62px] sm:px-3.5">
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-[9px] w-[62px]" />
          <Skeleton className="h-[13px] w-[44px]" />
        </div>
        <Skeleton className="h-[26px] w-[74px] rounded-doku-lg" />
      </div>

      <div className="flex h-[40px] items-center justify-between gap-3 border-t border-solid border-[var(--film-2)] px-3 sm:h-[48px] sm:px-3.5">
        <Skeleton className="h-[22px] w-[112px] rounded-doku-lg" />
        <Skeleton className="h-[20px] w-[88px] rounded-doku-lg" />
      </div>
    </div>
  </div>
);

/**
 * The rail's summary.
 *
 * Six rows at the 33px `.doku-summary-row` height, the terms key at `h-10`, and the button at
 * `h-14` — `LaunchCta`'s height, and the one block on this page it would be worst to get wrong,
 * because it is the thing a launcher is aiming at when the page settles.
 *
 * The block above the button is the room the `problems` panel takes — see the note on it below.
 */
const SummarySkeleton = () => (
  <div
    className="doku-edge doku-rim flex flex-col gap-3.5 rounded-doku-3xl p-4 [--rim-r:23px]"
    style={{ background: "var(--mat-bezel-bg)" }}
  >
    <div className="flex items-center gap-2.5">
      <Skeleton className="h-7 w-7 shrink-0 rounded-doku-lg" />
      <Skeleton className="h-[12px] w-[84px]" />
    </div>

    <div className="doku-summary-list flex flex-col overflow-hidden rounded-doku-xl">
      {[
        [64, 48],
        [72, 86],
        [80, 54],
        [62, 44],
        [76, 68],
        [68, 58],
      ].map(([label, value], i) => (
        <div
          key={i}
          className="doku-summary-row flex items-center justify-between gap-4 px-3 py-2.5"
        >
          <Skeleton className="h-[13px] shrink-0" style={{ width: label }} />
          <Skeleton className="h-[13px] shrink-0" style={{ width: value }} />
        </div>
      ))}
    </div>

    <div className="flex flex-col gap-3.5">
      <Skeleton className="h-10 w-full rounded-doku-xl" />

      {/*
        The block that says what is still missing, reserved but not coloured.

        It is the only part of the real rail conditional on what has been typed — and on this screen
        it is a certainty, because an untouched draft has no name and no ticker and `draftProblems`
        returns both. Leaving its 89px out put the launch button 103px lower the instant the form
        arrived, on a phone where the rail stacks under the steps and that is the foot of the page.
        Drawn in the loss hue it would be telling somebody their empty form is wrong before they had
        seen it, so it holds the room in plain grey and lets the real one bring the colour.
      */}
      <Skeleton className="h-[89px] w-full rounded-doku-xl" />

      <Skeleton className="h-14 w-full rounded-[16px]" />
    </div>
  </div>
);

/**
 * The whole bench, waiting.
 *
 * The grid, the gaps and the 360px rail are `LaunchBench`'s own, so the two occupy the same box —
 * which is the entire point of the file. `STICK_TOP` is not repeated: nothing here scrolls
 * independently for the second this is on screen, and a sticky placeholder that detaches from the
 * page under a thumb is a worse answer than one that sits still.
 */
export const LaunchBenchSkeleton = () => (
  <SkeletonRegion
    label="Preparing the launch form"
    className="grid w-full grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-6"
  >
    <div className="flex min-w-0 flex-col gap-5">
      {/* The one-line preview that pins to the top below `lg`. `CoinPreviewStrip` is a 36px mark in
          a `py-2.5` box — 56px, measured — and leaving it out is 56px of shift on a phone. */}
      <div
        className="doku-edge flex items-center gap-3 rounded-doku-2xl px-3 py-2.5 lg:hidden"
        style={{ background: "var(--mat-bezel-bg)" }}
      >
        <Skeleton className="h-[36px] w-[36px] shrink-0 rounded-[11px]" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Skeleton className="h-[12px] w-[42%] max-w-[130px]" />
          <Skeleton className="h-[10px] w-[26%] max-w-[80px]" />
        </div>
        <Skeleton className="h-[28px] w-[74px] shrink-0 rounded-doku-lg" />
      </div>

      <StepCard index="01" title="Identity">
        <IdentitySkeleton />
      </StepCard>

      <StepCard index="02" title="Trading pair">
        <PairSkeleton />
      </StepCard>

      <StepCard index="03" title="Fee routing">
        <FeeRoutingSkeleton />
      </StepCard>

      <StepCard index="04" title="Dev buy" optional>
        <DevBuySkeleton />
      </StepCard>

      {/* Step 05 is a single switch until somebody throws it, here as there — see `CreatorFee`. */}
      <StepCard index="05" title="Creator tax" optional>
        <div className="doku-edge flex w-full items-center justify-between gap-4 rounded-doku-2xl px-3.5 py-3">
          <Skeleton className="h-[14px] w-[156px]" />
          <Skeleton className="h-6 w-11 shrink-0 rounded-doku-pill" />
        </div>
      </StepCard>
    </div>

    <aside className="flex flex-col gap-4">
      <PreviewCardSkeleton />
      <SummarySkeleton />
    </aside>
  </SkeletonRegion>
);

export default LaunchBenchSkeleton;
