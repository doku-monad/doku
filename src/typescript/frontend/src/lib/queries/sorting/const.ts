/**
 * How many markets a page of the board holds.
 *
 * Twenty, not fifty. The pager renders nothing while there is only one page — which is right, and
 * is exactly why the control had never appeared: with fifty to a page, a board of two dozen coins
 * fitted entirely on page one. Twenty divides evenly by the grid's four- and five-across desktop
 * widths, so a page never ends mid-row.
 */
export const MARKETS_PER_PAGE = 20;
