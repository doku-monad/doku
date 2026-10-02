import type { Db } from "../../db/legacy.js";

/**
 * Holder counts, derived from ERC20 `Transfer` logs.
 *
 * Counted rather than estimated: the number on a market card is one people compare between
 * markets, and an approximation that drifts is worse than no number at all.
 *
 * Balances are tracked per address so the count is a query rather than a running total. A running
 * total cannot be corrected after a reorg without replaying every transfer, whereas balances can
 * simply be recomputed for the affected range.
 */
/**
 * The supply side of the same `Transfer` log that `applyTransfer` handles.
 *
 * Supply moves in BOTH directions and the column has to follow it both ways. A mint is supply
 * being created; a burn is supply being destroyed — and burns are not an edge case here, because
 * every market's tax buys its own token back and burns it, from the first taxed buy, while the
 * curve is still open.
 *
 * Counting only mints makes `total_supply` monotonically increasing against a live supply that
 * falls, and nothing ever re-reads the chain to correct it. The error is NOT the burned fraction:
 * if a fraction `b` is burned, the stored figure is `1/(1-b)` times the live one, so market cap is
 * overstated by `1/(1-b) - 1`. Measured live supply at fill gives +58.81% / +36.92% / +10.86% /
 * +3.20% at a 30-second / 5-minute / 30-minute / 1-day fill. `market_cap` and `ath_market_cap` are
 * both computed from this column and the explore grid sorts on it, so the whole ordering is wrong
 * by a fill-speed-dependent amount that never self-corrects.
 *
 * It lives next to `applyTransfer` because the two are the balance side and the supply side of one
 * fact, and separating them is how the supply half came to be missing in the first place.
 */
export async function applySupplyDelta(
  db: Db,
  market: string,
  from: string,
  to: string,
  value: bigint,
): Promise<void> {
  const ZERO = "0x0000000000000000000000000000000000000000";
  if (from === ZERO) {
    await db.query(
      "UPDATE markets SET total_supply = total_supply + $2 WHERE market_address = $1",
      [market, value.toString()],
    );
  } else if (to === ZERO) {
    await db.query(
      "UPDATE markets SET total_supply = total_supply - $2 WHERE market_address = $1",
      [market, value.toString()],
    );
  }
}

export async function applyTransfer(
  db: Db,
  token: string,
  from: string,
  to: string,
  value: bigint,
): Promise<void> {
  const ZERO = "0x0000000000000000000000000000000000000000";

  // Mints come from the zero address and burns go to it; neither is a holder.
  if (from !== ZERO) {
    await db.query(
      `UPDATE token_balances SET balance = balance - $3
        WHERE token_address = $1 AND holder = $2`,
      [token, from, value.toString()],
    );
  }
  if (to !== ZERO) {
    await db.query(
      `INSERT INTO token_balances (token_address, holder, balance)
       VALUES ($1, $2, $3)
       ON CONFLICT (token_address, holder) DO UPDATE
       SET balance = token_balances.balance + EXCLUDED.balance`,
      [token, to, value.toString()],
    );
  }
}

/**
 * The address a burn sends to, which is not a holder and must never be counted as one.
 *
 * Distinct from the zero address: `ERC20Burnable.burn` moves to zero and reduces supply, while
 * graduation's dust sweep on a REWARDS market *transfers* to this one. Tokens here are gone in
 * every sense that matters and nobody can sign for it.
 */
const DEAD = "0x000000000000000000000000000000000000dead";

/**
 * Recount holders for a market.
 *
 * ## This list must match `RewardVault`'s, and it is the same list for a different reason
 *
 * On-chain the exclusion set decides who gets *paid*: an address left in `eligibleSupply` that
 * cannot claim dilutes everyone who can, and the difference is stranded forever. Here it decides
 * what a market card *says*. The two lists have to agree — a market whose header claims 500 holders
 * while the vault pays 497 is reporting a number that means nothing — which is why this is written
 * out address by address rather than left to whatever the join happens to reach.
 *
 * Every one of these is a contract that holds a real balance and is not a person:
 *
 *   - the CURVE, which holds the unsold supply;
 *   - the TOKEN itself, which nothing sends to but which must never count if anything does;
 *   - the POOL, which under v4 is the PoolManager singleton. It really does custody every
 *     graduated market's tokens, so the column that is useless for routing is exactly right here;
 *   - the HOOK, which holds a BURN market's levy between `sweep` and `burn` — a balance that grows
 *     with volume, which is the ratchet the exclusion set exists to stop;
 *   - the SINK, which graduation sweeps its dust into and which accrues the market's share;
 *   - the GRADUATION contract, which holds tokens for the span of one transaction;
 *   - DEAD, where a REWARDS market's token dust is sent.
 *
 * `PositionManager` is in the on-chain set and deliberately not here: under v4 it settles straight
 * through to the singleton and never holds a token, so the indexer has no address to exclude and
 * nothing to exclude it from. The vault excludes itself on-chain; here it arrives as `g.sink`.
 *
 * The sink was the one that got missed, and it is instructive: it holds a balance only AFTER
 * graduation and only a dusty one, so it does not put a visible floor on every market the way the
 * curve would — it silently adds one phantom holder to every graduated market.
 *
 * @param graduationAddress the deployment's `DokuGraduation`, from chain config. Optional because
 *        a curve-only deployment has no graduations to exclude anything from.
 */
export async function recountHolders(
  db: Db,
  marketAddress: string,
  graduationAddress?: string,
): Promise<number> {
  const { rows } = await db.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM token_balances b
       JOIN markets m ON m.token_address = b.token_address
       LEFT JOIN graduations g ON g.market_address = m.market_address
      WHERE m.market_address = $1
        AND b.balance > 0
        AND b.holder <> m.market_address
        AND b.holder <> m.token_address
        AND b.holder <> $2
        AND b.holder <> COALESCE($3, '')
        AND (g.pool_address IS NULL OR g.pool_address = '' OR b.holder <> g.pool_address)
        AND (g.hooks        IS NULL OR g.hooks        = '' OR b.holder <> g.hooks)
        AND (g.sink         IS NULL OR g.sink         = '' OR b.holder <> g.sink)`,
    [marketAddress, DEAD, graduationAddress?.toLowerCase() ?? null],
  );
  const count = Number(rows[0]?.count ?? 0);
  await db.query("UPDATE market_state SET holders = $2 WHERE market_address = $1", [
    marketAddress,
    count,
  ]);
  return count;
}
