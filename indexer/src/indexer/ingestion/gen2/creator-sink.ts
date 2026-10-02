import type { Db } from "../../../db/legacy.js";
import type { LiveEvent } from "../../../websocket/live.js";
import { SINK_CREATOR } from "../../generations.js";
import { recordFeeEvent, refreshCreatorBalance, refreshMarketRewards } from "../../processing/fees.js";
import type { LogBase } from "./launch.js";

const addr = (v: unknown): string => String(v).toLowerCase();

/**
 * One signed movement, and the balance it feeds.
 *
 * `claimable` and `earned_lifetime` are two different questions about the same money and they are
 * answered by two different events, so every row states both deltas explicitly rather than
 * inferring one from the other.
 */
async function ledger(
  db: Db,
  who: string,
  quote: string,
  market: string | null,
  kind: string,
  claimable: bigint,
  earned: bigint,
  base: LogBase,
  ts: Date,
): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO creator_ledger (who, quote_asset, market_address, kind, claimable_delta, earned_delta,
                                 block_number, block_hash, log_index, tx_hash, ts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (tx_hash, log_index, kind) DO NOTHING RETURNING id`,
    [
      who,
      quote,
      market,
      kind,
      claimable.toString(),
      earned.toString(),
      base.block,
      base.hash,
      base.idx,
      base.tx,
      ts,
    ],
  );
  if ((r.rowCount ?? 0) === 0) return false;
  await refreshCreatorBalance(db, who, quote);
  return true;
}

/** A market's payee columns, as they stand before an event moves them. */
interface Recipients {
  routed: string | null;
  tax: string | null;
}

/**
 * Move a market's payee, and record the move.
 *
 * `markets.routed_recipient` and `markets.tax_recipient` are a cache of the newest
 * `recipient_updates` row, exactly as the metadata columns cache `metadata_updates`. The history
 * row is written FIRST and gates the column update, so the two can never disagree about whether
 * this log has been applied, and the previous value is always still on the row below it — which is
 * what lets `rewindTo` put the payee back when a reorg orphans one of these logs.
 *
 * The row holds a SNAPSHOT of both columns rather than the leg this event moved, because restoring
 * needs both and because the effective value is not always the event's argument: see `Registered`.
 */
async function setRecipients(
  db: Db,
  market: string,
  next: (current: Recipients, routing: number | null) => Recipients,
  base: LogBase,
  ts: Date,
): Promise<void> {
  const { rows } = await db.query<{
    routed_recipient: string | null;
    tax_recipient: string | null;
    routing: number | null;
  }>(
    `SELECT routed_recipient, tax_recipient, routing FROM markets
      WHERE market_address = $1 AND generation = 2`,
    [market],
  );
  const m = rows[0];
  if (!m) return;

  const value = next(
    { routed: m.routed_recipient, tax: m.tax_recipient },
    m.routing === null ? null : Number(m.routing),
  );
  const inserted = await db.query(
    `INSERT INTO recipient_updates (market_address, routed_recipient, tax_recipient,
                                    block_number, block_hash, log_index, tx_hash, ts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tx_hash, log_index) DO NOTHING RETURNING id`,
    [market, value.routed, value.tax, base.block, base.hash, base.idx, base.tx, ts],
  );
  if (inserted.rowCount === 0) return;

  await db.query(
    "UPDATE markets SET routed_recipient = $2, tax_recipient = $3 WHERE market_address = $1",
    [market, value.routed, value.tax],
  );
}

/**
 * The shared CreatorSink: every movement of creator money that is not a direct push.
 *
 * WHICH EVENT OWNS WHICH NUMBER, because on this contract two events describe the same payment and
 * getting that wrong doubles a figure nobody would question:
 *
 *   `claimable`  is owned by `Credited` and `Claimed`, and by nothing else. Those two are exactly
 *                the writes the contract makes to its `claimable[who][quote]` mapping, so this
 *                projection equals that mapping — which is the only number a `claim()` will
 *                actually pay out.
 *   `earned`     is owned by whichever event described the market GENERATING the money: Task 6's
 *                `pushed` row for a curve collection, and `Pulled` here for pool-side income.
 *
 * That split is forced by the contract, twice over:
 *
 *   `pull()` emits `Credited` for each non-zero leg AND a `Pulled` summarising the same two
 *   amounts. Both booking claimable would show a creator twice what they can withdraw.
 *
 *   `BondingCurve.collectFees` emits `FeesCollected(person, amount)` and then, if that push
 *   reverts, calls `credit(who = person, …)` — one payment, two logs, one transaction. Task 6
 *   already booked the earning on the first, so `Credited` booking it again would double every
 *   deferred creator's lifetime total. (The recipient on the collection event is never the sink:
 *   `feeRecipient()` is only consulted on the non-CREATOR branch, which never reaches this
 *   contract at all.)
 */
export async function handleCreatorSinkEvent(
  db: Db,
  eventName: string,
  a: Record<string, unknown>,
  sinkAddress: string,
  ts: Date,
  base: LogBase,
  cfg: { creatorSink?: string },
  announce: (event: LiveEvent) => void,
): Promise<void> {
  if (!cfg.creatorSink || sinkAddress.toLowerCase() !== cfg.creatorSink.toLowerCase()) return;

  switch (eventName) {
    case "Registered": {
      // R2: graduation registers the CreatorSink for every market with a creator tax, and for a
      // non-CREATOR market the `routed` leg is that market's OWN SINK (a RewardVault or the
      // BurnSink), not a person. Writing it into `routed_recipient` would put a contract on the
      // /markets row and make the vault show up as a payee in GET /creators/:vault. Only a
      // CREATOR market has a routed recipient worth recording.
      await setRecipients(
        db,
        addr(a.market),
        (current, routing) => ({
          routed: routing === SINK_CREATOR ? addr(a.routed) : current.routed,
          tax: addr(a.tax),
        }),
        base,
        ts,
      );
      return;
    }
    case "Credited": {
      const who = addr(a.who);
      const quote = addr(a.quote);
      const amount = BigInt(String(a.amount));
      // The crediting market is msg.sender on chain and not on the event; attributed by the
      // recipient's markets for the frame, and left null on the ledger row.
      // `Credited.kind` (R14) is decoded but both forms land as one ledger kind. If
      // `GET /creators/:a` ever needs routed income split from tax income without a join back to
      // `markets`, split this into "credited_routed" / "credited_tax" — the event already says which.
      if (await ledger(db, who, quote, null, "credited", amount, 0n, base, ts)) {
        const { rows } = await db.query<{ market_address: string }>(
          `SELECT market_address FROM markets WHERE generation = 2 AND quote_asset = $2
            AND (routed_recipient = $1 OR tax_recipient = $1)`,
          [who, quote],
        );
        for (const r of rows) announce({ type: "fees", market: r.market_address, recipient: who });
      }
      return;
    }
    case "Pulled": {
      const market = addr(a.market);
      const { rows } = await db.query<{
        quote_asset: string;
        routed_recipient: string | null;
        tax_recipient: string | null;
      }>(
        "SELECT quote_asset, routed_recipient, tax_recipient FROM markets WHERE market_address = $1",
        [market],
      );
      const m = rows[0];
      if (!m) return;
      const routed = BigInt(String(a.routedAmount));
      const tax = BigInt(String(a.taxAmount));
      // Earned only. The claimable half of this same pull arrived as the `Credited` logs the
      // contract emitted immediately before this one.
      //
      // And COLLECTED, on the market's own ledger. Since generation 4 the hook books its 70% sink
      // share to `pendingSink` (no `donate`), so every pool swap on a CREATOR market lands here as
      // a `routed` fee event with `venue: "pool"` — income the creator is owed but has not yet been
      // handed. `pull` is the moment it is handed over, and until this write existed nothing
      // netted it: `/rewards` reported the pulled hook levy as still pending, one swap's routed
      // share above the curve's `pendingFees()` for ever. The curve's `FeesCollected` is the
      // collection event for curve fees; this is the one for pool fees. One log, two kinds, and
      // the `(tx_hash, log_index, kind)` key keeps both idempotent.
      const common = { market, quoteAsset: m.quote_asset, venue: "sink" as const, ...base, ts };
      let netted = false;
      if (routed > 0n) {
        netted =
          (await recordFeeEvent(db, { ...common, kind: "routed_collected", recipient: m.routed_recipient, amount: routed })) || netted;
      }
      if (tax > 0n) {
        netted =
          (await recordFeeEvent(db, { ...common, kind: "tax_collected", recipient: m.tax_recipient, amount: tax })) || netted;
      }
      if (netted) await refreshMarketRewards(db, market);
      if (routed > 0n && m.routed_recipient) {
        if (
          await ledger(db, m.routed_recipient, m.quote_asset, market, "pulled_routed", 0n, routed, base, ts)
        )
          announce({ type: "fees", market, recipient: m.routed_recipient });
      }
      if (tax > 0n && m.tax_recipient) {
        if (await ledger(db, m.tax_recipient, m.quote_asset, market, "pulled_tax", 0n, tax, base, ts))
          announce({ type: "fees", market, recipient: m.tax_recipient });
      }
      return;
    }
    case "Claimed": {
      const who = addr(a.who);
      const quote = addr(a.quote);
      const amount = BigInt(String(a.amount));
      await ledger(db, who, quote, null, "claimed", -amount, 0n, base, ts);
      return;
    }
    case "RecipientTransferred": {
      // `transferRecipient` moves the routed leg alone; the creator tax keeps its payee.
      await setRecipients(
        db,
        addr(a.market),
        (current) => ({ routed: addr(a.to), tax: current.tax }),
        base,
        ts,
      );
      return;
    }
  }
}
