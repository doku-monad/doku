/**
 * What a position has earned and not yet taken: nothing, by construction, on the hook a market
 * graduates under from here on.
 *
 * ## The fee is not the pool's fee, and donation is gone too
 *
 * `PoolKey.fee` on a DOKU pool is zero and has to stay zero — the levy is skimmed from the swap's
 * flash accounting, which a non-zero pool fee makes unimplementable. So a position here earns
 * nothing from `PoolKey.fee`, ever. For a while that was not the whole story: `DokuHook.LP_LEVY_BPS`
 * donated part of every swap's levy to the pool's in-range positions through `poolManager.donate`,
 * which credited fee growth exactly as a fee would, and this module said so — a constant zero would
 * have quietly under-reported real donation income.
 *
 * Generation 4 removes the donation. `_settleLeg` books that same share straight to the market's
 * `pendingSink` ledger instead of to whichever position happens to be in range at the post-swap
 * tick — see `LP_LEVY_BPS`'s docblock in `contracts/src/v4/DokuHook.sol` for the round-3 audit
 * finding (a narrow band at a trade's end tick collecting a disproportionate share) that motivated
 * moving the money. So zero is, once again, the exact and complete answer for a market graduated
 * under this hook, not a placeholder standing in for "not measured yet".
 *
 * `useMakerLevy` reads a market's own hook off its `PoolKey`, so a market still on generation 2 or 3
 * — every one that exists at the time of writing, `docs/doku/deployments.md` — genuinely does still
 * earn a small amount from the donation that hook keeps paying, forever. `POSITIONS_EARN_FEES` does
 * not branch on that: it states the truth for what the liquidity feature is offering someone TODAY,
 * on the hook new markets actually graduate into, which is the honest question a person deciding
 * whether to add liquidity is asking. Distinguishing per-market would mean reading which hook backs
 * a specific position before rendering anything about it — real, and not done here.
 */

export interface FeeAmounts {
  amount0: bigint;
  amount1: bigint;
}

/**
 * Whether providing liquidity in a DOKU pool earns anything: it does not.
 *
 * `PoolKey.fee` is zero by construction (see `POOL_FEE_TIER`) and the swap levy's LP share is
 * credited to the market's sink, not donated to a position (see `LP_LEVY_BPS`). Exported so the UI
 * renders an honest "earns nothing" rather than implying a yield that no longer exists.
 */
export const POSITIONS_EARN_FEES = false;

/**
 * Accrued fees per position, keyed by token id as a string.
 *
 * Always empty — not "not quoted yet", but genuinely nothing: no fee has ever accrued to a position
 * from `PoolKey.fee`, and the hook no longer donates. Kept as a function rather than inlined at each
 * call site so the day either of those stops being true, there is one place to change and every
 * caller updates with it, the same reasoning `POSITIONS_EARN_FEES` follows.
 */
export function quoteFees(_tokenIds: readonly bigint[]): Map<string, FeeAmounts> {
  return new Map();
}
