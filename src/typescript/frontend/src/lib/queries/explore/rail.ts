import type { RailItem } from "components/pages/home/components/hero/types";

import type { SlimMarketRow } from "@/lib/api/markets";
import { quoteAmountNumber } from "@/lib/chain/quote-scale";
import type { MarketModel } from "@/lib/models";
import { identityFor } from "@/lib/token-identity";

/**
 * One market as a ticket on the hero's coin tape.
 *
 * Shared by the server's loader and the preview fixture, so the two paths cannot disagree about
 * what a ticket shows: the coin's picture, its market cap (dollars where the quote is priced, its
 * own units where not) and the day's change.
 */
export const railOf = (m: MarketModel): RailItem => {
  const identity = identityFor(m.market);
  return {
    address: m.market.marketAddress,
    tokenAddress: m.market.tokenAddress,
    ticker: identity.ticker,
    name: identity.name,
    logo: identity.logo,
    quoteSymbol: m.market.quote.symbol,
    marketCap: quoteAmountNumber(m.state.marketCap, m.market.quote.decimals),
    marketCapUsd: m.state.marketCapUsd,
    changePct: m.state.change24h,
  };
};

/**
 * A leaderboard row's dollar cap. The service sends it as a decimal string, and `null` where the
 * quote has no price — which stays `null` rather than becoming `0`, a coin worth nothing.
 */
export const usdOf = (row: Pick<SlimMarketRow, "marketCapUsd">): number | null => {
  const usd = row.marketCapUsd === null ? null : Number(row.marketCapUsd);
  return usd !== null && Number.isFinite(usd) ? usd : null;
};
