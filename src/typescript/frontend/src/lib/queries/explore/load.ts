import "server-only";

import type { HotMover, RailItem } from "components/pages/home/components/hero/types";
import { MARKETS_PER_PAGE } from "lib/queries/sorting/const";

import {
  fetchLeaderboard,
  fetchMarketsPage,
  type Leaderboard,
  type SlimMarketRow,
} from "@/lib/api/markets";
import { indexer } from "@/lib/api/server";
import type { MarketListPage } from "@/lib/api/types";
import type { QuoteAsset } from "@/lib/assets/quote-assets";
import { quoteAmountNumber } from "@/lib/chain/quote-scale";
import { previewEnabled } from "@/lib/dev/dummy-markets";
import { getCandlesticks, getMarketMoney, getQuoteAssets } from "@/lib/queries/doku";
import { toMarketModelsSkippingBad } from "@/lib/queries/market-list";
import { identityFor } from "@/lib/token-identity";
import { SortMarketsBy } from "@/sdk/sorting";

import { queryToNeedle } from "./needle";
import { railOf, usdOf } from "./rail";
import {
  type ExploreParams,
  type ExplorePayload,
  HERO_WINDOW,
  HOT_MOVERS,
  RAIL_ITEMS,
  SPARK_BUCKETS,
  SPARK_PERIOD_SECS,
} from "./types";

/**
 * Everything `/explore` shows, assembled on the server.
 *
 * This is the body of the page's server component as it stood until the page went static: the
 * same two indexer calls, the same sparkline fan-out, the same failure handling. It moved here so
 * `/api/explore` could serve it to the browser, and it is deliberately the ONLY thing that moved —
 * the arithmetic, the ordering rules and every note about why they are what they are came with it
 * unchanged.
 */

/** An empty board, for the one case where the indexer could not be reached at all. */
const EMPTY_PAGE: MarketListPage = {
  items: [],
  total: 0,
  page: 1,
  limit: MARKETS_PER_PAGE,
  pairCounts: {},
};

const EMPTY_LEADERBOARD: Leaderboard = {
  window: HERO_WINDOW,
  movers: [],
  volume: [],
  graduated: [],
  rail: [],
};

/**
 * A leaderboard row's headline figure, in whole units of ITS OWN quote asset.
 *
 * `marketCapQuote` and `volume24hQuote` are raw quote units — the service has already divided the
 * generation scale out of them — so they take the row's `quoteDecimals` and nothing else. The
 * figure this replaces was `formatUnits(cap, 18)`: right for MON, and wrong by a factor of 1e12
 * for a market quoted in six-decimal gold, where one whole token is 1.39e-9 troy ounces.
 *
 * `lastPrice` is the field on this shape that is NOT normalised, and `SlimMarketRow` carries no
 * generation to normalise it with. Nothing here reads it.
 */
const whole = (raw: string | null | undefined, decimals: number): number =>
  raw === null || raw === undefined ? 0 : quoteAmountNumber(raw, decimals);

/** The identity a leaderboard row resolves to — the same resolver every other surface uses. */
const identityOfSlim = (row: SlimMarketRow) =>
  identityFor({
    marketAddress: row.marketAddress,
    tokenAddress: row.tokenAddress,
    symbol: row.symbol,
    name: row.name,
    metadata: {
      ticker: row.ticker,
      logoUri: row.logoUri,
      bannerUri: null,
      description: null,
      website: null,
      x: null,
      telegram: null,
    },
  });

export async function loadExplore(params: ExploreParams): Promise<ExplorePayload> {
  const { page, sortBy, orderBy, q, pair } = params;

  /*
   * The board is one request, and the database does the work.
   *
   * Sorting, the pair filter, the search and the paging all happen in SQL. This route used to ask
   * for five hundred markets and do all four in the browser, which is right only while the site is
   * small enough for the truncation not to show — market 501 was simply not on the board, under any
   * sort, and nothing said so.
   *
   * `sortBy` is a `SortMarketsBy`, whose string values (`market_cap`, `bump`, `daily_vol`,
   * `newest`) are all keys of the service's own `SORT_ALIASES`. It is passed straight
   * through; a sort the service does not know is a 400, not a differently-ordered board.
   *
   * No `cursor` key reaches the wire — see `fetchMarketsPage`. Its mere presence would select the
   * address-ordered cursor contract, which has no `total` and no `pairCounts`, and the page would
   * render an empty pager over an unsorted list.
   */
  /*
   * Whether the reads failed, kept rather than thrown away.
   *
   * Both calls below `.catch()` into an empty result so one dead endpoint cannot take the whole
   * route down — right, and it used to be the end of it. An empty board and a failed board then
   * rendered identically, so an indexer outage announced "No markets yet": a claim about the
   * protocol made from a network error. The catch is the one place that knows the difference, so
   * it is recorded here and passed down.
   */
  let boardFailed = false;
  let leaderboardFailed = false;

  const [board, leaderboard, pairs, tape] = await Promise.all([
    fetchMarketsPage(indexer, {
      sort: sortBy,
      order: orderBy,
      pair,
      q: q ? queryToNeedle(q) : undefined,
      page,
      limit: MARKETS_PER_PAGE,
    }).catch((error) => {
      console.error("Could not load the market board", error);
      boardFailed = true;
      return EMPTY_PAGE;
    }),
    /*
     * The hero, in one call rather than a fan-out.
     *
     * It used to rank the five hundred markets it had just fetched and then issue two requests per
     * runner — a candle series and a single swap, for the age column. The ranking, the caps, the
     * volumes, the change over the window and the last-traded time all come off this one response
     * now; only the sparkline still needs candles, because a 96-point series is not something a
     * list endpoint can carry and the indexer has no batch candlestick route.
     */
    fetchLeaderboard(indexer, HERO_WINDOW).catch((error) => {
      console.error("Could not load the leaderboard", error);
      leaderboardFailed = true;
      return EMPTY_LEADERBOARD;
    }),
    /*
     * The quote registry, for the headline and the pair rail: they name the pairs a coin can be
     * launched against, and shipping them with the board means the hero's first render already
     * says the right words. A failure costs nothing but that — the hero reads the registry again
     * itself, and holds on MON if that fails too. See `usePairCycle`.
     */
    getQuoteAssets().catch((error): QuoteAsset[] => {
      console.error("Could not load the quote registry", error);
      return [];
    }),
    /*
     * The coin tape: the latest coins, in the board's own bump order — a coin's most recent
     * activity, which is its launch until it first trades. So a coin launched a minute ago arrives
     * at the front of the tape, and so does one that just traded.
     *
     * Not the leaderboard's `rail`, which is ranked by cap: the tape was a second copy of the
     * runner board beside it, the same few biggest coins twice on one fold. Fourteen rows. A
     * failure falls back to the rail rows, most recently traded first.
     */
    fetchMarketsPage(indexer, {
      sort: SortMarketsBy.BumpOrder,
      order: "desc",
      page: 1,
      limit: RAIL_ITEMS,
    }).catch((error) => {
      console.error("Could not load the coin tape", error);
      return null;
    }),
  ]);

  /*
   * The preview fallback: **only** when the indexer returned nothing **and** `DOKU_CARD_PREVIEW`
   * is set. The flag is read here, on the server, where the variable lives; the fixture itself is
   * built in the browser (`lib/dev/dummy-explore`), because its models carry `bigint`s that no
   * JSON body can. The emptiness check means that even with the flag set, one real market is
   * enough to switch the fixture off: fabricated rows can never appear *beside* real ones, only
   * instead of none.
   */
  const preview = board.items.length === 0 && previewEnabled;
  if (preview) {
    return {
      board: { items: [], total: 0, page, pairCounts: {} },
      movers: [],
      rail: [],
      pairs,
      boardFailed,
      leaderboardFailed,
      preview: true,
    };
  }

  /*
   * The runners: the top of the window's volume list, minus anything that did not trade.
   *
   * Ranked by volume over the window, which is the figure the rows are drawn from — the carousel
   * this replaces ranked by market cap and labelled each tile with its distance from an all-time
   * high, an order its own numbers did not explain. Markets with no volume are dropped rather than
   * padding the list to four: a leaderboard whose third and fourth rows read `0` is not a
   * leaderboard with two entries, it is one that is lying about having four.
   */
  const runners = leaderboard.volume
    .filter((row) => whole(row.volume24hQuote, row.quoteDecimals) > 0)
    .slice(0, HOT_MOVERS);

  /*
   * Each runner's generation and quote decimals, asked for once per market rather than guessed.
   *
   * `getMarketMoney` memoises per address for the life of the process: it asks the indexer about a
   * market the FIRST time it is seen and none after that, because a market's generation and its
   * quote's decimals never change. Handing the candle feed a guessed generation instead is the
   * defect that flattened a whole series into the axis on this service, four times.
   */
  const money = await getMarketMoney(runners.map((row) => row.marketAddress));

  const movers: HotMover[] = await Promise.all(
    runners.map(async (row) => {
      const identity = identityOfSlim(row);
      const scale = money.get(row.marketAddress.toLowerCase());

      /*
       * One request, not two, and a failure costs the trace rather than the row.
       *
       * A market whose candles fail renders with an empty `spark` and keeps every other figure,
       * because all of them came off the leaderboard response that already landed.
       */
      const closes =
        scale === undefined
          ? []
          : await getCandlesticks(
              row.marketAddress,
              { generation: scale.generation, quoteDecimals: scale.quoteDecimals },
              SPARK_PERIOD_SECS,
              SPARK_BUCKETS
            )
              .then((candles) =>
                candles
                  // Oldest first. The indexer returns newest-first, and a sparkline drawn in that
                  // order shows every rising market falling.
                  .slice()
                  .sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime())
                  .map((c) => c.close)
                  // `null` is a close whose scale could not be resolved. Dropped rather than
                  // coerced: a sparkline missing a point still draws the shape, and a point drawn
                  // at the wrong scale flattens every other point in the series into the axis.
                  .filter((c): c is number => c !== null && Number.isFinite(c) && c > 0)
              )
              .catch(() => []);

      return {
        address: row.marketAddress,
        tokenAddress: row.tokenAddress,
        name: identity.name,
        ticker: identity.ticker,
        logo: identity.logo,
        marketCap: whole(row.marketCapQuote, row.quoteDecimals),
        marketCapUsd: usdOf(row),
        quoteSymbol: row.quoteSymbol,
        /*
         * Epoch millis, not a `Date`: this crosses a JSON boundary, where a `Date` arrives as a
         * string, and the client re-computes the age from it on a timer. `null` where the market
         * has never traded, which the row states rather than a second request discovering.
         */
        lastSwapAt: row.lastTradeAt ? new Date(row.lastTradeAt).getTime() : null,
        /*
         * The server's own figure over the window, not one derived from the candles here.
         *
         * `changeWindow` is a JSON number and a percentage. Two components computing a change from
         * two different resamplings of the same series is how the hero and the card come to
         * disagree about whether a market is up.
         */
        changePct: row.changeWindow ?? null,
        spark: closes,
        volume24h: whole(row.volume24hQuote, row.quoteDecimals),
        volume24hUsd:
          row.volume24hUsd === null || row.volume24hUsd === undefined
            ? null
            : Number(row.volume24hUsd),
      };
    })
  );

  /*
   * The tape: the latest coins (see the read above), independent of the grid's own sort so it
   * holds still while somebody flips the board between orderings underneath it. Without that read,
   * the leaderboard's rail rows stand in, most recently traded first — the nearest thing they carry
   * to bump order.
   */
  const tapeMarkets = tape ? toMarketModelsSkippingBad(tape.items) : [];
  const rail: RailItem[] = tapeMarkets.length
    ? tapeMarkets.slice(0, RAIL_ITEMS).map(railOf)
    : leaderboard.rail
        .slice()
        .sort((a, b) => Date.parse(b.lastTradeAt ?? "0") - Date.parse(a.lastTradeAt ?? "0"))
        .slice(0, RAIL_ITEMS)
        .map((row) => {
          const identity = identityOfSlim(row);
          return {
            address: row.marketAddress,
            tokenAddress: row.tokenAddress,
            ticker: identity.ticker,
            name: identity.name,
            logo: identity.logo,
            quoteSymbol: row.quoteSymbol,
            marketCap: whole(row.marketCapQuote, row.quoteDecimals),
            marketCapUsd: usdOf(row),
            changePct: row.change24h ?? null,
          };
        });

  return {
    board: {
      items: board.items,
      total: board.total,
      page: board.page,
      pairCounts: board.pairCounts,
    },
    movers,
    rail,
    pairs,
    boardFailed,
    leaderboardFailed,
    preview: false,
  };
}
