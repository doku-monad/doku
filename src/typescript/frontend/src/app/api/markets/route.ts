import { type NextRequest, NextResponse } from "next/server";

import { getMarkets } from "@/lib/queries/doku";

/** The market list, for client-side search. */
export async function GET(request: NextRequest) {
  const limit = Math.min(Number(request.nextUrl.searchParams.get("limit") ?? 500), 500);

  try {
    const { markets, nextCursor } = await getMarkets({ limit });
    return NextResponse.json({
      // Trimmed to what its consumers need: the command palette searches this and prints a
      // price, a cap and a 24-hour turnover beside each hit; the portfolio's liquidity tab uses
      // it to turn a position's token address into an emoji. Whole models would ship the rest of
      // the curve state per market, which neither of them reads.
      //
      // The three figures are strings because they are 18-decimal `bigint`s and `JSON.stringify`
      // refuses those outright. The client parses them back with `BigInt`, the same contract the
      // indexer's own rows use.
      items: markets.map((m) => ({
        marketAddress: m.market.marketAddress,
        tokenAddress: m.market.tokenAddress,
        poolAddress: m.state.poolAddress,
        symbol: m.market.symbol,
        name: m.market.name,
        graduated: m.state.poolAddress !== null,
        lastPrice: m.state.lastPrice.toString(),
        marketCap: m.state.marketCap.toString(),
        volume24h: m.state.volume24h.toString(),
        /* The scale `lastPrice` is stored at, without which that column cannot be read at all.
           The caps are already normalised and take the decimals alone; a price is not, and this
           trim used to drop the one field that says by how much. The palette divided by 1e18 —
           the generation-1 scale — and printed a generation-2 market's 0.000112 MON as
           112,363,479,529,932.33. See `lib/chain/quote-scale`. */
        generation: m.market.generation,
        /* The quote, without which `marketCap` is a number with no unit. The palette formatted it
           at eighteen decimals and called it MON because this row said nothing else, so a USDC
           market's 2,938 cap printed as 0. `marketCapUsd` is the service's own dollar figure,
           already computed with that quote's decimals and that quote's price. */
        quoteDecimals: m.market.quote.decimals,
        quoteSymbol: m.market.quote.symbol ?? "MON",
        marketCapUsd: m.state.marketCapUsd,
        /* The launcher's artwork. The palette resolves an identity from this row and draws the
           logo off it, so a row without this column can only ever draw the fallback — which is
           what every search result did for as long as the trim omitted it. */
        logoUri: m.market.metadata.logoUri,
      })),
      nextCursor,
    });
  } catch (e) {
    console.error("markets route failed", e);
    return NextResponse.json({ error: "upstream unavailable" }, { status: 502 });
  }
}
