import { cn } from "lib/utils/class-name";
import React from "react";

/**
 * The brand lockup: a solid green disc carrying the wordmark, optionally followed by the wordmark
 * in ink.
 *
 * ## Outlines, not type
 *
 * Both used to be live text — "DOKU" in `.wordmark`, which is Plex Sans set `italic`. This app
 * ships Plex upright only (see `styles/fonts.ts`), so there was no italic to set: the browser
 * synthesised one by shearing the upright glyphs, and a synthetic shear moves the ink without
 * moving the box it is measured and centred by. Every letter leaned out of its own box to the
 * right, so the word sat visibly right of centre in the disc and leaned beside it — on the one
 * object on the page that has to be exact. It also reflowed when the font swapped in.
 *
 * What is here is the mark itself: the four glyphs of Archivo ExtraBold Italic (weight 800,
 * standard width, `-0.045em` tracking, kerned), the face and setting `brand.md` names and the
 * one `public/logo512.png` is drawn in — fitted against that icon's pixels, not by eye. The path
 * is normalised to its own ink box, so the box IS the ink, and centring the box centres the
 * letters. For an italic that is also the optical centre: the ink box of a slanted block is a
 * parallelogram's bounds, and its centre is the centre of the midline.
 */

/** The outlines, in font units, origin at the top-left of the ink box. */
const WORDMARK_PATH =
  "M0 699.1 121 12H395.8Q543.9 12 623.9 77Q703.8 141.9 703.8 278.7Q703.8 301.5 702.1 324.7Q700.3 347.8 695.8 371.9Q677.2 479.1 625.6 551.9Q574 624.8 493.6 661.9Q413.1 699.1 306.1 699.1ZM204.3 558.7H306.1Q348.6 558.7 382.5 546.7Q416.5 534.6 441.7 512Q467 489.3 483.4 455.8Q499.8 422.4 507.2 380.1Q512.8 350.3 515.3 332.6Q517.9 314.9 518.9 304.1Q519.9 293.2 519.9 284.9Q519.9 241.3 504.4 211.8Q489 182.4 458.2 167.4Q427.5 152.3 380.5 152.3H275.6ZM1049.9 711.1Q949.1 711.1 877.6 680.5Q806.2 650 768.9 589.4Q731.5 528.8 731.5 438.7Q731.5 416.4 733.6 393.6Q735.6 370.9 739.6 347.8Q758.7 236.1 810.3 158.4Q861.8 80.7 946.5 40.4Q1031.2 0 1149.4 0Q1250.7 0 1322.2 30.5Q1393.6 61.1 1431.2 121.9Q1468.7 182.8 1468.7 274Q1468.7 294.9 1466.9 316.9Q1465.2 338.9 1461.2 361.4Q1442.5 473.6 1390 551.7Q1337.4 629.9 1252.2 670.5Q1166.9 711.1 1049.9 711.1ZM1059.3 570.7Q1104 570.7 1139.8 557.4Q1175.7 544.1 1202.5 519Q1229.3 493.9 1246.8 457.8Q1264.3 421.6 1272.1 376.6Q1276.2 353.5 1278.7 337.5Q1281.3 321.5 1282.5 311Q1283.8 300.5 1284.3 293.1Q1284.8 285.7 1284.8 279.3Q1284.8 236 1268.6 204.7Q1252.3 173.5 1219.8 156.7Q1187.4 139.9 1139.1 139.9Q1094.8 139.9 1059 153.2Q1023.1 166.5 996.5 191.7Q970 216.8 952.6 252.9Q935.1 289 927.3 334Q923.2 357.7 920.9 373.6Q918.5 389.6 917.3 400.4Q916 411.2 915.5 418.3Q915 425.5 915 431.8Q915 474.6 931 505.9Q946.9 537.2 979.2 554Q1011.4 570.7 1059.3 570.7ZM1474.5 699.1 1596 12H1775.5L1723.2 306.2L2036.6 12H2268.4L1963.7 293.2L2152.3 699.1H1947.7L1823.4 413.2L1684.4 528.5L1653.9 699.1ZM2528.1 711.1Q2392.4 711.1 2316.1 655.4Q2239.8 599.7 2239.8 489.8Q2239.8 475.2 2241.3 459Q2242.8 442.8 2245.8 426.2L2318.7 12H2498.2L2424.8 428.2Q2423.8 435.8 2422.3 445.8Q2420.9 455.9 2420.9 464.8Q2420.9 515.1 2450 543.1Q2479 571.2 2537.9 571.2Q2606.2 571.2 2648.7 533.1Q2691.1 495.1 2703 429.1L2776.8 12H2956.2L2881.3 438Q2865.3 529.2 2819.4 590.1Q2773.5 650.9 2700.4 681Q2627.3 711.1 2528.1 711.1Z";

/** The ink box. The cap height is 686 of these, with O and U overshooting it by 12 each way. */
const WORDMARK_W = 2956.2;
const WORDMARK_H = 711.1;

/**
 * How much of the disc's diameter the word spans: 405 of 512 in `logo512.png`. Wider and the D's
 * foot and the U's shoulder crowd the rim at 28px; narrower and the disc reads as a badge with a
 * caption in it rather than as one mark.
 */
const DISC_INK = 0.791;

export function BrandDisc({
  size = 30,
  className,
  glow,
}: {
  size?: number;
  className?: string;
  glow?: boolean;
}) {
  const scale = (100 * DISC_INK) / WORDMARK_W;
  return (
    <span
      className={cn(
        "relative block shrink-0 rounded-full bg-doku",
        glow && "shadow-[0_0_28px_-6px_rgb(var(--doku-rgb)/0.8)]",
        className
      )}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {/* Positioned in the disc's own 100-unit space rather than by flex centring, so the offset
          is exact arithmetic instead of a layout pass rounding a 22.1px box into a 28px one.

          `text-canvas`, not `text-white`: this palette remaps `white` to cream ink, which on the
          brand green would be cream-on-green at about 1.3:1. The letters take the page ground,
          the same inversion the nav pills use for their active state. */}
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full text-canvas">
        <path
          fill="currentColor"
          transform={`translate(${50 - (WORDMARK_W * scale) / 2} ${50 - (WORDMARK_H * scale) / 2}) scale(${scale})`}
          d={WORDMARK_PATH}
        />
      </svg>
    </span>
  );
}

/**
 * The wordmark beside the disc, sized in `em` so the caller's `text-[15px]` still sets it.
 *
 * 0.711em tall is the ink height of the word at that font size, so a size carried over from the
 * text version keeps its footprint. The box is the ink, so `items-center` on the lockup lines the
 * word's cap band up with the disc's centre rather than a line box's.
 */
export function BrandWordmark({ className }: { className?: string }) {
  return (
    <svg
      viewBox={`0 0 ${WORDMARK_W} ${WORDMARK_H}`}
      role="img"
      aria-label="DOKU"
      className={cn("block shrink-0 text-ink", className)}
      style={{ height: `${WORDMARK_H / 1000}em`, width: `${WORDMARK_W / 1000}em` }}
    >
      <path fill="currentColor" d={WORDMARK_PATH} />
    </svg>
  );
}
