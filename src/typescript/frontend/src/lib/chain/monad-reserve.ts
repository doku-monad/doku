/**
 * Monad keeps a reserve balance, and a trade that ignores it reverts.
 *
 * The chain holds back **10 MON per account**. A transaction that decrements the balance and would
 * leave it below that reverts at execution — the error a trader sees is a reserve balance
 * violation, on a trade the app told them it could afford. It is a consensus rule that exists
 * because Monad executes asynchronously: consensus has to bound what inflight transactions can
 * spend before it knows what they did.
 *
 * There is one exemption, and it is why anybody holding less than 10 MON can trade at all. An
 * "emptying transaction" may spend down past the reserve, and qualifies when the sender is
 * undelegated, has sent no other transaction in the past few blocks, and has no delegation change
 * pending. Blocks are sub-second, so at human pace almost every trade qualifies — which is exactly
 * why this failure looks intermittent. Launch a coin and immediately buy it and the second
 * transaction is inside that window, is not an emptying transaction, and reverts.
 *
 * None of that is knowable from here: whether the exemption applies depends on what the wallet has
 * done in the last second. So this module does not refuse anything the chain might allow. It sizes
 * the max button so the common case needs no exemption, and it says plainly when a trade is relying
 * on one.
 *
 * @see https://docs.monad.xyz/developer-essentials/reserve-balance
 */

/** 10 MON. The protocol's number, not a safety margin of ours. */
export const MONAD_RESERVE_WEI = 10_000_000_000_000_000_000n;

export type ReserveVerdict =
  /** Lands above the reserve. Needs no exemption and cannot fail for this reason. */
  | "safe"
  /** Would dip below the reserve. Goes through only as an emptying transaction. */
  | "emptying"
  /** The balance cannot cover the spend and its gas at all, reserve or no reserve. */
  | "insufficient";

export function reserveVerdict(input: {
  /** Native MON balance, in wei. */
  balance: bigint;
  /** What the trade spends, in wei. Zero is always safe. */
  spend: bigint;
  /** What the transaction's gas will cost, in wei — see `nativeGasHeadroom`. */
  gas: bigint;
}): ReserveVerdict {
  if (input.spend <= 0n) return "safe";
  if (input.spend + input.gas > input.balance) return "insufficient";
  /* A strict dip. Ending exactly ON the reserve does not violate it, and rounding that boundary
     the cautious way would refuse a trade the chain accepts. */
  return input.balance - input.spend - input.gas >= MONAD_RESERVE_WEI ? "safe" : "emptying";
}

/**
 * What would put this transaction back above the reserve.
 *
 * The number, not the rule. "Keep 10 MON spare" is arithmetic over three figures a trader cannot
 * see — their balance, what they are spending, and the gas nobody quotes them — and every one of
 * those moves as they type. `Add 9.9643 MON` is the same fact already worked out.
 *
 * Zero when the transaction already clears the reserve, so a caller can treat it as "nothing to
 * say" without a second condition.
 */
export function reserveShortfall(input: { balance: bigint; spend: bigint; gas: bigint }): bigint {
  const needed = MONAD_RESERVE_WEI + input.spend + input.gas;
  return needed > input.balance ? needed - input.balance : 0n;
}

/**
 * The largest native amount a max button should offer.
 *
 * Above the reserve it stops at the reserve, so pressing max produces a trade that needs no
 * exemption and cannot revert for this reason. That is the whole fix: the button used to withhold
 * a flat 0.01 MON, which is less than the gas a buy reserves and nine hundred times less than the
 * protocol's own threshold, so max reverted for anyone holding more than a token amount.
 *
 * Below the reserve it offers the balance less gas instead. Withholding a reserve that is already
 * out of reach would offer zero to an account that can, in practice, trade its whole balance —
 * every spend there needs the emptying exemption anyway, so withholding buys nothing.
 */
export function maxNativeSpend(input: { balance: bigint; gas: bigint }): bigint {
  const spendable = input.balance - input.gas;
  if (spendable <= 0n) return 0n;
  const aboveReserve = spendable - MONAD_RESERVE_WEI;
  return aboveReserve > 0n ? aboveReserve : spendable;
}

/**
 * What to reserve for gas, from the fee the chain is actually charging.
 *
 * Monad bills the gas LIMIT rather than the gas used, so the reservation is the limit times the max
 * fee and not an estimate of consumption. A curve buy measures around 131,000 gas on mainnet and a
 * buy that fills the curve carries the graduation hint, which is 2.5 million — twenty times more.
 * Sizing this off a constant is what produced a max button that could not pay for itself.
 *
 * @param gasLimit the limit the transaction will carry.
 * @param maxFeePerGas the ceiling the wallet will sign for.
 */
export function nativeGasHeadroom(gasLimit: bigint, maxFeePerGas: bigint): bigint {
  return gasLimit * maxFeePerGas;
}
