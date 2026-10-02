"use client";
// cspell:word unpathify

import { IndeterminateBar } from "components/loader/brand-loader";
import { usePathname } from "next/navigation";
import React, { useEffect, useMemo } from "react";
import { Emoji } from "utils/emoji";
import { EMOJI_PATH_INTRA_SEGMENT_DELIMITER, ONE_SPACE } from "utils/pathname-helpers";

import { seededEmojiCycle } from "@/lib/loading-cycle";
import { SYMBOL_EMOJI_DATA, type SymbolEmojiData } from "@/sdk/emoji_data";

const unpathify = (pathEmojiName: string) =>
  SYMBOL_EMOJI_DATA.byName(pathEmojiName.replaceAll(EMOJI_PATH_INTRA_SEGMENT_DELIMITER, ONE_SPACE));

/**
 * The route-level loading state.
 *
 * This is what fills the screen for the seconds after a launch, while the market page it navigates
 * to is still resolving — so it is the first thing a creator sees of the token they just made.
 *
 * It used to be `AnimatedEmojiCircle`: fourteen random symbol emoji arranged on a 150px radius,
 * each fading in and out on its own delay, under a `pixel-display-2` caption. Random emoji spinning
 * in a ring say nothing about what is loading, the pixel face was the last of the terminal theme,
 * and on the market route the emoji in the URL were already known — the page could have shown you
 * your own symbol and instead showed you a carousel of unrelated ones.
 *
 * Now it shows the symbol being loaded, on DOKU's card, over an indeterminate bar. The cycle is
 * kept for routes that don't name a symbol, because a still emoji there would read as frozen.
 */
export const Loading = ({ emojis }: { emojis?: SymbolEmojiData[] }) => {
  const pathname = usePathname();
  const emojiCycle = useMemo(() => {
    const emojisInPath = pathname
      .split("/market/")
      .at(1)
      ?.split(";")
      .map(unpathify)
      .filter((e) => typeof e !== "undefined");

    if (emojisInPath?.length) return emojisInPath;
    if (emojis?.length) return emojis;
    return seededEmojiCycle(pathname);
  }, [pathname, emojis]);

  /*
   * An index into the cycle, rather than two copies of its head in state.
   *
   * The interval used to rotate the array in place — `emojiCycle.unshift(emojiCycle.pop()!)` — and
   * the array is either the `useMemo`'s own value or, when the `emojis` prop is supplied, *the
   * caller's array*. Two consequences: the memo returned a different order than it computed, so a
   * re-run of the memo (a route change) left the displayed symbol frozen on the previous route's;
   * and the caller's array was silently reordered under it.
   *
   * Deriving both fields from `[index]` also removes the two `useState`s that were seeded once from
   * `emojiCycle[0]` and never resynced when the cycle changed.
   */
  const [index, setIndex] = React.useState(0);
  const current = emojiCycle[index % emojiCycle.length];
  const emojiName = current.name;
  const emoji = current.emoji;

  // A single known symbol has nothing to cycle through — it just sits there being the answer.
  const cycles = emojiCycle.length > 1;

  // A new cycle starts at its own head rather than wherever the last one had rotated to.
  useEffect(() => setIndex(0), [emojiCycle]);

  useEffect(() => {
    if (!cycles) return;
    const interval = setInterval(() => setIndex((i) => i + 1), 900);

    return () => clearInterval(interval);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [cycles]);

  return (
    <div className="flex w-full grow items-center justify-center px-4 py-16">
      <div className="flex w-full max-w-[300px] flex-col items-center gap-5 rounded-doku-3xl border border-line bg-glass px-6 py-8 backdrop-blur-[16px]">
        <div className="grid h-[72px] w-[72px] place-items-center rounded-full bg-raise">
          <Emoji className="!text-[34px] leading-none" title={emojiName} emojis={emoji} />
        </div>

        <div className="flex w-full flex-col items-center gap-2.5">
          <span className="font-numeric text-[11px] uppercase tracking-[0.08em] text-mute">
            Loading
          </span>
          <IndeterminateBar />
        </div>
      </div>
    </div>
  );
};

export default React.memo(Loading);
