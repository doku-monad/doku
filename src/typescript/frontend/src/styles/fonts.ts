// cspell:word noto geist plex
import localFont from "next/font/local";

/**
 * Typography: three faces, three jobs.
 *
 *   Sans    Display, headings, buttons, field labels AND body copy. IBM Plex Sans.
 *   Mono    Every figure. Prices, balances, supply, addresses. JetBrains Mono.
 *   Pixel   ACCENTS ONLY — eyebrows, tickers, badges, the wordmark. Geist Pixel Square.
 *
 * ## Why the pixel face was demoted
 *
 * It used to carry display as well as accents: `--font-display` and `--font-pixel` both pointed at
 * it, so every `h1`/`h2`/`h3`, every field label and the Buy/Sell keys were set in a pixel face.
 * A pixel face is a *novelty* face — built on a fixed grid, one weight, and legible as "retro
 * game" long before it is legible as words. Carrying a whole product on it reads as basic no
 * matter how well the surfaces underneath it are built.
 *
 * Used sparingly it does the opposite: an eyebrow or a ticker set in pixel beside Plex prose reads
 * as a deliberate signature. So the face stays, and the *roles* changed — `--font-display` is Plex
 * now, and `--font-pixel` is what a call site asks for when it wants the accent on purpose.
 *
 * Two consequences worth knowing. Geist Pixel Square ships exactly ONE weight (500), so any
 * `font-semibold`/`font-bold` on it was always either snapped or synthesised; display roles can
 * now use Plex's real 600. And the display rule's tracking flips from +0.01em to -0.02em: the
 * positive value existed only because pulling a pixel grid together collides adjacent glyphs.
 *
 * ## Why Plex and JetBrains rather than Geist
 *
 * The pixel face was never the problem. Geist Sans and Geist Mono were: they are the default pair
 * of a popular starter, which is exactly why a page set in them reads as generated rather than
 * designed — the reader has seen that texture on a hundred other sites and correctly identifies it
 * as a default nobody chose.
 *
 * These two are not an arbitrary swap for another neutral. They are the stack `brand.md` already
 * names as DOKU's own — "IBM Plex Sans 400/500/600 with `cv05` + `ss01`; JetBrains Mono for every
 * figure, tabular with a slashed zero" — so this restores the documented system rather than
 * inventing a fourth one. Plex carries humanist detail (the single-storey `a` alternate, the
 * flat-sided `g`) that survives next to a pixel face, where a geometric grotesque flattens into
 * it. JetBrains Mono's tall x-height keeps a price legible at 12px in a dense table row.
 *
 * `GeistPixelSquare` of the five pixel variants: Grid and Line are outline faces that disappear
 * under 16px, Circle and Triangle are novelty shapes. Square has a solid enough body to work at
 * label sizes.
 *
 * The legacy `--font-pixelar` name is repointed here rather than retired, and that is the whole
 * trick: this app was originally built around a pixel face, so `.pixel-heading-*`,
 * `.med-pixel-text` and `font-pixelar` are already scattered through it in exactly the places a
 * pixel face belongs. Pointing that one variable at Geist Pixel keeps the original intent
 * everywhere at once.
 */

/** Eyebrows, tickers, badges, the wordmark — the accent face. */
/**
 * Declared here rather than imported from `geist/font/pixel`, and the reason is five files.
 *
 * That module declares ALL FIVE pixel variants — Square, Grid, Line, Circle, Triangle — in one
 * file, so importing any one of them evaluates every `localFont()` call in it. Next then emits a
 * `<link rel="preload">` for each: **five faces, ~133 kB, at the browser's highest priority, on
 * every cold visit**, of which this app renders one. Measured in a browser: all five requested
 * within 38 ms of navigation, ahead of the CSS.
 *
 * This is a verbatim copy of that package's `GeistPixelSquare` declaration — same file, same
 * weight, same variable name, same fallback chain, same `adjustFontFallback: false` — pointed at
 * the woff2 committed under `public/fonts` beside the other two faces. Nothing about the rendered
 * type changes; four preloads stop.
 *
 * Self-hosting it is also what the note below already argues for the text faces: the file is
 * served from this origin like every other static asset, and the build depends on nobody.
 */
export const geistPixel = localFont({
  src: [{ path: "../../public/fonts/geist-pixel-square.woff2", weight: "500", style: "normal" }],
  variable: "--font-geist-pixel-square",
  weight: "500",
  fallback: [
    "Geist Mono",
    "ui-monospace",
    "SFMono-Regular",
    "Roboto Mono",
    "Menlo",
    "Monaco",
    "Liberation Mono",
    "DejaVu Sans Mono",
    "Courier New",
    "monospace",
  ],
  /* The app reconciles this family itself — see `PIXEL_FALLBACK_FAMILY` above and the
     `@font-face` in `global.css` — so Next must not splice in its own adjusted stand-in. */
  adjustFontFallback: false,
});

/**
 * The name of the metric-matched stand-in the pixel face falls back to while it loads.
 *
 * ## Why the pixel face needs one and the other two do not
 *
 * `geist` declares `GeistPixelSquare` with `adjustFontFallback: false`, so nothing reconciles its
 * metrics with whatever renders in its place for the first second and a half. Measured, the
 * substitutes are 3–7% wider than the real face — which sounds like nothing and is not: the hero's
 * claim sits at 48px in a 619px column, near enough to a wrap that the extra few per cent pushes
 * `PAIRED WITH ANYTHING.` onto a third line. When the real face arrives the line comes back and
 * everything below it jumps up by 49 pixels.
 *
 * That single shift measured **0.0967** of a total CLS of 0.1008 on `/explore` — 96% of the route's
 * layout instability, from one word wrapping. It was invisible before only because the headline
 * itself was invisible: `framer-motion` held the whole fold at zero opacity until hydration, and a
 * shift you cannot see is not counted. Making the fold render on time is what exposed it.
 *
 * ## The numbers
 *
 * Menlo and Courier New cover every platform between them — Courier New is a core Windows font and
 * Liberation Mono is metric-compatible with it on Linux — and they sit within a third of a per cent
 * of each other, so a single `size-adjust` serves all three. The value itself was bisected against
 * the real face's own line count at eight viewport widths rather than derived from the advance
 * widths alone; `global.css` carries the reasoning, which is that matching the width is not the
 * same as matching the wrap when a line ends three pixels from its column.
 *
 * The ascent and descent overrides are the real face's own (101 and 29 per 100px), divided by the
 * size adjustment because those percentages resolve against the *adjusted* em. They matter less
 * than the width — the type this face sets carries explicit `line-height` almost everywhere — but
 * they cost nothing and they close the vertical half of the same hole.
 *
 * Declared in `global.css` next to the other `@font-face` rules; named here so the family list and
 * the declaration cannot drift apart.
 */
export const PIXEL_FALLBACK_FAMILY = "DokuPixelFallback";

/**
 * The pixel family list, with the stand-in spliced in directly behind the real face.
 *
 * Behind it and not in front of it: this is what renders *instead of* Geist Pixel, so it has to
 * come after it and before the generic monospace chain `geist` supplies, which stays as the last
 * resort for a platform that has none of the named faces.
 */
const pixelFamily = (() => {
  const [face, ...rest] = geistPixel.style.fontFamily.split(",");
  return [face, ` "${PIXEL_FALLBACK_FAMILY}"`, ...rest].join(",");
})();

/**
 * The two text faces are SELF-HOSTED, under `public/fonts`, and not fetched from Google at build.
 *
 * `next/font/google` downloads each face while `next build` runs. That is a network dependency on
 * fonts.googleapis.com inside every Railway build, and on 2026-09-17 a short outage of exactly
 * that host turned a dev render into a 500 and would have failed a production build the same way
 * — so a hotfix could not have shipped during it. The files here are the latin subsets Google
 * serves for the same requests (one variable file per family, 40 KB and 31 KB), committed once
 * and served from this origin like every other static asset. Nothing about the rendered type
 * changes; only who the build depends on.
 *
 * No italic faces: the app uses italic in two places, and shipping extra files for them is the
 * wrong trade. The browser synthesises an oblique from the upright where `italic` is asked for.
 */
/** Body copy. */
export const plexSans = localFont({
  src: [{ path: "../../public/fonts/plex-sans-latin.woff2", weight: "400 700", style: "normal" }],
  display: "swap",
  variable: "--font-plex-sans",
  fallback: ["system-ui", "Segoe UI", "Helvetica Neue", "Arial", "sans-serif"],
});

/** Every figure. */
export const jetBrainsMono = localFont({
  src: [
    { path: "../../public/fonts/jetbrains-mono-latin.woff2", weight: "400 700", style: "normal" },
  ],
  display: "swap",
  variable: "--font-jetbrains-mono",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
});

/**
 * The role variables.
 *
 * Written as a `<style>` tag rather than through the `variable` class names alone because the app
 * refers to these roles by half a dozen historical names — `--font-forma`, `--font-formaM`,
 * `--font-pixelar` — and every one of them has to resolve to a real face. Cult UI registry
 * components additionally hard-code `--font-geist-sans` and `--font-geist-mono`, so those are
 * pointed at the same two faces: a registry card sets its own body copy, and it should be the
 * app's body copy.
 */
export const fontsStyle = `
  :root {
    --font-pixel: ${pixelFamily};
    --font-pixelar: ${pixelFamily};
    /* Display is PLEX, not pixel — see the note above. --font-formaM is the legacy name behind the
       font-forma-bold alias, which every call site uses meaning "a bold sans"; pointed at the pixel
       face it rendered wallet/[address]/error.tsx as 64px of pixel type. */
    --font-display: ${plexSans.style.fontFamily};
    --font-formaM: ${plexSans.style.fontFamily};
    --font-forma: ${plexSans.style.fontFamily};
    --font-ui: ${plexSans.style.fontFamily};
    --font-sans: ${plexSans.style.fontFamily};
    --font-numeric: ${jetBrainsMono.style.fontFamily};
    --font-mono: ${jetBrainsMono.style.fontFamily};
    --font-geist-sans: ${plexSans.style.fontFamily};
    --font-geist-mono: ${jetBrainsMono.style.fontFamily};
  }
`;

/**
 * The emoji face — loaded, but never preloaded.
 *
 * `preload: true` put this in the document's `<link rel="preload">` set at high priority, competing
 * with the three faces that actually set the page. What it backs is a single hidden `👽` in
 * `app/layout.tsx` plus whatever emoji a launcher happens to put in a coin name — none of it in the
 * first viewport, and all of it perfectly served by `display: "swap"` a beat later.
 *
 * Seven simultaneous high-priority font preloads is the same as none: measured at 201 kB on every
 * route, on a link where that is a second of bandwidth. This gives one of those slots back.
 */
/**
 * It is also the one face still fetched from Google — at RUNTIME, by a stylesheet link in the
 * layout, never at build. The file is several megabytes and Google slices it per platform, which
 * is not worth committing; and a Google outage then costs a platform's own emoji face for a
 * moment rather than a deploy. `className` is a plain global class (`global.css`) that sets the
 * family, so every caller of `notoColorEmoji.className` reads as before.
 */
export const NOTO_COLOR_EMOJI_STYLESHEET =
  "https://fonts.googleapis.com/css2?family=Noto+Color+Emoji&display=swap";
export const notoColorEmoji = { className: "font-noto-color-emoji" } as const;
