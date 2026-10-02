"use client";

import { ROUTES } from "router/routes";

import { AssetIcon } from "@/components/ui/asset-icon";
import { IntentLink } from "@/components/ui/intent-link";

import type { PairCycle } from "./pair-cycle";

/**
 * The pair rail — every asset a coin can be launched against right now, as a row of marks.
 *
 * ## Why the claim needed a rail under it
 *
 * The headline types one pair at a time, which proves the mechanism and understates the range: at
 * any instant the reader sees exactly one asset. The rail shows all of them at once, with the marks
 * people already recognise, and the two together do the job neither does alone — the headline says
 * the pair is a *slot*, the rail says what goes in it.
 *
 * ## Only live pairs, and the launch form's own marks
 *
 * It showed seven slots, three of them tokenized equities the factory refuses and one an abstract
 * "anything" — a row of promises, most of which the launch form then greyed out. It now holds
 * exactly the options the form offers (see `pair-cycle.ts`), each drawn by `AssetIcon` in the same
 * round socket `PairSelect` uses, so a launcher who clicks GOLD here lands on a form showing the
 * same gold bar in the same setting.
 *
 * ## The rail and the headline are one instrument
 *
 * They share `usePairCycle`, so the lit chip is always the word being typed. Hovering a chip pins
 * the cycle to it: the headline finishes that word and holds while the pointer is down the row, and
 * resumes when it leaves.
 *
 * ## Why chips go to the launch form
 *
 * Every chip is now a pair the factory accepts, so the honest destination is the form, with the
 * pair already chosen — `?pair=` is the id `LaunchBench` reads. They pointed at `/assets` while
 * most of them could not be launched against, because that page is where the answer "not yet" was
 * given; nothing on this row needs that answer any more.
 */
export function PairRail({ cycle }: { cycle: PairCycle }) {
  return (
    /* `sm:w-fit`, not `w-auto`: a block-level flex container fills its column whatever its width
       says, and with five live pairs that left a length of empty tray after the last chip. The
       tray hugs its keys, and still scrolls if the registry grows past the column. */
    <div className="doku-pair-tray flex w-full items-stretch rounded-doku-xl p-[3px] sm:w-fit">
      {/* The label plate. Names what the row is without spending a line of type above it — and it
          is the same machined tab the top bar's ⌘K key and the card's rank plate are cut from. */}
      <span className="doku-pair-label hidden shrink-0 items-center rounded-[9px] px-2.5 font-numeric text-[11px] uppercase leading-none tracking-[0.14em] text-mute lg:flex">
        Pair
      </span>

      {/*
        The scroller.

        Below `lg` the row can be wider than the column and scrolls, with the tray's own mask fading
        the far end — a row of chips cut dead at the viewport edge reads as broken, and the fade
        reads as "there is more".
      */}
      <div className="doku-pair-scroll no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {cycle.slots.map((slot, i) => (
          <IntentLink
            key={slot.id}
            href={`${ROUTES.launch}?pair=${encodeURIComponent(slot.id)}`}
            title={`Launch a coin paired with ${slot.name}`}
            data-active={i === cycle.index}
            onPointerEnter={() => cycle.pin(i)}
            onPointerLeave={cycle.unpin}
            onFocus={() => cycle.pin(i)}
            onBlur={cycle.unpin}
            className="doku-pair-chip flex h-[30px] shrink-0 items-center gap-1.5 rounded-[9px] pl-[5px] pr-2.5"
          >
            {/* The socket `PairSelect` sets its coins in, at chip scale: a 20px recess round an
                18px coin. */}
            <span className="doku-pair-socket grid h-5 w-5 shrink-0 place-items-center rounded-full">
              <AssetIcon asset={slot.asset} size={18} className="doku-pair-mark rounded-full" />
            </span>
            <span className="whitespace-nowrap font-numeric text-[11.5px] font-semibold uppercase leading-none tracking-[0.045em]">
              {slot.word}
            </span>
          </IntentLink>
        ))}
      </div>
    </div>
  );
}

export default PairRail;
