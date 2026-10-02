import type { Db } from "../db/legacy.js";

/**
 * Seed `hidden_creators` from `HIDDEN_CREATORS`, a comma-separated list of wallet addresses.
 *
 * Additive and idempotent: an address already in the table keeps its row and its reason, and an
 * address an operator inserted by hand is never removed because it is missing from the variable.
 * Hiding is therefore the union of the deployment's configuration and the database, and removing
 * a wallet from the list is a deliberate `DELETE`, not a redeploy.
 *
 * @returns the addresses the variable named, lowercased, for the boot log.
 */
export async function ensureHiddenCreators(db: Db, raw: string | undefined): Promise<string[]> {
  const addresses = (raw ?? "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  for (const address of addresses) {
    await db.query(
      `INSERT INTO hidden_creators (address, reason) VALUES ($1, 'HIDDEN_CREATORS')
       ON CONFLICT (address) DO NOTHING`,
      [address],
    );
  }
  return addresses;
}
