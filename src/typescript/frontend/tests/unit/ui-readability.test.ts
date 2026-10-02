import fs from "fs";
import path from "path";

/**
 * Readability, enforced.
 *
 * The app shipped 88 labels between 8px and 10px and 48 of them set in a *pixel display face* —
 * which is how a product ends up with a board nobody can read and a designer's word against a
 * screenshot. These are the floors that fix stayed fixed by.
 *
 * Every rule here is deliberately mechanical and deliberately cheap to satisfy. None of them is a
 * judgement about whether a screen looks good; they are the three things that were measurably
 * wrong, expressed so they cannot come back silently.
 */

const SRC = path.join(__dirname, "..", "..", "src");
const GLOBAL_CSS = path.join(SRC, "app", "global.css");

/** Every `.ts`/`.tsx` under `src`. */
const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });

const files = sourceFiles(SRC);
const rel = (file: string) => path.relative(SRC, file);

const SIZE = /text-\[(\d+(?:\.\d+)?)px\]/g;

/**
 * The smallest type allowed anywhere.
 *
 * 11px is not a target, it is the floor — below it the mono face loses its counters at typical
 * screen densities and the label stops being a word and starts being a texture.
 */
const MIN_FONT_PX = 11;

/**
 * The smallest the display face may be set.
 *
 * This was 14px, on the rule that Geist Pixel Square is a *display* face — headings, names, the
 * wordmark — and that labels belong to the mono face. The product has since made the opposite
 * call deliberately and everywhere: the token masthead, the board card, the swap widget, the
 * footer and the portfolio all set their labels in the pixel face, because tracked upper-case
 * mono is the house style of every crypto dashboard of the last three years and reads as a
 * default rather than as a decision. A 14px floor would undo that on every surface at once.
 *
 * So the floor is the *readability* floor rather than a role rule: 11px, the same as the global
 * one. Below it the pixel grid stops resolving a glyph — 10px and 9.5px labels were the actual
 * complaint — and at 11px the face still reads as itself. Which face carries a label is a design
 * decision this test does not get a vote on; whether it can be read is what it is here to hold.
 */
const MIN_PIXEL_FACE_PX = 11;

describe("type scale", () => {
  it("sets nothing below the font-size floor", () => {
    const offenders: string[] = [];
    for (const file of files) {
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          for (const m of line.matchAll(SIZE)) {
            if (Number(m[1]) < MIN_FONT_PX) offenders.push(`${rel(file)}:${i + 1} → ${m[0]}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it("never sets the pixel display face below its own floor", () => {
    const offenders: string[] = [];
    for (const file of files) {
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (!line.includes("font-pixel")) return;
          for (const m of line.matchAll(SIZE)) {
            if (Number(m[1]) < MIN_PIXEL_FACE_PX) {
              offenders.push(`${rel(file)}:${i + 1} → font-pixel at ${m[0]}`);
            }
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------------------------
 * Contrast
 *
 * The palette is declared as channel triplets in `global.css`, once per theme, which means the
 * contrast of every text role against every ground it is used on is a computable property of that
 * file. This reads the real tokens rather than a copy — a test with its own hard-coded hexes would
 * pass forever after somebody edited the stylesheet.
 * ------------------------------------------------------------------------------------------- */

type Rgb = [number, number, number];

const css = fs.readFileSync(GLOBAL_CSS, "utf8");

/** The triplets declared inside a given selector's first block. */
const tokensIn = (selector: string): Record<string, Rgb> => {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`${selector} not found in global.css`);
  const open = css.indexOf("{", start);
  // The palette block is the first `{...}` after the selector; nested rules inside `:root` (the
  // toast overrides) come before the triplets, so scan to the matching close rather than the next.
  let depth = 0;
  let end = open;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = css.slice(open, end);
  const out: Record<string, Rgb> = {};
  for (const m of body.matchAll(/--([a-z0-9-]+)-rgb:\s*(\d+)\s+(\d+)\s+(\d+);/g)) {
    out[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  }
  return out;
};

/** WCAG relative luminance. */
const luminance = ([r, g, b]: Rgb) => {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * Text roles and the ground each is read on, with the ratio it has to clear.
 *
 * 4.5 is AA for body text. `mute` is held to it too, deliberately: it carries ages, addresses,
 * creators and every stat label on the board — it is *secondary*, which is not the same as
 * decorative, and treating the two as interchangeable is what made the cards unreadable.
 *
 * `faint` is not listed. It is the one role that is genuinely decorative — a separator glyph, an
 * icon at rest — and nothing informational is allowed to use it.
 */
const TEXT_ROLES: { ink: string; on: string; min: number; note: string }[] = [
  { ink: "ink", on: "canvas", min: 4.5, note: "primary text on the page" },
  { ink: "ink", on: "surface", min: 4.5, note: "primary text on a card" },
  { ink: "ash", on: "canvas", min: 4.5, note: "secondary text on the page" },
  { ink: "ash", on: "surface", min: 4.5, note: "secondary text on a card" },
  { ink: "mute", on: "canvas", min: 4.5, note: "labels on the page" },
  { ink: "mute", on: "surface", min: 4.5, note: "labels on a card" },
  { ink: "doku-ink", on: "canvas", min: 4.5, note: "positive figures" },
  { ink: "doku-ink", on: "surface", min: 4.5, note: "positive figures on a card" },
  { ink: "loss-ink", on: "canvas", min: 4.5, note: "negative figures" },
  { ink: "loss-ink", on: "surface", min: 4.5, note: "negative figures on a card" },
  { ink: "warn-ink", on: "surface", min: 4.5, note: "warnings" },
  { ink: "halo-ink", on: "surface", min: 4.5, note: "informational badges" },
];

describe.each([
  ["dark", ":root {"],
  ["lite", '[data-theme="lite"] {'],
])("%s theme contrast", (_theme, selector) => {
  const base = tokensIn(":root {");
  // Lite restates only what it changes; everything else inherits from `:root`.
  const tokens = { ...base, ...tokensIn(selector) };

  it.each(TEXT_ROLES)("$ink on $on clears $min:1 — $note", ({ ink, on, min }) => {
    const fg = tokens[ink];
    const bg = tokens[on];
    expect(fg).toBeDefined();
    expect(bg).toBeDefined();
    expect(Number(contrast(fg, bg).toFixed(2))).toBeGreaterThanOrEqual(min);
  });
});
