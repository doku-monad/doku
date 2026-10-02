import ClientPoolsPage from "components/pages/pools/ClientPoolsPage";
import generateMetadataHelper from "lib/utils/generate-metadata-helper";

import { getMarkets } from "@/lib/queries/doku";

/*
 * Rendered per request. `revalidate = 2` stood here and never applied: this page reads the
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
  title: "Liquidity pools",
  description: "Markets that graduated into permanent, locked liquidity.",
});

export default async function PoolsPage() {
  // Fetched whole and filtered in the client for now. Worth a `graduated=true` parameter on the
  // indexer once the market count makes paging through everything wasteful; while graduations are
  // rare this is one request instead of a new endpoint.
  const { markets } = await getMarkets({ limit: 200 }).catch(() => ({
    markets: [],
    nextCursor: null,
  }));

  return <ClientPoolsPage markets={markets} />;
}
