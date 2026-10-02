/** @jest-environment node */
import { readFileSync } from "fs";
import { join } from "path";

/**
 * The wallet surfaces have to be readable on paper as well as on the dark stage.
 *
 * Every colour in this app is a semantic token restated per theme, so a surface built from tokens
 * follows the theme for free. A surface built from a literal does not — and it does not throw, log
 * or fail a build either. It renders, in the theme its author happened to be looking at, and is
 * illegible in the other one. That is a defect only a human looking at the light theme can see,
 * which is why this measures it instead.
 *
 * The measurement is WCAG relative luminance, taken against the actual composited ground rather
 * than against the panel colour on its own: these panels are translucent, so the colour a reader
 * sees is the panel over the page beneath it.
 */

const css = readFileSync(join(__dirname, "../../src/app/global.css"), "utf8");

/** The declaration block opened by `selector`, brace-matched so a nested rule cannot end it early. */
const block = (selector: string): string => {
  const open = css.indexOf("{", css.indexOf(selector));
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unterminated block for ${selector}`);
};

/* The dark palette lives on bare `:root`; the light one overrides only the triplets. The second
   `[data-theme="lite"]` block in the file is the shadcn HSL bridge and defines none of these. */
const THEMES = {
  dark: block(":root"),
  lite: block('[data-theme="lite"]'),
} as const;

type Rgb = [number, number, number];

/** A `--x-rgb` triplet, e.g. `--ash-rgb: 201 199 176`. */
const token = (theme: keyof typeof THEMES, name: string): Rgb => {
  const m = new RegExp(`${name}:\\s*([\\d]+)\\s+([\\d]+)\\s+([\\d]+)\\s*;`).exec(THEMES[theme]);
  if (!m) throw new Error(`${name} not defined for ${theme}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};

/**
 * One `rgb(...)` term, with `var(--x-rgb)` resolved against the theme.
 *
 * Both spellings appear: a literal triplet (`rgb(28 29 32 / 0.97)`) and a token reference
 * (`rgb(var(--surface-rgb) / 0.97)`). Only the second one follows the theme, and telling them
 * apart is the entire point of this file.
 */
const term = (theme: keyof typeof THEMES, text: string): { rgb: Rgb; alpha: number } => {
  const alpha = Number(/\/\s*([\d.]+)\s*\)/.exec(text)?.[1] ?? 1);
  const varRef = /var\((--[\w-]+)\)/.exec(text);
  if (varRef) return { rgb: token(theme, varRef[1]), alpha };
  const lit = /rgb\(\s*(\d+)\s+(\d+)\s+(\d+)/.exec(text);
  if (!lit) throw new Error(`cannot read colour from ${text}`);
  return { rgb: [Number(lit[1]), Number(lit[2]), Number(lit[3])], alpha };
};

/** Source-over compositing, because a translucent panel is read through to the page behind it. */
const over = (fg: { rgb: Rgb; alpha: number }, bg: Rgb): Rgb =>
  fg.rgb.map((c, i) => c * fg.alpha + bg[i] * (1 - fg.alpha)) as Rgb;

const luminance = ([r, g, b]: Rgb): number => {
  const lin = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
};

const contrast = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** Every `rgb(...)` stop of the popover panel's `background`, in source order. */
const popoverStops = (theme: keyof typeof THEMES) => {
  const decl = /background:\s*([^;]+);/.exec(block(".doku-popover"))![1];
  return (decl.match(/rgb\([^)]*\)/g) ?? []).map((s) => term(theme, s));
};

describe("the connected-wallet menu, in both themes", () => {
  /**
   * The panel this menu is drawn on was a literal near-black gradient with no light-theme
   * override, while every row inside it uses `text-ash` / `text-mute` / `text-loss-ink` — tokens
   * that flip to near-black on paper. Dark text on a permanently dark panel: the menu was there,
   * responded to the pointer, and could not be read.
   */
  describe.each(["dark", "lite"] as const)("%s", (theme) => {
    const canvas = token(theme, "--canvas-rgb");

    it.each(["--ash-rgb", "--mute-rgb", "--loss-ink-rgb"])(
      "puts %s above the AA body-text threshold on the popover",
      (name) => {
        const ink = token(theme, name);
        for (const stop of popoverStops(theme)) {
          expect(contrast(ink, over(stop, canvas))).toBeGreaterThanOrEqual(4.5);
        }
      }
    );
  });
});

describe("the modal scrim, in both themes", () => {
  /**
   * Comments stripped before matching.
   *
   * The fix for this bug is documented in a comment that names the class it removed, and so does
   * the note left at each of the two other sites where the same mistake was made. A check that
   * cannot tell a class from a description of one forbids explaining the bug it guards against.
   */
  const baseModal = readFileSync(
    join(__dirname, "../../src/components/modal/BaseModal.tsx"),
    "utf8"
  ).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");

  /**
   * `bg-black` does not mean black here.
   *
   * `tailwind.config.js` remaps the legacy name `black` onto the *canvas* role — the page ground,
   * which is near-white on the light theme. So `bg-black bg-opacity-60` painted a 60% off-white
   * haze over a white page: no dimming, no separation between the dialog and the page behind it,
   * and no error anywhere. A scrim's one job is to be darker than what it covers.
   */
  it("does not reach for the legacy `black`, which resolves to the page ground", () => {
    expect(baseModal).not.toMatch(/\bbg-black\b/);
  });

  it("dims the page rather than washing it out, in both themes", () => {
    const scrim = /className="fixed inset-0 ([^"]*)"/.exec(baseModal)![1];
    const varName = /bg-\[var\((--[\w-]+)\)\]/.exec(scrim)?.[1];
    expect(varName).toBeDefined();

    for (const theme of ["dark", "lite"] as const) {
      const decl = new RegExp(`${varName}:\\s*([^;]+);`).exec(THEMES[theme])![1];
      const canvas = token(theme, "--canvas-rgb");
      const veiled = over(term(theme, decl), canvas);
      expect(luminance(veiled)).toBeLessThan(luminance(canvas));
    }
  });
});
