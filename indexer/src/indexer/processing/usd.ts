import type { Db } from "../../db/legacy.js";
import { createLogger } from "../../utils/logger.js";
import { type Job, startJob } from "../jobs.js";

export const USD_INTERVAL_MS = 60_000;
const log = createLogger().child({ component: "usd-prices" });

/** `{ prices: { k: v } }` or `{ k: v }` → lowercase key → positive finite number. */
export function parsePriceDocument(doc: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (typeof doc !== "object" || doc === null) return out;
  const src = (doc as { prices?: unknown }).prices;
  const table = typeof src === "object" && src !== null ? src : doc;
  for (const [k, v] of Object.entries(table as Record<string, unknown>)) {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (Number.isFinite(n) && n > 0) out.set(k.toLowerCase(), n);
  }
  return out;
}

/**
 * Refresh `quote_assets.usd_price`. Stablecoins are pinned to 1 first and always; the document is
 * consulted for everything else. Never throws: a price source being down is a stale `$` figure,
 * and the UI already refuses to print one whose `usd_price_at` is old.
 *
 * Returns the ids of the listed assets it could not price, having already logged each one — a
 * caller that wants to act on the gap does not have to re-query for it.
 */
export async function refreshUsdPrices(
  db: Db,
  url: string | undefined,
  fetchImpl: (url: string) => Promise<Response> = (u) => fetch(u),
): Promise<string[]> {
  await db.query(
    "UPDATE quote_assets SET usd_price = 1, usd_price_at = NOW() WHERE kind = 'stablecoin'",
  );

  const prices = url ? await load(url, fetchImpl) : null;
  if (prices && prices.size > 0) {
    const { rows } = await db.query<{ id: string; address: string | null; symbol: string | null }>(
      "SELECT id, address, symbol FROM quote_assets WHERE kind IS DISTINCT FROM 'stablecoin'",
    );
    for (const r of rows) {
      const p = [r.address, r.id, r.symbol]
        .map((k) => (k ? prices.get(k.toLowerCase()) : undefined))
        .find((v) => v !== undefined);
      if (p === undefined) continue;
      await db.query("UPDATE quote_assets SET usd_price = $2, usd_price_at = NOW() WHERE id = $1", [
        r.id,
        p,
      ]);
    }
  }

  // Reported on every path, including the ones that gave up early. A source that is down is
  // exactly when the gap matters, so skipping the report there would hide it when it counts.
  return reportUnpriced(db);
}

/** The price document, or null where it could not be had. Never throws — see above. */
async function load(
  url: string,
  fetchImpl: (url: string) => Promise<Response>,
): Promise<Map<string, number> | null> {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) {
      log.warn("price source answered", { status: res.status });
      return null;
    }
    return parsePriceDocument(await res.json());
  } catch (error) {
    log.warn("price source unreachable", { error });
    return null;
  }
}

/**
 * Name every listed, enabled quote asset that still has no USD price.
 *
 * `registered AND enabled` is the point: those are the assets a market can be launched against
 * today, so a missing price for one of them means live markets are being ranked on whole quote
 * units instead of on dollars. An asset that is merely in the catalogue, or registered but not yet
 * enabled, has nothing to price and is not a gap.
 *
 * Warn rather than error because nothing is broken and the board still renders; loud rather than
 * silent because the alternative — `COALESCE(usd, 0)` — read a $10M market as worth nothing and
 * looked perfectly normal doing it.
 */
async function reportUnpriced(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ id: string; symbol: string | null; address: string | null }>(
    `SELECT id, symbol, address FROM quote_assets
      WHERE registered AND enabled AND usd_price IS NULL
      ORDER BY id`,
  );
  for (const r of rows) {
    log.warn("listed quote asset has no USD price", {
      id: r.id,
      symbol: r.symbol,
      address: r.address,
    });
  }
  return rows.map((r) => r.id);
}

export function startUsdJob(
  db: Db,
  url: string | undefined,
  onError: (e: unknown) => void,
  intervalMs = USD_INTERVAL_MS,
): Job {
  return startJob({
    name: "usd-prices",
    intervalMs,
    // The unpriced ids are already logged by the refresher; the job discards them so its `run`
    // keeps the `Promise<void>` shape every other job has.
    run: async () => {
      await refreshUsdPrices(db, url);
    },
    onError,
  });
}
