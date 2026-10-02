import type { Db } from "../../../db/legacy.js";
import type { LiveEvent } from "../../../websocket/live.js";
import {
  type FeeKind,
  recordFeeEvent,
  refreshCreatorBalance,
  refreshMarketRewards,
} from "../../processing/fees.js";
import { SINK_CREATOR } from "../../generations.js";
import type { LogBase } from "./launch.js";

const KIND: Record<string, FeeKind> = {
  FeesCollected: "routed_collected",
  TaxCollected: "tax_collected",
  ProtocolFeesCollected: "protocol_collected",
};

/**
 * Money leaving a gen-2 curve.
 *
 * Every collection lowers the market's pending figure. The routed and tax collections are also
 * income for a person -- recorded as `pushed` in the creator ledger: earned, never claimable,
 * because the curve paid them directly. A push that fell back to the CreatorSink is the same
 * earning: `collectFees` emits `FeesCollected(person, amount)` and only then calls
 * `credit(who = person, ...)`, so the recipient here is the person either way and the credit that
 * follows moves claimable alone (see gen2/creator-sink.ts).
 *
 * EXCEPT on a market that does not route to a creator. `feeRecipient()` returns the market's OWN
 * SINK for BURN and REWARDS, so a dividends market's `FeesCollected` names its reward vault --
 * and that money is holder income, booked as `dividend_funded` when the vault reports it. A
 * `pushed` row for it would be unclaimable but would still count a contract as an earner, and the
 * same amount would sit in two aggregates under two meanings.
 *
 * Gated on `routing` rather than on the sink address: the two are equivalent by construction, and
 * `routing` is on the market from its launch event while `graduations.sink` does not arrive until
 * the deferred `PoolRegistered`. Reading the address here would misfile every collection the
 * indexer saw before that log.
 */
export async function handleCollection(
  db: Db,
  eventName: string,
  market: string,
  a: Record<string, unknown>,
  ts: Date,
  base: LogBase,
  announce: (event: LiveEvent) => void,
): Promise<void> {
  const kind = KIND[eventName];
  if (!kind) return;
  const { rows } = await db.query<{ generation: number; quote_asset: string; routing: number | null }>(
    "SELECT generation, quote_asset, routing FROM markets WHERE market_address = $1",
    [market],
  );
  const m = rows[0];
  // Gen-1 curves emit `FeesCollected(address,uint256)` under the same selector and were never
  // indexed. The generation on the market row is the gate; there is no address to filter by,
  // because every curve is its own address.
  if (!m || Number(m.generation) !== 2) return;

  const recipient = String(a.recipient).toLowerCase();
  const amount = BigInt(String(a.amount));
  const fresh = await recordFeeEvent(db, {
    market,
    kind,
    recipient,
    quoteAsset: m.quote_asset,
    amount,
    venue: "curve",
    ...base,
    ts,
  });
  if (!fresh) return;
  await refreshMarketRewards(db, market);

  if (kind === "protocol_collected") return;
  // The routed leg belongs to a person only on a CREATOR market; the tax leg always does.
  if (kind === "routed_collected" && Number(m.routing) !== SINK_CREATOR) return;

  await db.query(
    `INSERT INTO creator_ledger (who, quote_asset, market_address, kind, claimable_delta, earned_delta,
                                 block_number, block_hash, log_index, tx_hash, ts)
     VALUES ($1,$2,$3,'pushed',0,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (tx_hash, log_index, kind) DO NOTHING`,
    [
      recipient,
      m.quote_asset,
      market,
      amount.toString(),
      base.block,
      base.hash,
      base.idx,
      base.tx,
      ts,
    ],
  );
  await refreshCreatorBalance(db, recipient, m.quote_asset);
  announce({ type: "fees", market, recipient });
}
