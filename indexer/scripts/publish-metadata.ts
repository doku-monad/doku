/**
 * Republish every served market's metadata document.
 *
 * A backfill (tokens launched before the publisher existed) or a repair (a bucket outage during
 * ingest). Reads the current metadata off `markets`, which is what the chain last said, and PUTs
 * one document per market. Idempotent; run as often as you like.
 *
 *   DATABASE_URL=… R2_ACCOUNT_ID=… R2_BUCKET=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… \
 *   R2_PUBLIC_BASE_URL=https://cdn.doku.family pnpm tsx scripts/publish-metadata.ts [--dry]
 */
import { createDatabase } from "../src/db/index.js";
import { servedFrom } from "../src/repositories/served.js";
import { publishTokenMetadata, readMetadataStore, buildTokenMetadata } from "../src/metadata/token-metadata.js";

const dry = process.argv.includes("--dry");
const store = readMetadataStore(process.env);
if (!store && !dry) throw new Error("R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY are required (or pass --dry)");

const database = createDatabase();
const db = database.legacy;
const { rows } = await db.query<{
  token_address: string; name: string; ticker: string | null; description: string | null; logo_uri: string | null;
  banner_uri: string | null; website: string | null; x: string | null; telegram: string | null;
}>(
  `SELECT token_address, name, ticker, description, logo_uri, banner_uri, website, x, telegram
     FROM markets WHERE generation = 2 AND block_number >= $1 ORDER BY block_number`,
  [servedFrom().toString()],
);
let ok = 0;
for (const r of rows) {
  const input = {
    tokenAddress: r.token_address, name: r.name, ticker: r.ticker ?? r.name, description: r.description,
    logoUri: r.logo_uri, bannerUri: r.banner_uri, website: r.website, x: r.x, telegram: r.telegram,
  };
  if (dry || !store) {
    console.log(r.token_address, JSON.stringify(buildTokenMetadata(input, process.env.METADATA_SITE_URL)));
    continue;
  }
  try {
    const out = await publishTokenMetadata(store, input, { siteUrl: process.env.METADATA_SITE_URL });
    ok += 1;
    console.log("published", out.url ?? out.key);
  } catch (e) {
    console.error("failed", r.token_address, e instanceof Error ? e.message : e);
  }
}
console.log(`${ok}/${rows.length} published`);
await database.disconnect();
