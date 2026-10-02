import type { Db } from "../../../db/legacy.js";
import type { LiveEvent } from "../../../websocket/live.js";
import { recordFeeEvent, refreshMarketRewards } from "../../processing/fees.js";
import type { LogBase } from "./launch.js";

/**
 * RewardVault and BurnSink, attributed by the sink address graduation registered.
 *
 * There is nothing else to attribute by: `Funded(uint256)` and `Burned(uint256,uint256)` carry no
 * market, no pool and no token, and their signatures are generic enough that any contract on the
 * chain might emit them. `graduations.sink` is the whole of the identification, which is also why
 * the log query asks for them by address rather than by topic.
 */
export async function handleSinkEvent(
  db: Db,
  eventName: "Funded" | "Claimed" | "Burned",
  a: Record<string, unknown>,
  sinkAddress: string,
  ts: Date,
  base: LogBase,
  announce: (event: LiveEvent) => void,
): Promise<void> {
  const { rows } = await db.query<{
    market_address: string;
    quote_asset: string;
    token_address: string;
  }>(
    `SELECT g.market_address, m.quote_asset, m.token_address
       FROM graduations g JOIN markets m USING (market_address) WHERE g.sink = $1`,
    [sinkAddress.toLowerCase()],
  );
  const m = rows[0];
  if (!m) return;
  const common = { market: m.market_address, venue: "sink" as const, ...base, ts };
  let fresh = false;
  if (eventName === "Funded") {
    fresh = await recordFeeEvent(db, {
      ...common,
      kind: "dividend_funded",
      recipient: null,
      quoteAsset: m.quote_asset,
      amount: BigInt(String(a.amount)),
    });
  } else if (eventName === "Claimed") {
    const holder = String(a.holder).toLowerCase();
    fresh = await recordFeeEvent(db, {
      ...common,
      kind: "dividend",
      recipient: holder,
      quoteAsset: m.quote_asset,
      amount: BigInt(String(a.amount)),
    });
    if (fresh) announce({ type: "fees", market: m.market_address, recipient: holder });
  } else {
    // Token units: the burn sink destroys the market's token, never quote.
    fresh = await recordFeeEvent(db, {
      ...common,
      kind: "burn",
      recipient: null,
      quoteAsset: m.token_address,
      amount: BigInt(String(a.amount)),
    });
  }
  if (fresh) await refreshMarketRewards(db, m.market_address);
}
