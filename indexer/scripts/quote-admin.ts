/**
 * Edit what the UI shows about a quote asset.
 *
 *     npx tsx scripts/quote-admin.ts <id-or-address> [--symbol S] [--name N] [--kind stablecoin]
 *         [--blurb "…"] [--underlying U] [--icon-domain d.com] [--id newid] [--sort 3]
 *
 * On-chain columns (registered, enabled, decimals, quote_target) are never editable here: they are
 * whatever the QuoteRegistry last said, and a hand-edited `decimals` would silently misprice every
 * market quoted in that asset.
 */
import { createDatabase } from "../src/db/index.js";

const COLUMNS: Record<string, string> = {
  "--symbol": "symbol",
  "--name": "name",
  "--kind": "kind",
  "--blurb": "blurb",
  "--underlying": "underlying",
  "--icon-domain": "icon_domain",
  "--id": "id",
  "--sort": "sort_order",
};

async function main(): Promise<void> {
  const [key, ...rest] = process.argv.slice(2);
  if (!key) throw new Error("usage: quote-admin <id-or-address> --column value …");
  const sets: string[] = [];
  const params: unknown[] = [key.toLowerCase()];
  for (let i = 0; i < rest.length; i += 2) {
    const col = COLUMNS[rest[i]!];
    if (!col) throw new Error(`unknown option ${rest[i]}`);
    params.push(col === "sort_order" ? Number(rest[i + 1]) : rest[i + 1]);
    // Interpolated only from the whitelist above; the VALUE is always a bound parameter.
    sets.push(`${col} = $${params.length}`);
  }
  if (sets.length === 0) throw new Error("nothing to set");
  const database = createDatabase({ url: process.env.DATABASE_URL, poolSize: 1 });
  await database.connect();
  const r = await database.legacy.query(
    `UPDATE quote_assets SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $1 OR address = $1`,
    params,
  );
  console.log(`${r.rowCount ?? 0} row(s) updated`);
  await database.disconnect();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
