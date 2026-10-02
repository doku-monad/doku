import StatusPage from "components/pages/status-page";
import FEATURE_FLAGS from "lib/feature-flags";
import generateMetadataHelper from "lib/utils/generate-metadata-helper";
import { ROUTES } from "router/routes";
import { formatUnits } from "viem";

import { getIndexerStatus, getMarkets } from "@/lib/queries/doku";

import StatsTable from "./StatsTable";

/*
 * Rendered per request. `revalidate = 10` stood here and never applied: this page reads the
 * indexer `no-store` (`lib/api/client.ts`), which makes the route dynamic, and until 2026-09-18
 * the root layout read a request header that made every route dynamic anyway. When that header
 * read was removed, `next build` prerendered this page as static and then EVERY revalidation
 * failed at runtime ("Page changed from static to dynamic", the `no-store` fetch) — the build-time
 * copy would have been served forever. Stated explicitly so the page keeps the behaviour it has
 * always had. To make it cacheable for real, pair a `revalidate` with `fetchCache = "force-cache"`
 * and accept that Next serves a stale copy while it regenerates.
 */
export const dynamic = "force-dynamic";

export const metadata = generateMetadataHelper({
  title: "Protocol stats",
  description: "Every market on DOKU, ranked.",
});

const mon = (value: bigint) => Number(formatUnits(value, 18));

/**
 * Protocol-wide numbers.
 *
 * All of them are sums over markets the indexer already returns — no separate aggregate endpoint,
 * because at this scale one query is cheaper than a second code path that can disagree with the
 * first.
 */
export default async function StatsPage() {
  /*
   * Locked, and answered here rather than in middleware.
   *
   * The liquidity route is 404'd upstream because a disabled *feature* should not exist; this is a
   * page that will exist, whose numbers are simply not ready to be published, so the honest answer
   * is the
   * screen that says so — the same `StatusPage` the launching-soon route uses, so "not yet" looks
   * the same everywhere in this product. Returned before the fetches, so a locked route costs the
   * indexer nothing.
   */
  if (!FEATURE_FLAGS.Stats) {
    return (
      <StatusPage
        eyebrow="Not open yet"
        title="Stats are coming soon"
        code="Soon"
        actions={[
          { label: "Browse launches", href: ROUTES.explore, variant: "primary" },
          { label: "See what you can pair against", href: ROUTES.assets, variant: "secondary" },
        ]}
      >
        <p>
          Protocol-wide volume, raised, trades, holders and graduations — every one of them summed
          over every market. They open when there is enough behind them to be worth reading.
        </p>
      </StatusPage>
    );
  }

  const [{ markets }, status] = await Promise.all([
    getMarkets({ limit: 500 }).catch(() => ({ markets: [], nextCursor: null })),
    getIndexerStatus(),
  ]);

  const totals = markets.reduce(
    (acc, m) => ({
      volume: acc.volume + mon(m.state.volumeQuote),
      raised: acc.raised + mon(m.state.quoteRaised),
      trades: acc.trades + m.state.tradeCount,
      holders: acc.holders + m.state.holders,
      graduated: acc.graduated + (m.state.poolAddress ? 1 : 0),
    }),
    { volume: 0, raised: 0, trades: 0, holders: 0, graduated: 0 }
  );

  const summary = [
    { label: "Markets", value: markets.length.toLocaleString() },
    { label: "Graduated", value: totals.graduated.toLocaleString() },
    {
      label: "Volume",
      value: `${totals.volume.toLocaleString(undefined, { maximumFractionDigits: 2 })} MON`,
    },
    {
      label: "Raised",
      value: `${totals.raised.toLocaleString(undefined, { maximumFractionDigits: 2 })} MON`,
    },
    { label: "Trades", value: totals.trades.toLocaleString() },
    { label: "Holders", value: totals.holders.toLocaleString() },
  ];

  return (
    <div className="mx-auto w-full max-w-[1240px] px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="font-pixel text-[26px] font-medium tracking-[0.02em] text-ink">Stats</h1>
        <p className="mt-1.5 font-ui text-[14px] text-mute">
          {status.reachable
            ? `Indexed to block ${status.lastBlock.toString()}, ${status.lagBlocks} behind the chain.`
            : "The indexer is unreachable — these numbers may be stale."}
        </p>
      </header>

      <dl className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {summary.map((s) => (
          <div key={s.label} className="rounded-doku-xl border border-line bg-surface px-4 py-3">
            <dt className="font-numeric text-[11px] uppercase tracking-[0.11em] text-mute">
              {s.label}
            </dt>
            <dd className="mt-1 font-numeric text-[18px] font-semibold tabular-nums text-ink">
              {s.value}
            </dd>
          </div>
        ))}
      </dl>

      <StatsTable
        markets={markets.map((m) => ({
          marketAddress: m.market.marketAddress,
          tokenAddress: m.market.tokenAddress,
          symbol: m.market.symbol,
          volume: mon(m.state.volumeQuote),
          raised: mon(m.state.quoteRaised),
          progress: m.state.progress,
          holders: m.state.holders,
          trades: m.state.tradeCount,
          graduated: m.state.poolAddress !== null,
        }))}
      />
    </div>
  );
}
