import React, { type SVGProps } from "react";

/**
 * An arrow drawn on a 9×9 pixel grid.
 *
 * The rest of this product's chrome is set in a pixel face, and a smooth bezier arrowhead next to
 * that type reads as an icon borrowed from a different design system. This one is built the way
 * the type is: whole cells on a grid, no diagonals, `crispEdges` so a fractional scale never
 * softens an edge into two grey rows.
 *
 * Square by construction rather than tightly cropped. A 9×7 arrow is the same drawing with a
 * ratio the caller has to preserve by hand, and the first call site that passes a round
 * `width`/`height` pair stretches it. Square means one number sizes it.
 *
 * Points right. Anything else is a rotation at the call site — `rotate-90` for the down arrow on
 * the hero's secondary action — because a rotated square grid is still on the grid.
 */
const PixelArrow = ({ width = 12, height = 12, ...props }: SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={width}
    height={height}
    viewBox="0 0 9 9"
    fill="currentColor"
    shapeRendering="crispEdges"
    {...props}
  >
    {/* The shaft, running the full width so the tip lands on the last column. */}
    <rect x="0" y="4" width="9" height="1" />
    {/* The head: one cell per row, stepping in towards the tip. */}
    <rect x="5" y="1" width="1" height="1" />
    <rect x="6" y="2" width="1" height="1" />
    <rect x="7" y="3" width="1" height="1" />
    <rect x="7" y="5" width="1" height="1" />
    <rect x="6" y="6" width="1" height="1" />
    <rect x="5" y="7" width="1" height="1" />
  </svg>
);

export default PixelArrow;
