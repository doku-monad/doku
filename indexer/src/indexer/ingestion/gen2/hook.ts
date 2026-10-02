import type { Db } from "../../../db/legacy.js";
import type { LiveEvent } from "../../../websocket/live.js";
import { recordFeeEvent, refreshMarketRewards } from "../../processing/fees.js";
import { SINK_CREATOR } from "../../generations.js";
import type { LogBase } from "./launch.js";

interface PoolMarket {
  market_address: string;
  quote_asset: string;
  routing: number | null;
  routed_recipient: string | null;
  tax_recipient: string | null;
}

/**
 * The market a pool belongs to.
 *
 * By pool id, because that is the only thing a hook event carries that identifies anything: the
 * hook is one contract for every DOKU pool, so `log.address` says which protocol emitted the log
 * and nothing about which market it concerns.
 */
async function marketOfPool(db: Db, id: string): Promise<PoolMarket | undefined> {
  const { rows } = await db.query<PoolMarket>(
    `SELECT m.market_address, m.quote_asset, m.routing, m.routed_recipient, m.tax_recipient
       FROM graduations g JOIN markets m USING (market_address) WHERE g.pool_id = $1`,
    [id],
  );
  return rows[0];
}

/**
 * The gen-2 hook's per-swap creator tax and its periodic sweep.
 *
 * After graduation the 1% is levied inside the pool rather than on the curve, so this is where a
 * graduated market keeps generating. `TaxLevied` is the creator tax on one swap's quote leg;
 * `Swept` is the hook moving accrued protocol and sink shares into the buckets that owe them,
 * which is the closest the hook gets to announcing that the routed share was "generated".
 *
 * Only `DOKU_HOOK2` is followed. Generation-1 hooks emit a `Swept` of their own and generation-1
 * rewards stay out of this ledger by design — their `/rewards` answer is null-filled — so a levy
 * from any other address is another protocol's, or an older one's, and is not ours to count.
 */
export async function handleHookEvent(
  db: Db,
  eventName: "TaxLevied" | "Swept",
  a: Record<string, unknown>,
  hookAddress: string,
  ts: Date,
  base: LogBase,
  cfg: { hook2?: string },
  announce: (event: LiveEvent) => void,
): Promise<void> {
  if (!cfg.hook2 || hookAddress.toLowerCase() !== cfg.hook2.toLowerCase()) return;
  const m = await marketOfPool(db, String(a.id).toLowerCase());
  if (!m) return;
  const common = {
    market: m.market_address,
    quoteAsset: m.quote_asset,
    venue: "pool" as const,
    ...base,
    ts,
  };

  if (eventName === "TaxLevied") {
    const fresh = await recordFeeEvent(db, {
      ...common,
      kind: "tax",
      recipient: m.tax_recipient,
      amount: BigInt(String(a.amount)),
    });
    if (!fresh) return;
    await refreshMarketRewards(db, m.market_address);
    if (m.tax_recipient) announce({ type: "fees", market: m.market_address, recipient: m.tax_recipient });
    return;
  }

  // Only a CREATOR-routed market has somebody to name here. On BURN and REWARDS the sink is a
  // contract, and writing its address into `recipient` would put a vault in the list of people
  // owed money.
  const routedRecipient = m.routing === SINK_CREATOR ? m.routed_recipient : null;
  const fresh = await recordFeeEvent(db, {
    ...common,
    kind: "protocol",
    recipient: null,
    amount: BigInt(String(a.protocolAmount)),
  });
  await recordFeeEvent(db, {
    ...common,
    kind: "routed",
    recipient: routedRecipient,
    amount: BigInt(String(a.sinkAmount)),
  });
  if (!fresh) return;
  await refreshMarketRewards(db, m.market_address);
  if (routedRecipient) announce({ type: "fees", market: m.market_address, recipient: routedRecipient });
}
