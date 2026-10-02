import { type NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";

import { ApiError } from "@/lib/api/client";
import { getCandlesticks, getMarketScale } from "@/lib/queries/doku";

/**
 * Candlesticks for the chart.
 *
 * A proxy rather than a direct browser fetch, because the indexer URL is server-side
 * configuration — it may be a private address, and shipping it to the client would leak it and
 * then fail to resolve from a browser, which looks like the indexer being down rather than a
 * misconfiguration.
 */
const PERIODS = new Set([60, 300, 900, 1800, 3600, 14400, 86400]);

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const market = searchParams.get("market");
  const period = Number(searchParams.get("period") ?? 3600);
  const limitRaw = Number(searchParams.get("limit") ?? 200);
  // A limit that does not parse is not "the maximum" and not the default; it is a bad request.
  if (!Number.isFinite(limitRaw) || limitRaw <= 0) {
    return NextResponse.json({ error: "limit must be a positive number" }, { status: 400 });
  }
  const limit = Math.min(Math.floor(limitRaw), 1000);

  if (!market || !isAddress(market, { strict: false })) {
    return NextResponse.json({ error: "market must be an address" }, { status: 400 });
  }
  if (!PERIODS.has(period)) {
    return NextResponse.json(
      { error: "unsupported period", supported: [...PERIODS] },
      { status: 400 },
    );
  }

  try {
    // The market row first, for its generation and its quote decimals. A candle carries four
    // prices and says nothing about the scale they are stored at, so serving one without asking
    // is guessing — and the guess is right for generation 1 and out by a factor of 1e18 for
    // generation 2, drawing a chart whose shape is perfect and whose axis is meaningless.
    const scale = await getMarketScale(market);
    const candles = await getCandlesticks(market, scale, period, limit);
    // `volumeQuote` is a bigint, which `JSON.stringify` refuses outright. Serialised as a string
    // so it survives the trip; the alternative — a Number — would round it.
    return NextResponse.json(
      candles.map((c) => ({ ...c, volumeQuote: c.volumeQuote.toString() })),
    );
  } catch (e) {
    // A market the indexer does not know is a 404, not an outage.
    if (e instanceof ApiError && e.status === 404) {
      return NextResponse.json({ error: "unknown market" }, { status: 404 });
    }
    console.error("candlesticks route failed", e);
    return NextResponse.json({ error: "upstream unavailable" }, { status: 502 });
  }
}
