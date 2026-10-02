/**
 * A v4 pool's key, as the chain recorded it.
 *
 * Its own module so the swap and liquidity paths can take one without importing `addresses.ts`,
 * which reads `NEXT_PUBLIC_*` at load and therefore cannot appear in anything unit-tested.
 */
export interface PoolKeyLike {
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
}

/**
 * The two currencies of a pool, in the order the `PoolKey` must carry them.
 *
 * v4 sorts by address ascending, and the sorted key is what `poolIdFrom` hashes — so this is not a
 * presentation detail. A key assembled the other way round hashes to a pool that does not exist,
 * every read against it returns zeros, and the market renders as one that has never traded.
 *
 * It used to be a constant. Every DOKU pool was MON against a token and `address(0)` sorts below
 * every address, so `currency0` was always native MON. A market priced in USDC or in gold has no
 * such guarantee, and the token can land on either side of its own quote.
 *
 * Compared as BigInts rather than as strings: `"0xF…" < "0xa…"` is true in ASCII and false as an
 * address, so a checksummed row and a lower-cased constant would sort differently and produce a
 * key that addresses nothing.
 */
export function sortCurrencies(
  a: `0x${string}`,
  b: `0x${string}`,
): [`0x${string}`, `0x${string}`] {
  const left = a.toLowerCase() as `0x${string}`;
  const right = b.toLowerCase() as `0x${string}`;
  if (left === right) {
    throw new Error(`a pool needs two different currencies, got ${left} twice`);
  }
  return BigInt(left) < BigInt(right) ? [left, right] : [right, left];
}
