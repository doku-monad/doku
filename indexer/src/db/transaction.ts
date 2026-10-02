import type { PrismaClient } from "@prisma/client";

import { withRetry } from "./retry.js";

/**
 * The client inside a transaction.
 *
 * Prisma's interactive-transaction callback receives a client with the lifecycle methods removed —
 * you cannot `$connect`, `$disconnect` or nest a `$transaction` inside one. Naming that type is
 * what lets a repository declare "I can run inside a transaction" in its signature.
 */
export type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

/** Anything a repository can run against: the client itself, or an open transaction. */
export type Queryable = PrismaClient | Tx;

export interface TransactionOptions {
  /** How long the callback may hold the transaction open. */
  timeoutMs?: number;
  /** How long to wait for a connection before giving up. */
  maxWaitMs?: number;
}

/**
 * Run `work` inside one transaction, retrying the whole thing on transient failure.
 *
 * The retry wraps the *transaction*, not the statements inside it: once a transaction has failed
 * on a lost connection or a deadlock, every statement in it has been rolled back, and the only
 * correct response is to run all of them again. Retrying an individual statement inside a dead
 * transaction just produces "current transaction is aborted" for each one.
 *
 * A serialisation failure or deadlock — 40001, 40P01 — is exactly the case this exists for: the
 * database is telling us to try again, and the ingest pass is idempotent, so trying again is safe.
 */
export async function withTransaction<T>(
  prisma: PrismaClient,
  work: (tx: Tx) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const { timeoutMs = 30_000, maxWaitMs = 5_000 } = options;
  return withRetry(() =>
    prisma.$transaction((tx) => work(tx), { timeout: timeoutMs, maxWait: maxWaitMs }),
  );
}
