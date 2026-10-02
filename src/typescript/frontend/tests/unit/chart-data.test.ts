/**
 * @jest-environment node
 */
import {
  allWindowSecs,
  axisDigits,
  axisPadRight,
  captionFor,
  displayScale,
  fillBuckets,
  flattenForLine,
  formatAxisPrice,
  formatPrice,
  formatTimeFor,
  packCandles,
  packedAxis,
  plotWindowSecs,
  rangeForWindow,
  rangeIndexContaining,
  RANGES,
  resolveRange,
  rowsToCandles,
  tinyPriceParts,
  windowSecsFor,
  windowsFor,
  withOpeningBucket,
} from "../../src/components/charts/chart-data";

const row = (iso: string, o: number, h: number, l: number, c: number) => ({
  bucketStart: iso,
  open: o,
  high: h,
  low: l,
  close: c,
  volumeQuote: "0",
  tradeCount: 1,
});

describe("rows to candles", () => {
  it("splits the last bucket off as the live candle and keeps the closes as ticks", () => {
    const out = rowsToCandles([
      row("2026-09-17T10:00:00Z", 1, 2, 0.5, 1.5),
      row("2026-09-17T10:15:00Z", 1.5, 1.8, 1.4, 1.6),
      row("2026-09-17T10:30:00Z", 1.6, 1.7, 1.2, 1.3),
    ]);
    expect(out.candles).toHaveLength(2);
    expect(out.liveCandle).toEqual({ time: Date.UTC(2026, 8, 17, 10, 30) / 1000, open: 1.6, high: 1.7, low: 1.2, close: 1.3 });
    expect(out.ticks.map((t) => t.value)).toEqual([1.5, 1.6, 1.3]);
    expect(out.value).toBe(1.3);
  });

  it("sorts by time, dedupes a repeated bucket, drops a row without a close", () => {
    const out = rowsToCandles([
      row("2026-09-17T10:15:00Z", 1, 1, 1, 2),
      row("2026-09-17T10:00:00Z", 1, 1, 1, 1),
      row("2026-09-17T10:15:00Z", 1, 1, 1, 3),
      row("2026-09-17T10:30:00Z", 1, 1, 1, 0),
    ]);
    expect(out.ticks.map((t) => t.value)).toEqual([1, 3]);
  });

  it("falls back to open and close when high or low is missing, and never contradicts them", () => {
    const out = rowsToCandles([row("2026-09-17T10:00:00Z", 2, Number.NaN, 0, 1)]);
    expect(out.liveCandle).toEqual({ time: Date.UTC(2026, 8, 17, 10, 0) / 1000, open: 2, high: 2, low: 1, close: 1 });
    expect(out.candles).toHaveLength(0);
  });

  it("is empty on no rows", () => {
    expect(rowsToCandles([])).toEqual({ candles: [], liveCandle: undefined, ticks: [], value: 0 });
  });
});

describe("windows", () => {
  const now = 1_800_000_000;
  it("lists one button per range, ALL sized to the market's age", () => {
    const w = windowsFor(now - 5 * 86400, now);
    expect(w.map((x) => x.label)).toEqual(["1M", "15M", "1H", "4M", "ALL"]);
    expect(w.map((x) => x.secs)).toEqual([3600, 86400, 604800, 2592000, 5 * 86400]);
  });

  it("floors ALL to an hour on a brand-new market and to thirty days when the age is unknown", () => {
    expect(windowSecsFor(RANGES[4], now - 10, now)).toBe(3600);
    expect(windowSecsFor(RANGES[4], undefined, now)).toBe(30 * 86400);
  });

  it("maps a chosen window back to its range", () => {
    expect(rangeForWindow(86400, now - 5 * 86400, now)).toBe(1);
    expect(rangeForWindow(5 * 86400, now - 5 * 86400, now)).toBe(4);
  });

  it("ALL picks a bucket from the market's age", () => {
    expect(resolveRange(RANGES[4], now - 3 * 3600, now)).toEqual({ period: 60, limit: 181 });
    expect(resolveRange(RANGES[4], now - 90 * 86400, now).period).toBe(86400);
    expect(resolveRange(RANGES[1], now)).toEqual({ period: 900, limit: 96 });
  });
});

describe("time labels", () => {
  it("print a clock inside a day and a date beyond it", () => {
    const t = Date.UTC(2026, 8, 17, 10, 5) / 1000;
    expect(formatTimeFor(RANGES[0])(t)).toMatch(/\d{1,2}:\d{2}/);
    expect(formatTimeFor(RANGES[3])(t)).toMatch(/Sep/);
  });

  it("follow the window actually shown, not the range's nominal one", () => {
    // The 1H range nominally shows a week, but on a market twenty hours old it shows twenty
    // hours, and the library rules that window by the hour — so the labels are clocks.
    const t = Date.UTC(2026, 8, 17, 10, 5) / 1000;
    expect(formatTimeFor(RANGES[2], 20 * 3600)(t)).toMatch(/\d{1,2}:\d{2}/);
    expect(formatTimeFor(RANGES[2], 26 * 3600)(t)).toMatch(/Sep/);
  });
});

const candle = (time: number, open: number, close: number, high = Math.max(open, close), low = Math.min(open, close)) => ({
  time,
  open,
  high,
  low,
  close,
});

describe("display scale", () => {
  it("lands the largest value in [100, 1000) and divides back out exactly", () => {
    expect(displayScale([3.7e-11, 3.6e-11])).toBe(1e13);
    expect(3.7e-11 * displayScale([3.7e-11])).toBeCloseTo(370, 6);
    expect(displayScale([4.72e-8])).toBe(1e10);
    expect(displayScale([250])).toBe(1);
    expect(displayScale([2500])).toBe(0.1);
  });

  it("is one when there is nothing positive to scale", () => {
    expect(displayScale([])).toBe(1);
    expect(displayScale([0, Number.NaN, -1])).toBe(1);
  });
});

describe("ALL window", () => {
  const now = 1_800_000_000;
  it("reaches back to the earlier of launch and the first bucket, plus one bucket", () => {
    expect(allWindowSecs(now - 5000, now - 4000, 900, now)).toBe(5900);
    expect(allWindowSecs(now - 4000, now - 5000, 900, now)).toBe(5900);
    expect(allWindowSecs(undefined, now - 5000, 60, now)).toBe(5060);
  });
  it("floors at an hour and falls back to thirty days when nothing dates the market", () => {
    expect(allWindowSecs(now - 10, undefined, 60, now)).toBe(3600);
    expect(allWindowSecs(undefined, undefined, 60, now)).toBe(30 * 86400);
  });
});

describe("plot window", () => {
  const now = 1_800_000_000;
  /**
   * The market in the screenshot: launched twenty-six hours ago, one violent hour, flat since.
   * On the 1H range the plot showed a week, with the market's whole life in the rightmost sixth
   * and six empty days to its left.
   */
  const launched = now - 26 * 3600;
  it("never shows more than the market's life, on any range", () => {
    expect(plotWindowSecs(RANGES[2], launched, launched, 3600, now)).toBe(27 * 3600);
    expect(plotWindowSecs(RANGES[3], launched, launched, 14400, now)).toBe(26 * 3600 + 14400);
  });
  it("keeps the range's own window on a market older than it", () => {
    const old = now - 30 * 86400;
    expect(plotWindowSecs(RANGES[2], old, old, 3600, now)).toBe(604800);
    expect(plotWindowSecs(RANGES[1], old, old, 900, now)).toBe(86400);
  });
  it("reaches back to the first bucket when that is earlier than launch", () => {
    expect(plotWindowSecs(RANGES[2], now - 5000, now - 9000, 3600, now)).toBe(9000 + 3600);
  });
  it("is the market's life on ALL, floored at an hour, and the range's when nothing dates it", () => {
    expect(plotWindowSecs(RANGES[4], launched, launched, 900, now)).toBe(26 * 3600 + 900);
    expect(plotWindowSecs(RANGES[1], now - 10, now - 10, 60, now)).toBe(3600);
    expect(plotWindowSecs(RANGES[2], undefined, undefined, 3600, now)).toBe(604800);
  });
  it("says so in the caption when the window is the market's life", () => {
    expect(captionFor(RANGES[2], 27 * 3600)).toBe("Since launch");
    expect(captionFor(RANGES[2], 604800)).toBe("Last 7 days");
    expect(captionFor(RANGES[4], 27 * 3600)).toBe("All time");
  });
});

describe("candles for the line", () => {
  /**
   * The library sizes its vertical range from candle highs and lows even in line mode, while the
   * line itself is drawn through closes. One bucket that spiked to 2.76e-3 inside a minute and
   * closed at 9e-4 put the whole line, never above 3.4e-4, in the bottom tenth of the plot.
   */
  it("collapses every bucket onto its close, so the range fits what the line draws", () => {
    const out = flattenForLine([candle(0, 1.0e-4, 9.0e-4, 2.76e-3, 7.0e-4), candle(60, 9.0e-4, 7.0e-5, 9.5e-4, 6.0e-5)]);
    expect(out).toEqual([
      { time: 0, open: 9.0e-4, high: 9.0e-4, low: 9.0e-4, close: 9.0e-4 },
      { time: 60, open: 7.0e-5, high: 7.0e-5, low: 7.0e-5, close: 7.0e-5 },
    ]);
  });
  it("passes an empty series through", () => {
    expect(flattenForLine([])).toEqual([]);
  });
});

describe("first range", () => {
  const now = 1_800_000_000;
  it("is the smallest range whose window still holds the last trade", () => {
    expect(rangeIndexContaining(now - 600, now)).toBe(0);
    expect(rangeIndexContaining(now - 7200, now)).toBe(1);
    expect(rangeIndexContaining(now - 3 * 86400, now)).toBe(2);
    expect(rangeIndexContaining(now - 20 * 86400, now)).toBe(3);
    expect(rangeIndexContaining(now - 90 * 86400, now)).toBe(4);
  });
  it("is ALL when there is no trade to hold", () => {
    expect(rangeIndexContaining(undefined, now)).toBe(4);
  });
});

describe("opening bucket", () => {
  it("prepends a flat bucket at the open of a lone candle, at launch when launch is earlier", () => {
    const only = candle(1000, 2, 5);
    const out = withOpeningBucket([], only, 400, 100);
    expect(out.candles).toEqual([candle(400, 2, 2)]);
    expect(out.live).toBe(only);
  });
  it("uses one period earlier when launch is not before the candle", () => {
    const out = withOpeningBucket([], candle(1000, 2, 5), 1200, 100);
    expect(out.candles[0].time).toBe(900);
    expect(withOpeningBucket([], candle(1000, 2, 5), undefined, 100).candles[0].time).toBe(900);
  });
  it("leaves two or more buckets, and nothing, alone", () => {
    const two = [candle(900, 1, 2)];
    const live = candle(1000, 2, 3);
    expect(withOpeningBucket(two, live, 100, 100)).toEqual({ candles: two, live });
    expect(withOpeningBucket([], undefined, 100, 100)).toEqual({ candles: [], live: undefined });
  });
});

describe("dense buckets", () => {
  it("carries the previous close flat through quiet buckets up to now", () => {
    const out = fillBuckets([candle(1000, 1, 2), candle(1300, 2, 4)], 100, 1000, 1550);
    expect(out.map((c) => c.time)).toEqual([1000, 1100, 1200, 1300, 1400, 1500]);
    expect(out.map((c) => c.close)).toEqual([2, 2, 2, 4, 4, 4]);
    expect(out[1]).toEqual(candle(1100, 2, 2));
    expect(out[3]).toEqual(candle(1300, 2, 4));
  });
  it("starts at the first bucket when the market is younger than the window", () => {
    const out = fillBuckets([candle(1000, 1, 2)], 100, 0, 1250);
    expect(out.map((c) => c.time)).toEqual([1000, 1100, 1200]);
  });
  it("starts at the window and carries the last close before it when the market is older", () => {
    const out = fillBuckets([candle(100, 1, 7), candle(1300, 7, 9)], 100, 1000, 1350);
    expect(out.map((c) => c.time)).toEqual([1000, 1100, 1200, 1300]);
    expect(out.map((c) => c.close)).toEqual([7, 7, 7, 9]);
  });
  it("snaps an off-grid time onto its bucket and caps the run", () => {
    const out = fillBuckets([candle(1030, 1, 2)], 100, 0, 100_000, 5);
    expect(out).toHaveLength(5);
    expect(out[0].time).toBe(1000);
  });
  it("passes an empty series through", () => {
    expect(fillBuckets([], 100, 0, 1000)).toEqual([]);
  });
});

describe("axis prices", () => {
  it("counts a tiny price's zeros in subscript and keeps four digits", () => {
    expect(formatAxisPrice(3.736e-11)).toBe("0.0\u2081\u20803736");
    expect(formatAxisPrice(4.72e-8)).toBe("0.0\u20874720");
    expect(formatAxisPrice(-4.72e-8)).toBe("-0.0\u20874720");
  });
  it("rounds across a decade without lying about the zeros", () => {
    expect(formatAxisPrice(9.9996e-8)).toBe("0.0\u20861000");
  });
  it("leaves ordinary prices to the full format", () => {
    expect(formatAxisPrice(0.00123)).toBe(formatPrice(0.00123));
    expect(formatAxisPrice(12.5)).toBe("12.5000");
    expect(formatAxisPrice(0)).toBe("0");
    expect(formatAxisPrice(Number.NaN)).toBe("0");
  });
  it("sizes the plot's right padding to the widest label, never below the default", () => {
    expect(axisPadRight(undefined, undefined)).toBe(54);
    expect(axisPadRight(3e-11, 4e-11)).toBe(Math.ceil(16 + 10 * 6.8));
    expect(axisPadRight(1, 2)).toBe(Math.max(54, Math.ceil(16 + 7 * 6.8)));
  });
});

describe("readout parts", () => {
  it("splits a tiny price into its zeros and digits, and leaves an ordinary one whole", () => {
    expect(tinyPriceParts(3.736e-11)).toEqual({ zeros: 10, digits: "3736", negative: false });
    expect(tinyPriceParts(-4.72e-8)).toEqual({ zeros: 7, digits: "4720", negative: true });
    expect(tinyPriceParts(9.9996e-8)).toEqual({ zeros: 6, digits: "1000", negative: false });
    expect(tinyPriceParts(0.0123)).toEqual({ text: formatPrice(0.0123) });
    expect(tinyPriceParts(0)).toEqual({ text: "0" });
  });
});

describe("axis digits", () => {
  it("prints enough digits to tell a tenth of the range apart, within four and eight", () => {
    expect(axisDigits(3.736e-11, 3.738e-11)).toBe(5);
    expect(formatAxisPrice(3.7365e-11, 5)).toBe("0.0\u2081\u208037365");
    expect(axisDigits(1, 2)).toBe(4);
    expect(axisDigits(1, 1.000000001)).toBe(8);
    expect(axisDigits(undefined, 2)).toBe(4);
    expect(axisDigits(2, 2)).toBe(4);
  });
  it("widens the padding with the digits", () => {
    expect(axisPadRight(3.736e-11, 3.738e-11)).toBe(Math.ceil(16 + 11 * 6.8));
  });
});

describe("packed candles", () => {
  const now = 10_000;
  it("lays traded buckets side by side ending at the current bucket, and maps the stand-ins back", () => {
    const out = packCandles([candle(1000, 1, 2), candle(5000, 2, 3)], undefined, 100, now);
    expect(out.live).toEqual({ ...candle(10000, 3, 3), time: 10000 });
    expect(out.candles.map((c) => c.time)).toEqual([9800, 9900]);
    expect(out.realTimeOf(9800)).toBe(1000);
    expect(out.realTimeOf(9900)).toBe(5000);
    expect(out.realTimeOf(10000)).toBe(10000);
    expect(out.realTimeOf(9700)).toBeUndefined();
    expect(out.realTimeOf(9840)).toBe(1000);
    expect(out.windowSecs).toBe(24 * 100);
  });
  it("keeps a live candle that is already the current bucket as the last bar", () => {
    const out = packCandles([candle(9800, 1, 1.5), candle(9900, 1, 2)], candle(10000, 2, 4), 100, now);
    expect(out.live).toEqual(candle(10000, 2, 4));
    expect(out.candles).toEqual([candle(9800, 1, 1.5), candle(9900, 1, 2)]);
    expect(out.bars).toEqual([
      { fake: 9800, real: 9800 },
      { fake: 9900, real: 9900 },
      { fake: 10000, real: 10000 },
    ]);
  });
  it("puts a flat bar at the open in front of fewer than two committed bars, so one trade still draws", () => {
    const out = packCandles([], candle(10000, 2, 4), 100, now);
    expect(out.candles).toEqual([candle(9900, 2, 2)]);
    expect(out.live).toEqual(candle(10000, 2, 4));
    const old = packCandles([], candle(5000, 2, 4), 100, now);
    expect(old.candles).toEqual([candle(9800, 2, 2), candle(9900, 2, 4)]);
    expect(old.live).toEqual(candle(10000, 4, 4));
    expect(old.realTimeOf(9800)).toBe(4900);
    expect(old.realTimeOf(9900)).toBe(5000);
  });
  it("labels the last bar and every step back from it, placed where the library draws the bar", () => {
    const bars = [
      { fake: 9800, real: 1 },
      { fake: 9900, real: 2 },
      { fake: 10000, real: 3 },
    ];
    // 48 slots across 4800 px: 100 px a slot, wider than a label, so every bar gets one.
    const axis = packedAxis(bars, 100, 4800, now, 4800);
    expect(axis.map((a) => a.real)).toEqual([1, 2, 3]);
    const rightEdge = now + 4800 * 0.015;
    expect(axis[2].frac).toBeCloseTo((10000 + 50 - (rightEdge - 4800)) / 4800, 9);
    // 48 slots across 600 px: 12.5 px a slot, so a label every seventh bar, counted from the last.
    const many = Array.from({ length: 20 }, (_, i) => ({ fake: 8100 + i * 100, real: i }));
    expect(packedAxis(many, 100, 4800, now, 600).map((a) => a.real)).toEqual([5, 12, 19]);
    expect(packedAxis([], 100, 4800, now, 600)).toEqual([]);
  });
  it("widens the window past the minimum when there are more bars than slots", () => {
    const many = Array.from({ length: 60 }, (_, i) => candle(i * 100, 1, 1));
    expect(packCandles(many, undefined, 100, now).windowSecs).toBe(63 * 100);
  });
  it("is empty on nothing", () => {
    const out = packCandles([], undefined, 100, now);
    expect(out.candles).toEqual([]);
    expect(out.live).toBeUndefined();
  });
});
