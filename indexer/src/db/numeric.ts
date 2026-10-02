import { Prisma } from "@prisma/client";

/**
 * Moving token amounts between Postgres `NUMERIC(78,0)` and JavaScript `bigint`.
 *
 * This is the one conversion in the service that must never be done ad hoc, because getting it
 * wrong is silent. Prisma maps `NUMERIC` to a `Decimal`, and `Decimal.toString()` switches to
 * exponential notation above 1e21 — so a token supply of 1e27 stringifies as `"1e+27"`, and
 * `BigInt("1e+27")` does not round-trip badly, it *throws*. Amounts on this chain are 18-decimal
 * fixed point, so essentially every balance is past that threshold.
 *
 * `toFixed(0)` is the correct call. Verified exact across the whole column range, including the
 * 78-digit maximum:
 *
 *     1, 1e18, 1e27, 39 digits, 78 nines  →  all exact, all round-trip through BigInt
 *
 * The value itself was never at risk — Prisma's Decimal carries all 78 significant digits. Only
 * the default string form is lossy-looking, which is worse than an outright failure would be.
 */

/** A `NUMERIC(78,0)` column as read by Prisma, as a `bigint`. */
export function toBigInt(value: Prisma.Decimal): bigint {
  return BigInt(value.toFixed(0));
}

/** The same, for a column that is nullable. */
export function toBigIntOrNull(value: Prisma.Decimal | null): bigint | null {
  return value === null ? null : toBigInt(value);
}

/**
 * A `bigint` on its way into a `NUMERIC(78,0)` column.
 *
 * Prisma accepts a string here and parses it exactly. Passing the `bigint` directly does not work:
 * Prisma's Decimal constructor takes `string | number | Decimal`, and routing an amount through
 * `number` is precisely the rounding this module exists to prevent.
 */
export function toNumeric(value: bigint): Prisma.Decimal {
  return new Prisma.Decimal(value.toString());
}

/** Postgres `BIGINT`, which Prisma already gives us as a `bigint`, as a decimal string. */
export function blockToString(value: bigint): string {
  return value.toString();
}
