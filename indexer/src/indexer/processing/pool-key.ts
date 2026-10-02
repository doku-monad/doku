import { encodeAbiParameters, keccak256 } from "viem";

/** Uniswap v4 `PoolKey`, lowercase addresses. */
export interface PoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

/**
 * What `DokuGraduation` passes for every pool it creates: `LP_FEE = 0`, `TICK_SPACING = 60`.
 *
 * Read off the contract, not the plan — `contracts/src/DokuGraduation.sol` lines 93-94 — because
 * a constant that drifts from the deployed one produces a key that hashes to a pool nothing is
 * at, and the only thing that catches it is the id check below.
 */
export const DOKU_POOL_FEE = 0;
export const DOKU_TICK_SPACING = 60;

/**
 * The key a gen-2 graduation builds: currencies sorted ascending as v4 requires, native MON being
 * address(0) and therefore always first when it is the quote.
 *
 * This is only ever used TOGETHER with `poolIdOf` and a comparison against the emitted id. A key
 * rebuilt from constants is one refactor away from a pool that does not exist; the check is what
 * turns "assumed" into "verified".
 */
export function poolKeyFor(quote: string, token: string, hooks: string): PoolKey {
  const a = quote.toLowerCase();
  const b = token.toLowerCase();
  const [currency0, currency1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return {
    currency0,
    currency1,
    fee: DOKU_POOL_FEE,
    tickSpacing: DOKU_TICK_SPACING,
    hooks: hooks.toLowerCase(),
  };
}

/** `PoolId = keccak256(abi.encode(key))`, lowercase hex. */
export function poolIdOf(key: PoolKey): string {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [
        key.currency0 as `0x${string}`,
        key.currency1 as `0x${string}`,
        key.fee,
        key.tickSpacing,
        key.hooks as `0x${string}`,
      ],
    ),
  ).toLowerCase();
}
