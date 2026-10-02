import type { Db } from "../../../db/legacy.js";
import type { LiveEvent } from "../../../websocket/live.js";
import { recountHolders } from "../../processing/holders.js";
import { poolIdOf, poolKeyFor } from "../../processing/pool-key.js";
import type { LogBase } from "./launch.js";

/**
 * A gen-2 graduation.
 *
 * The event carries no `PoolKey` any more — seven fields, and the key is not among them. It is
 * rebuilt from what the event DOES carry (quote asset, token) plus the graduator's two constants
 * and the configured hook, and then CHECKED: `keccak256(abi.encode(key))` must equal the emitted
 * id.
 *
 * On a mismatch this THROWS, and the ingest pass — one transaction — rolls back.
 *
 * The tempting alternative is to record the graduation with empty key columns and log an error.
 * This repo shipped exactly that once; `pool-swaps.test.ts` still carries the comment about
 * columns that "silently held empty strings for a while". A row that looks indexed and is not is
 * the worst outcome available, because every downstream query accepts it. And a key that fails to
 * hash to its own id is not one market's problem: the reconstruction is a pure function of
 * constants and config, so if it is wrong here it is wrong for every market. The honest response
 * is a failed pass that retries and shouts, not a partial row nobody looks at again.
 */
export async function handleGraduated2(
  db: Db,
  a: Record<string, unknown>,
  ts: Date,
  base: LogBase,
  cfg: { poolManager?: string; hook2?: string },
  announce: (event: LiveEvent) => void,
): Promise<void> {
  const market = String(a.curve).toLowerCase();
  const id = String(a.id).toLowerCase();
  const token = String(a.token).toLowerCase();
  const quote = String(a.quoteAsset).toLowerCase();

  const key = cfg.hook2 ? poolKeyFor(quote, token, cfg.hook2) : null;
  if (key === null || poolIdOf(key) !== id) {
    throw new Error(
      `gen-2 PoolKey does not reproduce the emitted PoolId for market ${market}: ` +
        `rebuilt ${key === null ? "<no DOKU_HOOK2 configured>" : poolIdOf(key)} from ` +
        `quote=${quote} token=${token} hook=${cfg.hook2 ?? "unset"}, event carried ${id}`,
    );
  }

  const inserted = await db.query(
    `INSERT INTO graduations (market_address, pool_address, pool_id, currency0, currency1, fee,
                              tick_spacing, hooks, sink, sink_kind, quote_asset, token_id,
                              quote_amount, base_amount, liquidity, block_number, block_hash,
                              log_index, tx_hash, ts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'',0,$9,$10,$11,$12,0,$13,$14,$15,$16,$17)
     ON CONFLICT (tx_hash, log_index) DO NOTHING RETURNING market_address`,
    [
      market,
      (cfg.poolManager ?? "").toLowerCase(),
      id,
      key.currency0,
      key.currency1,
      key.fee,
      key.tickSpacing,
      key.hooks,
      quote,
      String(a.tokenId),
      String(a.quoteAmount),
      String(a.baseAmount),
      base.block,
      base.hash,
      base.idx,
      base.tx,
      ts,
    ],
  );
  if (inserted.rowCount === 0) return;

  await db.query("UPDATE market_state SET pool_address = $2, pool_id = $3 WHERE market_address = $1", [
    market,
    (cfg.poolManager ?? "").toLowerCase(),
    id,
  ]);
  announce({ type: "graduation", market });
}

/**
 * The hook's registration, which is where the sink ADDRESS comes from under gen 2 — the graduation
 * event no longer carries it, and the reward-vault and burn-sink log queries filter by it.
 *
 * Processed AFTER `Graduated` (deferred in `ingestOnce`) because `graduate()` initialises the pool
 * before it announces, so this log lands EARLIER in the same transaction than the row it patches.
 *
 * Being deferred is also why the holder count is recomputed here. `graduations.sink` is one of the
 * addresses `recountHolders` excludes — a sink holding the dust a graduation swept into it is not
 * a holder — and every `Transfer` in the graduation transaction, including that sweep, was already
 * counted while the column still read the empty string. Nothing recounts afterwards on its own, so
 * without this the market's holder count is permanently one too high, and a plausible number is
 * exactly the kind that never gets questioned.
 */
export async function handlePoolRegistered(
  db: Db,
  a: Record<string, unknown>,
  hookAddress: string,
  cfg: { hook2?: string; graduation?: string },
): Promise<void> {
  if (!cfg.hook2 || hookAddress.toLowerCase() !== cfg.hook2.toLowerCase()) return;
  const id = String(a.id).toLowerCase();
  const { rows } = await db.query<{ market_address: string }>(
    `UPDATE graduations SET sink = $2, sink_kind = $3, hooks = $4 WHERE pool_id = $1
      RETURNING market_address`,
    [id, String(a.sinkAddr).toLowerCase(), Number(a.sink), hookAddress.toLowerCase()],
  );
  if (!rows[0]) return;
  await recountHolders(db, rows[0].market_address, cfg.graduation);
}
