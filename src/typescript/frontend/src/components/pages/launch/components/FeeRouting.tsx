"use client";

import {
  FEE_ROUTING,
  type FeeRouting as FeeRoutingId,
  PROTOCOL_FEE_PCT,
} from "@/lib/launch/submit";

/**
 * Where the creator's share of every swap goes.
 *
 * Three keys rather than a dropdown, because the difference between them is a sentence each and a
 * select would hide two of the three behind a click. This is the decision a buyer will judge the
 * coin on, and the launcher should read all three before making it.
 *
 * The default is "you keep them" — the honest default, and the only option that is not a promise
 * made to somebody else. Defaulting to holder rewards would be the platform putting words in a
 * launcher's mouth.
 *
 * ## The blurbs are back
 *
 * They were cut on the argument that a title says it already. It does not. `HOLDER REWARDS` names
 * the *outcome* and says nothing about the mechanism, and the mechanism is the whole decision: fees
 * buy the quote asset and push it out pro-rata, which is a different thing from minting, from
 * airdropping and from a treasury — and a launcher choosing between three permanent, on-chain modes
 * is entitled to know which one they are signing. Three lines of body copy is the cheapest this
 * form will ever get that answer.
 *
 * ## There is no radio on it
 *
 * There was, and it was the one generic thing on the bench: a grey ring with a dot in it, bolted to
 * the right edge of a key that already states its selection six ways over — a brand face, a brand
 * rim, the brand's light under its foot, a lit well, a brand glyph and a brand title. A radio next
 * to all of that is not reinforcement, it is a second, weaker control drawn on top of the first,
 * and it is the widget every form on the internet uses to mean "pick one" precisely because it
 * carries no material of its own.
 *
 * What replaced it is what `PairSelect` uses one step above on this same page: a tick, filled in
 * the brand, riveted to the corner of the glyph's well. Same fact, stated on the object rather than
 * beside it — and the right edge of every row goes back to the copy, which is the half a launcher
 * is here to read.
 *
 * ## The split is stated before the choice, not after it
 *
 * The launcher is not choosing where "the fee" goes; they are choosing where *seven tenths of one
 * percent* goes. So the premise leads, as a gauge: a milled channel with the creator's share filled
 * in brand and the protocol's in bare metal, at their real proportions. Seven tenths is a fraction
 * people picture badly and a 70/30 bar is one they picture instantly.
 */

/** The creator's share of the protocol's cut. Seven tenths of `PROTOCOL_FEE_PCT`. */
const CREATOR_SHARE = 0.7;
/*
 * Rounded, and not for tidiness: `1 - 1 * 0.7` is `0.30000000000000004` in binary floating point,
 * and the label under the bar printed exactly that — seventeen digits of IEEE-754 in the middle of
 * a form about money. Three decimal places is more than a fee split in tenths of a percent can
 * carry, so nothing real is lost.
 */
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const YOURS_PCT = round3(PROTOCOL_FEE_PCT * CREATOR_SHARE);
const PROTOCOL_KEEPS_PCT = round3(PROTOCOL_FEE_PCT - YOURS_PCT);

/**
 * A drawn glyph per route, not an emoji.
 *
 * The three options carried 👛 🤝 🔥. An emoji is somebody else's artwork rendered in somebody
 * else's font: it lands at a different weight on every platform, it cannot take the brand hue when
 * its key is selected, and beside machined panels it reads as a placeholder. These are strokes in
 * `currentColor`, so each one is lit by the key it sits on.
 */
const ROUTE_GLYPH: Record<FeeRoutingId, React.ReactNode> = {
  /* A wallet: the share lands where every other payment does. */
  creator: (
    <>
      <rect x="3" y="6" width="18" height="13" rx="3.2" />
      <path d="M3 10.5h18" />
      <circle cx="16.8" cy="14.8" r="1.15" fill="currentColor" stroke="none" />
    </>
  ),
  /* One stream splitting into two: paid out, pro-rata, to somebody other than you. */
  holders: (
    <>
      <path d="M12 3.5v6.5" />
      <path d="M12 10 6.5 15.5M12 10l5.5 5.5" />
      <circle cx="5.6" cy="18.2" r="2.3" />
      <circle cx="18.4" cy="18.2" r="2.3" />
    </>
  ),
  /* A flame: nothing is handed out, supply goes away. */
  buyback: (
    <>
      <path d="M12 3c3.4 3.9 5.6 6 5.6 9.4a5.6 5.6 0 1 1-11.2 0c0-2 .8-3.4 2.1-4.7.3 1.7 1.2 2.5 2 2.7-.5-2.4-.7-5 1.5-7.4Z" />
    </>
  ),
};

export const FeeRoutingPicker = ({
  value,
  onChange,
}: {
  value: FeeRoutingId;
  onChange: (next: FeeRoutingId) => void;
}) => (
  <div className="flex flex-col gap-4">
    {/*
      The premise, as a gauge.

      A recessed channel with two bars in it: the creator's share lit in brand, the protocol's in
      bare metal. It is the same instrument the curve meter in the trade panel is, at strip scale,
      because it is the same kind of fact — a proportion of a fixed whole.
    */}
    <div className="doku-route-gauge flex flex-col gap-2.5 rounded-doku-2xl px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-pixel text-[12px] uppercase leading-none tracking-[0.05em] text-ash">
          Every trade pays {PROTOCOL_FEE_PCT}%
        </span>
      </div>

      <div className="doku-route-track flex h-[10px] w-full gap-[3px] rounded-doku-pill p-[2px]">
        <span
          className="doku-route-fill shrink-0 rounded-doku-pill"
          style={{ width: `${CREATOR_SHARE * 100}%` }}
        />
        {/* `flex-1` rather than a second percentage: 70% + 30% + the gap between them is more than
            100%, and the overflow lands on the segment the eye is least likely to check. */}
        <span className="doku-route-rest flex-1 rounded-doku-pill" />
      </div>

      <div className="flex items-baseline justify-between gap-3 font-numeric text-[12.5px] leading-none">
        <span className="font-semibold text-doku-ink">{YOURS_PCT}% yours to route</span>
        <span className="text-ash">{PROTOCOL_KEEPS_PCT}% the protocol keeps</span>
      </div>
    </div>

    {/* The three destinations. */}
    <div className="grid grid-cols-1 gap-2.5">
      {FEE_ROUTING.map((option) => {
        const selected = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            aria-pressed={selected}
            data-on={selected}
            className="doku-route-key group/route flex w-full items-start gap-3.5 rounded-doku-2xl px-3.5 py-3.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku"
          >
            {/*
              The glyph's well, which is also the state.

              38px and pressed into the key — the same recess `PairSelect` mounts a quote asset in
              one step above, so the two decisions on this bench are made of the same parts. When
              this route is the chosen one the well takes a brand rim, the glyph takes the brand
              hue, and a tick is riveted to its corner.
            */}
            <span className="relative shrink-0">
              <span
                className={[
                  "doku-route-tile grid h-[38px] w-[38px] place-items-center rounded-doku-lg",
                  "transition-[box-shadow,color] duration-200",
                  selected ? "text-doku-ink" : "text-ash",
                ].join(" ")}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  {ROUTE_GLYPH[option.id]}
                </svg>
              </span>

              {selected && (
                <span
                  aria-hidden
                  className="doku-route-tick absolute -bottom-1 -right-1 grid h-[17px] w-[17px] place-items-center rounded-full bg-doku text-[var(--mat-cta-ink)]"
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M5 12.5 10 17.5 19 7" />
                  </svg>
                </span>
              )}
            </span>

            <span className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span
                className={[
                  "font-numeric text-[14px] font-semibold uppercase leading-none tracking-[0.06em] transition-colors",
                  selected ? "text-doku-ink" : "text-ink",
                ].join(" ")}
              >
                {option.title}
              </span>
              {/* The mechanism, from `lib/launch/submit.ts` — the domain's own description of what
                  the mode does, so this form and the market page it produces cannot describe the
                  same routing two different ways. */}
              <span className="text-[12.5px] leading-[1.5] text-ash">{option.blurb}</span>
            </span>
          </button>
        );
      })}
    </div>
  </div>
);

export default FeeRoutingPicker;
