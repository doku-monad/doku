/**
 * Retrying the database failures that are worth retrying, and none of the ones that are not.
 *
 * The distinction matters more than the backoff. A dropped connection, a pool timeout, a database
 * restarting mid-deploy — those succeed on the next attempt. A unique-constraint violation, a
 * malformed query, a foreign key that does not exist — those fail identically every time, and
 * retrying them turns a clear error into the same error reported five times as slowly, after a
 * delay, with the original stack buried.
 *
 * Jitter is not decoration. Every connection in the pool fails at the same instant when a database
 * goes away, so a pure exponential schedule has them all wake together and stampede the moment it
 * comes back.
 */

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  /** Injected in tests so they do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/**
 * Postgres error codes worth another attempt.
 *
 * Class 08 is connection exceptions; 40001/40P01 are serialisation failure and deadlock, both of
 * which mean "your transaction lost, run it again"; 57P01/57P03 are the server shutting down or
 * refusing connections while it starts.
 */
const RETRYABLE_PG_CODES = new Set([
  "08000", "08003", "08006", "08001", "08004", "08007", "08P01",
  "40001", "40P01",
  "57P01", "57P03",
  "53300", // too many connections
]);

/** Prisma wraps connection problems in these rather than surfacing a pg code. */
const RETRYABLE_PRISMA_CODES = new Set([
  "P1000", // authentication failed — transient during a credential rotation
  "P1001", // cannot reach database server
  "P1002", // database server reachable but timed out
  "P1008", // operation timed out
  "P1017", // server has closed the connection
  "P2024", // timed out fetching a connection from the pool
]);

export function isRetryable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code: unknown = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    if (RETRYABLE_PG_CODES.has(code) || RETRYABLE_PRISMA_CODES.has(code)) return true;
    // Node's own socket failures, which surface when the pool dials a host that is not there.
    if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT") return true;
  }
  return false;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `work`, retrying only transient failures.
 *
 * Bounded on purpose. An unbounded retry loop against a database that is genuinely gone is a
 * service that never reports itself unhealthy, which is the failure mode the brief calls out.
 */
export async function withRetry<T>(work: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    attempts = 5,
    baseMs = 100,
    maxMs = 5_000,
    sleep = defaultSleep,
    onRetry,
  } = options;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts) throw error;

      // Full jitter: a random point in [0, ceiling]. Keeps a pool's worth of connections from
      // retrying in lockstep after a shared outage.
      const ceiling = Math.min(baseMs * 2 ** (attempt - 1), maxMs);
      const delay = Math.round(Math.random() * ceiling);
      onRetry?.(error, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}
