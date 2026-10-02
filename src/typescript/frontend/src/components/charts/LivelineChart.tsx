"use client";

import { cn } from "lib/utils/class-name";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  axisDigits,
  axisPadRight,
  type Candle,
  type CandlestickResponse,
  captionFor,
  displayScale,
  fillBuckets,
  flattenForLine,
  formatAxisPrice,
  formatPrice,
  formatTimeFor,
  formatWhen,
  packCandles,
  packedAxis,
  plotWindowSecs,
  rangeIndexContaining,
  RANGES,
  resolveRange,
  rowsToCandles,
  type Tick,
  tinyPriceParts,
  withOpeningBucket,
} from "@/components/charts/chart-data";
import { accentForStage } from "@/lib/hooks/doku/use-emoji-color";
import { useTheme } from "@/lib/theme/theme-context";

/**
 * The market chart: an instrument panel with one readout row on top and the plot filling
 * everything under it.
 *
 * The plot is `liveline` (benji.org/liveline), a canvas line and candlestick chart with a scrub
 * crosshair, an animated live candle and a live mark. Loaded on the client only, because it draws
 * a canvas.
 *
 * ## What is ours and what is the library's
 *
 * The library also ships a window bar and a line/candle bar, and neither is used. Its window bar
 * keeps its selection internally and ignores the `window` prop, so the plot would open on its
 * first entry whatever the page decided; its mode bar renders as a sibling above the canvas, in a
 * system font, outside any layout the page controls. The header here carries both controls, cut
 * from the same segmented tray as every other switch on the page, and the library receives only
 * `window` and `lineMode`.
 *
 * ## The plot's height
 *
 * The library's container carries an inline `position: relative; height: 100%`, which beats any
 * class on it — so a class meant to pin it to the plot box did nothing, and its `100%` resolved
 * against a flex item with no definite height, which is to say against nothing. The canvas ended
 * up a third of the box with dead panel under it. It now sits inside an absolutely positioned box
 * of ours, against which `100%` is a real number.
 */
const Liveline = dynamic(() => import("liveline").then((m) => m.Liveline), { ssr: false });

/** Line or candles, remembered per browser. Storage can be absent or throw; both mean line. */
const MODE_KEY = "doku.chart.mode";
const readLineMode = (): boolean => {
  try {
    return typeof window === "undefined" || window.localStorage.getItem(MODE_KEY) !== "candle";
  } catch {
    return true;
  }
};
const writeLineMode = (line: boolean) => {
  try {
    window.localStorage.setItem(MODE_KEY, line ? "line" : "candle");
  } catch {
    // The choice simply does not survive a reload.
  }
};

const POLL_MS = 15_000;

type Loaded = { candles: Candle[]; liveCandle: Candle | undefined; ticks: Tick[]; value: number };

/**
 * A price set for reading. A tiny one — every curve price on a bitcoin-quoted market — is written
 * `0.0₁₀3736` with the zero count as a true subscript, the notation every terminal uses, instead
 * of sixteen characters that force the row to wrap and that nobody can count.
 */
function Price({ value, className }: { value: number; className?: string }) {
  const parts = tinyPriceParts(value);
  if ("text" in parts) return <span className={className}>{parts.text}</span>;
  return (
    <span className={className} title={formatPrice(value)}>
      {parts.negative ? "-" : ""}0.0
      <sub className="relative top-[0.12em] mx-[0.04em] text-[0.5em] font-semibold leading-none text-mute">
        {parts.zeros}
      </sub>
      {parts.digits}
    </span>
  );
}

/** The mode keys' glyphs: a line and a pair of candles, drawn at the key's own size. */
const LineGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
    <path d="M1.5 10.5 4.75 6.25 7.75 8.5 12.5 2.75" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const CandleGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
    <path d="M4 1.5v2M4 10.5v2M10 1.5v1M10 9.5v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <rect x="2.25" y="3.5" width="3.5" height="7" rx="0.75" fill="currentColor" />
    <rect x="8.25" y="2.5" width="3.5" height="7" rx="0.75" fill="currentColor" />
  </svg>
);

export function LivelineChart({
  marketAddress,
  accent = "10,228,72",
  quoteSymbol = "MON",
  launchedAt,
  className,
}: {
  marketAddress: string;
  /** `r,g,b`; the market page passes the emoji's own colour. */
  accent?: string;
  quoteSymbol?: string;
  /** Unix seconds; ALL sizes its window and bucket from it. */
  launchedAt?: number;
  className?: string;
}) {
  const { theme } = useTheme();
  const lite = theme === "lite";
  const color = useMemo(() => `rgb(${accentForStage(accent, lite)})`, [accent, lite]);

  const [rangeIndex, setRangeIndex] = useState(1);
  const [lineMode, setLineMode] = useState(true);
  const [loaded, setLoaded] = useState<Loaded>({ candles: [], liveCandle: undefined, ticks: [], value: 0 });
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "error">("loading");
  // The plot box's width, for spacing the packed axis's labels. Zero until measured.
  const plotRef = useRef<HTMLDivElement>(null);
  const [plotWidth, setPlotWidth] = useState(0);
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setPlotWidth(w);
    });
    ro.observe(el);
    setPlotWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  const range = RANGES[rangeIndex];
  const { period, limit } = useMemo(() => resolveRange(range, launchedAt), [range, launchedAt]);
  const firstTime = loaded.ticks[0]?.time;
  // The range's window, or the market's life when that is shorter — see `plotWindowSecs`.
  const windowSecs = useMemo(
    () => plotWindowSecs(range, launchedAt, firstTime, period),
    [range, launchedAt, firstTime, period]
  );

  useEffect(() => {
    setLineMode(readLineMode());
  }, []);

  useEffect(() => {
    let cancelled = false;
    let first = true;
    const params = new URLSearchParams({ market: marketAddress, period: String(period), limit: String(limit) });
    const load = () => {
      if (first) setStatus("loading");
      fetch(`/api/candlesticks?${params.toString()}`)
        .then(async (res) => {
          if (!res.ok) throw new Error(await res.text());
          return (await res.json()) as CandlestickResponse[];
        })
        .then((rows) => {
          if (cancelled) return;
          const next = rowsToCandles(rows);
          setLoaded(next);
          setStatus(next.ticks.length === 0 ? "empty" : "ready");
        })
        .catch(() => {
          // A failed poll keeps what is on screen; only the first load reports an error.
          if (!cancelled && first) setStatus("error");
        })
        .finally(() => {
          first = false;
        });
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [marketAddress, period, limit]);

  const setMode = useCallback((line: boolean) => {
    setLineMode(line);
    writeLineMode(line);
  }, []);

  // The readout reads the real numbers, never the scaled ones the canvas is fed.
  const shown = loaded.liveCandle ? [...loaded.candles, loaded.liveCandle] : loaded.candles;
  const hi = shown.length ? Math.max(...shown.map((c) => c.high)) : undefined;
  const lo = shown.length ? Math.min(...shown.map((c) => c.low)) : undefined;
  // The plot's own labels are drawn into its right padding, so the padding has to fit them.
  const padRight = axisPadRight(lo, hi);
  const padLeft = 8;

  // The chart is handed scaled numbers (see `displayScale`); the labels divide them back out.
  const scale = useMemo(() => displayScale(loaded.ticks.map((t) => t.value)), [loaded.ticks]);
  /*
   * Two layouts, one per mode. The line is a clock: one point per period from the window's start
   * to now, quiet periods carried flat, so a two-trade day is a step and not a dot. The candles
   * are a shelf: traded buckets side by side with the axis made irregular to suit, so the same
   * two trades are two bars and not two slivers with a dotted line between — see `packCandles`.
   */
  const { ticks, candles, liveCandle, value, plotWindow, realTimeOf, axis } = useMemo(() => {
    const up = (v: number) => v * scale;
    const scaled = (c: Candle) => ({ time: c.time, open: up(c.open), high: up(c.high), low: up(c.low), close: up(c.close) });
    const now = Math.floor(Date.now() / 1000);
    if (lineMode) {
      const sparse = withOpeningBucket(loaded.candles, loaded.liveCandle, launchedAt, period);
      const dense = fillBuckets(
        sparse.live ? [...sparse.candles, sparse.live] : sparse.candles,
        period,
        now - windowSecs,
        now
      );
      // The line is drawn through closes; the library sizes its range from highs and lows even
      // now, so the buckets it is handed are collapsed onto their closes — see `flattenForLine`.
      const flat = flattenForLine(dense);
      const live = flat[flat.length - 1];
      return {
        ticks: flat.map((c) => ({ time: c.time, value: up(c.close) })),
        candles: flat.slice(0, -1).map(scaled),
        liveCandle: live ? scaled(live) : undefined,
        value: up(loaded.value),
        plotWindow: windowSecs,
        realTimeOf: undefined,
        axis: undefined,
      };
    }
    const packed = packCandles(loaded.candles, loaded.liveCandle, period, now);
    const all = packed.live ? [...packed.candles, packed.live] : packed.candles;
    return {
      ticks: all.map((c) => ({ time: c.time, value: up(c.close) })),
      candles: packed.candles.map(scaled),
      liveCandle: packed.live ? scaled(packed.live) : undefined,
      value: up(loaded.value),
      plotWindow: packed.windowSecs,
      realTimeOf: packed.realTimeOf,
      // The library's own axis cannot label a packed layout (its ticks fall between bars), so
      // the labels are drawn under the plot by hand, one per bar that gets one.
      axis: packedAxis(packed.bars, period, packed.windowSecs, now, Math.max(120, plotWidth - padLeft - padRight)),
    };
  }, [loaded, scale, launchedAt, period, windowSecs, lineMode, plotWidth, padRight]);
  // The line's labels follow the window shown; packed candles' follow the range, their axis
  // being irregular anyway.
  const formatTime = useCallback(
    (t: number) => {
      const real = realTimeOf ? realTimeOf(t) : t;
      return real === undefined ? "" : formatTimeFor(range, realTimeOf ? undefined : windowSecs)(real);
    },
    [realTimeOf, range, windowSecs]
  );

  // On the first load, open on the smallest range that still holds the last trade.
  const pickedRange = useRef(false);
  useEffect(() => {
    if (pickedRange.current || status !== "ready") return;
    pickedRange.current = true;
    const last = loaded.ticks[loaded.ticks.length - 1]?.time;
    setRangeIndex(rangeIndexContaining(last));
  }, [status, loaded.ticks]);

  const first = loaded.ticks[0]?.value;
  const last = loaded.ticks[loaded.ticks.length - 1]?.value;
  const changePct = first && last ? ((last - first) / first) * 100 : 0;
  const up = changePct >= 0;
  const hasSpan = loaded.ticks.length > 1;
  // The axis prints as many digits as its rulings need.
  const sig = axisDigits(lo, hi);
  const formatScaled = useCallback((v: number) => formatAxisPrice(v / scale, sig), [scale, sig]);
  // Packed candles carry their own axis under the plot, so the library's strip is folded away.
  const padding = useMemo(
    () => ({ right: padRight, top: 16, bottom: axis ? 0 : 30, left: padLeft }),
    [padRight, axis]
  );

  const keyClass =
    "doku-seg-key inline-flex h-7 items-center justify-center rounded-[8px] font-numeric text-[11px] font-semibold tracking-[0.04em]";

  return (
    <div className={cn("flex h-full w-full flex-col", className)}>
      {/* ---- The instrument row: price and its change left, both switches right ------------ */}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
          {last === undefined ? (
            <span className="font-numeric text-[28px] font-semibold leading-none tracking-[-0.02em] text-mute">—</span>
          ) : (
            <Price
              value={last}
              className="font-numeric text-[28px] font-semibold leading-none tracking-[-0.02em] text-ink tabular-nums"
            />
          )}
          <span className="font-numeric text-[11px] font-semibold uppercase leading-none tracking-[0.12em] text-mute">
            {quoteSymbol}
          </span>
          {hasSpan && (
            <span
              className={cn(
                "inline-flex h-5 items-center gap-1 self-center rounded-doku-pill px-1.5 font-numeric text-[11px] font-semibold leading-none tabular-nums",
                up ? "bg-doku/10 text-doku-ink" : "bg-loss/10 text-loss-ink"
              )}
            >
              {up ? "▲" : "▼"} {Math.abs(changePct).toFixed(2)}%
            </span>
          )}
        </div>

        {/* Both switches in one cluster, cut from the same tray as the page's other controls. */}
        <div className="flex shrink-0 items-center gap-1.5">
          <div role="group" aria-label="Range" className="doku-seg flex items-center gap-0.5 rounded-[11px] p-[3px]">
            {RANGES.map((r, i) => (
              <button
                key={r.label}
                type="button"
                onClick={() => setRangeIndex(i)}
                aria-pressed={i === rangeIndex}
                data-active={i === rangeIndex}
                className={cn(keyClass, "px-2.5")}
              >
                {r.label}
              </button>
            ))}
          </div>
          <div role="group" aria-label="Chart type" className="doku-seg flex items-center gap-0.5 rounded-[11px] p-[3px]">
            <button
              type="button"
              onClick={() => setMode(true)}
              aria-pressed={lineMode}
              aria-label="Line"
              title="Line"
              data-active={lineMode}
              className={cn(keyClass, "w-8")}
            >
              <LineGlyph />
            </button>
            <button
              type="button"
              onClick={() => setMode(false)}
              aria-pressed={!lineMode}
              aria-label="Candles"
              title="Candles"
              data-active={!lineMode}
              className={cn(keyClass, "w-8")}
            >
              <CandleGlyph />
            </button>
          </div>
        </div>
      </div>

      {/* ---- The summary line: what the window holds, in one quiet row ---------------------- */}
      <div className="mt-2.5 flex min-h-[14px] flex-wrap items-center gap-x-2.5 gap-y-1 font-numeric text-[11px] leading-none tabular-nums">
        <span className="uppercase tracking-[0.08em] text-mute">{captionFor(range, windowSecs)}</span>
        {hasSpan && hi !== undefined && lo !== undefined && (
          <>
            <span aria-hidden className="h-3 w-px bg-[var(--film-3)]" />
            <span className="inline-flex items-center gap-1 text-ash">
              <span className="text-faint">H</span>
              <Price value={hi} />
            </span>
            <span className="inline-flex items-center gap-1 text-ash">
              <span className="text-faint">L</span>
              <Price value={lo} />
            </span>
            <span aria-hidden className="hidden h-3 w-px bg-[var(--film-3)] sm:inline-block" />
            <span className="hidden text-faint sm:inline">since {formatWhen(loaded.ticks[0].time)} UTC</span>
          </>
        )}
      </div>

      {/* ---- The plot: everything under the row, on its own ruled stage --------------------- */}
      <div ref={plotRef} className="relative mt-3.5 min-h-[240px] flex-1 border-t border-solid border-[var(--film-1)]">
        <div className={cn("absolute inset-0", axis && "bottom-7")}>
          <Liveline
            mode="candle"
            data={ticks}
            value={value}
            candles={candles}
            candleWidth={period}
            liveCandle={liveCandle}
            lineMode={lineMode}
            lineData={ticks}
            lineValue={value}
            window={plotWindow}
            color={color}
            theme={lite ? "light" : "dark"}
            formatValue={formatScaled}
            formatTime={formatTime}
            padding={padding}
            grid
            scrub
            badge
            pulse
            momentum
            exaggerate
            showValue={false}
            loading={status === "loading"}
            emptyText={status === "error" ? "Price history unavailable" : "No trades yet"}
          />
        </div>
        {axis && axis.length > 0 && (
          <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-7">
            {axis.map(({ frac, real }) => (
              <span
                key={real}
                className="absolute top-2 -translate-x-1/2 whitespace-nowrap font-numeric text-[11px] leading-none tabular-nums text-faint"
                style={{ left: `calc(${padLeft}px + ${frac} * (100% - ${padLeft + padRight}px))` }}
              >
                {formatTimeFor(range)(real)}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default LivelineChart;
