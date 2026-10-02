/**
 * Clamping a caller-supplied page size.
 *
 * A limit is always bounded and always a positive integer. Unbounded, `?limit=1000000` is a single
 * request that reads the whole table; unvalidated, `?limit=abc` becomes `NaN`, which Postgres
 * rejects with a type error the caller reads as "the server is broken".
 */
export function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

/** An address as it is stored: lowercase. Logs carry EIP-55 checksummed, the database does not. */
export function normalizeAddress(raw: string): string {
  return raw.toLowerCase();
}
