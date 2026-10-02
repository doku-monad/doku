import { useMemo } from "react";
import { useWindowSize } from "react-use";

const MAX_ELEMENTS_PER_LINE = 4;

/** DOKU's content rail, and the horizontal padding it carries (`px-4` / `sm:px-6`). */
const CONTENT_MAX_WIDTH = 1240;
const RAIL_PADDING = 24;

/**
 * The narrowest a card may get before dropping a column.
 *
 * ## Why this went up, a lot
 *
 * It was 230px, which at the full rail gave five columns of ~238px. That was the right floor for a
 * card whose content was an emoji and two figures. The card is now a coin: a banner, a logo, a
 * name, a ticker, an age, a pair badge, a contract address, a state badge, a market cap, a delta,
 * a creator and a row of actions. At 238px those either truncate or shrink to sizes nobody can
 * read, which is exactly the complaint this floor exists to answer.
 *
 * 288px gives four columns of ~296px on the full rail — the same card width the reference board
 * uses, and enough that the name, the address chip and the cap all sit at their intended size with
 * nothing eliding. Fewer, bigger cards is the whole trade, and it is the right one: a board you
 * can read four of beats a board you can see seven of.
 *
 * ## One floor, phones included
 *
 * There was a second floor of 165px below `sm`, on the argument that 288 would give a single column
 * on every phone and "one card per screen is not a grid, it is a list of posters". The intent was
 * right and the number was not survivable: two columns on a 390px viewport is a **173px card**, and
 * at 173px this card cannot print its own contents. Measured on the board, every one of them broke
 * at once — the market cap's unit truncated, `24H VOL` wrapped onto two lines, the pair elided to
 * `M…`, the price to `0.000…` and the state badge to `BON`. A grid of two cards that have each hidden
 * their four figures is strictly worse than a list of one card that shows them.
 *
 * It also assumed a compensating layout below `sm` — "the card drops its banner and tightens its
 * bands to suit" — that the card does not implement and never did.
 *
 * So: one floor at every width. A phone gets one column at ~342px, which is wider than the desktop
 * card and prints everything at full size; 640px gets two at ~296px, the desktop card's own width;
 * the full rail still gets four. Nothing about the card has to know the breakpoint.
 */
const MIN_CARD_WIDTH = 288;

export const useGridRowLength = () => {
  const { width } = useWindowSize();
  const rowLength = useMemo(() => {
    // Previously measured against `window.innerWidth` with a fixed card width, which on a wide
    // display asked for seven 259px columns (~1893px) and overflowed the rail.
    const available = Math.min(width, CONTENT_MAX_WIDTH) - RAIL_PADDING * 2;
    const num = Math.floor(available / MIN_CARD_WIDTH);
    return Math.max(1, Math.min(num, MAX_ELEMENTS_PER_LINE));
  }, [width]);

  return rowLength;
};
