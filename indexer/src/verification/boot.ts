import type { PublicClient } from "viem";
import type { Db } from "../db/legacy.js";
import { setCloneImplementations } from "../indexer/ingestion/gen2/launch.js";
import { createLogger } from "../utils/logger.js";
import { readVerifierConfig, sourcifyStatus } from "./explorer.js";
import { configureContractVerifier, queueCloneVerification } from "./verifier.js";

const log = createLogger().child({ component: "contract-verifier" });

const factoryAbi = [
  { type: "function", name: "tokenImplementation", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "curveImplementation", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

/**
 * Arm the clone verifier at boot: read the two implementations off the factory, hand them to the
 * launch handler, configure the queue if a key exists, and say where the implementations stand on
 * Sourcify (MonadVision) — the one thing a per-clone call cannot fix. Never throws: a failure here
 * costs verification, not indexing.
 */
export async function armContractVerifier(opts: {
  db: Db;
  client: PublicClient;
  factory: `0x${string}`;
  chainId: number;
  env: Record<string, string | undefined>;
}): Promise<void> {
  const config = readVerifierConfig(opts.env, opts.chainId);
  try {
    const [token, curve] = await Promise.all([
      opts.client.readContract({ address: opts.factory, abi: factoryAbi, functionName: "tokenImplementation" }),
      opts.client.readContract({ address: opts.factory, abi: factoryAbi, functionName: "curveImplementation" }),
    ]);
    setCloneImplementations({ token, curve });
    configureContractVerifier({ db: opts.db, config });
    if (config) await requeueUnverified(opts.db);
    log.info(config ? "contract verifier armed (MonadScan)" : "contract verifier off (no MONADSCAN_API_KEY)", {
      tokenImplementation: token,
      curveImplementation: curve,
    });
    const sourcify = config?.sourcifyUrl ?? readVerifierConfig({ MONADSCAN_API_KEY: "-" }, opts.chainId)!.sourcifyUrl;
    const [tokenStatus, curveStatus] = await Promise.all([
      sourcifyStatus(sourcify, opts.chainId, token),
      sourcifyStatus(sourcify, opts.chainId, curve),
    ]);
    const fields = { tokenImplementation: tokenStatus, curveImplementation: curveStatus, sourcify };
    if (tokenStatus === "unverified" || curveStatus === "unverified") {
      log.warn("an implementation is NOT verified on Sourcify/MonadVision; clones will show no source there until contracts/script/verify.sh runs", fields);
    } else {
      log.info("implementations on Sourcify/MonadVision", fields);
    }
  } catch (error) {
    configureContractVerifier({ db: opts.db, config: null });
    log.warn("contract verifier off: could not read the implementations off the factory", {
      factory: opts.factory,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Re-queue every clone the table does not yet call verified: a nudge refused because the explorer
 * had not indexed the clone yet, a guid the process could not wait out, a launch during an outage.
 * Bounded, oldest first, and the queue's own dedupe skips anything verified meanwhile.
 */
async function requeueUnverified(db: Db): Promise<void> {
  const { rows } = await db.query<{ address: string; kind: "token" | "curve"; implementation: string }>(
    `SELECT address, kind, implementation FROM contract_verifications
      WHERE status <> 'verified' ORDER BY updated_at ASC LIMIT 200`,
  );
  for (const r of rows) queueCloneVerification({ address: r.address, kind: r.kind, implementation: r.implementation });
  if (rows.length) log.info("re-queued clones the explorer has not confirmed yet", { count: rows.length });
}
