/**
 * Small shared type helpers.
 *
 * What used to live here — Move struct mirrors, PostgREST row shapes, arena types — described an
 * Aptos deployment and is gone. These two are language-level utilities and outlived it.
 */

/** A number that may arrive as any of the three ways JSON and the EVM express one. */
export type AnyNumberString = number | bigint | string;

/**
 * Flatten a type to remove any nested properties from unions and intersections.
 * {@link https://twitter.com/mattpocockuk/status/1622730173446557697}
 */
export type Flatten<T> = { [K in keyof T]: T[K] } & NonNullable<unknown>;
