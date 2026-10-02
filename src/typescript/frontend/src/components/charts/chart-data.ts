/**
 * The market chart's data path, shared by every chart component: which windows are offered, what
 * each asks the candlestick service for, how a row becomes a candle or a tick, and how prices and
 * times are printed.
 */

/** What `/api/candlesticks` returns, already unscaled from fixed point. */
export type CandlestickResponse = {
  bucketStart: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeQuote: string;
  tradeCount: number;
};

/** One OHLC bucket in unix seconds, the shape the chart library draws. */
export type Candle = { time: number; open: number; high: number; low: number; close: number };
/** One close in unix seconds. */
export type Tick = { time: number; value: number };

/**
 * Ranges offered, as a bucket period, how many buckets back to ask for, the window in seconds the
 * chart shows, and what the window is called in words. `period: null` on ALL means work it out
 * from the market's age; `secs: null` likewise.
 */
export const RANGES = [
  { label: "1M", period: 60, limit: 60, secs: 3600, caption: "Last hour" },
  { label: "15M", period: 900, limit: 96, secs: 86400, caption: "Last 24 hours" },
  { label: "1H", period: 3600, limit: 168, secs: 604800, caption: "Last 7 days" },
  { label: "4M", period: 14400, limit: 180, secs: 2592000, caption: "Last 30 days" },
  { label: "ALL", period: null, limit: 0, secs: null, caption: "All time" },
] as const;

export type Range = (typeof RANGES)[number];

/** The bucket sizes the candlestick service aggregates to, smallest first. */
export const PERIODS = [60, 900, 3600, 14400, 86400] as const;

const TARGET_BUCKETS = 180;
const MAX_BUCKETS = 400;
/** What ALL shows when the market's age is unknown. */
const FALLBACK_ALL_SECS = 30 * 86400;

/**
 * What a range asks the service for. ALL picks a bucket from the market's age, aiming for about
 * 180 buckets over its whole life, never finer than a minute or coarser than a day.
 */
export const resolveRange = (
  range: Range,
  launchedAt?: number,
  now: number = Math.floor(Date.now() / 1000)
): { period: number; limit: number } => {
  if (range.period !== null) return { period: range.period, limit: range.limit };
  if (!launchedAt || !Number.isFinite(launchedAt)) return { period: 86400, limit: 365 };
  const ageSeconds = Math.max(60, now - launchedAt);
  const wanted = ageSeconds / TARGET_BUCKETS;
  const period = PERIODS.find((p) => p >= wanted) ?? 86400;
  // One extra bucket so the window reaches past the launch rather than stopping a bucket short.
  const limit = Math.min(MAX_BUCKETS, Math.max(2, Math.ceil(ageSeconds / period) + 1));
  return { period, limit };
};

/** The seconds a range shows. ALL is the market's age, with a floor so a new market is not a sliver. */
export const windowSecsFor = (
  range: Range,
  launchedAt?: number,
  now: number = Math.floor(Date.now() / 1000)
): number => {
  if (range.secs !== null) return range.secs;
  if (!launchedAt || !Number.isFinite(launchedAt)) return FALLBACK_ALL_SECS;
  return Math.max(3600, now - launchedAt);
};

/** The window buttons the chart library renders, one per range. */
export const windowsFor = (launchedAt?: number, now?: number): { label: string; secs: number }[] =>
  RANGES.map((r) => ({ label: r.label, secs: windowSecsFor(r, launchedAt, now) }));

/** The range whose window is `secs`, or the closest one. */
export const rangeForWindow = (secs: number, launchedAt?: number, now?: number): number => {
  let best = 0;
  let bestDist = Infinity;
  RANGES.forEach((r, i) => {
    const d = Math.abs(windowSecsFor(r, launchedAt, now) - secs);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
};

/**
 * Rows to what the chart draws. Deduped by bucket and sorted by time; a row without a positive
 * close is dropped; a missing high or low falls back to the wider of open and close. The last
 * bucket is the live candle, the rest are committed.
 */
export function rowsToCandles(rows: CandlestickResponse[]): {
  candles: Candle[];
  liveCandle: Candle | undefined;
  ticks: Tick[];
  value: number;
} {
  const byTime = new Map<number, Candle>();
  for (const r of rows) {
    const time = Math.floor(new Date(r.bucketStart).getTime() / 1000);
    if (!Number.isFinite(time) || !Number.isFinite(r.close) || r.close <= 0) continue;
    const open = Number.isFinite(r.open) && r.open > 0 ? r.open : r.close;
    const high = Number.isFinite(r.high) && r.high > 0 ? Math.max(r.high, open, r.close) : Math.max(open, r.close);
    const low = Number.isFinite(r.low) && r.low > 0 ? Math.min(r.low, open, r.close) : Math.min(open, r.close);
    byTime.set(time, { time, open, high, low, close: r.close });
  }
  const all = [...byTime.values()].sort((a, b) => a.time - b.time);
  const liveCandle = all[all.length - 1];
  return {
    candles: all.slice(0, -1),
    liveCandle,
    ticks: all.map((c) => ({ time: c.time, value: c.close })),
    value: liveCandle?.close ?? 0,
  };
}

/** Enough significant digits to be meaningful on a token that trades at 1e-7. */
export const formatPrice = (v: number) => {
  if (!Number.isFinite(v) || v === 0) return "0";
  if (v >= 1) return v.toFixed(4);
  const exp = Math.floor(Math.log10(Math.abs(v)));
  return v.toFixed(Math.min(18, Math.max(4, -exp + 3)));
};

const SUBSCRIPT_DIGITS = "\u2080\u2081\u2082\u2083\u2084\u2085\u2086\u2087\u2088\u2089";

/**
 * The axis form of a price: a tiny one is written with its run of zeros counted in subscript,
 * `0.0\u2081\u20803736` for 3.736e-11, the notation every terminal uses for sub-cent tokens. The
 * readout above the plot keeps the full number; the axis has a few dozen pixels per label.
 */
export const formatAxisPrice = (v: number, sig = 4): string => {
  if (!Number.isFinite(v) || v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1e-4) return formatPrice(v);
  const exp = Math.floor(Math.log10(abs));
  let zeros = -exp - 1;
  let digits = String(Math.round((abs / 10 ** exp) * 10 ** (sig - 1)));
  if (digits.length > sig) {
    // 9.9996e-8 rounds up to 1.000e-7: one fewer zero, and the digits are a plain one.
    digits = "1".padEnd(sig, "0");
    zeros -= 1;
  }
  const sub = String(zeros).replace(/\d/g, (d) => SUBSCRIPT_DIGITS[Number(d)]);
  return `${v < 0 ? "-" : ""}0.0${sub}${digits}`;
};

/**
 * The parts of a price for a DOM readout: a tiny one is split into its `0.0`, the count of zeros
 * to set in subscript, and the four digits that follow, so the count can be a real `<sub>` in the
 * app's own numeric face rather than a Unicode subscript glyph it may not carry. An ordinary price
 * is one plain string.
 */
export const tinyPriceParts = (v: number): { text: string } | { zeros: number; digits: string; negative: boolean } => {
  if (!Number.isFinite(v) || v === 0 || Math.abs(v) >= 1e-4) return { text: formatPrice(v) };
  const abs = Math.abs(v);
  const exp = Math.floor(Math.log10(abs));
  let zeros = -exp - 1;
  let digits = String(Math.round((abs / 10 ** exp) * 1000));
  if (digits.length > 4) {
    digits = "1000";
    zeros -= 1;
  }
  return { zeros, digits, negative: v < 0 };
};

/**
 * How many significant digits the axis needs so that neighbouring rulings read differently.
 *
 * A market that moved 0.04% in a day has a ruling every 0.005% of its price; four digits print
 * the same label on every line. Enough digits to tell a tenth of the range apart, never fewer
 * than four nor more than eight.
 */
export const axisDigits = (lo: number | undefined, hi: number | undefined): number => {
  if (lo === undefined || hi === undefined || !(hi > 0) || !(hi > lo)) return 4;
  const step = (hi - lo) / 10;
  return Math.min(8, Math.max(4, Math.ceil(Math.log10(hi / step))));
};

/** Canvas pixels per character of the chart library's 11 px monospace label font, with slack. */
const AXIS_CHAR_PX = 6.8;

/**
 * The right padding the plot needs for its labels. The library draws each label into the
 * padding without measuring it, so a price wider than the default is cut off at the canvas
 * edge; this sizes the padding to the widest label the visible range can produce.
 */
export const axisPadRight = (lo: number | undefined, hi: number | undefined, minimum = 54): number => {
  const sig = axisDigits(lo, hi);
  const chars = Math.max(
    lo !== undefined ? formatAxisPrice(lo, sig).length : 0,
    hi !== undefined ? formatAxisPrice(hi, sig).length : 0
  );
  if (chars === 0) return minimum;
  return Math.max(minimum, Math.ceil(16 + (chars + 1) * AXIS_CHAR_PX));
};

/** A point in time on the chart, in UTC — the zone the trade feed and every explorer use. */
export const formatWhen = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString("en-GB", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });

/**
 * The time axis: a clock inside a day, a date beyond it. UTC, like `formatWhen`.
 *
 * Keyed on the window the plot actually shows when one is given, because a range's nominal window
 * is clamped to the market's life (see `plotWindowSecs`): the 1H range on a market twenty hours
 * old shows twenty hours, and the library rules a window that short by the hour, so the labels
 * have to be clocks or every ruling reads the same date.
 */
export const formatTimeFor =
  (range: Range, windowSecs?: number) =>
  (seconds: number): string => {
    const d = new Date(seconds * 1000);
    const secs = windowSecs ?? range.secs;
    if (secs !== null && secs <= 86400) {
      return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
    }
    return d.toLocaleDateString("en-GB", { month: "short", day: "numeric", timeZone: "UTC" });
  };

/**
 * A multiplier that brings a price series into a magnitude a canvas chart can rasterise.
 *
 * Curve prices on an 18-decimal token quoted in bitcoin sit around 1e-11; a chart that reserves
 * an epsilon for "flat" (a sensible 1e-9 or so) sees such a series as a horizontal nothing and
 * draws its empty state. Every value handed to the chart is multiplied by this, and every label
 * divides it back out, so the reader sees the real number and the chart sees hundreds.
 */
export const displayScale = (values: number[]): number => {
  let max = 0;
  for (const v of values) if (Number.isFinite(v) && v > max) max = v;
  if (max <= 0) return 1;
  // Land the largest value in [100, 1000).
  return 10 ** (2 - Math.floor(Math.log10(max)));
};

/** The ALL window, wide enough to include the first bucket the chart has, plus one bucket. */
export const allWindowSecs = (
  launchedAt: number | undefined,
  firstTime: number | undefined,
  period: number,
  now: number = Math.floor(Date.now() / 1000)
): number => {
  const start = Math.min(
    launchedAt && Number.isFinite(launchedAt) ? launchedAt : Number.POSITIVE_INFINITY,
    firstTime && Number.isFinite(firstTime) ? firstTime : Number.POSITIVE_INFINITY
  );
  if (!Number.isFinite(start)) return FALLBACK_ALL_SECS;
  return Math.max(3600, now - start + period);
};

/**
 * The window the plot shows for a range: the range's own, or the market's life when that is
 * shorter.
 *
 * Every range but ALL used to show its nominal window whatever the market's age. On a market a
 * day old the 1H range drew a week: the market's whole life in the rightmost sixth of the plot
 * and six empty days to its left, and the 4M range drew a month, with the life in a sliver. No
 * range shows more than the market has lived; the range still chooses the bucket size.
 */
export const plotWindowSecs = (
  range: Range,
  launchedAt: number | undefined,
  firstTime: number | undefined,
  period: number,
  now: number = Math.floor(Date.now() / 1000)
): number => {
  const life = allWindowSecs(launchedAt, firstTime, period, now);
  if (range.secs === null) return life;
  // Nothing dates the market: the life is a fallback, not a measurement, so the range wins.
  if ((!launchedAt || !Number.isFinite(launchedAt)) && (!firstTime || !Number.isFinite(firstTime))) return range.secs;
  return Math.min(range.secs, life);
};

/** What the summary line calls the window: the range's own words, or the truth when clamped. */
export const captionFor = (range: Range, windowSecs: number): string =>
  range.secs !== null && windowSecs < range.secs ? "Since launch" : range.caption;

/** The smallest range whose window still contains `lastTime`; ALL when none does. */
export const rangeIndexContaining = (
  lastTime: number | undefined,
  now: number = Math.floor(Date.now() / 1000)
): number => {
  if (!lastTime || !Number.isFinite(lastTime)) return RANGES.length - 1;
  const age = now - lastTime;
  const i = RANGES.findIndex((r) => r.secs !== null && r.secs >= age);
  return i === -1 ? RANGES.length - 1 : i;
};

/**
 * A chart needs two buckets to draw anything. A market with a single traded bucket still has a
 * first price: the price it opened at, which is that bucket's open. This prepends a flat bucket at
 * launch (or one period earlier) so a one-trade market draws a line from its open to its trade.
 */
export const withOpeningBucket = <C extends { time: number; open: number; high: number; low: number; close: number }>(
  candles: C[],
  live: C | undefined,
  launchedAt: number | undefined,
  period: number
): { candles: C[]; live: C | undefined } => {
  const count = candles.length + (live ? 1 : 0);
  const first = candles[0] ?? live;
  if (count >= 2 || !first) return { candles, live };
  const at = launchedAt && Number.isFinite(launchedAt) && launchedAt < first.time ? launchedAt : first.time - period;
  const opening = { ...first, time: at, open: first.open, high: first.open, low: first.open, close: first.open } as C;
  return { candles: [opening, ...candles], live };
};

/**
 * A dense series for the chart: one bucket per `period` from the start of the window to now,
 * with quiet buckets carried flat at the previous close.
 *
 * The candlestick service returns only buckets that traded. A window with one trade is one
 * point, and a chart cannot draw one point; a price does not vanish between trades either.
 * The carry starts from the last close before the window, or the first bucket's open when the
 * market is younger than the window. Capped so a long ALL window on a fine period stays sane.
 */
export const fillBuckets = <C extends { time: number; open: number; high: number; low: number; close: number }>(
  candles: C[],
  period: number,
  windowStart: number,
  now: number,
  maxBuckets = 2000
): C[] => {
  if (candles.length === 0 || period <= 0) return candles;
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const byTime = new Map<number, C>();
  for (const c of sorted) byTime.set(Math.floor(c.time / period) * period, c);
  let carry: number | undefined;
  for (const c of sorted) {
    if (c.time < windowStart) carry = c.close;
  }
  const firstAt = Math.floor(sorted[0].time / period) * period;
  let t = Math.max(Math.floor(windowStart / period) * period, carry === undefined ? firstAt : -Infinity);
  if (!Number.isFinite(t)) t = firstAt;
  const end = Math.floor(now / period) * period;
  if (carry === undefined) carry = sorted[0].open;
  const out: C[] = [];
  for (; t <= end && out.length < maxBuckets; t += period) {
    const hit = byTime.get(t);
    if (hit) {
      out.push({ ...hit, time: t });
      carry = hit.close;
    } else {
      out.push({ ...sorted[0], time: t, open: carry, high: carry, low: carry, close: carry } as C);
    }
  }
  return out;
};

/**
 * The buckets handed to the library in line mode, each collapsed onto its close.
 *
 * The library draws the line through closes but sizes its vertical range from candle highs and
 * lows, in line mode as in candle mode. A bucket that spiked to 2.76e-3 inside a minute and closed
 * at 9e-4 put a line that never rose above 3.4e-4 in the bottom tenth of the plot, flat against
 * the axis. With every bucket flattened to its close the range fits what is drawn; the readout
 * above the plot still reports the true high and low from the real buckets.
 */
export const flattenForLine = <C extends { time: number; open: number; high: number; low: number; close: number }>(
  candles: C[]
): C[] => candles.map((c) => ({ ...c, open: c.close, high: c.close, low: c.close }));

/**
 * Candle mode's layout: traded buckets side by side, not spread along a clock.
 *
 * A candle chart on a market that trades a few times a day cannot be drawn on a linear time axis:
 * the traded buckets are slivers days apart and the quiet ones between them, if drawn at all, are
 * flat dashes. Every charting terminal lays bars out by INDEX instead — one slot per traded bucket,
 * the axis irregular — and that is what this does. Each candle is given a stand-in time one period
 * apart ending at the current bucket, and `realTimeOf` turns a stand-in back into the bucket's
 * real time for the axis and the crosshair. A stand-in that falls before the first bar is nothing,
 * so the empty run left of a young market carries no labels.
 *
 * The last bar is always now: when the last traded bucket is older than the current one, a flat
 * bar at its close is appended, because the price has not moved since and the live mark belongs
 * on the right edge. A lone traded bucket gets a flat bar at its open in front of it, so a market
 * with one trade still draws its first move. The window is at least `minSlots` wide so a young
 * market's bars sit at the right, the way a fresh listing looks anywhere.
 */
export const packCandles = <C extends { time: number; open: number; high: number; low: number; close: number }>(
  candles: C[],
  live: C | undefined,
  period: number,
  now: number,
  minSlots = 24
): {
  candles: C[];
  live: C | undefined;
  windowSecs: number;
  realTimeOf: (fake: number) => number | undefined;
  bars: { fake: number; real: number }[];
} => {
  const sorted = [...candles, ...(live ? [live] : [])].sort((a, b) => a.time - b.time);
  const end = Math.floor(now / period) * period;
  if (sorted.length === 0 || period <= 0) {
    return { candles: [], live: undefined, windowSecs: minSlots * period, realTimeOf: () => undefined, bars: [] };
  }
  const last = sorted[sorted.length - 1];
  if (last.time < end) {
    sorted.push({ ...last, time: end, open: last.close, high: last.close, low: last.close, close: last.close });
  }
  // The library draws nothing under two committed bars, and the last bar here is the live one.
  if (sorted.length < 3) {
    const first = sorted[0];
    sorted.unshift({ ...first, time: first.time - period, open: first.open, high: first.open, low: first.open, close: first.open });
  }
  const n = sorted.length;
  const real = sorted.map((c) => c.time);
  const placed = sorted.map((c, i) => ({ ...c, time: end - (n - 1 - i) * period }));
  const realTimeOf = (fake: number) => {
    const idx = Math.round((fake - end) / period) + (n - 1);
    return idx >= 0 && idx < n ? real[idx] : undefined;
  };
  return {
    candles: placed.slice(0, -1),
    live: placed[n - 1],
    windowSecs: Math.max(minSlots, n + 2) * period,
    realTimeOf,
    bars: placed.map((c, i) => ({ fake: c.time, real: real[i] })),
  };
};

/**
 * Where a packed bar's label goes, as a fraction of the plot's width, and which bars get one.
 *
 * The library places a bar's centre at `time + width / 2` inside a window whose right edge is
 * `now + window * buffer`, so the same arithmetic puts a label under it. The last bar is always
 * labelled; the rest as often as a label's width allows, counted back from it, so none collide.
 */
export const packedAxis = (
  bars: { fake: number; real: number }[],
  period: number,
  windowSecs: number,
  now: number,
  /** The plot's width in pixels; labels are spaced so that none can touch its neighbour. */
  chartPx: number,
  labelPx = 84,
  buffer = 0.015
): { frac: number; real: number }[] => {
  if (bars.length === 0 || windowSecs <= 0 || period <= 0) return [];
  const rightEdge = now + windowSecs * buffer;
  const leftEdge = rightEdge - windowSecs;
  const slotPx = (chartPx * period) / windowSecs;
  const step = slotPx > 0 ? Math.max(1, Math.ceil(labelPx / slotPx)) : 1;
  const n = bars.length;
  return bars
    .map((b, i) => ({ frac: (b.fake + period / 2 - leftEdge) / windowSecs, real: b.real, i }))
    .filter(({ i }) => (n - 1 - i) % step === 0)
    .map(({ frac, real }) => ({ frac, real }));
};
