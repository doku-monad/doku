"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { displaySymbolText } from "@/lib/assets/display-symbol";
import {
  launchableQuoteAssets,
  NATIVE_QUOTE_ADDRESS,
  pickableQuoteAssets,
  type QuoteAsset,
} from "@/lib/assets/quote-assets";
import { useQuoteAssets } from "@/lib/hooks/use-quote-assets";

/**
 * The slots the headline cycles through, and the state both it and the pair rail read.
 *
 * ## Why one hook and not two components with their own timers
 *
 * The claim types a word — `MON`, `USDC`, `GOLD` — and the rail beneath it shows every asset that
 * word can be. Those are the same fact stated twice, and with two independent timers they drift
 * apart within a cycle: the headline says gold while the rail lights USDC, which reads as two
 * unrelated widgets rather than as one sentence with an index under it.
 *
 * So the cycle lives here, `ExploreHero` owns it, and both surfaces are given the same value. It
 * also buys the interaction the rail is actually for: hovering a chip *pins* the cycle to that
 * asset, so the headline finishes the reader's thought instead of typing over it.
 *
 * ## Only what a coin can be launched against today
 *
 * The list was seven hand-written slots — "anything", then Tesla, NVIDIA and Apple, gold, USDC,
 * MON — and the three equities are `soon` in the registry: `DokuFactory.launch` reverts
 * `QuoteNotEnabled()` for every one of them. A headline typing TSLA above a launch key that cannot
 * pair against TSLA is the fold promising what the form then walks back.
 *
 * The slots are now exactly the launch picker's options — `launchableQuoteAssets` over
 * `pickableQuoteAssets`, in registry order, named by `displaySymbolText` — so the headline, the
 * rail and the form cannot disagree. An asset the registry enables tomorrow appears here without a
 * change to this file.
 */

export interface PairSlot {
  /** The registry id — the `?pair=` value the launch form reads. */
  id: string;
  /** The word as typed into the headline, and the rail chip's label. `WETH`, `BTC`, `GOLD`. */
  word: string;
  /** The asset's own name, for the chip's tooltip. */
  name: string;
  asset: QuoteAsset;
}

/**
 * What the fold says when the registry could not be read at all — server and browser both.
 *
 * MON is the one pair that needs no registry to be true: it is the chain's own asset, `address(0)`
 * in every `PoolKey`, and its mark resolves from the id alone (`lib/assets/asset-marks`). One slot
 * holds still rather than cycling, so the degraded headline is a finished sentence.
 */
const FALLBACK: PairSlot[] = [
  {
    id: "mon",
    word: "MON",
    name: "Monad",
    asset: {
      id: "mon",
      symbol: "MON",
      name: "Monad",
      kind: "native",
      status: "live",
      decimals: 18,
      address: NATIVE_QUOTE_ADDRESS,
      blurb: "",
    },
  },
];

export const pairSlots = (assets: readonly QuoteAsset[]): PairSlot[] => {
  const slots = launchableQuoteAssets(pickableQuoteAssets(assets)).map((asset) => ({
    id: asset.id,
    word: displaySymbolText(asset),
    name: asset.name,
    asset,
  }));
  return slots.length ? slots : FALLBACK;
};

/** Milliseconds per character typed, per character deleted, and the pause on a finished word. */
const TYPE_MS = 62;
const DELETE_MS = 30;
const HOLD_MS = 1700;

type Phase = "hold" | "deleting" | "typing";

export interface PairCycle {
  slots: PairSlot[];
  /** Which slot is showing. The rail lights this one. */
  index: number;
  /** The slot's word, cut to however much of it has been typed. */
  typed: string;
  /** Whether `typed` is the whole word — the moment the mark is allowed to appear beside it. */
  complete: boolean;
  /** Hover handlers for a rail chip: hold the cycle on `i`, then let it run again. */
  pin: (i: number) => void;
  unpin: () => void;
}

/**
 * The typing cycle, pausable.
 *
 * `initial` is the registry as the server read it. The first render uses it on both sides of
 * hydration — the query below has not resolved on the server or on the browser's first pass — so
 * the headline is a finished word in the HTML and does not re-type itself when the script lands.
 * The browser's own read takes over once it arrives, which is the same rows unless an admin
 * changed the registry in between.
 *
 * Starts fully typed on the first slot, so the first paint is a sentence rather than a caret on an
 * empty line. Pinning writes the finished word straight into the state the timer drives, rather
 * than overriding it downstream, so releasing a chip picks the cycle up from the pinned word's hold
 * exactly as if it had typed it.
 */
export const usePairCycle = (reduced: boolean, initial: readonly QuoteAsset[]): PairCycle => {
  const { assets: fetched } = useQuoteAssets();
  const source = fetched.length ? fetched : initial;
  const slots = useMemo(() => pairSlots(source), [source]);

  const [index, setIndex] = useState(0);
  const [length, setLength] = useState(() => pairSlots(initial)[0].word.length);
  const [phase, setPhase] = useState<Phase>("hold");
  const [paused, setPaused] = useState(false);

  /* The list can change length under the cycle when the browser's read lands; wrap rather than
     index past the end. */
  const at = index % slots.length;
  const slot = slots[at];
  /* One pair is a statement, not a list — deleting and retyping the same word is a tic. */
  const still = reduced || slots.length < 2;

  useEffect(() => {
    if (still || paused) return;

    const next = () => {
      if (phase === "hold") return setPhase("deleting");
      if (phase === "deleting") {
        if (length > 0) return setLength((n) => n - 1);
        setIndex((i) => (i + 1) % slots.length);
        return setPhase("typing");
      }
      if (length < slot.word.length) return setLength((n) => n + 1);
      return setPhase("hold");
    };

    const delay = phase === "hold" ? HOLD_MS : phase === "deleting" ? DELETE_MS : TYPE_MS;
    const timer = setTimeout(next, delay);
    return () => clearTimeout(timer);
  }, [still, paused, phase, length, slot.word.length, slots.length]);

  const pin = useCallback(
    (i: number) => {
      setPaused(true);
      setIndex(i);
      setLength(slots[i].word.length);
      setPhase("hold");
    },
    [slots]
  );

  const unpin = useCallback(() => setPaused(false), []);

  const shown = still ? slot.word.length : length;

  return {
    slots,
    index: at,
    typed: slot.word.slice(0, shown),
    complete: shown >= slot.word.length,
    pin,
    unpin,
  };
};
