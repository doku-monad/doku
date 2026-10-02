"use client";

import { useReducedMotion } from "framer-motion";
import { cn } from "lib/utils/class-name";

import { CoinMark } from "@/components/ui/coin-mark";
import { IntentLink } from "@/components/ui/intent-link";
import { marketPath } from "@/lib/market-path";

import { capText } from "./cap-text";
import type { RailItem } from "./types";

/**
 * The coin tape — the latest coins, travelling along a channel cut into the foot of the hero.
 *
 * ## One geometry, from the hero's corner to the coin
 *
 * Every curve on the strip is concentric with the one outside it. The hero's corner is 22px; the
 * channel sits 6px inside it, so its ends are 16px — a 32px pill. Each coin rides 3px inside the
 * channel, so its key is a 26px pill (13px ends); the coin's picture and the change's readout sit
 * 3px inside that, 20px tall. 22, 16, 13, 10. That is why the strip reads as one machined part rather than a row of
 * things placed on a band — and why it is as thin as it is: a channel concentric with a 22px corner
 * fixes the band at 44px, twice that radius, whatever the padding.
 *
 * ## What a ticket says
 *
 * The coin's picture, its market cap, and the day's change. No label on the strip and nothing
 * else on a ticket: at forty pixels a second a reader takes in whose picture, how big, which way.
 * The name and ticker are there for a tooltip and a screen reader.
 *
 * The key is symmetric about its face: the coin seated in a socket at its left end and the change
 * in a recessed readout at its right, both 20px, both 3px in, both concentric with the ends they
 * sit in — one raised, one sunk. Every edge on the strip is even: a key's hairline is the same all
 * the way round, because a key lit green along its foot read as a border drawn heavier on one side
 * than the other.
 *
 * ## Depth of field
 *
 * The channel's mask does more than fade the ends: keys come out of the dark at the edges and are
 * fully lit only through the middle, so the strip has a focal band instead of reading as a flat
 * list that happens to move. The recess is outside the mask, so its rim stays whole.
 *
 * ## Why CSS and not JavaScript
 *
 * A `requestAnimationFrame` loop nudging a transform burns a frame callback forever and stutters
 * the moment the main thread is busy. A CSS `translate3d` keyframe runs on the compositor.
 *
 * ## The duplicated list is load-bearing
 *
 * The keys are rendered twice and the keyframe travels exactly `-50%`. At the moment the animation
 * loops, the second copy sits precisely where the first started, so the seam is invisible and the
 * tape appears endless.
 */

/** Seconds of travel per key. A key is ~145px with its gap, so this is ~40px/s. */
const DURATION_PER_ITEM_S = 3.6;

/** How many keys one copy of the track carries — enough to overfill a 2560px screen. */
const MIN_TICKETS = 20;

export function TickerRail({ items, failed }: { items: RailItem[]; failed?: boolean }) {
  const reduced = useReducedMotion();

  /*
   * An empty tape draws nothing. A FAILED one says so — on a phone the runner board is hidden, so
   * this is the only part of the hero that can speak at all. A static notice in the same channel.
   */
  if (!items.length) {
    if (!failed) return null;
    return (
      <div className="doku-tape p-1.5">
        <p
          role="status"
          className="doku-tape-channel grid h-8 place-items-center rounded-full px-4 font-ui text-[12px] leading-none text-mute"
        >
          The coins didn&apos;t load — try again in a moment.
        </p>
      </div>
    );
  }

  /* Enough keys that one copy is wider than any viewport before it is doubled. */
  const filled: RailItem[] = [];
  while (filled.length < MIN_TICKETS) filled.push(...items);

  const duration = filled.length * DURATION_PER_ITEM_S;

  return (
    <div className="doku-tape p-1.5" role="region" aria-label="Latest coins">
      {/* The channel: the recess. The mask lives on the window inside it, so the keys fade and
          focus while the recess's own rim and lit lower lip stay whole. */}
      <div className="doku-tape-channel relative h-8 overflow-hidden rounded-full">
        <div className="doku-tape-window h-full overflow-hidden rounded-full">
          <div
            className="doku-tape-track flex h-full w-max items-center"
            style={{
              animationDuration: `${duration}s`,
              /* Set only when "paused", never "running": an inline value beats the stylesheet's
                 hover and focus pauses in `global.css`, which are what let a key be clicked. */
              animationPlayState: reduced ? "paused" : undefined,
            }}
          >
            {[0, 1].map((copy) => (
              // The second copy is `aria-hidden`: it is the same coins again.
              <div
                key={copy}
                aria-hidden={copy === 1}
                className="flex items-center gap-2 pl-[3px] pr-[5px]"
              >
                {filled.map((item, i) => (
                  <Ticket key={`${copy}-${item.address}-${i}`} item={item} hidden={copy === 1} />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The change's direction, on the pixel grid `PixelArrow` is drawn on — a stepped triangle rather
 * than a font's ▲, which sits on its own baseline and renders at whatever weight the fallback face
 * has.
 */
const PixelTriangle = ({ down }: { down: boolean }) => (
  <svg
    aria-hidden
    viewBox="0 0 7 4"
    width="7"
    height="4"
    fill="currentColor"
    shapeRendering="crispEdges"
    className={cn("shrink-0", down && "rotate-180")}
  >
    <rect x="3" y="0" width="1" height="1" />
    <rect x="2" y="1" width="3" height="1" />
    <rect x="1" y="2" width="5" height="1" />
    <rect x="0" y="3" width="7" height="1" />
  </svg>
);

function Ticket({ item, hidden }: { item: RailItem; hidden: boolean }) {
  const cap = capText(item.marketCap, item.marketCapUsd, item.quoteSymbol);
  const change = item.changePct;
  const trend = change === null ? "flat" : change < 0 ? "down" : "up";
  const changeText = change === null ? "—" : `${Math.abs(change).toFixed(1)}%`;

  return (
    <IntentLink
      href={marketPath(item.tokenAddress)}
      tabIndex={hidden ? -1 : undefined}
      title={`${item.name} · $${item.ticker}`}
      aria-label={`${item.name}, $${item.ticker}: market cap ${cap}${
        change === null ? "" : `, ${trend} ${changeText} today`
      }`}
      className="doku-tape-ticket flex h-[26px] shrink-0 items-center gap-2 rounded-full px-[3px]"
    >
      {/* The coin, seated in a socket at the key's left end — a 20px disc, 3px in from the edge,
          concentric with the end it sits in. */}
      <span className="doku-tape-coin grid h-5 w-5 shrink-0 place-items-center overflow-hidden rounded-full">
        <CoinMark
          logo={item.logo}
          ticker={item.ticker}
          name={item.name}
          size={20}
          className="!rounded-full !border-0"
        />
      </span>

      <span className="whitespace-nowrap font-numeric text-[12px] font-semibold leading-none tabular-nums text-ink">
        {cap}
      </span>

      {/*
        The readout — a recess at the key's right end, mirroring the coin at its left: 20px tall,
        3px in from the edge, concentric with the end it sits in. The coin stands on the key and
        the readout is sunk into it, so the key has depth in both directions from its face, and
        the change sits in its own window rather than trailing after the cap. Colour is in the
        figure alone — no lit edge, no glow.
      */}
      <span
        className={cn(
          "doku-tape-readout flex h-5 shrink-0 items-center gap-[5px] rounded-full pl-2 pr-[9px] font-numeric text-[11px] font-semibold leading-none tabular-nums",
          trend === "flat" ? "text-mute" : trend === "down" ? "text-loss-ink" : "text-doku-ink"
        )}
      >
        {change !== null && <PixelTriangle down={trend === "down"} />}
        {changeText}
      </span>
    </IntentLink>
  );
}

export default TickerRail;
