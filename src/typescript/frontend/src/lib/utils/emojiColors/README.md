<!---
cspell:word noto
-->

# Emoji Colors

Every symbol emoji has one dominant color, and the UI tints market cards and
charts with it. Sampling that color at render time would mean rasterising an
emoji to a canvas on every paint, so the colors are precomputed into the tables
under `symbol-emojis/` and shipped as data.

## What is here

| File                                         | Role                                                                |
| -------------------------------------------- | ------------------------------------------------------------------- |
| `symbol-emojis/apple-symbol-emoji-colors.ts` | Colors as macOS and iOS draw the emoji                              |
| `symbol-emojis/noto-symbol-emoji-colors.ts`  | Colors as Noto Color Emoji draws them, the fallback everywhere else |
| `emoji-color-data.ts`                        | Picks the table for the current platform and loads it               |
| `use-emoji-colors.ts`                        | React Query wrapper, because that load is async                     |
| `emoji-color-helpers.ts`                     | The sampling algorithm that produced the tables                     |

The two tables exist because the same codepoint is a different picture on
different platforms — an Apple-sampled color on a Noto device is visibly wrong.
`emoji-color-data.ts` imports one of them dynamically, so a bundle carries the
table the visitor will actually use rather than both.

## Regenerating the tables

`getEmojiDominantColor` in `emoji-color-helpers.ts` rasterises an emoji to an
`OffscreenCanvas`, groups the pixels into color clusters, and averages the
largest cluster.

It only runs in a browser: it needs the Canvas API, and it needs the font to be
the one whose colors you are sampling. Apple emoji cannot be sampled off a Mac
or an iOS device — another platform will silently substitute a different font
and produce a full table of plausible, wrong colors.

There is no page that drives it. Call it from a scratch client component over
`SYMBOL_EMOJI_DATA`, one font family at a time, and write the result out in the
same `Record<string, string>` shape the existing tables use.
