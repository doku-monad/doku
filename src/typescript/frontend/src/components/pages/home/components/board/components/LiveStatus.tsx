"use client";

import { useQuery } from "@tanstack/react-query";
import { FormattedNumber } from "components/FormattedNumber";

/**
 * Blocks behind the chain before the feed stops being "live".
 *
 * Measured in blocks, not in seconds since the last write. The indexer only writes when something
 * happens, so on a quiet chain the seconds-since-write grows without bound and a perfectly healthy
 * indexer reports itself as delayed. Blocks behind is what "keeping up" actually means.
 *
 * The floor is the ingester's own five-block confirmation lag, which is deliberate and permanent.
 */
const LIVE_LAG_BLOCKS = 15;

/**
 * The left half of the board toolbar — the section's name and the state of the feed behind it.
 *
 * The dot reflects how far behind the chain the indexer is — not whether a socket is open. A
 * connected socket serving stale data would still show "Live", which is exactly the failure this
 * indicator exists to catch. The socket only decides how *quickly* the answer updates.
 *
 * The feed itself is subscribed to one level up, in the table, because the grid needs the same
 * messages to flash its cards — and two subscriptions would mean two sockets carrying identical
 * traffic.
 *
 * ## The lamp
 *
 * It was a 5px circle of brand green in a 13px housing, beside the word LIVE. Two rounds of notes
 * on it — first that it blinked, then that a steady version of the same dot still read as the
 * stock "we are live!" sticker every dashboard on the internet wears. Both complaints are really
 * the same one: a flat coloured circle is a *decoration* that means "online", and this product
 * does not draw anything else that way. Every other surface here is a machined object catching
 * light — a tray, a well pressed into it, a key standing proud of it.
 *
 * So the indicator is built as the hardware it is imitating: a lamp sunk in a housing, with an
 * emitter that is brightest off-centre (a radial, not a fill), a specular catch-light where the
 * lens curves toward the viewer, and a halo bleeding onto the plate around it. It holds still —
 * the thing it reports is a *condition*, not an event, and a pulsing light says "something is
 * happening" on a board where nothing has.
 *
 * The lamp and the readout share one recessed plate, seamed between the state and the count, which
 * is the same join the pair row and the mobile bar already use. That is what makes the three
 * facts — feed alive, how far behind, how many markets — read as one instrument rather than as
 * three loose spans next to a heading.
 */
export const LiveStatus = ({ numMarkets }: { numMarkets: number }) => {
  const { data, isPending, isError } = useQuery({
    queryKey: ["indexer-status"],
    refetchInterval: 15_000,
    queryFn: async () => {
      const res = await fetch("/api/status");
      if (!res.ok) throw new Error(`status: ${res.status}`);
      return (await res.json()) as {
        reachable: boolean;
        lagBlocks?: number;
        lagSeconds?: number;
      };
    },
  });

  const live = Boolean(data?.reachable) && (data?.lagBlocks ?? Infinity) <= LIVE_LAG_BLOCKS;
  /*
   * Only the two states that say something about the rows below.
   *
   * It printed "…", "Unknown" and "Offline" as well — and those three are facts about THIS PAGE'S
   * request, not about the launches beside them. On a board that is showing markets, a red-adjacent
   * "Offline" next to the section's own title reads as "these are broken", which is the opposite of
   * true. When the check has not answered, or cannot, the honest thing is to claim nothing rather
   * than to claim a fault — the plate then carries the count alone.
   */
  const label = isPending || isError || !data?.reachable ? null : live ? "Live" : "Delayed";

  return (
    <div className="flex min-w-0 items-center gap-2.5 sm:gap-3.5">
      {/*
        The board's name, and the one place on the route that says it.

        A section this large with no title reads as "the rest of the page" rather than as an object
        with a scope — which matters here because the hero above it is also full of markets. The
        heading says where the showcase stops and the complete list starts.
      */}
      <h2 className="shrink-0 font-ui text-[14px] uppercase leading-none tracking-[0.06em] text-ink sm:text-[17px]">
        Launches
      </h2>

      {/*
        The readout, on one plate.

        `py-[3px]` and a 9px radius: the plate is the same object as the pair row's count tabs and
        the ⌘K keycaps, at the size a 12px lamp and two words need.
      */}
      <div className="doku-status-plate flex min-w-0 shrink items-center gap-2 rounded-[9px] py-[3px] pl-[7px] pr-2">
        {label && (
          <>
            {/* `data-state` rather than two class names: the CSS switches the emitter's hue, its
                halo and the housing's inner glow together, and a lamp with three of those four in
                agreement is worse than one with none. */}
            <span
              className="doku-lamp shrink-0"
              data-state={live ? "live" : "delayed"}
              aria-hidden
            />
            <span
              className="shrink-0 font-numeric text-[11px] uppercase leading-none tracking-[0.1em] text-mute"
              title={
                data?.reachable && !live
                  ? `The indexer is ${data.lagBlocks} blocks behind the chain.`
                  : undefined
              }
            >
              {label}
            </span>
            {/* The seam: dark line, lit line beside it — the join every other multi-part surface in
                the product carries. It is what makes one plate read as two cells. */}
            <span aria-hidden className="doku-status-seam h-[11px] w-px shrink-0" />
          </>
        )}

        <span className="flex min-w-0 items-center gap-1">
          <FormattedNumber
            className="font-numeric text-[11px] leading-none text-ink"
            value={numMarkets}
            decimals={0}
          />
          {/* The unit is the first thing to go on a phone: the figure sits beside a heading that
              already says these are launches, and 360px of bar has better uses for 54 pixels.
              Singular when there is one of them — the plural was unconditional, which read as
              "1 markets" the moment the pager's floor leaked into this figure. */}
          <span className="hidden font-numeric text-[11px] uppercase leading-none tracking-[0.08em] text-mute sm:inline">
            {numMarkets === 1 ? "market" : "markets"}
          </span>
        </span>
      </div>
    </div>
  );
};

export default LiveStatus;
