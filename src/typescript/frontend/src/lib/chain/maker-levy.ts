/**
 * The levy a liquidity provider pays on entry and exit, and why the panel has to know it.
 *
 * `DokuHook` charges the maker on both `afterAddLiquidity` and `afterRemoveLiquidity`. The charge
 * is a hook delta added to the caller's, so the token a mint actually pulls is NOT the amount
 * Uniswap's `LiquidityAmounts` pairs — it is that amount plus the levy on it. Pairing without the
 * levy understates the cost of every deposit, and understates it by exactly enough to make the one
 * deposit people reach for most — the whole balance — impossible: the mint asks for `balance` plus
 * the levy, Permit2's `transferFrom` fails on the shortfall, and the panel reports
 * `TRANSFER_FROM_FAILED`, which names the mechanism and not one thing the person can act on.
 *
 * ## The rates are read off the SWAP levy, not off the market's recorded maker rates
 *
 * `DokuHook.markets(poolId)` stores `makerBps0` and `makerBps1`, and reading those would be the
 * obvious thing to do here. It is wrong against every hook deployed so far. `_makerLevy` charges
 * `_bps0`/`_bps1` — the SWAP rates — while `registerMarket` validates the recorded fields against
 * `wantMaker0`/`wantMaker1`, which are deliberately the swap rates WITHOUT the LP share. The two
 * agreed until the LP share was introduced, because it used to be `SINK_LEVY_BPS` and both
 * expressions read it. They do not agree now:
 *
 *     BURN market   _bps1 = LP share = 75      markets(id).makerBps1 = SINK_LEVY_BPS = 0
 *
 * So a BURN market records a maker levy of zero on the token leg and charges seventy-five basis
 * points of it — that 75 is `LEGACY_HOOK_LP_SHARE_BPS` below, not `config.ts`'s `LP_LEVY_BPS`; see
 * that constant for why the two have stopped being the same number.
 *
 * ## Why this does not import `LP_LEVY_BPS` from `config.ts`
 *
 * That constant mirrors `contracts/src/v4/DokuHook.sol` — generation 4's source, not-yet-deployed
 * at the time of writing (`docs/doku/deployments.md` shows generation 3 as the live mainnet hook).
 * Generation 4 also fixes the recorded-vs-charged divergence this section describes: its
 * `registerPool` records `makerBps0`/`makerBps1` as EXACTLY what `_makerLevy` charges, so once a
 * market has graduated under it the reconstruction below is no longer even necessary for that
 * market. But `useMakerLevy` reads `markets(poolId)` off WHICHEVER hook a market's pool key actually
 * carries — generation 2 and 3 hooks are live today and keep answering for every market already
 * graduated under them, forever (a hook address is part of a `PoolKey`; there is no migration).
 * Reusing generation 4's `LP_LEVY_BPS` here would silently apply the wrong, not-yet-relevant rate to
 * every position that exists right now, which is exactly the `TRANSFER_FROM_FAILED` regression the
 * comment above describes — reintroduced by an import instead of a bug. `LEGACY_HOOK_LP_SHARE_BPS`
 * is `docs/doku/deployments.md`'s pinned mainnet reading for the CURRENTLY live hook, verified
 * against a real deposit by bisection in `tests/unit/maker-levy.test.ts`.
 *
 * This file mirrors `_bps0`/`_bps1`, because a frontend's job is to predict what the deployed code
 * DOES. The divergence is a contract defect and wants fixing in the contract; a hook address is a
 * `PoolKey` field, so fixing it produces a different pool and cannot reach the pools already live.
 * Once a market exists under generation 4, this function needs a branch on which hook answered —
 * not written here, because none does yet.
 */

/**
 * The LP share of the swap levy on the hook that is actually live today — generation 3,
 * `0xb1A67a7c…6Fcf` per `docs/doku/deployments.md` — NOT `config.ts`'s `LP_LEVY_BPS`, which now
 * mirrors generation 4's not-yet-deployed source. See this file's docblock for why the two differ.
 */
const LEGACY_HOOK_LP_SHARE_BPS = 75;

/** `Sinks.BURN`. The market burns its levy, taken in its own token. */
export const SINK_BURN = 0;
/** `Sinks.REWARDS`. The market pays its levy out in MON, so it is levied in MON. */
export const SINK_REWARDS = 1;

/** How a market is configured, as `DokuHook.markets(poolId)` reports it. */
export interface MarketLevyConfig {
  sink: number;
  protocolBps: number;
}

/** The maker levy in basis points, per currency. `bps0` is MON; `bps1` is the market's token. */
export interface MakerLevy {
  bps0: number;
  bps1: number;
}

/** No market read yet, or a pool this hook does not know. Charging nothing is what it does. */
export const NO_LEVY: MakerLevy = { bps0: 0, bps1: 0 };

/**
 * `DokuHook._bps0` and `_bps1`, which is what `_makerLevy` multiplies by.
 *
 * An unregistered market reads zero rates and is levied nothing — the hook's documented fail-open —
 * and a caller that has not read the market yet should pass nothing rather than guess.
 */
export function makerLevyBps(market: MarketLevyConfig | null): MakerLevy {
  if (!market) return NO_LEVY;
  return {
    bps0: market.sink === SINK_REWARDS ? market.protocolBps + LEGACY_HOOK_LP_SHARE_BPS : market.protocolBps,
    bps1: market.sink === SINK_BURN ? LEGACY_HOOK_LP_SHARE_BPS : 0,
  };
}

/**
 * What settling `amount` costs once the hook has taken its cut.
 *
 * Floor division, matching `_makerLevy`'s `(uint256(a) * bps) / BPS` exactly. Rounding this up
 * "to be safe" would put the panel's arithmetic a wei away from the contract's on every deposit,
 * and the balance check and the Max button are both equality-sensitive at the top of a balance.
 */
export function withLevy(amount: bigint, bps: number): bigint {
  if (amount < 0n) throw new Error("an amount cannot be negative");
  if (bps < 0) throw new Error(`a levy cannot be negative: ${bps}`);
  return amount + (amount * BigInt(bps)) / 10_000n;
}

/**
 * The largest deposit whose levied cost still fits inside `balance`.
 *
 * What the Max button is actually asking for. `balance` itself is not it: the mint would pull
 * `balance` plus the levy, which by definition is not there. Flooring is what makes the result
 * safe rather than borderline — `d * (10000 + bps) <= balance * 10000` holds for the floor, so
 * `withLevy(d, bps) <= balance` holds too.
 */
export function depositWithin(balance: bigint, bps: number): bigint {
  if (balance < 0n) throw new Error("a balance cannot be negative");
  if (bps < 0) throw new Error(`a levy cannot be negative: ${bps}`);
  return (balance * 10_000n) / BigInt(10_000 + bps);
}
