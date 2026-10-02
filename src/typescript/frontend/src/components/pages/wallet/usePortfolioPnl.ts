"use client";

import { useQuery } from "@tanstack/react-query";
import { formatUnits } from "viem";

/* The launched token is eighteen decimals on both sides of every trade. The QUOTE side is not, and
   arrives per row — see `n` and `quoteDecimals` below. */
import { TOKEN_DECIMALS as BASE_DECIMALS } from "@/lib/chain/config";
import type { SwapModel } from "@/lib/models";

import { groupByQuote, type QuoteGroup } from "./quote-groups";

/**
 * What an address has actually made, worked out from its own trades.
 *
 * ## Why this is computed here rather than fetched
 *
 * Because nothing stores it. The indexer records swaps; it has no cost-basis column, no realised
 * figure and no notion of a position's history. Every launchpad portfolio page that shows a P&L
 * either keeps that ledger server-side or invents it — and the arithmetic is not hard, so this
 * page keeps it: read the address's swaps, walk them oldest-first, and maintain an average-cost
 * basis per market.
 *
 * ## Average cost, and why not FIFO
 *
 * Average cost is the only basis that can be computed correctly from a *partial* history, and a
 * partial history is what this page always has: the feed is capped, an address may have traded
 * before the indexer was watching, and tokens can arrive by transfer with no trade at all. FIFO
 * needs every lot in order; average cost needs only totals, and degrades to "unknown" cleanly
 * rather than silently mis-stating a gain.
 *
 * ## What counts as cost
 *
 * The quote asset that actually left the wallet: `quoteVolume`, which is the amount in, plus the
 * fee and the launch tax charged on top. A cost basis that ignores fees reports a profit the
 * trader never had — and on a market where the anti-sniper tax was 40%, it reports one that is
 * wildly wrong.
 *
 * ## Every amount is in the market's OWN quote asset
 *
 * Each row is scaled by that market's `quote_decimals`, which the account-swaps feed now carries.
 * A fixed eighteen understated a six-decimal market by a factor of a trillion — and then the
 * totals ADDED those figures to MON ones, which is the same arithmetic as adding dollars to troy
 * ounces. So the totals are grouped by asset (`realisedByQuote`, `feesPaidByQuote`) and the flat
 * `realised` and `feesPaid` are gone; there is no single number that could have been right.
 *
 * Sells credit realised P&L for the difference between what came back and the average cost of the
 * tokens that left, and reduce the remaining basis by that same average. That is the standard
 * treatment and it means a position sold down to zero has its whole result in `realised`.
 *
 * ## Where it refuses to answer
 *
 * `basisComplete` is false when an address holds more of a token than its indexed trades can
 * account for — tokens that arrived by transfer, from another venue, or before the indexer saw
 * them. The page renders a dash for those positions rather than an entry price computed from half
 * the story. This is the whole reason the flag exists: a wrong number here is worse than no
 * number, because somebody will act on it.
 */

export interface MarketPnl {
  marketAddress: string;
  /** What every figure on this market is denominated in. */
  quoteSymbol: string | null;
  /** Quote units paid for tokens still held, at average cost. */
  costRemaining: number;
  /** Average quote units per token paid for what is still held. `null` when nothing is held. */
  avgEntry: number | null;
  /** Realised on everything sold, net of the cost of those tokens, in this market's quote. */
  realised: number;
  /** Tokens bought and sold across the indexed history. */
  bought: number;
  sold: number;
  /** Fees and launch tax this address paid on this market, in this market's quote asset. */
  feesPaid: number;
  /**
   * Whether the indexed trades account for everything held.
   *
   * `false` means some of the balance arrived another way, so there is no honest entry price.
   */
  basisComplete: boolean;
}

export interface PortfolioPnl {
  byMarket: Map<string, MarketPnl>;
  /**
   * Fees and launch tax, totalled PER QUOTE ASSET, largest first.
   *
   * Not one number. A trader who paid fees in MON and in USDC paid two amounts of two different
   * things, and the sum of them is not a fee anybody paid.
   */
  feesPaidByQuote: QuoteGroup<MarketPnl>[];
  /** Realised, totalled per quote asset, largest first. Same reason. */
  realisedByQuote: QuoteGroup<MarketPnl>[];
  /** How many trades the calculation saw. */
  trades: number;
  /** The oldest indexed trade, or `null` for an address that has never traded here. */
  firstTradeAt: Date | null;
  /**
   * True when the history was cut off by the page cap.
   *
   * The figures are then a floor rather than a total, and the page says so instead of printing a
   * confident number over an incomplete ledger.
   */
  truncated: boolean;
}

/** Rows per request, and the ceiling on how many we will walk. */
const PAGE = 500;
const MAX_PAGES = 6;

/** A quote-side amount, at that market's own decimals. */
const n = (v: bigint, decimals: number) => Number(formatUnits(v, decimals));
/** A base-side amount. Every launched token is eighteen decimals. */
const base = (v: bigint) => Number(formatUnits(v, BASE_DECIMALS));

/** The swap rows come back with every bigint as a string — see the account swaps route. */
type WireSwap = Omit<SwapModel, "swap" | "block"> & {
  symbol: string;
  quoteSymbol: string | null;
  quoteDecimals: number;
  swap: Record<keyof SwapModel["swap"], string | boolean>;
  block: { number: string; txHash: string; time: string };
};

export function usePortfolioPnl(address: string) {
  return useQuery({
    queryKey: ["portfolio-pnl", address],
    staleTime: 30_000,
    queryFn: async (): Promise<PortfolioPnl> => {
      const rows: {
        marketAddress: string;
        quoteSymbol: string | null;
        isSell: boolean;
        quote: number;
        base: number;
        fee: number;
        tax: number;
        time: Date;
      }[] = [];

      let cursor: string | undefined;
      let truncated = false;

      for (let page = 0; page < MAX_PAGES; page++) {
        const url = `/api/accounts/${address}/swaps?limit=${PAGE}${cursor ? `&cursor=${cursor}` : ""}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`portfolio pnl: ${res.status}`);
        const body = (await res.json()) as { items: WireSwap[]; nextCursor?: string | null };

        for (const item of body.items) {
          // The quote side takes THIS market's decimals; the base side is always eighteen. A row
          // that arrived without decimals — an older cached response — is read as eighteen, which
          // is the value the feed itself falls back to.
          const d = item.quoteDecimals ?? 18;
          rows.push({
            marketAddress: item.market.marketAddress,
            quoteSymbol: item.quoteSymbol ?? null,
            isSell: Boolean(item.swap.isSell),
            quote: n(BigInt(item.swap.quoteVolume as string), d),
            base: base(BigInt(item.swap.baseVolume as string)),
            fee: n(BigInt(item.swap.fee as string), d),
            tax: n(BigInt(item.swap.tax as string), d),
            time: new Date(item.block.time),
          });
        }

        cursor = body.nextCursor ?? undefined;
        if (!cursor) break;
        // Ran out of pages before running out of history: the totals below are a floor.
        if (page === MAX_PAGES - 1) truncated = true;
      }

      // Oldest first. An average-cost walk over a newest-first list credits sales against a basis
      // that has not been bought yet, which produces a realised figure that is simply wrong.
      rows.sort((a, b) => a.time.getTime() - b.time.getTime());

      const byMarket = new Map<string, MarketPnl>();

      for (const row of rows) {
        const key = row.marketAddress.toLowerCase();
        const m: MarketPnl = byMarket.get(key) ?? {
          marketAddress: row.marketAddress,
          quoteSymbol: row.quoteSymbol,
          costRemaining: 0,
          avgEntry: null,
          realised: 0,
          bought: 0,
          sold: 0,
          feesPaid: 0,
          basisComplete: true,
        };

        const charges = row.fee + row.tax;
        m.feesPaid += charges;

        if (row.isSell) {
          const held = m.bought - m.sold;
          // Average cost of what is being sold. A sale larger than the tracked position — which
          // happens whenever tokens arrived by transfer — is credited at the basis that exists and
          // flags the market, rather than inventing cost for the excess.
          const avg = held > 0 ? m.costRemaining / held : 0;
          const matched = held > 0 ? Math.min(row.base, held) : 0;
          if (row.base > matched) m.basisComplete = false;

          const costOut = avg * matched;
          // Proceeds are net of what the venue took, because that is what reached the wallet.
          const proceeds = row.quote - charges;
          m.realised += proceeds - costOut;
          m.costRemaining = Math.max(0, m.costRemaining - costOut);
          m.sold += row.base;
        } else {
          // Cost is what left the wallet: the amount in plus the charges taken on top of it.
          m.costRemaining += row.quote + charges;
          m.bought += row.base;
        }

        const held = m.bought - m.sold;
        m.avgEntry = held > 0 && m.costRemaining > 0 ? m.costRemaining / held : null;
        byMarket.set(key, m);
      }

      const markets = [...byMarket.values()];
      return {
        byMarket,
        // Totalled within each asset, never across. See the note at the top of this file.
        feesPaidByQuote: groupByQuote(markets, (m) => m.quoteSymbol, (m) => m.feesPaid),
        realisedByQuote: groupByQuote(markets, (m) => m.quoteSymbol, (m) => m.realised),
        trades: rows.length,
        firstTradeAt: rows.length ? rows[0].time : null,
        truncated,
      };
    },
  });
}
