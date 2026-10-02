/**
 * LOCAL DEVELOPMENT STUB — not the real TradingView charting library.
 *
 * `public/static` is a git submodule pointing at a private TradingView repository
 * (`tradingview/charting_library`). Without access to it, every module that imports
 * `@/static/charting_library` fails to resolve and the whole market page refuses to compile —
 * even though the chart itself is loaded lazily at runtime and would simply stay hidden.
 *
 * This file provides just enough of the module's shape to let the app build. The types are
 * deliberately permissive; the `widget` constructor throws if anything ever tries to instantiate
 * it, which shouldn't happen: `ChartContainer` only mounts the chart after
 * `/static/datafeeds/udf/dist/bundle.js` loads, and that file ships with the same submodule.
 *
 * Running `pnpm run submodule` (with `TRADING_VIEW_REPO_OWNER` and `GITHUB_ACCESS_TOKEN` set)
 * overwrites this directory with the real library.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type ResolutionString = string;
export type LanguageCode = string;
export type ThemeName = string;
export type Timezone = string;
export type Bar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};
export type PeriodParams = {
  from: number;
  to: number;
  countBack: number;
  firstDataRequest: boolean;
};
export type LibrarySymbolInfo = Record<string, any>;
export type SearchSymbolResultItem = Record<string, any>;
export type DatafeedConfiguration = Record<string, any>;
export type ChartingLibraryWidgetOptions = Record<string, any>;
export type IBasicDataFeed = Record<string, any>;
export type IChartingLibraryWidget = Record<string, any>;
export type SubscribeBarsCallback = (bar: Bar) => void;

export class widget {
  constructor(_options?: ChartingLibraryWidgetOptions) {
    throw new Error(
      "The TradingView charting library is not installed. This is the local development stub " +
        "at frontend/public/static/charting_library. Run `pnpm run submodule` with a valid " +
        "TRADING_VIEW_REPO_OWNER and GITHUB_ACCESS_TOKEN to install the real library."
    );
  }
}
