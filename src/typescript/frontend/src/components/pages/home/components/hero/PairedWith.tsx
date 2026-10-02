"use client";

import { AssetIcon } from "@/components/ui/asset-icon";

import type { PairCycle } from "./pair-cycle";

/**
 * The word at the end of the headline, typing itself through the pairs a coin can launch against.
 *
 * ## Why it names assets
 *
 * "Launch coins paired with anything" was the repositioning, and *anything* was the one word in the
 * sentence a reader could not picture — and, with the equities still `soon`, the one that was not
 * true. Naming the live pairs, each with the mark a reader already recognises, makes the claim both
 * concrete and exact. What they are comes from `pair-cycle.ts`, which reads the registry.
 *
 * ## Why it is typed rather than cross-faded
 *
 * A cross-fade says "these words are interchangeable". A typewriter says "and, and, and" — it is
 * the same word being *replaced*, which is the point: the pair is a slot, and these are things you
 * can put in it. It also survives the pixel face, where a cross-fade of two different-width words
 * is a smear.
 *
 * ## The state is not this component's
 *
 * It belongs to `usePairCycle`, held by the hero, because the rail under the headline lights the
 * same slot and hovering a chip pins it.
 *
 * ## Nothing here shifts the layout
 *
 * Every phrase is stacked invisibly in one grid cell, so the element is always as wide as its
 * longest state, and the live row is laid over that stack out of flow, so it cannot widen it.
 *
 * Both halves matter, and the second was missing. The stack reserved the mark, the word and the
 * full stop but not the caret, and the live row sat IN the cell — so with the longest word typed
 * and the caret beside it, the box grew by the caret's 7px, and shrank again as the next word was
 * deleted. The headline's line holds together (see `ExploreHero`), so the column it sits in is as
 * wide as that line: every cycle, the hero's grid gave the runner board 7px and took it back, and
 * the board beside the headline visibly stretched and squeezed. Measured: the board moved between
 * 583.5 and 590.7px, in step with the word's box.
 *
 * ## Reduced motion gets a sentence, not a still of the animation
 *
 * `usePairCycle` holds the first pair fully typed and schedules nothing; the caret goes. The mark
 * stays, because it is part of the word rather than part of the effect.
 */
export const PairedWith = ({ reduced, cycle }: { reduced: boolean; cycle: PairCycle }) => {
  const slot = cycle.slots[cycle.index];
  const words = cycle.slots.map((s) => s.word);

  return (
    <>
      {/* The accessible name is the whole claim, stated once. A screen reader following the live
          element would announce a stream of half-words. */}
      <span className="sr-only">
        {words.length > 1
          ? `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`
          : words[0]}
      </span>

      {/* `align-baseline` on an inline grid resolves to the baseline of the first item in the
          first row — one of the invisible sizing spans, set in the same face at the same size as
          the words before it. So the typed word sits on the headline's own baseline rather than on
          the box's bottom edge. */}
      <span aria-hidden className="relative inline-grid align-baseline">
        {/* The sizing stack: every phrase, invisible, in the same cell — mark, word, CARET and
            full stop, the same four parts the live row draws. See the note above. */}
        {cycle.slots.map((s) => (
          <span key={s.id} className="invisible col-start-1 row-start-1 whitespace-nowrap">
            <span className="mr-[0.16em] inline-block h-[0.7em] w-[0.7em] align-[-0.06em]" />
            {s.word}
            <span className="ml-[0.06em] inline-block w-[0.09em]" />.
          </span>
        ))}

        {/* The live row, laid OVER the stack rather than in it: absolutely positioned, it has no
            say in the box's width, so nothing it does while typing can move anything. */}
        <span className="absolute inset-y-0 left-0 flex items-center whitespace-nowrap">
          {/* The mark appears only once its word is finished — it is the payoff, not a label that
              sits there while the letters arrive under it. The launch form's own mark, round, as
              `PairSelect` sets it. */}
          <span
            className={`mr-[0.16em] inline-flex transition-opacity duration-200 ${
              cycle.complete ? "opacity-100" : "opacity-0"
            }`}
          >
            <AssetIcon asset={slot.asset} size="0.7em" className="rounded-full" />
          </span>

          <span className="doku-headline-accent">{cycle.typed}</span>

          {/* The caret. A block in the brand hue rather than a text `|`: the headline is set in a
              pixel face, and a hairline bar next to it reads as a rendering artifact. Absent when
              nothing is typing. */}
          {!reduced && cycle.slots.length > 1 && (
            <span
              className="doku-caret ml-[0.06em] inline-block h-[0.72em] w-[0.09em] shrink-0 bg-doku"
              style={{ verticalAlign: "baseline" }}
            />
          )}

          <span className="text-ink">.</span>
        </span>
      </span>
    </>
  );
};

export default PairedWith;
