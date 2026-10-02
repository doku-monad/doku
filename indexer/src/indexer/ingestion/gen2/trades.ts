import type { Db } from "../../../db/legacy.js";
import type { LiveEvent } from "../../../websocket/live.js";
import { updateCandles } from "../../processing/derive.js";
import { recordFeeEvent, refreshMarketRewards, splitFee } from "../../processing/fees.js";
import { SINK_CREATOR } from "../../generations.js";
import type { LogBase } from "./launch.js";

/**
 * A decoded uint field. Zero for a field this event does not carry — a `Sold` has no anti-sniper
 * tax, and reading it as `undefined` would put the string "undefined" in a NUMERIC column.
 */
const big = (v: unknown): bigint => {
  if (typeof v === "bigint") return v;
  if (typeof v === "string" || typeof v === "number") return BigInt(v);
  return 0n;
};

interface MarketEconomics {
  quote_asset: string;
  routing: number | null;
  routed_recipient: string | null;
  tax_recipient: string | null;
}

/**
 * A gen-2 curve trade. The swap row is the gen-1 shape plus `creator_tax`; the fee components
 * become ledger rows; the price is the event's own post-trade spot.
 */
export async function handleTrade2(
  db: Db,
  market: string,
  isBuy: boolean,
  a: Record<string, unknown>,
  ts: Date,
  base: LogBase,
  announce: (event: LiveEvent) => void,
): Promise<void> {
  const { rows } = await db.query<MarketEconomics>(
    "SELECT quote_asset, routing, routed_recipient, tax_recipient FROM markets WHERE market_address = $1",
    [market],
  );
  const m = rows[0];
  if (!m) return;

  const quote = big(isBuy ? a.quoteIn : a.quoteOut);
  const baseAmt = big(isBuy ? a.baseOut : a.baseIn);
  const fee = big(a.fee);
  const antiSniper = isBuy ? big(a.antiSniperTax) : 0n;
  const creatorTax = big(a.creatorTax);
  const raised = big(a.quoteRaised);
  const price = big(a.price).toString();

  const inserted = await db.query(
    `INSERT INTO swaps (market_address, trader, is_buy, venue, quote_amount, base_amount, fee,
                        tax, creator_tax, quote_raised, price, block_number, block_hash, log_index,
                        tx_hash, ts)
     VALUES ($1,$2,$3,'curve',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (tx_hash, log_index) DO NOTHING RETURNING id`,
    [
      market,
      String(isBuy ? a.buyer : a.seller).toLowerCase(),
      isBuy,
      quote.toString(),
      baseAmt.toString(),
      fee.toString(),
      antiSniper.toString(),
      creatorTax.toString(),
      raised.toString(),
      price,
      base.block,
      base.hash,
      base.idx,
      base.tx,
      ts,
    ],
  );
  if (inserted.rowCount === 0) return;

  await db.query(
    `UPDATE market_state SET quote_raised = $2, last_price = $3, volume_quote = volume_quote + $4,
                             trade_count = trade_count + 1, block_number = $5
      WHERE market_address = $1`,
    [market, raised.toString(), price, quote.toString(), base.block],
  );
  await updateCandles(db, market, ts, price, quote);
  announce({ type: "swap", market, isBuy });

  const { protocol, routed } = splitFee(fee);
  const routedRecipient = m.routing === SINK_CREATOR ? m.routed_recipient : null;
  const common = { market, quoteAsset: m.quote_asset, venue: "curve" as const, ...base, ts };
  await recordFeeEvent(db, { ...common, kind: "protocol", recipient: null, amount: protocol });
  await recordFeeEvent(db, { ...common, kind: "routed", recipient: routedRecipient, amount: routed });
  if (creatorTax > 0n) {
    await recordFeeEvent(db, { ...common, kind: "tax", recipient: m.tax_recipient, amount: creatorTax });
  }
  await refreshMarketRewards(db, market);

  if (routedRecipient) announce({ type: "fees", market, recipient: routedRecipient });
  if (creatorTax > 0n && m.tax_recipient) announce({ type: "fees", market, recipient: m.tax_recipient });
}
