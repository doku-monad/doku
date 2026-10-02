/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";

import { UNKNOWN_GENERATION } from "../../src/lib/chain/quote-scale";
import { marketListItemFromRow, type MarketListRow } from "../../src/lib/hooks/use-market-list";
import { toMarketModel } from "../../src/lib/models";
import { priceFigure } from "../../src/lib/price-figure";
import { marketRow } from "../fixtures/market-row";

const MON = { decimals: 18, symbol: "MON" };
const USDC = { decimals: 6, symbol: "USDC" };
const GOLD = { decimals: 6, symbol: "XAUt0" };

/**
 * MONKE, live on mainnet: a generation-2 market quoted in MON, storing `quote * 1e36 / base`.
 *
 * The palette printed this as `112,363,479,529,932.33` — the same digits, with the generation-2
 * scale mistaken for the quote's decimals and a factor of 1e18 left on the number.
 */
const MONKE_RAW = "112363479529932323883229135480996";

/** The identical price on a generation-1 market, which stores it at `quote * 1e18 / base`. */
const MONKE_RAW_GEN1 = "112363479529932";

describe("a last price and its unit", () => {
  it("reads MONKE at the scale its own generation stored it", () => {
    const f = priceFigure(MONKE_RAW, 2, MON);
    expect(f.value).toBeCloseTo(0.000112363479529932, 15);
    expect(f.label).toBe("0.0001124 MON");
  });

  /// The bug, stated as the thing that must not come back.
  it("does not leave the generation scale on the figure", () => {
    expect(priceFigure(MONKE_RAW, 2, MON).value).toBeLessThan(1);
  });

  /**
   * The regression guard the fix exists for.
   *
   * A hard-coded `/1e36` is correct for every market that exists today and wrong for the first
   * generation-1 row that reaches a search result — which is the same shape of mistake as the
   * `/1e18` it replaces, one generation later. The two scales are exactly 1e18 apart, so the same
   * price stored under each has to come out the same figure.
   */
  it("reads the same price on either generation", () => {
    const gen2 = priceFigure(MONKE_RAW, 2, MON).value;
    const gen1 = priceFigure(MONKE_RAW_GEN1, 1, MON).value;
    expect(gen1).not.toBeNull();
    expect(gen2).not.toBeNull();
    expect(Math.abs((gen1 as number) - (gen2 as number))).toBeLessThan(1e-18);
  });

  /// The generation is one divisor and the quote's decimals are the other. A market quoted in
  /// six-decimal USDC at generation 2 is off by 1e12 if only the generation is accounted for.
  it("takes the quote asset's decimals, not a global eighteen", () => {
    // 0.25 USDC per whole token: 0.25 * 1e6 raw quote units per token, at the 1e36 scale.
    const raw = (250_000n * 10n ** 36n) / 10n ** 18n;
    expect(priceFigure(raw, 2, USDC).label).toBe("0.25 USDC");
  });

  /// The case that took every gold market to zero elsewhere: a coin worth a millionth of a troy
  /// ounce. The fraction has to survive, so this cannot go through an integer division first.
  it("keeps a price smaller than one raw unit of a coarse quote", () => {
    const raw = 10n ** 36n / 10n ** 18n; // one millionth of an ounce per whole token
    const f = priceFigure(raw, 2, GOLD);
    expect(f.value).toBeCloseTo(1e-6, 12);
    expect(f.label).toBe("0.000001 XAUt0");
  });

  /**
   * An em dash, not a number and not a zero.
   *
   * A row whose generation nobody can name has no readable price. Printing one anyway is the
   * failure this whole module exists to prevent, and printing `0` claims the coin is worthless.
   */
  it("declines to scale a price whose generation is unknown", () => {
    const f = priceFigure(MONKE_RAW, UNKNOWN_GENERATION, MON);
    expect(f.value).toBeNull();
    expect(f.label).toBe("—");
  });

  /// The same mistake the cap made before `capFigure`: a figure printed in whichever asset the
  /// reader assumes, on a launchpad where the assets differ by six orders of magnitude.
  it("labels the figure with the market's own quote asset", () => {
    expect(priceFigure(MONKE_RAW, 2, GOLD).currency).toBe("XAUt0");
    expect(priceFigure(MONKE_RAW, 2, GOLD).label.endsWith(" XAUt0")).toBe(true);
  });

  it("prints an honest zero for a market that has never traded", () => {
    expect(priceFigure("0", 2, MON)).toMatchObject({ value: 0, label: "0 MON" });
  });

  /// Above one the rule flips from significant digits to fixed places, as it did before the fix.
  it("keeps four decimals on a price above one", () => {
    expect(priceFigure((123_456_700n * 10n ** 36n) / 10n ** 18n, 2, USDC).label).toBe(
      "123.4567 USDC"
    );
  });
});

/**
 * The generation has to survive the trim to reach the palette at all.
 *
 * `/api/markets` sends a narrow row on purpose, and the cost of that trim is that a column nobody
 * listed does not exist downstream. The price was the column that lost its scale this way: the row
 * carried `quoteDecimals` and not the generation, so the client had one of the two divisors and
 * invented the other.
 */
jest.mock("../../src/lib/queries/doku", () => ({ getMarkets: jest.fn() }));

const routeItems = async (generation: number): Promise<Record<string, unknown>[]> => {
  const { getMarkets } = await import("../../src/lib/queries/doku");
  (getMarkets as jest.Mock).mockResolvedValue({
    markets: [toMarketModel(marketRow({ generation, last_price: MONKE_RAW }))],
    nextCursor: null,
  });
  const { GET } = await import("../../src/app/api/markets/route");
  const res = await GET(new NextRequest("http://x/api/markets?limit=500"));
  const body = (await res.json()) as { items: Record<string, unknown>[] };
  return body.items;
};

describe("the market list the palette prices from", () => {
  it("sends the generation beside the price it scales", async () => {
    const [item] = await routeItems(2);
    expect(item.generation).toBe(2);
  });

  it("prices a search result at its own market's generation", async () => {
    const [item] = await routeItems(2);
    const parsed = marketListItemFromRow(item as unknown as MarketListRow);
    expect(
      priceFigure(parsed.lastPrice, parsed.generation, {
        decimals: parsed.quoteDecimals,
        symbol: parsed.quoteSymbol,
      }).label
    ).toBe("0.0001124 MON");
  });

  /**
   * A response cached before the column existed parses to "nobody said", not to generation 1.
   * TanStack Query's cache outlives a deploy, so this is a real state — and defaulting it to the
   * older scale would reproduce the exact defect for as long as the stale entry lived.
   */
  it("reads a row from before the column existed as having no generation", () => {
    const stale = { symbol: "🐳", marketAddress: "0xa" } as unknown as MarketListRow;
    const parsed = marketListItemFromRow(stale);
    expect(parsed.generation).toBe(UNKNOWN_GENERATION);
    expect(priceFigure(parsed.lastPrice, parsed.generation, MON).label).toBe("—");
  });
});
