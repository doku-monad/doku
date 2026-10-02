"use client";

/*
 * eslint-disable @next/next/no-img-element — the logo is a URL a launcher typed, from any host.
 * `next/image` requires every host to be allow-listed in `next.config.mjs`, and a permissionless
 * launchpad cannot hold that list.
 */
/* eslint-disable @next/next/no-img-element */

import { cn } from "lib/utils/class-name";

/**
 * A coin's square mark — its logo, or a monogram built from its ticker.
 *
 * One component because the board card, the hero's runner rows and the tape chip all draw the same
 * object at three sizes, and they used to draw three different ones: an emoji in a lit well, an
 * emoji in a smaller well, and a bare emoji. When the coin *was* an emoji that was merely
 * inconsistent; now that most coins have no image at all, the fallback is the thing most people
 * will actually see, and it has to be the same fallback everywhere or the same coin is
 * unrecognisable between the hero and the grid.
 *
 * The monogram is the first three characters of the ticker in the display face. Not initials of the
 * name: a ticker is what the rest of the card is keyed to, it is already upper case, and it is
 * short by construction — a name's initials would give "AB" for two coins out of five.
 */
export const CoinMark = ({
  logo,
  ticker,
  name,
  size = 44,
  className,
}: {
  logo?: string | null;
  ticker: string;
  /** Used only for the alt text when a logo is present. */
  name?: string;
  /**
   * The box the mark is drawn into.
   *
   * A number is pixels; a string is any CSS length, which is how the market card asks for
   * `var(--coin-mark)` and gets a mark that changes size at a breakpoint. A `size` prop is a
   * *number* set once at render, so it cannot answer a media query at all — and the card needs a
   * smaller mark on a phone, where the whole point of the exercise is fitting two cards on screen.
   *
   * The same escape hatch `PairMark` already carries, for the same reason.
   */
  size?: number | string;
  className?: string;
}) => {
  const monogram = (ticker || name || "?")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 3)
    .toUpperCase();

  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden rounded-doku-xl border border-line",
        className
      )}
      style={{ width: size, height: size, background: "var(--mat-well-bg)" }}
    >
      {logo ? (
        /* Lazy for the same reason the card's banner is: this mark is rendered once per card
           across the whole board, and the ones below the fold should not compete with hydration.
           See the note in `coin-card`. */
        <img
          src={logo}
          alt=""
          aria-hidden
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
      ) : (
        <span
          className="select-none font-pixel uppercase leading-none tracking-[0.02em] text-ash"
          /* Scaled off the tile so one component serves 26px chips and 44px card marks without a
             size prop per call site deciding its own type scale. A CSS-length box has no number to
             scale from here, so the same proportion is expressed as a `calc()` on the length —
             which resolves against a custom property just as happily as against `84px`. */
          style={{
            fontSize:
              typeof size === "number"
                ? Math.max(8, Math.round(size * 0.3))
                : `calc(${size} * 0.3)`,
          }}
        >
          {monogram}
        </span>
      )}
    </span>
  );
};

export default CoinMark;
