import type { Db } from "../db/legacy.js";
import { createLogger } from "../utils/logger.js";
import {
  type ExplorerIo,
  InvalidKeyError,
  type ProxyOutcome,
  redactedUrl,
  type RetryPolicy,
  type VerifierConfig,
  verifyProxy,
} from "./explorer.js";

/**
 * The process-wide clone verifier the ingester hands every launch to.
 *
 * Same shape as `metadata/publisher.ts`, for the same reason: the handler that sees a launch is
 * deep inside the ingest loop, and verification is a side effect the loop must never wait on or
 * fail for. `configure` runs once at boot; `queueCloneVerification` is fire-and-forget; every
 * outcome — verified, still pending at the explorer, refused — lands in `contract_verifications`
 * so a restart does not re-submit and `scripts/verify-clones.ts` can finish what a process could
 * not wait for.
 *
 * Calls are serialised: Etherscan-family keys are rate limited per second and a launch burst
 * would otherwise turn into a burst of 429s. An invalid key disarms the queue for the life of the
 * process (one error line, not one per launch); a missing key means it was never armed.
 */

const log = createLogger().child({ component: "contract-verifier" });

export type CloneKind = "token" | "curve";

export interface CloneVerification {
  address: string;
  kind: CloneKind;
  implementation: string;
}

interface VerifierState {
  db: Db;
  config: VerifierConfig;
  io: ExplorerIo;
  policy: RetryPolicy | undefined;
}

let state: VerifierState | null = null;
let disarmed: string | null = null;
let inFlight: Promise<void> = Promise.resolve();
const counts = { verified: 0, pending: 0, failed: 0, skipped: 0 };

export function configureContractVerifier(
  s: { db: Db; config: VerifierConfig | null; io?: ExplorerIo; policy?: RetryPolicy },
): void {
  state = s.config ? { db: s.db, config: s.config, io: s.io ?? {}, policy: s.policy } : null;
  disarmed = null;
}

export function contractVerifierEnabled(): boolean {
  return state !== null && disarmed === null;
}

export function contractVerifierCounts(): typeof counts & { disarmed: string | null } {
  return { ...counts, disarmed };
}

/** What the table says about an address, or nothing. */
export async function recordedVerification(
  db: Db,
  address: string,
): Promise<{ status: string; guid: string | null } | undefined> {
  const { rows } = await db.query<{ status: string; guid: string | null }>(
    "SELECT status, guid FROM contract_verifications WHERE address = $1",
    [address.toLowerCase()],
  );
  return rows[0];
}

export async function recordVerification(
  db: Db,
  c: CloneVerification,
  outcome: ProxyOutcome,
  explorer = "monadscan",
): Promise<void> {
  const status = outcome.state === "pending" ? "submitted" : outcome.state;
  await db.query(
    `INSERT INTO contract_verifications
       (address, kind, implementation, explorer, status, guid, attempts, last_error, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
     ON CONFLICT (address) DO UPDATE SET
       status = EXCLUDED.status, guid = EXCLUDED.guid,
       attempts = contract_verifications.attempts + EXCLUDED.attempts,
       last_error = EXCLUDED.last_error, updated_at = NOW()`,
    [
      c.address.toLowerCase(),
      c.kind,
      c.implementation.toLowerCase(),
      explorer,
      status,
      outcome.guid,
      outcome.attempts,
      outcome.state === "verified" ? null : outcome.message,
    ],
  );
}

/**
 * One clone through the explorer, with the outcome persisted. Shared by the queue and the
 * backfill; throws only `InvalidKeyError` (so the caller can disarm) or an exhausted retry.
 */
export async function verifyClone(s: VerifierState, c: CloneVerification): Promise<ProxyOutcome> {
  const outcome = await verifyProxy(
    s.config,
    { address: c.address, expectedImplementation: c.implementation },
    s.io,
    s.policy,
  );
  await recordVerification(s.db, c, outcome);
  return outcome;
}

/** Queue one clone. Serialised behind whatever is already in flight; never throws. */
export function queueCloneVerification(c: CloneVerification): void {
  if (!state || disarmed || !c.implementation) {
    counts.skipped += 1;
    return;
  }
  const s = state;
  inFlight = inFlight
    .then(async () => {
      const prior = await recordedVerification(s.db, c.address);
      if (prior?.status === "verified") {
        counts.skipped += 1;
        return;
      }
      const outcome = await verifyClone(s, c);
      counts[outcome.state] += 1;
      const fields = { address: c.address, kind: c.kind, guid: outcome.guid, attempts: outcome.attempts, explorer: outcome.message };
      if (outcome.state === "verified") log.info("clone verified as a proxy of its implementation", fields);
      else if (outcome.state === "pending") log.info("clone verification still pending at the explorer; the backfill will finish it", fields);
      else log.warn("clone verification refused by the explorer", fields);
    })
    .catch((error: unknown) => {
      if (error instanceof InvalidKeyError) {
        disarmed = error.message;
        log.error("contract verifier disarmed: the explorer rejected the API key", {
          endpoint: redactedUrl(s.config, { module: "contract", action: "verifyproxycontract" }),
        });
        return;
      }
      counts.failed += 1;
      log.warn("clone verification failed; scripts/verify-clones.ts retries it", {
        address: c.address,
        kind: c.kind,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

/** For tests and the backfill script: wait for everything queued so far. */
export function contractVerifierIdle(): Promise<void> {
  return inFlight;
}
