import { cn } from "lib/utils/class-name";

/**
 * The frame every route's content sits inside.
 *
 * ## Why the page needed one
 *
 * Every surface in this product is built the same way — a tray, a hairline rim, a bezel with a lit
 * top edge — and the page itself was the one thing that was not. Content sat directly on the
 * canvas, full width, with nothing separating "the app" from "the background", so a grid of cards
 * read as objects floating in a void rather than as objects *on* something.
 *
 * This is that missing surface, and it is deliberately the quietest one in the system: a
 * translucent wash, one hairline, one lit edge. It has to lose every contrast contest it enters
 * with the cards sitting on it, or it stops being a ground and starts being a panel.
 *
 * ## Why it bleeds outward instead of padding inward
 *
 * The frame is inset by a negative margin and then given the same padding back
 * (`-mx-4 px-4`, `sm:-mx-6 sm:px-6`). The visible edge therefore lands on the outside of
 * `ContentWrapper`'s rail while the content inside keeps the exact horizontal position it had
 * before this element existed — the frame is added with zero layout shift.
 *
 * That is not tidiness, it is a hard constraint. The home grid's column count is computed from the
 * *viewport* — `useGridRowLength` divides `min(innerWidth, 1240) - 48` by the card's minimum width
 * — so it assumes the rail's own padding and nothing else. Any real padding here would take pixels
 * off the row without the hook knowing, and the four cards it asked for would each come out
 * narrower than the floor that decided there could be four.
 *
 * ## Why the background is translucent
 *
 * `BackgroundEmojis` renders a drifting emoji field at `z-index: -1` inside `#content-wrapper`,
 * and this frame is its sibling. An opaque fill would erase it on every route. At this alpha the
 * field still reads through, which is the effect the `glass` token in `tailwind.config.js` was
 * introduced for.
 *
 * The landing route opts out entirely — see `#content-wrapper:has(.landing) .doku-page-frame` in
 * `global.css`, which dissolves this the same way the rail itself is dissolved, so the hero's
 * full-bleed mesh is not interrupted by a box.
 */
/*
 * The surface itself is declared in `global.css`, not inline here.
 *
 * It was inline first, and the landing route's opt-out silently did nothing: an inline `style`
 * beats any selector in a stylesheet, so `#content-wrapper:has(.landing) .doku-page-frame` cleared
 * the radius (a utility class, so beatable) and left the background and the border painted right
 * across the hero. Both declarations belong in the same cascade or the exception cannot win.
 */
const PageFrame = ({
  children,
  className,
}: {
  children: React.ReactNode;
  /**
   * For routes that compose their own frames.
   *
   * The home page stacks two of these — one for the hero, one for the grid — and needs to set the
   * gap between them. Everything else uses the single frame applied in `providers.tsx` and passes
   * nothing.
   */
  className?: string;
}) => (
  <div
    className={cn(
      /*
       * Tighter above the fold on a phone.
       *
       * `pb-12 pt-6` is 72px of vertical padding, which on a 1440px desktop is a comfortable margin
       * and on an 844px phone is nine percent of the screen spent on nothing — visible on /explore,
       * where the hero frame's bottom rule sat a full thumb's width below the last label. The
       * padding is a page margin, and a page margin should scale with the page.
       */
      /*
       * On a phone the frame stops short of the screen edge.
       *
       * It used to bleed by exactly the wrapper's own padding (`-mx-4` against `px-4`), which put
       * its outer edge at x=0: the panel ran off both sides of the display, its 26px corners were
       * cut in half, and the rim floating 5px proud of it was clipped away entirely by
       * `ContentWrapper`'s `overflow-x: clip`. So the one surface whose whole job is to be the
       * *ground* the cards stand on was the only one on the page with no edges — it read as the
       * page's background rather than as an object, which is the opposite of what it is for.
       *
       * `-mx-2` bleeds 8px instead of 16, so 8px of canvas shows either side, the corners are whole
       * and the rim clears the clip with 3px to spare. `px-2` gives the same 8px back inside, which
       * is the load-bearing half: content lands at exactly the same x it did before, so the grid —
       * whose column count is measured against the viewport rather than against this element (see
       * `useGridRowLength`) — is not narrowed by a single pixel.
       *
       * ## And the same arithmetic above `sm`, which was missed
       *
       * `sm:-mx-6` cancelled `ContentWrapper`'s `sm:px-6` exactly, putting the frame's outer edge
       * ON the wrapper's own border box — so the rim, floating 5px proud, fell outside it and
       * `overflow-x: clip` took the whole left and right stroke. The frame kept its top border and
       * lost its sides, on every viewport above 640px. `-mx-[19px]` is the same 24 minus the rim's
       * 5, and `px-[19px]` gives it back inside, so content lands where it always did.
       */
      "doku-page-frame relative -mx-2 flex flex-1 flex-col px-2 pb-7 pt-4 sm:-mx-[19px] sm:px-[19px] sm:pb-12 sm:pt-6",
      className
    )}
  >
    {children}
  </div>
);

export default PageFrame;
