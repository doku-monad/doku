import React, { type SVGProps } from "react";

/**
 * A magnifier on the pixel grid — the search glyph for the same product as `PixelArrow`.
 *
 * Nine cells square, drawn at 18px so every cell is exactly two pixels: a round lens stepped out of
 * single cells, and a handle two cells wide stepping down to the corner. The stroked icon it
 * replaced was the default magnifier every icon set ships, and beside pixel type it read as a part
 * from a different kit.
 */
const CELLS = [
  "..XXX....",
  ".X...X...",
  "X.....X..",
  "X.....X..",
  "X.....X..",
  ".X...X...",
  "..XXXXX..",
  "......XX.",
  ".......XX",
];

const PixelSearch = ({ width = 18, height = 18, ...props }: SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={width}
    height={height}
    viewBox="0 0 9 9"
    fill="currentColor"
    shapeRendering="crispEdges"
    {...props}
  >
    {CELLS.flatMap((row, y) =>
      [...row].map((c, x) =>
        c === "X" ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" /> : null
      )
    )}
  </svg>
);

export default PixelSearch;
