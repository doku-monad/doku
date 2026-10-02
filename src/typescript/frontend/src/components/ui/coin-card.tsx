"use client";

/*
 * eslint-disable @next/next/no-img-element — the logo and banner are URLs a launcher typed, from
 * any host. `next/image` requires every host to be allow-listed in `next.config.mjs`, and a
 * permissionless launchpad cannot hold that list.
 */
/* eslint-disable @next/next/no-img-element */

import { motion, useMotionValue, useReducedMotion, useSpring, useTransform } from "framer-motion";
import { cn } from "lib/utils/class-name";
import { useCallback, useEffect, useRef, useState } from "react";

import type { QuoteAsset } from "@/lib/assets/quote-assets";
import { useCopyFlag } from "@/lib/hooks/use-copy-flag";

import { AssetIcon } from "./asset-icon";
import { CoinMark } from "./coin-mark";

/**
 * A coin, as a card.
 *
 * ## What this replaced
 *
 * A mounted emoji specimen: a 1067-line component built around a lit display window with an
 * iridescent ring, a two-stop bloom keyed to the market's state, corner brackets that drew
 * themselves on hover, and a dither layer to stop the bloom banding. It was a good object and it
 * was answering the wrong question — it made the *glyph* the subject, because when this was an
 * emoji launchpad the glyph was the coin.
 *
 * A coin has a name someone chose, a ticker, a logo, a pair, a creator and a set of links. None of
 * those fit inside a lit window, and all of them are what a person scanning a board actually reads.
 *
 * ## The layout, and why it is in this order
 *
 * Five bands, divided by hairlines, in the order a trader reads them:
 *
 *   1. **Banner** — the coin's own image, or one generated from its ticker, carrying the rank plate
 *      in its corner and the curve meter across its foot. Identity at a glance, from across the
 *      grid, before any text is legible.
 *   2. **Identity** — logo, name (scrolling if it is too long for the card), `$TICKER · age`.
 *   3. **Figures** — the market cap, its delta and the asset it is quoted in. Three facts that are
 *      only useful together, so they share one row; see the note on `.doku-pair-badge`.
 *   4. **Provenance** — contract address (copyable) and the market's state.
 *   5. **Actions** — the coin's own links, its creator, and the three places to look it up.
 *
 * The bands are separated rather than merged because each answers a different question, and a card
 * that runs them together is one you have to read linearly instead of jumping to the row you want.
 *
 * ## The edges
 *
 * Four of them, and they are four different things rather than four borders: the tray the card is
 * pressed into, the rim floating proud of it, the bezel's lit top lip, and — drawn over everything,
 * because the bezel clips its children and its children paint grounds — the card's own hairline at
 * `--line-2`. See `EDGE`, which exists because without that last layer the card had no visible
 * outline anywhere a ground reached its edge, which is most of its height.
 *
 * ## Readability is the whole brief
 *
 * Every label on this card is `mute` or better and every value is `ink`. Nothing informational is
 * set in `faint` — `brand.md` is explicit that `faint` is 2.39:1 and decorative only, and the
 * previous card used it for the age, the address, the creator and every stat label, which is most
 * of the card. The type scale is bigger across the board and the grid gives each card ~300px
 * rather than ~250, because the fix for "I cannot read this" is usually width, not weight.
 */

export interface CoinCardProps {
  /** The coin's name. */
  name: string;
  /** Ticker without the `$`; the card adds the sigil. */
  ticker: string;
  /** Square logo. Falls back to a monogram tile built from the ticker. */
  logo?: string | null;
  /** Wide card image, roughly 3:1. Falls back to a mark generated from the ticker. */
  banner?: string | null;
  /**
   * What the coin trades against.
   *
   * The whole asset rather than its ticker, so the badge can carry the issuer's mark. `NVDAx` next
   * to a coin means nothing to somebody who has not read the registry; the NVIDIA mark beside it
   * means it immediately, which is the entire argument for pairing against real-world assets.
   */
  pair?: QuoteAsset;
  /**
   * Market cap: either a ready-made string, or a number formatted with `currency`.
   *
   * A number is formatted compactly. This app denominates in MON unless a price feed is configured,
   * so the caller decides the unit and its position — see the note in the grid cell about never
   * printing a `$` on a figure that is really MON.
   */
  marketCap: number | string;
  currency?: string;
  currencyPosition?: "prefix" | "suffix";
  /**
   * The percentage beside the cap, coloured by its sign.
   *
   * A number rather than a formatted string, because the sign picks the colour and the card should
   * not have to parse a `-` back out of the caller's text. `null` renders nothing at all rather
   * than a `0%` invented out of missing data.
   */
  delta?: number | null;
  /** What `delta` measures, for the tooltip. */
  deltaLabel?: string;
  contractAddress: string;
  creator?: string;
  /**
   * The creator's account on the block explorer.
   *
   * Separate from `creator` for the same reason `explorerHref` is separate from `contractAddress`:
   * this component has no business knowing which chain it is on, and a card that built its own
   * explorer URL would be a second place to fix the day the explorer moves. The caller has the
   * helper — see `TableCard`.
   */
  creatorHref?: string;
  launchedAt?: Date | number | string;
  /** Pre-formatted age, for callers that already computed one. Wins over `launchedAt`. */
  age?: string;
  /** 0–100. Ignored when `isGraduated`. */
  graduationPercentage?: number;
  isGraduated?: boolean;
  /** Position in the list this card came from — 1-based and absolute, or omitted. */
  rank?: number;
  links?: { website?: string; x?: string };
  /** A link to this coin on the block explorer. */
  explorerHref?: string;
  /**
   * Where this coin can be looked up outside DOKU — see `lib/external-links`.
   *
   * Three destinations rather than one, because they answer three different questions and traders
   * ask all of them: DexScreener for the chart and the pool, GMGN for wallet-level flow, and the
   * coin's own trader board for who is actually in it. A card that links only to itself is a card
   * people leave to open three tabs by hand.
   */
  external?: { dexscreener: string; gmgn: string; fomo: string };
  href?: string;
  className?: string;
}

/* ---------------------------------------------------------------------------------------------
 * Formatting
 * ------------------------------------------------------------------------------------------- */

/**
 * Drops trailing zeros without dropping significant ones.
 *
 * `1.50` is a figure printed to a precision it does not have; `1.5` is the same number said
 * plainly. It matters here because the magnitude suffix already carries the scale — `$1.50M` reads
 * as false precision where `$1.5M` reads as a round number.
 */
const trimZeros = (value: number, dp: number) =>
  value.toFixed(dp).replace(/\.0+$|(\.\d*[1-9])0+$/, "$1");

/**
 * A figure at roughly three significant digits, with its magnitude as a suffix.
 *
 * `$1.5M`, `$450K`, `$45.2K`, `$843.6`.
 */
export const formatCompact = (n: number) =>
  n >= 1_000_000_000
    ? `${trimZeros(n / 1_000_000_000, 2)}B`
    : n >= 1_000_000
      ? `${trimZeros(n / 1_000_000, 2)}M`
      : n >= 1_000
        ? `${trimZeros(n / 1_000, 1)}K`
        : trimZeros(n, 2);

/**
 * A percentage with its sign always written out.
 *
 * The sign is the part being read, so it is never dropped: an unsigned figure in a column that is
 * otherwise signed reads as a missing value rather than as zero.
 */
const formatSignedPercent = (pct: number) => {
  const magnitude = Math.abs(pct);
  const figure = magnitude >= 10 ? Math.round(magnitude) : Number(magnitude.toFixed(1));
  return `${pct < 0 ? "−" : "+"}${figure}%`;
};

/** `0x1234…ABCD`. Falls back to the raw value for anything too short to truncate meaningfully. */
const truncateAddress = (address: string, lead = 6, tail = 4) =>
  address.length <= lead + tail + 1 ? address : `${address.slice(0, lead)}…${address.slice(-tail)}`;

/** Compact age. Minutes below an hour, then hours, then days — one unit, never "3d 4h". */
const formatAge = (at: Date | number | string): string => {
  const ms = Date.now() - new Date(at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
};

/* ---------------------------------------------------------------------------------------------
 * The generated banner
 *
 * Most coins never upload one, so this is the cover the board and the market page actually wear.
 * It is generated rather than a shipped image: nothing to download, nothing to keep in an object
 * store, and identical on the server and in the browser.
 *
 * ## What it stopped being
 *
 * A flat hue wash with the coin's own ticker set across it at 44px. Three things were wrong with
 * that, and they are worth writing down because each of them looks like a detail and is not:
 *
 *   1. **The palette said things it did not mean.** Six hues, two of which — `warn` and `loss` —
 *      are this product's *status* colours. A coin drawn in `loss` is a red card on a board where
 *      red means down, and `BURN` got one. Identity now draws from the four hues that carry no
 *      reading: the brand green, `halo`, `lilac`, `blush`.
 *   2. **The ticker was in the one place it could not go.** Bottom left, which is exactly where
 *      the coin's mark is mounted — so on a real card the word was cut in half by the logo sitting
 *      on top of it.
 *   3. **It was already written twice.** `$COLD` is printed under the cover and `COL` is on the
 *      mark in front of it. A third copy at 44px is not decoration, it is repetition, and the
 *      wallet's own version of this band worked that out first — see `AddressCover`, which
 *      deliberately refused to tile an address behind the same address.
 *
 * ## What it is
 *
 * Material, lit from one corner, with no words on it at all. Two weaves, because a board of forty
 * identical grounds takes away the one cue that lets somebody find a card again after scrolling
 * past it:
 *
 *   - **Lattice** — the fine dot grid the explore hero's ground is made of, so an empty cover is
 *     visibly cut from the same cloth as the fold above it.
 *   - **Knurl** — close diagonal hairlines, the grip on a machined dial. The rest of this product
 *     is trays, rims and lit lips; this is what those are milled from.
 *
 * Both are films and shades, never colour. The only colour is one soft wash entering from a
 * corner, and the weave is masked to fade *into* that wash — texture reads strongest where the
 * light is weakest, which is how a real surface behaves and is most of why this looks machined
 * rather than printed.
 *
 * Four hues, two weaves and four corners give sixteen distinguishable covers, every one of them
 * recognisably the same object. Deterministic and pure: the same seed always draws the same
 * ground, so there is no hydration mismatch and a coin looks like itself on the board, on its own
 * page, and anywhere else this is used.
 * ------------------------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------------------------
 * The materials.
 *
 * Four names, and every value behind them lives in `global.css` as a token. They were literal
 * gradients once, copied out of the top bar — which is how the bar and the card drifted apart
 * twice, because nobody can diff a gradient by eye across two files. One declaration per material,
 * and Lite Mode restates each as paper rather than as metal.
 * ------------------------------------------------------------------------------------------- */

/** The recessed tray the whole card is pressed into. */
const TRAY = {
  background: "var(--mat-tray-bg)",
  boxShadow: "var(--mat-tray-shadow)",
} as const;

/**
 * The collar the coin's mark is mounted in, and the mark's own face.
 *
 * The mark straddles the cover's bottom edge, so whatever surrounds it has one job: make it read as
 * standing in front of the artwork rather than as a hole cut in it. This was a flat `0 0 0 3px`
 * ring in the body's colour with an iridescent conic band showing through a 2px gap — three tells
 * at once. The conic is a *spectrum*, so at rest it drew a green corner and a violet one around a
 * dark square and read as a rendering fault; the flat ring had no light in it at all; and neither
 * cast a shadow, so a 108px object sat on the cover with nothing under it.
 *
 * What is here instead is the construction the rest of the product is made of, at mark scale: a
 * collar in `--mat-cover-foot` — the body's own colour, so the mark is punched through the cover
 * and follows the theme — a hairline rim around it, a lit lip along its top edge where the light in
 * this app always comes from, and two shadows underneath. The shadows are what supply the depth:
 * one tight and one wide, both biased downward so the mark casts onto the body below rather than
 * smearing sideways across the meter beside it.
 *
 * The hue still lights on hover; it is on the collar's rim now, with the card's other rim, rather
 * than being its own spinning object.
 */
const MARK_MOUNT = [
  "0 0 0 1px var(--film-2)",
  "inset 0 1px 0 var(--film-4)",
  "0 2px 4px -1px var(--shade-2)",
  "0 12px 20px -10px var(--shade-3)",
].join(", ");

/** The face inside the collar: a lit top edge and a shaded foot, so the mark is seated in it. */
const MARK_FACE = "inset 0 1px 0 var(--film-4), inset 0 -2px 3px -1px var(--shade-2)";

/** The bezel sitting in the tray, with its lit top edge. */
const BEZEL = {
  background: "var(--mat-bezel-bg)",
  borderTop: "1px solid var(--mat-bezel-edge)",
} as const;

/**
 * The card's own edge, drawn over everything inside it.
 *
 * ## Why this is a separate layer rather than a border on the bezel
 *
 * The bezel clips its children, and its children paint grounds — the banner runs to all four edges,
 * the footer band carries a film. A border on that element is painted under them, so the card's
 * outline vanished along exactly the runs where a ground touched the edge, which is most of the
 * card's height. That is the whole reason the edge read as "not that visible": it was there, and it
 * was underneath things.
 *
 * Drawn on top, at `--line-2` — the visible hairline, not the almost-invisible one used *inside*
 * objects — with a lit line under its top edge, so the border reads as a machined lip rather than
 * as a stroke. `pointer-events-none`, so it never takes a click from the overlay link beneath it.
 */
const EDGE = {
  borderColor: "var(--film-4)",
  /*
   * A lit top lip *and* a shaded foot.
   *
   * The lit line alone gave the card a top edge and left the bottom one to the hairline, so the
   * object read as lit from above on one side and flat on the other. Both lines together is the
   * whole grammar this product uses for a raised surface — every key in the dock, the pair badge,
   * the rank plates — and at card scale it is what makes the inner of the two borders read as the
   * card's own lip rather than as a second stroke someone added.
   */
  boxShadow: "inset 0 1px 0 var(--film-3), inset 0 -1px 0 var(--shade-2)",
} as const;

/** Cells in the graduation meter. Reads as an instrument; also rhymes with the pixel face. */
const SEGMENTS = 14;

/**
 * The caption over a figure.
 *
 * One declaration because there are two of them side by side and they have to be identical — a
 * pair of column headings that differ by half a pixel of tracking is the kind of thing nobody can
 * name and everybody can see.
 */
const FIGURE_LABEL =
  "font-numeric text-[11.5px] font-semibold uppercase leading-none tracking-[0.08em] text-mute";

/**
 * The identity hues, as token names.
 *
 * Four, not six. `warn` and `loss` are gone: they are the colours this product uses for "needs
 * attention" and "down", and a cover drawn in either of them makes a claim about the coin that
 * nobody chose and nothing supports.
 */
const BANNER_HUES = ["doku", "halo", "lilac", "blush"] as const;

/** The two weaves. See the note above for what each one is quoting. */
const BANNER_WEAVES = ["lattice", "knurl"] as const;

/** Where the light enters. One corner, so the band has a direction rather than a middle. */
const BANNER_ORIGINS = ["14% 0%", "86% 0%", "14% 100%", "86% 100%"] as const;

/** FNV-ish, and stable across runtimes. The seed is a ticker or an address; anything goes. */
const hashOf = (seed: string) => {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++)
    h = (Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0) >>> 0;
  return h;
};

/**
 * The hue alone.
 *
 * The card tints its hover rim and pointer wash with the coin's own colour, and that has to be the
 * colour its cover is drawn in whether or not the cover is the generated one. Not exported any
 * more: the wallet used to read it to hand-roll a matching band, and now draws `GeneratedBanner`
 * itself.
 */
const hueFor = (seed: string) => BANNER_HUES[hashOf(seed) % BANNER_HUES.length];

/**
 * The whole ground for one seed.
 *
 * Three different slices of the hash rather than three functions of the same number, so a coin
 * that lands on the brand green is no more likely to be knurled than latticed.
 */
const groundFor = (seed: string) => {
  const h = hashOf(seed);
  return {
    hue: hueFor(seed),
    weave: BANNER_WEAVES[(h >>> 6) % BANNER_WEAVES.length],
    origin: BANNER_ORIGINS[(h >>> 13) % BANNER_ORIGINS.length],
  };
};

/**
 * The cover a coin without artwork wears, on every surface that draws one.
 *
 * `seed` is whatever identifies the thing: a ticker for a coin, an address for a wallet. It only
 * has to be stable — the same seed draws the same ground for the life of the product.
 */
export const GeneratedBanner = ({ seed }: { seed: string }) => {
  const { hue, weave, origin } = groundFor(seed || "COIN");
  const tint = (alpha: number) => `rgb(var(--${hue}-rgb) / ${alpha})`;

  return (
    <div
      aria-hidden
      className="absolute inset-0 overflow-hidden"
      /*
        The ground and the light, in one paint.

        The wash is wider than the box on purpose (`150% 190%`): a radial that fits inside the band
        has a visible edge where it lands, and an edge is the thing that makes a gradient read as a
        shape drawn on a surface rather than as light falling across one.
      */
      style={{
        background: `
          radial-gradient(150% 190% at ${origin}, ${tint(0.3)} 0%, ${tint(0.07)} 40%, transparent 72%),
          var(--mat-well-bg)
        `,
      }}
    >
      {/*
        The weave, fading into the light.

        The mask is what keeps this from looking like a texture laid over a picture: at full
        strength everywhere, close hairlines across a lit corner read as dirt on the lens. Strongest
        where the wash has fallen away, gone where it is brightest — which is how machined metal
        actually photographs, and it costs one gradient.
      */}
      <span
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            weave === "lattice"
              ? "radial-gradient(circle at 1px 1px, var(--film-3) 1px, transparent 0)"
              : "repeating-linear-gradient(118deg, var(--film-2) 0 1px, transparent 1px 7px)",
          backgroundSize: weave === "lattice" ? "22px 22px" : undefined,
          WebkitMaskImage: `radial-gradient(150% 190% at ${origin}, transparent 0%, #000 62%)`,
          maskImage: `radial-gradient(150% 190% at ${origin}, transparent 0%, #000 62%)`,
        }}
      />

      {/*
        The lit lip.

        Every raised face in this product catches light along its top edge, and a cover is the
        topmost face on the card. Without it the band starts abruptly against the card's own rim;
        with it the two read as one object with a seam.
      */}
      <span
        className="pointer-events-none absolute inset-x-0 top-0 h-1/3"
        style={{ background: "linear-gradient(180deg, var(--film-2) 0%, transparent 100%)" }}
      />
    </div>
  );
};

/* ---------------------------------------------------------------------------------------------
 * Small parts
 * ------------------------------------------------------------------------------------------- */

const CopyGlyph = () => (
  <svg
    viewBox="0 0 24 24"
    width="12"
    height="12"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <rect x="9" y="9" width="12" height="12" rx="2.5" />
    <path d="M5.5 15H4.8A1.8 1.8 0 0 1 3 13.2V4.8A1.8 1.8 0 0 1 4.8 3h8.4A1.8 1.8 0 0 1 15 4.8v.7" />
  </svg>
);

const CheckGlyph = () => (
  <svg
    viewBox="0 0 24 24"
    width="12"
    height="12"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="m4 12.5 5 5L20 6.5" />
  </svg>
);

export const GlobeGlyph = () => (
  <svg
    viewBox="0 0 24 24"
    width="13"
    height="13"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.9"
    aria-hidden
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9S14.5 18.3 12 21c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3Z" />
  </svg>
);

export const XGlyph = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden>
    <path d="M13.9 10.6 21.3 2h-1.8l-6.4 7.5L8 2H2.2l7.8 11.3L2.2 22H4l6.8-7.9L16.2 22H22l-8.1-11.4Zm-2.4 2.8-.8-1.1L4.6 3.3h2.7l5.1 7.3.8 1.1 6.6 9.4h-2.7l-5.6-7.7Z" />
  </svg>
);

/**
 * The block explorer, as a block.
 *
 * It was a generic arrow-out-of-a-box — the same glyph the whole web uses for "opens in a new tab",
 * sitting in a row where *every* control opens in a new tab. It said nothing about the destination,
 * and next to the coin's site and its X account it was the one icon that named no place at all.
 *
 * A cube in isometric, with its three visible faces implied by the seams meeting at the top vertex.
 * That is the one shape that means "block" to anybody who has used a chain explorer, it survives at
 * 13px because it is three straight lines inside a hexagon, and it belongs to the same outline
 * family as the globe beside it rather than to a brand.
 */
export const ExplorerGlyph = () => (
  <svg
    viewBox="0 0 24 24"
    width="13"
    height="13"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.9"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M12 2.8 20.2 7.4v9.2L12 21.2 3.8 16.6V7.4L12 2.8Z" />
    <path d="M3.9 7.5 12 12l8.1-4.5M12 12v9.2" />
  </svg>
);

/**
 * The coin's name, which scrolls when it does not fit.
 *
 * ## Why truncation alone was not enough
 *
 * Names here are typed by whoever launched the coin, and on a memecoin launchpad a meaningful share
 * of them are sentences. `INFINITE MONEY GLITCH MACHINE` truncates to `INFINITE MONEY GL…` in a
 * 300px card, and the part that got cut is the part that made it funny — which on this product is
 * the part that makes it a coin somebody buys. A `title` tooltip is not an answer either: it needs
 * a pointer held still for a second, and it does not exist on a phone at all.
 *
 * ## Why it only runs under the pointer
 *
 * Forty of these are on screen. Forty names scrolling continuously is a page that vibrates, and it
 * is the single fastest way to make a dense board feel cheap. Hovering a card is already the
 * gesture that means "this one" — the lift, the rim, the wash and the trace all key off it — so the
 * name joining in costs no new interaction and reads as the card opening up.
 *
 * The travel is measured, not guessed: the animation shifts by exactly the overflow, so a name two
 * characters too long moves two characters and a name twice too long moves the whole way. A fixed
 * `-50%` would send short overflows sailing off the edge and leave long ones half-read.
 *
 * Where there is no pointer the name truncates as before and keeps its `title`. That is the same
 * outcome the card has always had, not a regression — the marquee is strictly an addition.
 */
const MarqueeName = ({ name }: { name: string }) => {
  const clip = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  /** Pixels the name is wider than the space it has. `0` means it fits and nothing animates. */
  const [overflow, setOverflow] = useState(0);

  useEffect(() => {
    const box = clip.current;
    const label = text.current;
    if (!box || !label) return;

    /* A pixel of slack: sub-pixel layout rounding makes `scrollWidth` exceed `clientWidth` by
       fractions on names that visibly fit, and a card that scrolls its name by 0.4px on hover is a
       card with a twitch in it. */
    const measure = () => setOverflow(Math.max(0, Math.round(label.scrollWidth - box.clientWidth)));

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(label);
    return () => observer.disconnect();
  }, [name]);

  const scrolls = overflow > 1;

  return (
    <div
      ref={clip}
      title={name}
      /* The fade is only painted while there is something behind it: an always-on mask would
         soften the last letter of every name on the board, including the ones that fit. */
      className={cn("relative overflow-hidden", scrolls && "doku-name-clip")}
    >
      <span
        ref={text}
        className={cn(
          "block w-max whitespace-nowrap font-ui font-semibold text-[16px] uppercase leading-tight tracking-[0.01em] text-ink",
          scrolls && "doku-name-track"
        )}
        style={
          scrolls
            ? ({
                "--doku-name-shift": `${overflow}px`,
                /* Roughly 34px a second, so a name that is barely too long takes about as long to
                   read as one that is twice too long — a fixed duration makes the first crawl and
                   the second bolt. Floored, so a two-pixel overflow is not a flicker. */
                "--doku-name-duration": `${Math.max(2.4, overflow / 34 + 1.6)}s`,
              } as React.CSSProperties)
            : undefined
        }
      >
        {name}
      </span>
    </div>
  );
};

/**
 * One band of the card, and the rule above it.
 *
 * ## The rule is a seam, not a border
 *
 * It was `--line` first — the hairline used *inside* a single object, chosen to be almost invisible
 * — and the bands ran together into one paragraph of mixed type. It went to `--line-2` next, which
 * is the opposite failure: `--line-2` is a grey-green stroke meant to outline an object against the
 * page, and four of them drawn *across* a card cut it into slices. On a surface made of machined
 * metal a hard grey rule reads as a scratch, or as a table border from a different product.
 *
 * What a join between two panels looks like here is a film: a hair of shadow with a hair of light
 * directly under it. `--film-2` over `--film-1`, the same pair the runner board's seams, the tape's
 * lip, the footer's cells and the card's own outer edge all use. It is barely a line and it reads
 * unmistakably as an edge, which is the whole trick — the eye takes it as two surfaces meeting
 * rather than as ink laid across one.
 *
 * ## `tint` is one band, not every other one
 *
 * The grounds used to alternate, on the argument that rules give you a list and alternating grounds
 * give you rows. True in general, wrong here: the band it landed on was the *figures* — the market
 * cap and the pair, the largest and most important type on the card — which made the one thing that
 * should dominate look like a panel inset into the card. Alternation is a rule for rows of similar
 * things, and these bands are not similar things.
 *
 * So the tint is spent once, on the footer, where a ground means "this is the base the card rests
 * on" rather than "this is stripe two of four".
 */
const Band = ({
  children,
  className,
  /** Recesses the band's ground. Used once, on the footer — see the note above. */
  tint,
}: {
  children: React.ReactNode;
  className?: string;
  tint?: boolean;
}) => (
  <div
    className={cn(
      /* Tighter on a phone. 3.5/2 is a comfortable gutter in a 300px desktop column and, multiplied
         by four bands, 26px of a 390px screen's card spent on air. */
      "relative z-10 px-3 py-1.5 sm:px-3.5 sm:py-2.5",
      /*
       * The band does not take clicks; the controls inside it do.
       *
       * The whole card is a link — an `<a>` stretched across it *under* the content, because the
       * card also contains a copy button and several outbound links and a button inside an anchor
       * is invalid HTML. But a band is a painted `z-10` box, so it hit-tests, and it was swallowing
       * every click aimed at the card: pressing a market's name, its price or its address did
       * nothing at all, and the only way into a market page was the 30px venue key in the corner.
       *
       * `pointer-events: none` on the band lets the click fall through to the link beneath, and the
       * two descendant selectors hand it back to the things that genuinely handle their own clicks.
       * Nothing else in a band is interactive.
       */
      "pointer-events-none [&_a]:pointer-events-auto [&_button]:pointer-events-auto",
      className
    )}
    style={{
      background: tint ? "var(--film-1)" : undefined,
      boxShadow: "inset 0 1px 0 var(--film-2), inset 0 2px 0 var(--film-1)",
    }}
  >
    {children}
  </div>
);

/* ---------------------------------------------------------------------------------------------
 * The lookup links
 *
 * Three places a trader checks before buying, as their own marks.
 *
 * ## Why these are icons now
 *
 * They were the words `DEXS`, `GMGN` and `FOMO` in the mono face, on the argument that nobody
 * recognises a DexScreener glyph and everybody recognises the word. Half of that is right — the
 * word is unambiguous — and the conclusion was wrong, because these are not three labels a person
 * reads. They are three destinations somebody already has a relationship with, and a brand mark is
 * the fastest possible way to say "the site you already use". `DEXS` is not even the name.
 *
 * Three marks also cost a third of the width of three four-letter words, which is what let the
 * creator's address stop truncating to `by 0…` in the same row.
 *
 * ## The mark is fetched, not shipped
 *
 * Self-hosted under `public/venues` (it used to come from the site's own domain through `faviconUrl`, the mechanism the quote-asset registry
 * uses for issuer marks, and for the same reason: this repository does not carry copies of other
 * companies' trademarks. A mark that does not load falls back to the site's initials, so the
 * control always says what it is.
 * ------------------------------------------------------------------------------------------- */

const VENUES = {
  dexscreener: {
    name: "DexScreener",
    domain: "dexscreener.com",
    /** Self-hosted (public/venues), 64 px. Fetched once from the site's own favicon and committed,
     *  so the board makes no request to google.com/s2/favicons — a host every content blocker
     *  drops and that cost the board 17 third-party requests per visit. */
    icon: "/venues/dexscreener.png",
    initials: "DS",
    /** What this link is actually for. Becomes the accessible name. */
    purpose: "the chart and the pool",
  },
  gmgn: {
    name: "GMGN",
    domain: "gmgn.ai",
    icon: "/venues/gmgn.png",
    initials: "GM",
    purpose: "wallet-level flow",
  },
  fomo: {
    name: "FOMO",
    domain: "fomo.family",
    icon: "/venues/fomo.png",
    initials: "FO",
    purpose: "who is actually holding",
  },
} as const;

/**
 * One key.
 *
 * ## Why a coin that has not graduated has no keys to press
 *
 * All three destinations describe a *pool*. DexScreener and GMGN index Uniswap pairs, and until the
 * curve graduates there is no pair to index — both open a "token not found" page on a coin that is
 * trading perfectly well on DOKU, which reads as the coin being fake rather than as the venue being
 * early. Fomo lists graduated pools the same way, so the state being communicated is "these
 * lookups exist once this coin is on Uniswap", and that is true of all three at once.
 *
 * Dead keys are `<span>`s, not `<a aria-disabled>`s — the house rule (see the dock in
 * `gradient-button-group.tsx` and the footer's "Soon" rows): a destination that does not exist is
 * not a link, so the keyboard skips it rather than landing on something that does nothing. They
 * keep `.doku-venue` so the channel keeps its three cells and its hairlines, and the mark goes
 * grey — the group holds its width, and the row does not reflow on graduation.
 *
 * There is no `title` on either state. It was the coin's name, the venue's name and the venue's
 * purpose in one string, on a 30px key inside a card that is itself a link — a native tooltip that
 * appeared a second late, over the next card down, saying what the mark already said. `aria-label`
 * stays: that is the accessible name, not a tooltip, and it is the only thing a screen reader has
 * to go on once the mark is an image with an empty `alt`.
 */
const VenueLink = ({
  venue,
  href,
  coin,
  /** Stays in the app, so it opens in place rather than in a new tab. */
  internal,
  /** No pool yet, so nothing to look up. Renders an inert cell in place of the link. */
  disabled,
}: {
  venue: keyof typeof VENUES;
  href: string;
  coin: string;
  internal?: boolean;
  disabled?: boolean;
}) => {
  const { name, icon, initials, purpose } = VENUES[venue];
  const [failed, setFailed] = useState(false);
  const src = icon;
  const label = disabled
    ? `${coin} on ${name} — available once the coin graduates`
    : `${coin} on ${name} — ${purpose}`;

  const mark =
    src && !failed ? (
      <img
        src={src}
        alt=""
        width={16}
        height={16}
        loading="lazy"
        onError={() => setFailed(true)}
        /* Held back at rest so three brand marks in a row do not out-shout the figures above
           them, and full colour under the pointer. */
        className="doku-venue-mark h-4 w-4 object-contain"
      />
    ) : (
      /* The mark that did not load. It brightens under the pointer with the key it sits in — but
         only where the key is live, for the same reason the key itself does not lift when it is
         not. */
      <span
        className={cn(
          "font-numeric text-[11px] font-semibold uppercase leading-none tracking-[0.04em] text-mute transition-colors",
          !disabled && "group-hover/venue:text-ink"
        )}
      >
        {initials}
      </span>
    );

  const className =
    "doku-venue group/venue relative grid h-[26px] w-[30px] place-items-center rounded-[7px]";

  if (disabled) {
    return (
      /* `onClick` still stops the bubble: the card behind this footer is a link to the market, and
         a tap that lands on a key the visitor can see is off should do nothing rather than quietly
         navigate somewhere they did not aim for. */
      <span
        aria-disabled
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
        className={cn(className, "cursor-default")}
      >
        {mark}
      </span>
    );
  }

  return (
    <a
      href={href}
      target={internal ? undefined : "_blank"}
      rel={internal ? undefined : "noreferrer noopener"}
      aria-label={label}
      onClick={(e) => e.stopPropagation()}
      className={className}
    >
      {mark}
    </a>
  );
};

/**
 * The three lookups, as one control.
 *
 * ## Why they are grouped rather than spaced
 *
 * They were three separate 28px squares with their own borders, sitting beside three more of
 * exactly the same size and shape holding the coin's own links. Six identical outlined squares in a
 * 300px footer is not a hierarchy, it is a toolbar — and it made the row read as generic in a way
 * that is hard to name and impossible to unsee once you have.
 *
 * These three are one thing: *look this coin up somewhere else*. So they are built as one thing —
 * a recessed channel with three cells pressed into it, divided by hairlines, in the same material
 * as the segmented controls everywhere else in this product. It reads as a single instrument with
 * three keys, it is visually distinct from the coin's own identity links two elements to its left,
 * and it is narrower than the three loose squares were.
 *
 * ## The marks are fetched, not shipped
 *
 * Self-hosted under `public/venues` (formerly each site's own domain through `faviconUrl`, the mechanism the quote-asset registry
 * uses for issuer marks, and for the same reason: this repository does not carry copies of other
 * companies' trademarks. A mark that does not load falls back to the site's initials, so a key
 * always says what it is.
 */
export const VenueGroup = ({
  external,
  coin,
  className,
  /**
   * Whether the coin has a pool to look up. All three keys are inert until it does — see
   * `VenueLink`. Defaults to `false`, so a caller that has not thought about it gets the safe
   * state rather than three links to a page that says the coin does not exist.
   */
  graduated = false,
}: {
  external: { dexscreener: string; gmgn: string; fomo: string };
  coin: string;
  className?: string;
  graduated?: boolean;
}) => (
  /* No `ml-auto` here: the card's footer pushes it right with its own class, and the market
     masthead sets it in a row of its own. A margin baked into the component is a position decided
     in the wrong file — it stranded the group mid-row on the page that reuses it. */
  <div
    className={cn("doku-venue-group flex shrink-0 items-center rounded-doku-lg p-[2px]", className)}
  >
    <VenueLink venue="dexscreener" href={external.dexscreener} coin={coin} disabled={!graduated} />
    <VenueLink venue="gmgn" href={external.gmgn} coin={coin} disabled={!graduated} />
    <VenueLink venue="fomo" href={external.fomo} coin={coin} disabled={!graduated} />
  </div>
);

export const IconLink = ({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: React.ReactNode;
}) => (
  <a
    href={href}
    target="_blank"
    rel="noreferrer noopener"
    aria-label={label}
    title={label}
    onClick={(e) => e.stopPropagation()}
    className="doku-icon-link grid h-7 w-7 place-items-center rounded-doku-lg border border-solid border-[var(--film-2)] text-mute transition-colors hover:border-[var(--film-4)] hover:bg-[var(--film-2)] hover:text-ink"
  >
    {children}
  </a>
);

/* ---------------------------------------------------------------------------------------------
 * The card
 * ------------------------------------------------------------------------------------------- */

export function CoinCard({
  name,
  ticker,
  logo,
  banner,
  pair,
  marketCap,
  currency = "MON",
  currencyPosition = "suffix",
  delta,
  deltaLabel = "Change",
  contractAddress,
  creator,
  creatorHref,
  launchedAt,
  age,
  graduationPercentage = 0,
  isGraduated = false,
  rank,
  links,
  explorerHref,
  external,
  href,
  className,
}: CoinCardProps) {
  const reduced = useReducedMotion();

  /*
   * Hover, as motion values written straight to the DOM — never React state.
   *
   * Forty of these are on screen at once. A `setState` per `mousemove` re-renders the card sixty
   * times a second, and in a grid that is the difference between buttery and unusable. The two
   * values here drive the ring's opacity and the wash that follows the pointer across the banner;
   * both are read by `style`, which framer writes without a render.
   */
  const root = useRef<HTMLDivElement>(null);
  const hover = useMotionValue(0);
  const px = useMotionValue(0.5);
  const py = useMotionValue(0.5);
  const smooth = useSpring(hover, { stiffness: 220, damping: 28 });

  /** The rim, the outer bloom and the bezel sheen all fade together — one light, three surfaces. */
  const glowOpacity = useTransform(smooth, [0, 1], [0, 1]);
  /** The ring around the mark is dim at rest rather than absent; it is part of the object. */
  const ringOpacity = useTransform(smooth, [0, 1], [0.22, 1]);
  const washOpacity = glowOpacity;
  const wash = useTransform(
    [px, py],
    ([x, y]: number[]) =>
      `radial-gradient(190px 120px at ${x * 100}% ${y * 100}%, var(--film-3), transparent 70%)`
  );
  /** The body catching the same light as the banner, from the same direction. */
  const sheen = useTransform(
    [px, py],
    ([x, y]: number[]) =>
      `radial-gradient(320px 220px at ${x * 100}% ${y * 100}%, var(--film-2), transparent 72%)`
  );

  /* The flag, its timer and the timer's cleanup are `useCopyFlag`'s — including the cleanup this
     card needed most, since every card in a re-sorting grid can unmount while showing its tick. */
  const { copied, failed, copy: copyToClipboard } = useCopyFlag();

  const copy = useCallback(
    (e: React.MouseEvent) => {
      /* The chip sits inside the card's link; without these a copy also navigates. */
      e.preventDefault();
      e.stopPropagation();
      void copyToClipboard(contractAddress);
    },
    [contractAddress, copyToClipboard]
  );

  const capLabel = typeof marketCap === "number" ? formatCompact(marketCap) : marketCap;
  const capPrefix = typeof marketCap === "number" && currencyPosition === "prefix" ? currency : "";
  const capSuffix = typeof marketCap === "number" && currencyPosition === "suffix" ? currency : "";

  const ageLabel = age ?? (launchedAt !== undefined ? formatAge(launchedAt) : undefined);
  const pct = Math.max(0, Math.min(100, graduationPercentage));

  const hue = hueFor(ticker || name || "COIN");

  return (
    <motion.div
      ref={root}
      /* The hook the name marquee hangs off. A `data-` attribute rather than the `group/card`
         class, because the keyframe lives in `global.css` and a stylesheet rule that has to match
         Tailwind's escaped `.group\/card` is a rule nobody will recognise as ours. */
      data-coin-card=""
      className={cn(
        /*
         * One transition, one easing, 300ms, and a translate of exactly 4px.
         *
         * `motion-reduce` cancels the movement without cancelling the light — somebody who has
         * asked for less motion still gets to see which card the pointer is on. The lift is a CSS
         * transition rather than a spring on purpose: a spring overshoots and settles, so forty
         * cards under a moving pointer read as a row of things being flicked rather than as one
         * surface answering.
         */
        "group/card relative h-full transition-transform duration-300 ease-in-out hover:-translate-y-1 motion-reduce:transform-none",
        className
      )}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        px.set((e.clientX - r.left) / r.width);
        py.set((e.clientY - r.top) / r.height);
      }}
      onPointerEnter={() => hover.set(1)}
      onPointerLeave={() => {
        hover.set(0);
        px.set(0.5);
        py.set(0.5);
      }}
    >
      {/* The bloom *outside* the card, so light spills onto the page rather than stopping at the
          edge. Sits behind everything and never takes a pointer event. */}
      <motion.span
        aria-hidden
        className="pointer-events-none absolute -inset-6 -z-10 blur-2xl"
        style={{
          opacity: glowOpacity,
          mixBlendMode: "plus-lighter",
          background: `radial-gradient(40% 40% at 50% 34%, rgb(var(--${hue}-rgb) / 0.16) 0%, rgb(var(--${hue}-rgb) / 0.06) 46%, transparent 74%)`,
        }}
      />

      {/*
        The cast shadow, as its own layer.

        It cannot live on the tray: that span's `box-shadow` is doing three inset jobs already, and
        a `style` prop cannot be transitioned by a utility class. A separate element underneath
        everything, fading from nothing to a wide soft pool, is what makes the 4px lift read as the
        card leaving the page rather than as the card twitching. Deliberately large and very soft —
        a tight dark shadow on this canvas looks like a border, not like depth.
      */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[15px] opacity-0 shadow-doku-hover transition-opacity duration-300 ease-in-out group-hover/card:opacity-100"
      />

      {/* ---- The dock's three layers, at card size ----------------------------------------- */}

      {/* 1. The tray the whole thing is pressed into. */}
      <span aria-hidden className="absolute inset-0 rounded-[15px]" style={TRAY} />

      {/* 2. The rim, floating proud of the tray — dim at rest, the coin's own hue under the
             pointer. A hairline drawn *on* a surface reads as a border; the same hairline floating
             three pixels off it reads as a machined edge catching light, and it is the one cue
             every premium surface in this product shares.

             Two details make it read as metal rather than as a second outline:

             **Concentric radii.** 17px, not 18 — the card's own edge is 14 and the rim floats 3px
             outside it, so 14 + 3 is the only radius at which the two curves stay parallel. At 18
             they converged through the corner and the gap between them pinched, which is the exact
             tell that a "double border" is two borders rather than one object with a rim.

             **A lit top lip.** The hairline was one flat value all the way round, which is what a
             *drawn* rectangle looks like. A hair of light along the inside of its top edge is what a
             machined one looks like under a light source above it — the same asymmetry the bezel,
             the trays and every key in the dock already carry. */}
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-[3px] rounded-[17px] border border-solid border-[var(--film-2)]"
        style={{ boxShadow: "inset 0 1px 0 var(--film-4)" }}
      />
      <motion.span
        aria-hidden
        className="pointer-events-none absolute -inset-[3px] rounded-[17px] border border-solid"
        style={{ opacity: glowOpacity, borderColor: `rgb(var(--${hue}-rgb) / 0.55)` }}
      />

      {/* 3. The bezel. Everything below lives inside it. */}
      {/* `--coin-mark` is declared on the bezel rather than on the identity row because two of the
            bezel's children are sized from it: the mount that holds the mark, and the meter in the
            cover's foot, which has to start where the mark stops. */}
      <div
        className="relative flex h-full flex-col overflow-hidden rounded-[14px] [--coin-mark:84px] sm:[--coin-mark:104px]"
        style={BEZEL}
      >
        {/* The bezel's own sheen — the card body catching the same light as the banner. */}
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-0 z-[1]"
          style={{ opacity: glowOpacity, background: sheen }}
        />

        {/* ============================================================================
          1. Banner — the coin's image, or one made from its ticker.
         ============================================================================ */}
        {/*
          A fixed height, not a 3:1 aspect — and a different fixed height per breakpoint.

          The ratio tied the cover's height to the card's *width*, so the same component drew a 96px
          band on a desktop column and a 119px one on a phone: the cover got bigger exactly where
          vertical space is scarcest. On a 390px screen that is most of why only one and a half
          cards fitted on the display.

          92 on a phone and 124 above `sm`. Both are taller than the mark standing in them (84 and
          104), which is the constraint that matters — a mark taller than its cover reads as a tile
          with a stripe behind it rather than as a portrait over a backdrop.

          `.doku-card-cover` gives it a lip: a lit hairline along the bottom edge with a shade under
          it, so the body reads as a panel sitting *below* the cover rather than as the same surface
          continuing. That is the card's own seam grammar, and it is what the phone card gains in
          depth for the height it gives up.
        */}
        <div className="doku-card-cover pointer-events-none relative z-10 h-[92px] w-full shrink-0 overflow-hidden sm:h-[124px]">
          {banner ? (
            /*
              `lazy` + `async`, because this is a grid.

              The upload route stores one banner derivative at 1536×512 (`api/uploads/image`), and
              this cover is 92px tall on a phone and 124 above `sm` — so every card on the board
              pulls a full-width image to paint a strip. Eagerly, that is forty of them racing the
              scripts that hydrate the grid they sit in.

              `decoding="async"` matters as much as `loading` here: a synchronous decode of a
              1536px WebP blocks the main thread, and on the 4× CPU profile the board does forty.
            */
            <img
              src={banner}
              alt=""
              aria-hidden
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />
          ) : (
            <GeneratedBanner seed={ticker} />
          )}

          {/*
          The wash that follows the pointer.

          Painted over the banner and clipped to it, at an opacity that springs in on enter. It is
          the cheapest possible "this card is the one under your cursor" and it does the job a
          border-colour change does, without the border twitching.
        */}
          <motion.span
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{ opacity: washOpacity, backgroundImage: reduced ? undefined : wash }}
          />

          {/* The vignette. Without it a generated banner is a coloured rectangle; with it the colour
            has somewhere to fall off to and the band reads as lit rather than filled. */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(120% 130% at 50% 0%, transparent 45%, var(--shade-1) 100%)",
            }}
          />

          {/*
            The pair badge is not here any more — it is on the figures row, at the right-hand end of
            the market cap. See section 3.

            On the cover it was correct about one thing and wrong about the rest. Correct: the pair
            is what a coin *is*, not a statistic about it, and it deserved to be out of a stats
            table. Wrong: it cost the banner its left third, so the coin's own artwork — the reason
            anybody stops on a card — was competing with a badge in front of it, and the badge's six
            layers of relief sat on top of an image it had no relationship with. Two objects fighting
            for one corner.

            Beside the cap it has a column of its own, it balances a row that was one figure and a
            lot of air, and it reads as the denominator of the number next to it — which is exactly
            what it is. The banner is left to the artwork and the rank plate alone.
          */}

          {/* The rank plate. Zero-padded so 1 and 12 occupy the same width and the plates line up
            down the grid. Only where rank means something — the caller decides by passing it. */}
          {rank !== undefined && (
            <span
              aria-hidden
              className="absolute right-2 top-2 rounded-doku-sm px-1.5 py-1 font-numeric text-[11px] font-medium leading-none tracking-[0.06em] text-ash backdrop-blur-sm"
              style={{ background: "var(--mat-tab-bg)", boxShadow: "var(--mat-tab-shadow)" }}
            >
              {String(rank).padStart(2, "0")}
            </span>
          )}

          {/*
          The curve, as a segmented meter across the foot of the banner.

          A rounded bar sliding across a track is the single most generic component on the web, and
          it is the piece that made the first pass at this card read as a template. Cells in a
          recessed channel read as an instrument, they rhyme with the pixel face the name is set in,
          and the leading cell runs hotter than the rest so the eye lands on where the market has
          actually got to rather than on the whole filled length.

          A graduated market fills every cell in the halo hue instead. Done is a different state,
          not 100% of the same one.
        */}
          {/*
            `.doku-card-meter` is the channel the cells are pressed into — a dark groove with a lit
            line under it, which is the same seam the bands are divided by. Without it fourteen
            cells sat directly on whatever the banner's bottom pixels happened to be, so the meter
            read as a row of dashes drawn on the image; in a channel it reads as an instrument
            recessed into the card's foot, which is the one place on the card where depth is free.
          */}
          <div
            aria-hidden
            className="doku-card-meter absolute bottom-0 left-[calc(var(--coin-mark)+27px)] right-0 flex h-[9px] items-stretch gap-[2px] rounded-l-[5px] px-[3px] pb-[3px] pt-[2px] sm:left-[calc(var(--coin-mark)+29px)]"
          >
            {Array.from({ length: SEGMENTS }, (_, i) => {
              const filled = isGraduated ? SEGMENTS : Math.round((pct / 100) * SEGMENTS);
              const on = i < filled;
              const hot = on && !isGraduated && i === filled - 1;
              return (
                <span
                  key={i}
                  className="flex-1 rounded-[1px]"
                  style={{
                    background: on
                      ? hot
                        ? "var(--doku-ink)"
                        : isGraduated
                          ? "var(--halo)"
                          : "var(--doku)"
                      : "var(--film-2)",
                    boxShadow: hot ? "0 0 7px rgb(var(--doku-rgb) / 0.75)" : undefined,
                  }}
                />
              );
            })}
          </div>
        </div>

        {/* ============================================================================
          2. Identity — logo, name, ticker, age, pair.

          Not a `Band`: it sits directly under the banner, and the banner's own bottom edge is
          already the strongest division on the card. A rule there would be a second line drawn
          across an edge that exists.
         ============================================================================ */}
        {/*
          Profile over cover.

          The mark used to be a 44px tile sitting in its own row *below* the banner, which put the
          coin's own artwork at a quarter of the area of the generated backdrop behind it — on a
          product where the image is most of why somebody stops on a card. It read as a favicon
          beside a headline rather than as the subject.

          It is 72px now and pulled up into the banner's foot, which is the composition every social
          and profile product converged on for the same reason: the avatar crossing the cover's edge
          makes it unambiguously the foreground, and it costs no extra height because the overlap
          comes out of the banner rather than being added below it.

          `items-end` rather than `items-start`: with the mark hanging above the band's top edge, the
          name and ticker align to the *bottom* of it, so the type sits on the same baseline it would
          have without the overlap and the row does not look like it slid upwards.
        */}
        {/*
          `--coin-mark` is the mark's own size, declared here so three things can be derived from
          one number: the mount, the image inside it, and the overlap that pulls the row up into the
          cover. The overlap is always half the mark, so the identity row costs exactly half a mark
          of height below the banner however large the mark gets — which is why shrinking it by 20px
          on a phone takes 10px off the card and never breaks the composition.
        */}
        <div className="pointer-events-none relative z-10 -mt-[42px] flex items-end gap-2.5 px-3 pb-1.5 sm:-mt-[52px] sm:gap-3 sm:px-3.5 sm:pb-3">
          {/*
          The mark, mounted rather than placed.

          An image dropped onto a surface is a sticker; the same image in a machined collar is a
          specimen. That is most of what separates this card from a list row with a picture on it,
          and it is why the mark gets a mount at all rather than a border.

          The collar is `--mat-cover-foot` — the bezel's own colour where the cover ends — so the
          mark reads as punched through the artwork rather than pasted on top of it, and it follows
          the theme, which a literal would not. Its rim, its lip and the two shadows under it are in
          `MARK_MOUNT`, with the note on what they replaced.

          108px, half of it over the cover. The overlap is always half the mark's height, so the
          identity row costs 54px below the banner however large the mark gets — which is why the
          mark could grow by half again while the card as a whole got shorter. It is the artwork the
          launcher chose and the reason anyone stops on a card; at 72 it was smaller than the
          generated gradient behind it.
        */}
          <span
            className="relative grid shrink-0 place-items-center rounded-[23px] p-[4px] sm:rounded-[27px]"
            style={{
              width: "calc(var(--coin-mark) + 8px)",
              height: "calc(var(--coin-mark) + 8px)",
              background: "var(--mat-cover-foot)",
              boxShadow: MARK_MOUNT,
            }}
          >
            {/* The hue, on the collar's own rim. Dim at rest, full under the pointer — the same
                light on the same schedule as the card's outer rim and its bezel sheen, so the
                object lights as one thing rather than as a card with a glowing badge on it. */}
            <motion.span
              aria-hidden
              className="pointer-events-none absolute -inset-px rounded-[24px] border border-solid sm:rounded-[28px]"
              style={{ opacity: ringOpacity, borderColor: `rgb(var(--${hue}-rgb) / 0.45)` }}
            />
            <CoinMark
              logo={logo}
              ticker={ticker}
              name={name}
              size="var(--coin-mark)"
              className="relative z-10 rounded-[19px] sm:rounded-[23px]"
            />
            {/* The face's own catch-light, drawn *over* the mark rather than under it. As an inset
                shadow on the tile it would be painted beneath the logo filling it, so it would have
                lit the monograms and nothing else — and the coins with artwork are the ones the
                edge matters most on. */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-[4px] z-20 rounded-[19px] sm:rounded-[23px]"
              style={{ boxShadow: MARK_FACE }}
            />
          </span>

          {/* `pb-0.5` optically seats the two lines on the mark's lower edge — the ticker's
              descender-free mono face sits a shade high against the square otherwise. */}
          <div className="min-w-0 flex-1 pb-0.5">
            {/* The name scrolls under the pointer when it is longer than the card — launcher-typed
                names are frequently sentences, and the funny half is the half that truncates. See
                `MarqueeName`. */}
            <MarqueeName name={name} />
            <p className="mt-1 flex items-center gap-1.5 font-numeric text-[12.5px] leading-none text-ash sm:mt-1.5 sm:text-[13px]">
              <span className="truncate">
                <span className="text-mute">$</span>
                {ticker}
              </span>
              {ageLabel && (
                <>
                  <span aria-hidden className="text-mute">
                    ·
                  </span>
                  {/* A minute-granular clock reading: the server's copy can be a minute behind the
                      client's by the time it hydrates, and React is told to keep the client's. */}
                  <span className="shrink-0 text-mute" title="Age" suppressHydrationWarning>
                    {ageLabel}
                  </span>
                </>
              )}
            </p>
          </div>
        </div>

        {/* ============================================================================
          3. Figures — the market cap and its delta.

          The largest type on the card, because it is the thing the grid is sorted by and the
          thing an eye running down a column is looking for.

          ## Why this is no longer a shaded box

          It was a `tint` band: the whole row sat on a lighter ground, so the figures — the most
          important content on the card — were the one region that read as *inset*, a panel dropped
          into the card rather than part of it. Alternating grounds is a good rule for rows of
          similar things and the wrong one for the row that has to dominate.

          What separates the figures now is structure, not fill: the band takes no ground of its own
          and the type does the work — which is what the type was always big enough to do.
         ============================================================================ */}
        {/*
          The cap, its delta and what it is quoted in — one row, three facts, no extra height.

          This band briefly carried a second row of price, 24-hour turnover and the pair, on the
          argument that a cap with no price beside it cannot be acted on. True, and it was the wrong
          place to fix it: three more figures cost the card ~44px of height on a board whose whole
          problem on a phone was that one card filled the screen, and the price a scanner needs is
          on the market page one tap away.

          What is here instead is the figure the grid is sorted by, the percentage that qualifies it
          and the asset it is denominated in — the three things that have to be read together, laid
          out so they can be. Nothing was added to the card's height to do it: the delta gave up a
          line of its own and the badge took the space at the end of a row that was already two
          lines tall.
        */}
        <Band className="flex items-end justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <span className={FIGURE_LABEL}>Market cap</span>

            {/*
              The figure and its delta, on one line.

              The delta used to ride the *label* line above this one, on the argument that a 22px
              number, a unit and a pill could not share a 300px row without the number truncating —
              `812.4K MON` becoming `812.4K M…`. That was true of the row as it then was, and the
              row has changed: the card is denser, the delta is the only thing on this line besides
              the figure, and the two belong together. A percentage is a statement *about* the number
              it sits beside; parked a line above it, it read as a second statistic that happened to
              be there.

              `min-w-0` on the figure and `shrink-0` on the chip is what keeps the truncation
              argument answered — if the row ever does run out of width, it is the cap that
              ellipsises and the delta that survives whole, rather than the unit being cut off the
              end of a number.
            */}
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 truncate font-numeric text-[22px] font-medium leading-none tracking-[-0.015em] text-ink">
                {capPrefix}
                {capLabel}
                {capSuffix && <span className="ml-1 text-[0.58em] text-mute">{capSuffix}</span>}
              </span>

              {/*
                The delta as a chip, not as coloured text.

                A signed percentage set beside a larger figure in green or red is two values
                competing at the same weight, and on a grid of forty it is the one thing people
                said they could not find. A tinted pill is a different *object* — the eye picks it
                out by shape before it reads the sign, which is exactly the job.
              */}
              {typeof delta === "number" && (
                <span
                  /* `aria-label` rather than `title`: the chip is inside a band that does not take
                     pointer events (see `Band`), so a tooltip on it could never appear — while the
                     label still needs to reach a screen reader. */
                  aria-label={deltaLabel}
                  className={cn(
                    "shrink-0 translate-y-[-1px] rounded-doku-sm border px-1.5 py-[3px] font-numeric text-[11px] font-semibold leading-none",
                    delta < 0
                      ? "border-loss/30 bg-loss/10 text-loss-ink"
                      : "border-doku/30 bg-doku/10 text-doku-ink"
                  )}
                >
                  {formatSignedPercent(delta)}
                </span>
              )}
            </span>
          </div>

          {/*
            What the cap is denominated in, at the end of the row it qualifies.

            This is the card's one badge and it has moved twice: a column in a stats table, then a
            plate on the cover. Both were arguments about *importance* — is the pair a statistic or
            is it identity — and both missed where it is actually *read*. It is read against the
            number: `812.4K MON` and `812.4K` quoted in gold are different instruments, and the two
            facts are one glance apart only if they are on the same line.

            Here it costs the card no height at all — the row it sits at the end of is two lines tall
            already — which is the whole reason the badge could come back without the card growing.
            Six layers of relief, as before: a lit top lip, a hairline all round, a shaded bottom
            lip, a contact shadow and a wide ambient one, with the issuer's mark in a well recessed
            into the plate. See `.doku-pair-badge`.
          */}
          {pair && (
            <span
              title={`Paired with ${pair.name}`}
              className="doku-pair-badge flex max-w-[46%] shrink-0 items-center gap-1.5 rounded-doku-lg py-1 pl-1 pr-2"
            >
              <span className="doku-pair-badge-well grid h-[22px] w-[22px] shrink-0 place-items-center rounded-[7px]">
                <AssetIcon asset={pair} size={15} className="rounded-[4px]" />
              </span>
              <span aria-hidden className="doku-pair-badge-seam h-[14px] w-px shrink-0" />
              {/* No `uppercase`: `cbBTC` and the `x`-suffixed equities are cased deliberately in the
                  registry, and transforming them prints tickers that do not exist. */}
              <span className="min-w-0 truncate font-numeric text-[11px] font-semibold leading-none tracking-[0.05em] text-ink">
                {pair.symbol}
              </span>
            </span>
          )}
        </Band>

        {/* ============================================================================
          4. Provenance — the contract, the state, and who launched it.
         ============================================================================ */}
        <Band className="flex items-center gap-2">
          <button
            type="button"
            onClick={copy}
            title={contractAddress}
            aria-label={copied ? "Address copied" : `Copy contract address ${contractAddress}`}
            className={cn(
              "doku-tap flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-doku-lg border border-solid border-[var(--film-2)] px-2",
              "font-numeric text-[12px] font-medium leading-none transition-colors",
              copied
                ? "border-doku/40 text-doku-ink"
                : failed
                  ? "border-loss/40 text-loss-ink"
                  : "text-mute hover:border-[var(--film-4)] hover:bg-[var(--film-2)] hover:text-ink"
            )}
          >
            <span className="shrink-0 uppercase tracking-[0.08em] text-mute">CA</span>
            <span className="truncate">{truncateAddress(contractAddress, 4, 4)}</span>
            <span className="shrink-0">{copied ? <CheckGlyph /> : <CopyGlyph />}</span>
          </button>

          {/* The state, at the same height as the chip beside it. Two controls in a row at two
              different heights is the detail that makes a card look assembled rather than made. */}
          <span
            className={cn(
              "ml-auto flex h-7 shrink-0 items-center rounded-doku-lg border px-2.5 font-numeric text-[11.5px] font-semibold uppercase leading-none tracking-[0.06em]",
              isGraduated
                ? "border-halo/40 bg-halo/10 text-halo-ink"
                : "border-doku/35 bg-doku/10 text-doku-ink"
            )}
          >
            {isGraduated ? "Graduated" : `Bonding ${Math.round(pct)}%`}
          </span>

          <span className="sr-only" role="status" aria-live="polite">
            {copied ? "Address copied to clipboard" : failed ? "Copy failed" : ""}
          </span>
        </Band>

        {/* ============================================================================
          5. Actions — where to look this coin up, and who launched it.
         ============================================================================ */}
        {/* The footer keeps a ground of its own — and now that the figures band has given its up,
            it is the only band that has one, which is exactly what a footer should be: the card
            resting on a base rather than one stripe in a set. */}
        {(links?.website || links?.x || explorerHref || external) && (
          <Band tint className="mt-auto flex items-center gap-2.5">
            {/* The coin's own links, as icons — a site and an X account are identity, not
              destinations, so they get the quiet treatment. */}
            <div className="flex shrink-0 items-center gap-1.5">
              {links?.website && (
                <IconLink href={links.website} label={`${name} website`}>
                  <GlobeGlyph />
                </IconLink>
              )}
              {links?.x && (
                <IconLink href={links.x} label={`${name} on X`}>
                  <XGlyph />
                </IconLink>
              )}
              {explorerHref && (
                <IconLink href={explorerHref} label={`${name} on the block explorer`}>
                  <ExplorerGlyph />
                </IconLink>
              )}
            </div>

            {/* Who launched it. A card that names its creator is a card you can hold somebody to,
              which on a permissionless launchpad is most of what due diligence is. It sits here
              rather than on the row above because that row's two chips are both fixed-width, and
              squeezed between them this truncated to "by 0…" — which is worse than absent. */}
            {/*
              Who launched it — and now a way to go and look.

              It was inert text. On a permissionless launchpad the creator's address is the whole of
              what due diligence has to work with, and the next question after "who" is always "what
              else have they launched, and what did they do with it" — which is a page that exists,
              on the explorer, one click away. Printing the address and then making the reader
              select it by hand was the card stopping one step short of being useful.

              The affordance is a dotted rule under the address, not an icon beside it. An icon was
              the first attempt and it cost 14px in a row that is already three groups wide — on a
              card carrying a website, an X account, an explorer link and the venue keys, that is
              the difference between `by 0x00…7aca` and `by …`. An underline is the oldest signal
              there is for "this goes somewhere", it is drawn inside the type's own box, and it
              costs the row nothing. It warms to the brand hue under the pointer.

              `stopPropagation` because the whole card is a link underneath this one — without it,
              clicking the creator would navigate to the market *and* open the explorer.
            */}
            {creator &&
              (creatorHref ? (
                <a
                  href={creatorHref}
                  target="_blank"
                  rel="noreferrer noopener"
                  onClick={(e) => e.stopPropagation()}
                  title={`Launched by ${creator} — open on the block explorer`}
                  className="doku-card-creator hidden min-w-0 truncate font-numeric text-[12px] leading-none text-mute md:inline"
                >
                  by {truncateAddress(creator, 4, 4)}
                </a>
              ) : (
                <span
                  title={`Launched by ${creator}`}
                  className="hidden min-w-0 truncate font-numeric text-[12px] leading-none text-mute md:inline"
                >
                  by {truncateAddress(creator, 4, 4)}
                </span>
              ))}

            {/* The three places a trader checks before buying, as one segmented control. It is a
                different *shape* from the loose identity icons at the other end of the row, which
                is what tells the eye that the two groups answer different questions — "who is this"
                and "where do I go and look". See `VenueGroup`. */}
            {external && (
              <VenueGroup
                external={external}
                coin={name}
                graduated={isGraduated}
                className="ml-auto"
              />
            )}
          </Band>
        )}

        {/*
          The card's own edge, drawn last so nothing paints over it. See `EDGE`.

          This is the fix for "the borders are not that visible": the card had a rim floating three
          pixels outside it and a lit line along the top of the bezel, and between them no actual
          outline — so on a dark page a dark card had no edge except where its own banner happened
          to end. `--line-2` is the hairline meant to be seen; `--line` is the one meant to divide
          things *inside* an object, and it was being asked to do a job it is deliberately too faint
          for.
        */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 z-20 rounded-[14px] border border-solid"
          style={EDGE}
        />

        {/*
        The overlay link.

        The card is not an `<a>`: it contains a copy button and several links, and a button inside
        an anchor is invalid HTML — browsers disagree about which one owns a click, and the copy
        button intermittently navigates instead of copying. This covers the surface *beneath* them
        instead, so the whole card is clickable and every control still works.
      */}
        {href && (
          <a
            href={href}
            className="absolute inset-0 z-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku"
          >
            <span className="sr-only">{`Open ${name}`}</span>
          </a>
        )}
      </div>
    </motion.div>
  );
}

export default CoinCard;
