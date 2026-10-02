/**
 * A 24-hour price trace, at thumbnail size.
 *
 * Inline SVG and about forty lines of arithmetic, rather than a charting library. The market page
 * already carries one (`LivelineChart`) and it is the right tool there — ranges, a crosshair, a live
 * subscription. None of that applies to a 96-point line drawn 40px tall: what a sparkline has to
 * do is show a direction, and every feature that makes a real chart good makes this one heavier
 * and no clearer.
 *
 * ## The flat case is not the same as the empty case
 *
 * A market that has traded at one price all day has a real, meaningful series — it just has zero
 * range. Scaling it by `(v - min) / (max - min)` divides by zero and yields `NaN`, which SVG
 * renders as nothing at all, so the one market that most needs to be described as "flat" would
 * silently vanish from the leaderboard. It is drawn as a centred rule instead.
 *
 * ## Why the fill is clipped rather than closed
 *
 * The area under the line is a second path that drops to the baseline and closes. Drawing it as
 * one filled path with the stroke on top would stroke the vertical drops at both ends too — two
 * bright verticals framing every trace, which is what makes a small chart look like a bar rather
 * than a line.
 */

/** Viewbox units. The component is rendered at whatever CSS size its container gives it. */
const W = 120;
const H = 36;
/** Kept clear of the top and bottom edges so the stroke's own width never clips. */
const PAD = 3;

export function Sparkline({
  values,
  /** Tints the trace to match the row's direction. Defaults to the brand green. */
  positive = true,
  className,
}: {
  values: number[];
  positive?: boolean;
  className?: string;
}) {
  if (!values.length) return null;

  const stroke = positive ? "var(--doku)" : "var(--loss)";

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;

  const x = (i: number) => (values.length === 1 ? W / 2 : (i / (values.length - 1)) * W);
  /*
   * SVG's y axis points down, so the subtraction from `H - PAD` is what puts a rising price at the
   * top of the box rather than the bottom. Getting this backwards produces a chart that is exactly
   * wrong rather than obviously broken, which is the kind that ships.
   */
  const y = (v: number) => (range === 0 ? H / 2 : H - PAD - ((v - min) / range) * (H - PAD * 2));

  const points = values.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`);
  const line = `M${points.join("L")}`;
  const area = `${line}L${W},${H}L0,${H}Z`;

  // Unique per instance: four of these render side by side, and SVG ids are document-global — a
  // shared id means all four rows draw the first row's gradient.
  const id = `spark-${Math.abs(hash(values.join(","))).toString(36)}`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={className}
      aria-hidden
      focusable="false"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/**
 * A stable id from the series itself.
 *
 * Not `Math.random()`: this renders on the server and again on the client, and an id that differs
 * between the two is a hydration mismatch on every row.
 */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

export default Sparkline;
