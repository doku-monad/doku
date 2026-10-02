import { encodeAbiParameters, keccak256, parseAbiParameters } from "viem";

import type { LiquidityPoolKey } from "./liquidity-calls";

/**
 * A v4 pool's identity.
 *
 * There is no pool contract to hold an address. Every pool lives inside the one PoolManager and is
 * addressed by `keccak256(abi.encode(poolKey))` — so every read that V3 did by calling a pool
 * (`slot0`, `liquidity`) is done here by passing this to StateView instead.
 *
 * `abi.encode`, not `encodePacked`. The struct is encoded with each field padded to 32 bytes, and
 * packing instead produces a completely different, perfectly valid-looking hash that simply
 * addresses no pool — every read against it returns zeros, which reads as "this pool has never
 * been initialised" rather than as an encoding mistake.
 */
export function poolIdFrom(key: LiquidityPoolKey): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        "(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)",
      ),
      [
        {
          currency0: key.currency0,
          currency1: key.currency1,
          fee: key.fee,
          tickSpacing: key.tickSpacing,
          hooks: key.hooks,
        },
      ],
    ),
  );
}
