/**
 * Finish or redo explorer verification for every served market's clones.
 *
 * The in-process verifier gives each launch a bounded wait; whatever was still pending at the
 * explorer, refused, or launched before the verifier existed is picked up here. Idempotent.
 *
 *   DATABASE_URL=… MONAD_RPC_URL=… DOKU_FACTORY2_ADDRESS=… MONADSCAN_API_KEY=… \
 *   pnpm tsx scripts/verify-clones.ts [--dry] [--only-failed]
 */
import { createPublicClient, http } from "viem";
import { createDatabase } from "../src/db/index.js";
import { servedFrom } from "../src/repositories/served.js";
import { pollProxy, readVerifierConfig } from "../src/verification/explorer.js";
import { recordedVerification, recordVerification, verifyClone } from "../src/verification/verifier.js";

const dry = process.argv.includes("--dry");
const onlyFailed = process.argv.includes("--only-failed");
const chainId = Number(process.env.MONAD_CHAIN_ID ?? 143);
const config = readVerifierConfig(process.env, chainId);
if (!config && !dry) throw new Error("MONADSCAN_API_KEY is required (or pass --dry)");
const factory = process.env.DOKU_FACTORY2_ADDRESS as `0x${string}` | undefined;
if (!factory) throw new Error("DOKU_FACTORY2_ADDRESS is required");
const rpc = process.env.MONAD_RPC_URL;
if (!rpc) throw new Error("MONAD_RPC_URL is required");

const abi = [
  { type: "function", name: "tokenImplementation", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "curveImplementation", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const client = createPublicClient({ transport: http(rpc) });
const [tokenImpl, curveImpl] = await Promise.all([
  client.readContract({ address: factory, abi, functionName: "tokenImplementation" }),
  client.readContract({ address: factory, abi, functionName: "curveImplementation" }),
]);

const database = createDatabase();
const db = database.legacy;
const { rows } = await db.query<{ market_address: string; token_address: string }>(
  `SELECT market_address, token_address FROM markets
    WHERE generation = 2 AND block_number >= $1 ORDER BY block_number`,
  [servedFrom().toString()],
);
const clones = rows.flatMap((r) => [
  { address: r.token_address, kind: "token" as const, implementation: tokenImpl },
  { address: r.market_address, kind: "curve" as const, implementation: curveImpl },
]);
const tally = { verified: 0, pending: 0, failed: 0, skipped: 0 };
for (const c of clones) {
  const prior = await recordedVerification(db, c.address);
  if (prior?.status === "verified" || (onlyFailed && prior?.status !== "failed")) {
    tally.skipped += 1;
    continue;
  }
  if (dry || !config) {
    console.log("would verify", c.kind, c.address, "→", c.implementation, prior ? `(was ${prior.status})` : "");
    continue;
  }
  try {
    const outcome =
      prior?.status === "submitted" && prior.guid
        ? await pollProxy(config, prior.guid)
        : await verifyClone({ db, config, io: {}, policy: undefined }, c);
    if (prior?.status === "submitted" && prior.guid) await recordVerification(db, c, outcome);
    tally[outcome.state] += 1;
    console.log(outcome.state, c.kind, c.address, outcome.message);
  } catch (e) {
    tally.failed += 1;
    console.error("failed", c.kind, c.address, e instanceof Error ? e.message : e);
  }
}
console.log(tally);
await database.disconnect();
