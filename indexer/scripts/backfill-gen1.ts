/**
 * One-off: set `routing` on gen-1 markets that had not graduated when the column arrived.
 *
 * The gen-1 `MarketLaunched` carries `sink` and the indexer never stored it. Rather than a full
 * re-scan, this asks the node for that one event from the gen-1 factory, in batches the public
 * RPC accepts, and writes the sink kind onto rows that still have routing = NULL.
 *
 *     cd indexer && npx tsx scripts/backfill-gen1.ts
 */
import { createPublicClient, http } from "viem";
import { readConfig } from "../src/config/index.js";
import { createDatabase } from "../src/db/index.js";
import { factoryAbi } from "../src/indexer/abi.js";
import { createLogger } from "../src/utils/logger.js";

async function main(): Promise<void> {
  const log = createLogger();
  const config = readConfig(process.env);
  const database = createDatabase({ url: config.databaseUrl, poolSize: 2 });
  await database.connect();
  const db = database.legacy;
  const client = createPublicClient({ transport: http(config.chain.rpcUrl) });

  const { rows } = await db.query<{ market_address: string; block_number: string }>(
    "SELECT market_address, block_number::text AS block_number FROM markets WHERE generation = 1 AND routing IS NULL ORDER BY block_number",
  );
  if (rows.length === 0) {
    log.info("nothing to backfill");
    await database.disconnect();
    return;
  }

  const batch = config.chain.batchSize;
  let updated = 0;
  for (const row of rows) {
    const at = BigInt(row.block_number);
    const logs = await client.getLogs({
      address: config.chain.factory,
      event: factoryAbi[0],
      args: { curve: row.market_address as `0x${string}` },
      fromBlock: at,
      toBlock: at + batch - 1n,
    });
    const launched = logs[0];
    if (!launched) {
      log.warn("no launch log", { market: row.market_address });
      continue;
    }
    await db.query("UPDATE markets SET routing = $2 WHERE market_address = $1 AND routing IS NULL", [
      row.market_address,
      Number(launched.args.sink),
    ]);
    updated++;
  }
  log.info("backfilled", { updated, of: rows.length });
  await database.disconnect();
}

main().catch((err: unknown) => {
  createLogger().error("backfill failed", { error: err });
  process.exit(1);
});
