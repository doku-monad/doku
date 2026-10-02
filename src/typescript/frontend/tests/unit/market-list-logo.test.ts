/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";

import {
  identityInputFor,
  marketListItemFromRow,
  type MarketListRow,
} from "../../src/lib/hooks/use-market-list";
import { toMarketModel } from "../../src/lib/models";
import { identityFor } from "../../src/lib/token-identity";
import { marketRow } from "../fixtures/market-row";

/**
 * The launcher's artwork has to survive the trim.
 *
 * `/api/markets` deliberately sends a narrow row — the palette and the portfolio read a handful of
 * columns between them, and shipping whole models would ship the curve state of five hundred
 * markets to draw eight of them. The cost of that trim is that a column nobody listed is a column
 * that silently does not exist downstream: the palette has always rendered `identity.logo`, and it
 * has always drawn the emoji instead, because the row it resolves an identity from carries no
 * `logoUri` for `identityFor` to find.
 */
jest.mock("../../src/lib/queries/doku", () => ({ getMarkets: jest.fn() }));

const LOGO = "https://cdn.doku.family/bafylogo.webp";

const routeItems = async (): Promise<Record<string, unknown>[]> => {
  const { getMarkets } = await import("../../src/lib/queries/doku");
  (getMarkets as jest.Mock).mockResolvedValue({
    markets: [toMarketModel(marketRow({ generation: 2, ticker: "GOLDY", logo_uri: LOGO }))],
    nextCursor: null,
  });
  const { GET } = await import("../../src/app/api/markets/route");
  const res = await GET(new NextRequest("http://x/api/markets?limit=500"));
  const body = (await res.json()) as { items: Record<string, unknown>[] };
  return body.items;
};

describe("the market list a search result is drawn from", () => {
  it("sends the coin's logo with the row", async () => {
    const [item] = await routeItems();
    expect(item.logoUri).toBe(LOGO);
  });

  it("carries the logo through the client parser", async () => {
    const [item] = await routeItems();
    expect(marketListItemFromRow(item as unknown as MarketListRow).logoUri).toBe(LOGO);
  });

  /**
   * The parser's whole job on a new column: a response cached before the column existed has to
   * parse to "this coin has no logo" rather than to `undefined`, which `identityFor` would put
   * straight into an `<img src>`.
   */
  it("reads a row from before the column existed as having no logo", () => {
    const stale = { symbol: "🐳", marketAddress: "0xa" } as unknown as MarketListRow;
    expect(marketListItemFromRow(stale).logoUri).toBeNull();
  });

  /**
   * The point of all of it: the palette resolves an identity from this row and gets the artwork.
   *
   * Through `identityInputFor`, because the row is flat and `identityFor` reads `metadata.logoUri`
   * — passing the row straight in is exactly the near-miss that leaves the logo one key away from
   * the resolver looking for it.
   */
  it("resolves to an identity carrying the logo", async () => {
    const [item] = await routeItems();
    const parsed = marketListItemFromRow(item as unknown as MarketListRow);
    expect(identityFor(identityInputFor(parsed)).logo).toBe(LOGO);
  });
});
