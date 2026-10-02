"use client";

import { useEffect, useState } from "react";

/**
 * The dominant colour of an emoji, sampled from the glyph the browser actually draws.
 *
 * ## Why it is measured rather than mapped
 *
 * The obvious implementation is a lookup table — 🐸 is green, 🔥 is orange — and it is wrong for
 * this product specifically. A market's symbol can be *any* emoji, including sequences this app
 * has never seen, so a table is a list of the ones somebody remembered, and every miss falls back
 * to a house colour that makes the page look broken rather than themed.
 *
 * Drawing the glyph to an offscreen canvas and reading its pixels asks the same question of the
 * same renderer that is about to paint it on screen, so the ambient light always belongs to the
 * emoji actually on the page. It also costs nothing at runtime: one 48px draw, once per symbol.
 *
 * ## Why the average is weighted
 *
 * A flat mean over every opaque pixel returns mud. Emoji carry heavy black outlines and large
 * white highlights, and both pull any straight average toward grey — 🐸 sampled that way comes out
 * a dull olive rather than green.
 *
 * So each pixel is weighted by its own saturation and penalised for being very dark or very light.
 * What survives is the colour a person would name if you asked them what colour the emoji is,
 * which is the entire point. The result is then floored to a minimum saturation and lightness,
 * because a glow has to actually glow: a correctly-sampled dark brown is still useless as light.
 */

/** An `r,g,b` triplet, ready to interpolate into a `rgba(...)` string. */
export type Rgb = readonly [number, number, number];

/** The brand green, used until a sample arrives and for anything that cannot be measured. */
const FALLBACK: Rgb = [10, 228, 72];

/** How large the glyph is rendered for sampling. Big enough to be representative, small to decode. */
const SAMPLE_PX = 48;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** sRGB → HSL, on 0–1 channels. Only the parts that are needed. */
function toHsl([r, g, b]: Rgb): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === rn
      ? ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
      : max === gn
        ? ((bn - rn) / d + 2) / 6
        : ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

/** HSL → sRGB, on 0–1 channels, returning 0–255. */
function toRgb(h: number, s: number, l: number): Rgb {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return [
    Math.round(channel(h + 1 / 3) * 255),
    Math.round(channel(h) * 255),
    Math.round(channel(h - 1 / 3) * 255),
  ];
}

/**
 * Draws the emoji once and returns the colour it is "made of", or null if that cannot be decided.
 *
 * Null rather than a guess: a glyph that rendered as an empty box, or a canvas the browser refused
 * to read back, should fall through to the brand colour rather than report a confident grey.
 */
function sampleEmoji(emoji: string): Rgb | null {
  if (typeof document === "undefined") return null;

  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_PX;
  canvas.height = SAMPLE_PX;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  ctx.clearRect(0, 0, SAMPLE_PX, SAMPLE_PX);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  /*
   * The emoji family is named first so the sample comes from the same face the page shows. Only
   * the first symbol of a multi-emoji sequence is drawn: the glow is one colour, and averaging
   * 💎🙌🏆 across three unrelated hues produces the grey that weighting exists to avoid.
   */
  ctx.font = `${SAMPLE_PX - 8}px "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
  ctx.fillText([...emoji][0] ?? emoji, SAMPLE_PX / 2, SAMPLE_PX / 2 + 1);

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, SAMPLE_PX, SAMPLE_PX).data;
  } catch {
    // A tainted or disallowed canvas. Not an error worth surfacing — just no sample.
    return null;
  }

  let wr = 0;
  let wg = 0;
  let wb = 0;
  let total = 0;

  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    if (alpha < 0.6) continue;

    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const [, s, l] = toHsl([r, g, b]);

    /*
     * Saturation is the signal; the rest is punctuation. Outlines (l≈0) and highlights (l≈1) are
     * damped hard, so a glyph that is mostly black line-art still reports the colour of the small
     * saturated area a person would call its colour.
     */
    const weight = s * s * (1 - Math.abs(l - 0.5) * 1.6);
    if (weight <= 0) continue;

    wr += r * weight;
    wg += g * weight;
    wb += b * weight;
    total += weight;
  }

  // Nothing saturated at all — a ⬛ or a glyph that did not render. The brand colour is a better
  // answer than the grey this would otherwise produce.
  if (total < 1) return null;

  const mean: Rgb = [
    Math.round(clamp01(wr / total / 255) * 255),
    Math.round(clamp01(wg / total / 255) * 255),
    Math.round(clamp01(wb / total / 255) * 255),
  ];

  // Floors, because this value's only job is to be light. A perfectly accurate dark brown lights
  // nothing, and an unsaturated one reads as a smudge rather than as a colour.
  const [h, s, l] = toHsl(mean);
  return toRgb(h, Math.max(s, 0.55), Math.min(Math.max(l, 0.52), 0.68));
}

/**
 * The same colour, made readable on the stage it is about to be drawn on.
 *
 * `sampleEmoji` floors lightness at 0.52 and caps it at 0.68, which is correct for the dark stage
 * and exactly wrong for paper: a colour that is bright enough to light a near-black panel is a
 * pastel on white, and the chart drew its line, its area and its tooltip dot in it. A 1.75px stroke
 * at L=0.6 over `#EDF0EE` is roughly 1.6:1 — a trace you have to look for.
 *
 * The hue is the market's own and is never touched. Only lightness moves, down to at most 0.38, and
 * saturation comes up to meet it so the darker value does not read as grey. On the dark stage the
 * triplet is returned exactly as sampled.
 */
export function accentForStage(css: string, lite: boolean): string {
  if (!lite) return css;
  const parts = css.split(",").map((n) => Number(n.trim()));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return css;
  const [h, s, l] = toHsl(parts as unknown as Rgb);
  const [r, g, b] = toRgb(h, Math.min(1, Math.max(s, 0.62)), Math.min(l, 0.38));
  return `${r},${g},${b}`;
}

/**
 * The ambient colour for a market, as an `r,g,b` triplet string ready for `rgba()`.
 *
 * Runs in an effect rather than during render: it touches `document`, so doing it inline would
 * break the server render, and the fallback means the first paint is never uncoloured.
 */
export function useEmojiColor(emoji: string): { rgb: Rgb; css: string } {
  const [rgb, setRgb] = useState<Rgb>(FALLBACK);

  useEffect(() => {
    // Deferred a frame so a page full of markets never samples during the same tick it paints in.
    const id = requestAnimationFrame(() => setRgb(sampleEmoji(emoji) ?? FALLBACK));
    return () => cancelAnimationFrame(id);
  }, [emoji]);

  return { rgb, css: `${rgb[0]},${rgb[1]},${rgb[2]}` };
}
