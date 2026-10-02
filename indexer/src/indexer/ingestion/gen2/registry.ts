import type { Db } from "../../../db/legacy.js";

/**
 * The QuoteRegistry's three events. Rows are keyed by `id`; the address finds an existing one.
 *
 * The chain wins on `decimals`. The catalogue's value is presentational and the frontend's is
 * wrong for gold — it says 18; XAUt0 is 6 — and `decimals` is what every amount on a market
 * quoted in that asset is scaled by, so a stale one is a price out by twelve orders of magnitude.
 */
export async function handleRegistryEvent(
  db: Db,
  eventName: string,
  a: Record<string, unknown>,
  emitter: string,
  block: string,
  cfg: { quoteRegistry?: string },
): Promise<void> {
  if (!cfg.quoteRegistry || emitter.toLowerCase() !== cfg.quoteRegistry.toLowerCase()) return;
  const asset = String(a.asset).toLowerCase();
  switch (eventName) {
    case "QuoteAssetRegistered":
      await db.query(
        // `ON CONFLICT (address)` relies on the UNIQUE on `address`: a catalogue row already
        // carrying this address is updated in place and keeps its `id`, so the UI's `usdc` stays
        // `usdc`. An asset the catalogue does not know inserts fresh with its address as the `id`,
        // symbol null, for an admin to name later — `/quotes` renders a short address until then.
        `INSERT INTO quote_assets (id, address, decimals, quote_target, registered, enabled, block_number, updated_at)
         VALUES ($1,$1,$2,$3,TRUE,TRUE,$4,NOW())
         ON CONFLICT (address) DO UPDATE SET decimals = EXCLUDED.decimals, quote_target = EXCLUDED.quote_target,
           registered = TRUE, enabled = TRUE, block_number = EXCLUDED.block_number, updated_at = NOW()`,
        [asset, Number(a.decimals), String(a.quoteTarget), block],
      );
      return;
    case "QuoteTargetChanged":
      await db.query(
        "UPDATE quote_assets SET quote_target = $2, updated_at = NOW() WHERE address = $1",
        [asset, String(a.current)],
      );
      return;
    case "QuoteAssetEnabled":
      await db.query("UPDATE quote_assets SET enabled = $2, updated_at = NOW() WHERE address = $1", [
        asset,
        Boolean(a.enabled),
      ]);
      return;
  }
}
