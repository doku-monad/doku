/**
 * The utilities that outlived the Aptos SDK.
 *
 * Gone with it: an Aptos client, type-tag parsing, write-set resource extraction, balance-change
 * parsing, Q64 price conversion and the bonding-curve maths. Every one of them described either a
 * Move transaction's shape or that curve's specific constants.
 *
 * What is left is generic: hex handling, bigint comparison, number validation, emoji byte counting.
 */
export * from "./compare-bigint";
export * from "./hex";
export * from "./misc";
export * from "./sum-emoji-bytes";
export * from "./validation";
export * from "./validation_";
