import generateMetadataHelper from "lib/utils/generate-metadata-helper";

import AssetsPage from "@/components/pages/assets/AssetsPage";
import { quoteAssetFromWire } from "@/lib/assets/quote-assets";
import { dummyQuoteAssets, previewEnabled } from "@/lib/dev/dummy-markets";
import { getMarkets, getQuoteAssets } from "@/lib/queries/doku";

/*
 * Rendered per request. `revalidate = 30` stood here and never applied: this page reads the
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
  title: "Quote assets",
  description:
    "Every asset a DOKU coin can be paired with — stablecoins, majors, tokenized equities and real-world assets on Monad.",
});

/**
 * The quote-asset registry.
 *
 * Both halves are read, neither is written down. The list came from a constant in
 * `lib/assets/quote-assets` that had every address as null and gold at 18 decimals; it now comes
 * from the chain's own registry, through the indexer, so the status column on this page is the
 * chain's `registered && enabled` rather than a guess somebody typed. A registry page whose facts
 * are decorative is the specific kind of page people stop trusting.
 *
 * The registry read is deliberately NOT caught in production. With no assets there is no page — an
 * empty registry says "there is nothing to pair against", which is a claim about the product rather
 * than about the indexer being down. The market count is caught, because a page that lists the
 * assets and cannot say how many markets exist is still the page.
 *
 * ## Except under `DOKU_CARD_PREVIEW`, where it falls back to the fixture
 *
 * Without this the page was unopenable on a laptop. `getQuoteAssets` throws the moment the local
 * indexer is not running, and because this route streams behind `loading.tsx` the throw surfaced as
 * a skeleton that never resolved — so the one page whose entire subject is the registry was the one
 * page nobody could look at while designing it.
 *
 * The rule is the same one `api/quotes/route.ts` already follows and states: the fixture only ever
 * fills a hole. A real registry is returned untouched, including a real empty one, and with the
 * flag off an outage still fails loudly. See the note in that route.
 */
const readRegistry = async () => {
  try {
    const assets = await getQuoteAssets();
    if (assets.length === 0 && previewEnabled) return dummyQuoteAssets().map(quoteAssetFromWire);
    return assets;
  } catch (error) {
    if (previewEnabled) {
      console.warn("Quote registry unavailable — falling back to the preview fixture", error);
      return dummyQuoteAssets().map(quoteAssetFromWire);
    }
    throw error;
  }
};

export default async function Assets() {
  const [assets, { markets }] = await Promise.all([
    readRegistry(),
    getMarkets({ limit: 500 }).catch((error) => {
      console.error("Could not load markets for the asset registry", error);
      return { markets: [], nextCursor: null };
    }),
  ]);

  return <AssetsPage assets={assets} marketCount={markets.length} />;
}
