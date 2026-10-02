import { type NextRequest, NextResponse } from "next/server";

import { fetchLaunches, type LaunchRow } from "@/lib/api/markets";
import { indexer } from "@/lib/api/server";
import { dummyLaunches, PREVIEW_ACCOUNT, previewEnabled } from "@/lib/dev/dummy-markets";
import type { MarketModel } from "@/lib/models";

/**
 * The markets an address launched.
 *
 * A straight proxy for `GET /accounts/:address/launches`. Every figure on the row is already what
 * the wallet tab needs — the fee amounts come from the service's `market_rewards`, which sums what
 * the fee EVENTS recorded, in raw units of each market's own quote asset with `quoteDecimals`
 * beside them.
 *
 * ## What this replaces
 *
 * A walk over the whole market list: five hundred full curve states a page, up to four pages,
 * filtered by `creator` in this handler — two thousand markets read to find the two an address
 * launched. It also had to report `truncated`, because past that cap it was guessing. The endpoint
 * asks the database for exactly the matching rows, so `truncated` is always false and is kept in
 * the shape only because the client already renders it.
 *
 * The client's per-market `pendingFees()` / `feeRecipient()` multicall goes with it. Those two
 * reads are on the row now — `pending` and `feeRecipient` — and the row also carries `pendingTax`
 * and `taxRecipient`, which the multicall never asked for, so a creator whose CREATOR TAX was
 * owed to them saw nothing at all.
 */

/** Stands in for the factory's own recipient in preview. Never used off that branch. */
const TREASURY = "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead";

/**
 * The fixture, shaped as the endpoint's rows.
 *
 * Preview has no indexer and no chain, so the claim control — the point of this tab — could not be
 * reviewed at all without one. Two of the four route to the account looking at them, so both sides
 * of the control show. These rows exist only on this branch.
 */
const previewRows = (): LaunchRow[] =>
  dummyLaunches(Date.now()).map((m: MarketModel, i: number) => ({
    marketAddress: m.market.marketAddress,
    tokenAddress: m.market.tokenAddress,
    symbol: m.market.symbol,
    name: m.market.name,
    ticker: m.market.metadata.ticker,
    logoUri: m.market.metadata.logoUri,
    launchedAt: m.market.launchedAt.toISOString(),
    graduated: m.state.poolAddress !== null,
    progress: m.state.progress,
    holders: m.state.holders,
    tradeCount: m.state.tradeCount,
    volumeQuote: m.state.volumeQuote.toString(),
    marketCap: m.state.marketCap.toString(),
    quoteAsset: m.market.quote.asset,
    quoteDecimals: m.market.quote.decimals,
    quoteSymbol: m.market.quote.symbol,
    routing: m.market.routing,
    creatorTaxBps: m.market.creatorTaxBps,
    feesGenerated: (m.state.volumeQuote / 100n).toString(),
    pending: (m.state.volumeQuote / 400n).toString(),
    feeRecipient: i % 2 === 0 ? PREVIEW_ACCOUNT : TREASURY,
    taxRecipient: i % 2 === 0 ? PREVIEW_ACCOUNT : TREASURY,
    pendingTax: "0",
  }));

export async function GET(_request: NextRequest, { params }: { params: { address: string } }) {
  const preview = () => NextResponse.json({ items: previewRows(), truncated: false });

  try {
    const page = await fetchLaunches(indexer, params.address);
    // Same rule the board follows: the fixture only ever fills a hole. A real answer, including a
    // real empty one from an address that has launched nothing, is returned untouched.
    if (page.items.length === 0 && previewEnabled) return preview();
    return NextResponse.json(page);
  } catch (e) {
    if (previewEnabled) return preview();
    console.error("launches route failed", e);
    return NextResponse.json({ error: "upstream unavailable" }, { status: 502 });
  }
}
