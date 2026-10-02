import PageFrame from "components/layout/PageFrame";
import { Skeleton, SkeletonRegion } from "components/ui/skeleton";

/**
 * The `/explore` route's loading state — its skeleton.
 *
 * Rendered in two places: by `app/explore/loading.tsx` while the route's static shell streams
 * in, and by the shell itself (`ExploreClient`) while the first `/api/explore` answer is on its
 * way. The page is static now, so the second is the one a visitor actually sees; both draw this
 * so the swap from one to the other moves nothing.
 *
 * ## Why this is not a spinner
 *
 * It used to be — a centred 44px spinner on a `100dvh` flex box. Which meant the sequence on every
 * cold load was: full-height empty page, spinner in the middle, then the entire layout appearing at
 * once and shoving the viewport. The page didn't just *look* like it jumped, it measurably did: the
 * spinner's container and the real content share no dimensions at all.
 *
 * This mirrors the real page's boxes instead. Same `doku-split`, same two `PageFrame`s, same
 * 46/54 hero grid, same tape, same toolbar band, same card grid — so what fades in replaces
 * something already the right shape, and the scroll position under the user's thumb stays where
 * they put it.
 *
 * ## The rule this file exists to enforce
 *
 * Every block below is sized from the same number as the component it stands in for. Where a
 * height is arbitrary here it is arbitrary there too. When you change a height in the hero or the
 * card, change it here — a skeleton that has drifted from its content is worse than no skeleton,
 * because it introduces the shift it was added to prevent while looking like it was handled.
 */

/**
 * Mirrors `ExploreHero`'s left column: two headline lines, two copy lines, the pair rail, two
 * buttons.
 *
 * The eyebrow badge that used to open this block is gone from both — see the note in `ExploreHero`
 * about why the fold states "markets, live" with the tape and the board rather than with a label.
 */
const HeroCopySkeleton = () => (
  <div className="flex flex-col items-start">
    {/* The headline is `clamp(1.9rem, 3.85vw, 3rem)` at `leading-[0.92]`; these two blocks are that
        line box, twice, at the widths the two lines actually occupy. */}
    <Skeleton className="h-[clamp(1.75rem,3.54vw,2.76rem)] w-[76%] max-w-[420px]" />
    <Skeleton className="mt-[0.12em] h-[clamp(1.75rem,3.54vw,2.76rem)] w-[58%] max-w-[320px]" />

    <Skeleton className="mt-2.5 h-[14px] w-full max-w-[400px] sm:mt-3" />
    <Skeleton className="mt-2 h-[14px] w-[72%] max-w-[300px]" />

    {/* The pair rail: a 36px tray, full width on a phone and its natural width above `sm`. */}
    <Skeleton className="mt-3.5 h-[36px] w-full rounded-doku-xl sm:mt-4 sm:w-[430px]" />

    <div className="mt-4 flex w-full flex-col gap-2.5 sm:mt-5 sm:w-auto sm:flex-row sm:gap-3">
      <Skeleton className="h-[43px] w-full rounded-[14px] sm:w-[192px]" />
      <Skeleton className="h-[43px] w-full rounded-[14px] sm:w-[184px]" />
    </div>
  </div>
);

/**
 * Mirrors `RunnerBoard`: the tray, the rim, the bezel, a title bar and four 46px rows.
 *
 * The board is real hardware — a recessed tray with a rim floating proud of it and a bezel inside
 * that — so the skeleton is built from the same three elements rather than from one grey rectangle.
 * A placeholder the right *shape* but the wrong construction still shifts the layout when the real
 * thing arrives, because the tray's 3px inset and the bezel's radius are part of the box.
 */
const HeroBoardSkeleton = () => (
  <div className="doku-board relative rounded-[15px] p-[3px]">
    <span
      aria-hidden
      className="doku-board-rim pointer-events-none absolute -inset-[3px] rounded-[18px]"
    />

    <div className="doku-board-face relative overflow-hidden rounded-[13px] px-3 pb-2 pt-2.5 sm:px-3.5">
      {/* The title bar: label left, the 24h plate right. */}
      <div className="flex items-center justify-between pb-2">
        <Skeleton className="h-[9px] w-[104px]" />
        <Skeleton className="h-[18px] w-[52px] rounded-[5px]" />
      </div>

      <span aria-hidden className="doku-board-seam block w-full" />

      {/* The column headers, at the widths the four labels actually occupy. */}
      <div className="flex items-center justify-between gap-3 px-1.5 pb-1.5 pt-2">
        <Skeleton className="h-[8px] w-[46px]" />
        <div className="flex items-center gap-2.5">
          <Skeleton className="h-[8px] w-[34px]" />
          <Skeleton className="h-[8px] w-[26px]" />
          <Skeleton className="h-[8px] w-[24px]" />
        </div>
      </div>

      {/* Four rows at `ROW_H`. The 30px square is the symbol's well; the block beside it is the
          ticker; the three on the right are the figures. */}
      {[0, 1, 2, 3].map((i) => (
        <div key={i}>
          {i > 0 && <span aria-hidden className="doku-board-seam block w-full" />}
          <div className="flex h-[46px] items-center justify-between gap-3 px-1.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <Skeleton className="h-[14px] w-[16px] rounded-[4px]" />
              <Skeleton className="h-[30px] w-[30px] shrink-0 rounded-[8px]" />
              <Skeleton className="h-[12px] w-[86px]" />
            </div>
            <div className="flex items-center gap-2.5">
              <Skeleton className="h-[11px] w-[46px]" />
              <Skeleton className="h-[11px] w-[22px]" />
              <Skeleton className="h-[11px] w-[44px]" />
            </div>
          </div>
        </div>
      ))}
    </div>
  </div>
);

/**
 * Mirrors one market card.
 *
 * The column count is CSS here rather than the JS `useGridRowLength` the real grid uses. A hook
 * that reads `window` cannot run before hydration, so a skeleton driven by it would render one
 * column on the server and then re-flow — reintroducing the shift. Two/three/five at the same
 * breakpoints the hook resolves to is stable from the first paint.
 */
const CardSkeleton = () => (
  <div className="rounded-[20px] border border-solid border-[var(--film-2)] p-3">
    <Skeleton className="aspect-[4/3] w-full rounded-[14px]" />
    <Skeleton className="mt-3 h-[15px] w-[70%] sm:h-[17px]" />
    <div className="mt-2 flex items-start justify-between gap-3">
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-[8px] w-[54px]" />
        <Skeleton className="h-[12px] w-[62px] sm:h-[13px]" />
      </div>
      <div className="flex flex-col items-end gap-1.5">
        <Skeleton className="h-[8px] w-[44px]" />
        <Skeleton className="h-[12px] w-[56px] sm:h-[13px]" />
      </div>
    </div>
    <div className="mt-3 border-t border-solid border-[var(--film-2)] pt-3">
      <Skeleton className="h-[10px] w-[62%]" />
    </div>
  </div>
);

export function ExploreSkeleton() {
  return (
    <SkeletonRegion label="Loading markets" className="doku-split relative">
      <PageFrame className="mb-4">
        <section className="relative isolate overflow-hidden rounded-[22px]">
          <div className="grid grid-cols-1 items-center gap-6 px-4 pb-3 pt-6 sm:gap-8 sm:px-6 sm:pt-8 lg:grid-cols-[46fr_54fr] lg:gap-10 lg:pb-4 lg:pt-9">
            <HeroCopySkeleton />
            <HeroBoardSkeleton />
          </div>

          {/* The tape, at its real geometry — the chassis, the 32px channel and 26px keys — so
              nothing shifts on arrival. */}
          <div className="doku-tape p-1.5">
            <div className="doku-tape-channel flex h-8 items-center gap-2 overflow-hidden rounded-full px-[3px]">
              {Array.from({ length: 9 }, (_, i) => (
                <Skeleton key={i} className="h-[26px] w-[132px] shrink-0" round />
              ))}
            </div>
          </div>
        </section>
      </PageFrame>

      <PageFrame>
        {/* The toolbar, at the real one's two-row geometry — 42px then 36 on a phone, `--toolbar-h`
            then 36 above `sm`, with the hairline between them. The board's controls are the last
            thing to arrive on this route (the heading waits on `/api/status`, the chips on the
            quote registry), so a skeleton that mirrors one row where there are two hands the grid
            a different starting line than the real page does. */}
        <div className="flex h-[42px] items-center justify-between gap-3 sm:h-[var(--toolbar-h)]">
          <div className="flex items-center gap-3">
            <Skeleton className="h-[13px] w-[86px]" />
            <Skeleton className="h-[18px] w-[76px] rounded-[9px] sm:w-[132px]" />
          </div>
          <Skeleton className="h-[36px] w-[86px] rounded-doku-xl sm:w-[168px]" />
        </div>

        {/* The search is a real field on a phone now rather than a 36px key, so the tray takes
            what is left of the line instead of all of it. `min-w-0` on the tray and a fixed basis
            on the field, which is the live row's own arrangement — see `BoardSearch`. */}
        <div className="flex items-center justify-between gap-2 border-t border-solid border-line pt-3 sm:gap-4 sm:pt-3.5">
          <Skeleton className="h-[36px] w-full min-w-0 rounded-doku-xl sm:w-[617px]" />
          <Skeleton className="h-9 w-[124px] shrink-0 rounded-doku-lg sm:w-[260px]" />
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {Array.from({ length: 10 }, (_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      </PageFrame>
    </SkeletonRegion>
  );
}

export default ExploreSkeleton;
