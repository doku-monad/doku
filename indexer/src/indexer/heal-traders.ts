import type { PublicClient } from "viem";

import type { Db } from "../db/legacy.js";

/**
 * Repairs pool swaps whose trader was recorded as the string `"undefined"`.
 *
 * v4's `Swap` event has no `recipient` field. The ingester read one anyway, and the result went
 * through `String()` on its way into a text column, so every post-graduation trade was attributed
 * to a trader literally named "undefined". A NULL would have been caught by the first join that
 * expected an address; a four-character string is a perfectly ordinary value that simply is not
 * anybody, so the trade feed and the portfolio queries carried it without complaint.
 *
 * Runs once at startup rather than as a schema migration, because the correct value is not in the
 * database — it is the sender of the transaction that carried the log, which takes an RPC call per
 * affected row. Self-limiting: after the ingester stopped writing the literal, this matches nothing
 * and costs one indexed lookup per boot.
 *
 * Deliberately does not touch rows it cannot resolve. A swap attributed to the wrong address is
 * worse than one still visibly attributed to nobody.
 */
export async function healUndefinedTraders(
  client: PublicClient,
  db: Db,
  log: {
    info: (message: string, fields?: Record<string, unknown>) => void;
    warn: (message: string, fields?: Record<string, unknown>) => void;
  },
): Promise<number> {
  const { rows } = await db.query<{ tx_hash: string }>(
    "SELECT DISTINCT tx_hash FROM swaps WHERE trader = 'undefined'",
  );
  if (rows.length === 0) return 0;

  let healed = 0;
  for (const { tx_hash } of rows) {
    try {
      const tx = await client.getTransaction({ hash: tx_hash as `0x${string}` });
      const { rowCount } = await db.query(
        "UPDATE swaps SET trader = $1 WHERE tx_hash = $2 AND trader = 'undefined'",
        [tx.from.toLowerCase(), tx_hash],
      );
      healed += rowCount ?? 0;
    } catch (error) {
      log.warn("could not resolve the trader for a swap; leaving it", { tx: tx_hash, error });
    }
  }
  log.info("repaired swaps with an unresolved trader", {
    transactions: rows.length,
    rows: healed,
  });
  return healed;
}
