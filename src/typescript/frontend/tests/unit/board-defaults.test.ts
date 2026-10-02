/**
 * @jest-environment node
 */
import { SortMarketsBy } from "@/sdk/sorting";

import { MARKETS_PER_PAGE } from "../../src/lib/queries/sorting/const";
import type { HomePageSearchParams } from "../../src/lib/queries/sorting/query-params";
import { toHomePageParamsWithDefault } from "../../src/lib/routes/home-page-params";

/**
 * A URL's query string, which is what this function actually receives.
 *
 * Every field is optional in practice — a visitor arriving at `/explore` supplies none of them —
 * but the declared type spells them all out, so the tests build one explicitly rather than casting
 * a partial and losing the compiler's check that the field names are real.
 */
const params = (over: Partial<HomePageSearchParams> = {}): HomePageSearchParams =>
  ({
    page: undefined,
    sort: undefined,
    order: undefined,
    bonding: undefined,
    q: undefined,
    pair: undefined,
    ...over,
  }) as HomePageSearchParams;

describe("what the board shows before anyone asks for anything", () => {
  it("orders by market cap, so the coins that have attracted money are at the top", () => {
    // The front page is where a visitor sizes up the launchpad; bump order stays in the pill.
    expect(toHomePageParamsWithDefault(params()).sortBy).toBe(SortMarketsBy.MarketCap);
    expect(toHomePageParamsWithDefault(undefined).sortBy).toBe(SortMarketsBy.MarketCap);
  });

  it("still honours an explicit sort, so the default is a default and not a lock", () => {
    expect(toHomePageParamsWithDefault(params({ sort: "bump" })).sortBy).toBe(
      SortMarketsBy.BumpOrder
    );
    expect(toHomePageParamsWithDefault(params({ sort: "daily_vol" })).sortBy).toBe(
      SortMarketsBy.DailyVolume
    );
    expect(toHomePageParamsWithDefault(params({ sort: "newest" })).sortBy).toBe(SortMarketsBy.Newest);
  });

  it("no longer serves all-time volume; an old link to it lands on the default", () => {
    expect(toHomePageParamsWithDefault(params({ sort: "all_time_vol" })).sortBy).toBe(
      SortMarketsBy.MarketCap
    );
  });

  it("falls back to market cap for a sort the board cannot serve", () => {
    // `price`, `apr` and `tvl` exist in the vocabulary but not on this board.
    expect(toHomePageParamsWithDefault(params({ sort: "apr" })).sortBy).toBe(
      SortMarketsBy.MarketCap
    );
    // A value the type does not admit, which is what a hand-typed URL supplies.
    expect(toHomePageParamsWithDefault(params({ sort: "nonsense" as never })).sortBy).toBe(
      SortMarketsBy.MarketCap
    );
  });

  it("starts on page one, whatever nonsense the URL carries", () => {
    for (const page of [undefined, "0", "-3", "abc", ""]) {
      expect(toHomePageParamsWithDefault(params({ page })).page).toBe(1);
    }
    expect(toHomePageParamsWithDefault(params({ page: "3" })).page).toBe(3);
  });
});

describe("the board's page size", () => {
  /**
   * The pager renders nothing while there is one page, which is correct — and is why a page size
   * of fifty meant the control had never appeared: the board has around two dozen markets, so
   * every one of them fitted on page one.
   */
  it("is small enough that a board of two dozen coins actually pages", () => {
    expect(MARKETS_PER_PAGE).toBeLessThan(23);
    expect(Math.ceil(23 / MARKETS_PER_PAGE)).toBeGreaterThan(1);
  });

  it("is a whole number of rows on the grid's common widths", () => {
    // Four and five across on desktop; a page that ends mid-row leaves a ragged edge.
    expect(MARKETS_PER_PAGE % 4).toBe(0);
    expect(MARKETS_PER_PAGE % 5).toBe(0);
  });

  it("is still a board and not a trickle", () => {
    expect(MARKETS_PER_PAGE).toBeGreaterThanOrEqual(20);
  });
});
