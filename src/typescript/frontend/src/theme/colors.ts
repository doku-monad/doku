/**
 * Palette — the styled-components projection of the app's tokens.
 *
 * Every value here is a CSS variable rather than a literal, and that is the whole point: the app
 * ships two themes (the dark stage, and Lite Mode's paper canvas — see `global.css`), and a hex
 * compiled into a styled-component cannot change when the theme does. This file was the third
 * copy of the palette, and it is the copy that kept the page ground dark while every token around
 * it had already flipped.
 *
 * So: `global.css` owns the values, and these own only the names. The role names are historical
 * and are kept so no component has to be rewritten — `black` is the page ground, `white` is
 * primary text, `darkGray` is a card surface. The literal names lie; the roles don't.
 *
 * `tailwind.config.js` is the same projection for utility classes, and it is pointed at the same
 * variables for the same reason.
 */
export const baseColors = {
  transparent: "transparent",
} as const;

/**
 * The design tokens under their own names.
 *
 * The composed `var(--x)` form rather than the channel triplets Tailwind uses: styled-components
 * writes these straight into a declaration, and nothing here needs Tailwind's opacity modifier.
 * Anywhere that does want an alpha uses the `--film-*` / `--veil-*` ladders instead of composing
 * one out of a token.
 */
export const dokuColors = {
  // surfaces — one stage with three lifted steps
  canvas: "var(--canvas)",
  surface: "var(--surface)",
  raise: "var(--raise)",
  sink: "var(--sink)",
  hover: "var(--doku-hover)",

  // ink
  ink: "var(--ink)",
  ash: "var(--ash)",
  mute: "var(--mute)",
  faint: "var(--faint)",

  // brand + signal (fills)
  doku: "var(--doku)",
  phos: "var(--phos)",
  loss: "var(--loss)",
  warn: "var(--warn)",
  halo: "var(--halo)",

  /**
   * Text-safe counterparts.
   *
   * Which direction "text-safe" runs in depends on the ground, and the ground moves: on the dark
   * stage `dokuInk` is the *lighter* green, on paper it is a darker one. Both definitions live in
   * `global.css` under the same variable name, which is precisely why this file must not hold a
   * value of its own for either.
   */
  dokuInk: "var(--doku-ink)",
  lossInk: "var(--loss-ink)",
  warnInk: "var(--warn-ink)",
  haloInk: "var(--halo-ink)",
  muteInk: "var(--mute-ink)",

  // the remaining category hues, available for accenting
  lilac: "var(--lilac)",
  blush: "var(--blush)",

  // lines, and one step lighter for hover
  line: "var(--line)",
  line2: "var(--line-2)",
} as const;

const roleColors = {
  ...baseColors,
  /** Role: primary text. */
  white: dokuColors.ink,
  /** Role: muted/helper text. */
  lightGray: dokuColors.muteInk,
  /** Role: card surface / hairline. */
  darkGray: dokuColors.surface,
  /** Role: page ground. */
  black: dokuColors.canvas,
  blue: dokuColors.haloInk,
  /** Role: positive / buy. */
  green: dokuColors.dokuInk,
  /** Role: negative / sell. */
  pink: dokuColors.lossInk,
  /** Role: brand accent. */
  dokuAccent: dokuColors.doku,
  warning: dokuColors.warnInk,
  error: dokuColors.lossInk,
} as const;

export const darkColors = roleColors;

export const GREEN = roleColors.green;
export const PINK = roleColors.pink;
export const INK = dokuColors.ink;
export const DOKU = dokuColors.doku;
export const CANVAS = dokuColors.canvas;
export const LINE = dokuColors.line;
