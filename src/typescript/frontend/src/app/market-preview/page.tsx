import PreviewBanner from "components/dev/PreviewBanner";
import ClientMarketPage from "components/pages/market/ClientMarketPage";
import generateMetadataHelper from "lib/utils/generate-metadata-helper";
import Link from "next/link";
import { notFound } from "next/navigation";

import { dummyHolders, dummyMarkets, dummySwaps, previewEnabled } from "@/lib/dev/dummy-markets";
import { identityFor } from "@/lib/token-identity";

/*
 * An internal preview route, and it gets a title for the same reason the public ones do: these are
 * opened four at a time beside the pages they mirror, and four tabs reading
 * `Doku | A Launchpad on Monad` are four tabs nobody can tell apart.
 */
export const metadata = generateMetadataHelper({
  title: "Market page preview",
  description: "The market page against a fabricated coin.",
});

/**
 * One market's page, on fabricated data.
 *
 * ## Why this route exists when `/market/0xdead…` already renders the fixture
 *
 * It does — but only if you know the address, and the addresses are
 * `0xdeaddeaddeaddeaddeaddeaddeaddead00000007`. Judging the market page means moving between
 * markets in different *states*: one still on its curve, one that has graduated into a pool, one
 * with a supplied logo and banner against one drawing a monogram, one with a rewards module and
 * one without. Doing that by hand-editing eight hex digits in the URL is why nobody did it.
 *
 * So this is the same fixture with a switcher on top: every preview market as a chip, the state it
 * is in written under the name, and the page itself unchanged below. It renders the real
 * `ClientMarketPage` — the real masthead, chart, swap widget, trade feed and holder table — which
 * is the only thing that makes it worth having.
 *
 * ## The guard
 *
 * `notFound()` unless `DOKU_CARD_PREVIEW=true`, exactly as `/card-preview`. The reasoning, and the
 * post-mortem of the `NODE_ENV` check that shipped a preview to production, is in
 * `lib/dev/dummy-markets.ts`. This page prints invented prices on the surface people trade from;
 * "it is only reachable if you know the URL" is not a control.
 *
 * @see /card-preview — the same idea for the board's card grid.
 * @see /launch-preview — the launch bench, pre-filled.
 */
export const dynamic = "force-dynamic";

/** A chip's second line: what makes this fixture different from the one beside it. */
const stateOf = (graduated: boolean, readyToGraduate: boolean) =>
  graduated ? "Graduated" : readyToGraduate ? "Ready" : "On the curve";

export default function MarketPreviewPage({ searchParams }: { searchParams: { i?: string } }) {
  if (!previewEnabled) notFound();

  /*
   * `Date.now()` is passed in rather than read inside the fixture builder, so the server render and
   * the hydrating client render compute identical ages instead of tripping a hydration mismatch on
   * every "8h" in the page — the same reason `/card-preview` does it.
   */
  const now = Date.now();
  const markets = dummyMarkets(now);

  /* Clamped rather than 404'd: this is a switcher, and a typo in a dev URL should land on the first
     market with the chips still visible, not on a not-found page with no way back. */
  const parsed = Number(searchParams.i);
  const index = Number.isFinite(parsed)
    ? Math.min(Math.max(Math.trunc(parsed), 0), markets.length - 1)
    : 0;
  const market = markets[index];

  return (
    <>
      <PreviewBanner note="This market is fabricated — the price, the chart, the feed and the holders are all invented. Gated behind DOKU_CARD_PREVIEW; without it this route is a 404." />

      {/*
        The switcher.

        `doku-seg` / `doku-seg-key` are the product's own segmented control — the one the asset
        roadmap and the portfolio deck use — so the sandbox is built out of the same parts as the
        app it is a sandbox for. Links rather than buttons: each fixture is a URL, so a state worth
        looking at twice can be bookmarked and pasted into a pull request.
      */}
      <nav
        aria-label="Preview market"
        className="doku-chiprow -mx-1 mb-5 flex items-center overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <div className="doku-seg flex shrink-0 items-center gap-1 rounded-[13px] p-1">
          {markets.map((m, i) => {
            const identity = identityFor(m.market);
            const active = i === index;
            return (
              <Link
                key={m.market.marketAddress}
                href={`/market-preview?i=${i}`}
                scroll={false}
                aria-current={active ? "page" : undefined}
                data-active={active}
                className="doku-seg-key inline-flex shrink-0 flex-col items-start gap-1 whitespace-nowrap rounded-[10px] px-3 py-1.5"
              >
                <span className="font-numeric text-[12.5px] font-semibold leading-none">
                  ${identity.ticker}
                </span>
                <span className="font-numeric text-[11px] leading-none text-mute">
                  {stateOf(m.state.poolAddress !== null, m.state.readyToGraduate)}
                </span>
              </Link>
            );
          })}
        </div>
      </nav>

      <ClientMarketPage
        data={{
          market,
          swaps: dummySwaps(market, now),
          holders: dummyHolders(market),
        }}
      />
    </>
  );
}
