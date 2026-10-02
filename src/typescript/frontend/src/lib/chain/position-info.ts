/**
 * Unpacking v4's `PositionInfo`.
 *
 * V3 returned a position as a twelve-field tuple and the ABI decoder did the work. v4 packs the
 * same facts into one `uint256` and hands it over whole:
 *
 *     200 bits poolId | 24 bits tickUpper | 24 bits tickLower | 8 bits hasSubscriber
 *
 * The ticks are `int24`, and that is the whole reason this is a module with tests rather than two
 * shifts at the call site. Every range below the current price has a NEGATIVE lower tick, and a
 * signed field read as unsigned does not error — it returns roughly 16.7 million, which is past
 * `MAX_TICK`, so the position silently reads as an enormous range somewhere off the top of the
 * price scale. The amounts computed from it are wrong, the "in range" badge is wrong, and nothing
 * anywhere throws.
 */

const MASK_24 = 0xffffffn;
const SIGN_BIT_24 = 0x800000n;
const TWO_POW_24 = 0x1000000n;

const TICK_LOWER_OFFSET = 8n;
const TICK_UPPER_OFFSET = 32n;

/** Reads a 24-bit two's-complement field as a signed number. */
function toInt24(raw: bigint): number {
  const masked = raw & MASK_24;
  return Number(masked >= SIGN_BIT_24 ? masked - TWO_POW_24 : masked);
}

export interface PositionInfo {
  tickLower: number;
  tickUpper: number;
  /** Whether the position is subscribed to a notifier. Nothing here uses it; decoded for clarity. */
  hasSubscriber: boolean;
}

/**
 * @param info the packed `uint256` from `getPoolAndPositionInfo`
 *
 * A position that does not exist decodes to all zeros, which is a real, empty range rather than an
 * error — callers distinguish it by liquidity, not by this.
 */
export function decodePositionInfo(info: bigint): PositionInfo {
  if (info < 0n) throw new Error("position info is a uint256");
  return {
    tickLower: toInt24(info >> TICK_LOWER_OFFSET),
    tickUpper: toInt24(info >> TICK_UPPER_OFFSET),
    hasSubscriber: (info & 0xffn) !== 0n,
  };
}
