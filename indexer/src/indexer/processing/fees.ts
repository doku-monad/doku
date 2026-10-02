import type { Db } from "../../db/legacy.js";

/**
 * The fee ledger and its projections.
 *
 * Every fee component is a ROW in `fee_events` first — one per component per log — and the
 * per-market totals in `market_rewards` and the per-recipient balances in `creator_balances` are
 * recomputed from those rows. Recomputed, not accumulated: an accumulator cannot be corrected
 * after a reorg without knowing every delta that went into it, which is the mistake the holder
 * counter avoided by storing balances, and this module avoids the same way.
 */
export type FeeKind =
  | "protocol"
  | "routed"
  | "tax"
  | "protocol_collected"
  | "routed_collected"
  | "tax_collected"
  | "dividend_funded"
  | "dividend"
  | "burn";

export interface FeeEventInput {
  market: string;
  kind: FeeKind;
  recipient: string | null;
  quoteAsset: string;
  amount: bigint;
  venue: "curve" | "pool" | "sink";
  block: string;
  hash: string;
  idx: number;
  tx: string;
  ts: Date;
}

/** Inserts one component. Returns false when the row already existed (replay). */
export async function recordFeeEvent(db: Db, e: FeeEventInput): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO fee_events (market_address, kind, recipient, quote_asset, amount, venue,
                             block_number, block_hash, log_index, tx_hash, ts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (tx_hash, log_index, kind) DO NOTHING RETURNING id`,
    [
      e.market,
      e.kind,
      e.recipient,
      e.quoteAsset,
      e.amount.toString(),
      e.venue,
      e.block,
      e.hash,
      e.idx,
      e.tx,
      e.ts,
    ],
  );
  return (r.rowCount ?? 0) > 0;
}

const REWARDS_SQL = `
  INSERT INTO market_rewards (market_address, protocol_generated, protocol_collected,
                              routed_generated, routed_collected, tax_generated, tax_collected,
                              dividends_funded, dividends_paid, burned_tokens, updated_at)
  SELECT m.market_address,
         COALESCE(SUM(f.amount) FILTER (WHERE f.kind = 'protocol'), 0),
         COALESCE(SUM(f.amount) FILTER (WHERE f.kind = 'protocol_collected'), 0),
         COALESCE(SUM(f.amount) FILTER (WHERE f.kind = 'routed'), 0),
         COALESCE(SUM(f.amount) FILTER (WHERE f.kind = 'routed_collected'), 0),
         COALESCE(SUM(f.amount) FILTER (WHERE f.kind = 'tax'), 0),
         COALESCE(SUM(f.amount) FILTER (WHERE f.kind = 'tax_collected'), 0),
         COALESCE(SUM(f.amount) FILTER (WHERE f.kind = 'dividend_funded'), 0),
         COALESCE(SUM(f.amount) FILTER (WHERE f.kind = 'dividend'), 0),
         COALESCE(SUM(f.amount) FILTER (WHERE f.kind = 'burn'), 0),
         NOW()
    FROM markets m
    LEFT JOIN fee_events f ON f.market_address = m.market_address
   WHERE ($1::text IS NULL OR m.market_address = $1)
   GROUP BY m.market_address
  ON CONFLICT (market_address) DO UPDATE SET
    protocol_generated = EXCLUDED.protocol_generated, protocol_collected = EXCLUDED.protocol_collected,
    routed_generated = EXCLUDED.routed_generated, routed_collected = EXCLUDED.routed_collected,
    tax_generated = EXCLUDED.tax_generated, tax_collected = EXCLUDED.tax_collected,
    dividends_funded = EXCLUDED.dividends_funded, dividends_paid = EXCLUDED.dividends_paid,
    burned_tokens = EXCLUDED.burned_tokens, updated_at = NOW()`;

/** Recompute one market's totals (or every market's, with null) from its fee rows. */
export async function refreshMarketRewards(db: Db, market: string | null): Promise<void> {
  await db.query(REWARDS_SQL, [market]);
}

const BALANCES_SQL = `
  INSERT INTO creator_balances (who, quote_asset, claimable, earned_lifetime, updated_at)
  SELECT who, quote_asset, SUM(claimable_delta), SUM(earned_delta), NOW()
    FROM creator_ledger
   WHERE ($1::text IS NULL OR (who = $1 AND quote_asset = $2))
   GROUP BY who, quote_asset
  ON CONFLICT (who, quote_asset) DO UPDATE SET
    claimable = EXCLUDED.claimable, earned_lifetime = EXCLUDED.earned_lifetime, updated_at = NOW()`;

export async function refreshCreatorBalance(
  db: Db,
  who: string | null,
  quote: string | null,
): Promise<void> {
  await db.query(BALANCES_SQL, [who, quote]);
}

/** After a rewind: drop the projections and rebuild both from the rows that survived. */
export async function rebuildFeeProjections(db: Db): Promise<void> {
  await db.query("DELETE FROM creator_balances");
  await refreshCreatorBalance(db, null, null);
  await refreshMarketRewards(db, null);
}

/** Split an emitted 1% fee into the protocol's 30 and the routed 70 (interface.md). */
export function splitFee(fee: bigint): { protocol: bigint; routed: bigint } {
  const protocol = (fee * 30n) / 100n;
  return { protocol, routed: fee - protocol };
}
