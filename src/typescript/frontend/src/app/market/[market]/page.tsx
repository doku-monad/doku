import PreviewBanner from "components/dev/PreviewBanner";
import ClientMarketPage from "components/pages/market/ClientMarketPage";
import AwaitingIndexPage from "components/pages/market/components/awaiting-index";
import type { Metadata } from "next";
import { permanentRedirect } from "next/navigation";
import { cache } from "react";
import { isAddress } from "viem";

import { ApiError } from "@/lib/api/client";
import { createShortMemo } from "@/lib/api/short-memo";
import { classifyDeployment, fallbackFor, probeCode } from "@/lib/chain/deployment-state";
import { serverClient } from "@/lib/chain/server-client";
import {
  dummyHolders,
  dummyMarketByAddress,
  dummyMarketFor,
  dummySwaps,
  previewEnabled,
} from "@/lib/dev/dummy-markets";
import { marketPath } from "@/lib/market-path";
import { isHiddenAddress } from "@/lib/markets/hidden-markets";
import type { MarketModel } from "@/lib/models";
import { getHolders, getMarket, getSwaps, resolveMarketSlug, scaleOf } from "@/lib/queries/doku";
import { marketPreviewMetadata } from "@/lib/social/market-preview";
import { identityFor } from "@/lib/token-identity";

import EmojiNotFoundPage from "./not-found";

/*
 * Rendered per request, on purpose — and `revalidate = 2` is therefore inert here.
 *
 * This page is dynamic twice over: it reads `searchParams` (the `launched` flag below), and every
 * indexer call goes out `no-store`. It was looked at alongside `/explore` when that page went
 * static (2026-09-18) and deliberately left server-rendered. Caching its HTML (ISR) means Next
 * serves a STALE copy first and regenerates in the background, with no ceiling on how stale — the
 * first visitor to a quiet market after an hour would get an hour-old price and cap in the HTML,
 * and the market row is not something the client re-fetches (only the swaps and holders are,
 * `use-market-live.ts`). Caching only the fetches (`fetchCache = "force-cache"`) has the same
 * stale-while-revalidate shape at the data layer. Either is a freshness regression on the one
 * page where a stale price is a real cost; neither is taken here.
 *
 * What IS taken is the burst: a shared link or a launch puts many visitors on one market within
 * the same second, and each render asked the indexer three times. `reads` below hands those
 * renders one in-flight answer per address for 300 ms — a hard expiry, never a stale one — so a
 * burst costs the indexer three round trips rather than three per visitor. If market pages ever
 * need more than that, the honest route is ISR *with* the client re-fetching the market row on
 * mount when the HTML is older than its poll, or more web replicas.
 */
export const dynamic = "force-dynamic";

const SWAPS_ON_PAGE_LOAD = 25;
const HOLDERS_ON_PAGE_LOAD = 50;

/** One in-flight indexer answer per key for 300 ms. See the note above and `lib/api/short-memo`. */
const reads = createShortMemo<unknown>(300);
const shared = <T,>(key: string, produce: () => Promise<T>): Promise<T> =>
  reads(key, produce) as Promise<T>;

interface MarketPageProps {
  params: { market: string };
  /**
   * `?launched=1` says the visitor's own browser has a launch transaction in flight for this
   * address. It is the one fact the chain cannot supply — see `fallbackFor`.
   */
  searchParams: { launched?: string };
}

/**
 * The URL carries a TICKER, not the market address, and a ticker is not an address.
 *
 * Generation 1 derived one from the other: its factory salted a market's clones with the symbol
 * key, so an emoji determined an address and this page could render the moment a launch confirmed,
 * before the indexer had seen anything. Generation 2 salts on the CREATOR and a nonce. Two people
 * may launch $MOON and neither address follows from the name, so the slug is looked up — which
 * means it can miss, and can be ambiguous, and both are answered rather than guessed at.
 *
 * The cost is the one generation 1 avoided: a market is reachable by ticker only once the indexer
 * has it. Links inside the app carry the address and are unaffected.
 *
 * ## Which address
 *
 * The TOKEN's. A market has two contracts and the URL used to carry the curve's — the one address
 * a visitor could not do anything with outside DOKU, on the one surface (the address bar) whose
 * whole job is to be copied. Every link in the app now carries the token (`lib/market-path`), the
 * indexer's `/markets/:address` answers to either address, and a curve URL — an old bookmark, a
 * shared link from before — is answered by a permanent redirect to the token URL rather than by a
 * second page under a second key.
 */

/** The readable name a market slug already carries, tidied for a tab. */
function nameFromSlug(slug: string): string {
  const words = decodeURIComponent(slug).split("-").filter(Boolean);
  if (words.length === 0) return "DOKU";
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * The slug's market address, resolved at most once per request.
 *
 * `cache` is React's per-render-pass memo: `generateMetadata` and the page body both ask for this
 * while rendering the same request, and the second one is answered from memory. Without it the
 * ticker path would do the `/markets/search` lookup twice.
 */
const addressForSlug = cache(async (slug: string): Promise<`0x${string}` | null> => {
  if (isAddress(slug, { strict: false })) return slug.toLowerCase() as `0x${string}`;
  const resolved = await resolveMarketSlug(slug);
  // Ambiguity is a 404 on purpose. Two markets share the ticker, nothing in the URL says which,
  // and sending a shared link to whichever the sort favoured is a wrong page that looks right.
  return resolved.kind === "ticker" ? resolved.token : null;
});

/**
 * The market, resolved at most once per request, and never throwing.
 *
 * Both callers treat absence as a state rather than an error — the page renders one of three
 * recovery screens for it, and the metadata falls back to what the URL says — so the `catch` lives
 * here, once, rather than in each of them with a chance of differing.
 */
/**
 * Whether a failed market read means "the indexer has no such market" or "the indexer could not
 * be asked". A 404 is the first; anything else — a timeout, a refused connection, a 5xx while the
 * indexer restarts — is the second, and the page below treats the two differently on purpose.
 */
const indexerSaidNotFound = (error: unknown): boolean => error instanceof ApiError && error.status === 404;

const marketForAddress = cache(async (address: `0x${string}`) =>
  shared(`market:${address}`, () => getMarket(address)).catch((error: unknown) => {
    // Logged, not swallowed. A bare `.catch(() => null)` renders "not found" for a market that
    // exists whenever the indexer hiccups, and gives nobody a way to tell the two apart. A 404
    // is the one answer that means "no such market"; anything else is rethrown so the page can
    // tell an unreachable indexer from an unknown address.
    console.error(`Could not load market ${address}`, error);
    if (indexerSaidNotFound(error)) return null;
    throw error;
  })
);


/**
 * The card a shared market link previews with.
 *
 * ## This DOES resolve the market now, and the comment it replaces was measuring the wrong thing
 *
 * What was here said resolving the address would be "a second indexer round trip on every crawl".
 * The round trip is real; the word doing the work is *second*, and it is not: the page body fetches
 * the same market from the same URL in the same render pass, and both `cache` above and Next's own
 * fetch memoisation collapse the pair into one request. A crawl costs exactly what a visit costs.
 *
 * What was actually being paid was the other way round: every market link the product has ever
 * served — from X, from Discord, from a wallet's history — previewed as the launchpad's own banner
 * under a title made out of the URL, on the one surface where a coin's identity is the entire
 * message. See `lib/social/market-preview` for the two rules that card has to follow.
 */
export async function generateMetadata({ params }: MarketPageProps): Promise<Metadata> {
  const address = await addressForSlug(params.market);
  const market = address ? await marketForAddress(address).catch(() => null) : null;

  if (market) {
    const identity = identityFor(market.market);
    return marketPreviewMetadata({
      name: identity.name,
      ticker: identity.ticker,
      logo: identity.logo,
    });
  }

  /*
   * No market: an address URL for a coin the indexer has not indexed, an unknown ticker, or an
   * indexer that is down. The URL is the only thing left that names the coin, and for a ticker
   * slug it names it well.
   *
   * The emoji goes in the description, not the title. A bare emoji as a tab title renders as a
   * lone glyph beside the favicon — indistinguishable from a second icon, and unreadable in a list
   * of tabs or a browser history.
   */
  if (isAddress(params.market, { strict: false })) {
    return marketPreviewMetadata({ name: "DOKU", ticker: null, logo: null });
  }
  const ticker = nameFromSlug(params.market);
  return marketPreviewMetadata({ name: ticker, ticker, logo: null });
}

export default async function MarketPage({ params, searchParams }: MarketPageProps) {
  /*
   * The slug is either an address or an emoji-name path.
   *
   * Both are real entry points: links inside the app carry the address, which needs no lookup and
   * cannot fail on an emoji whose name is missing, while a shared or typed URL is far more likely
   * to be the readable form. `generateMetadata` asked the same question a moment ago and the answer
   * is memoised for this request, so the lookup happens once.
   */
  const address = await addressForSlug(params.market);

  // Whichever of the market's two addresses the URL carried: the fixture, the fetch and the
  // bytecode probe below all take it as-is, because each answers to either.
  if (!address) return <EmojiNotFoundPage />;

  /*
   * The preview fixture, under the same guard `/explore` uses.
   *
   * `/explore` could be reviewed with the indexer down and the page it links *into* could not —
   * so the busiest surface in the product, the one carrying the swap widget, was a "no such
   * market" screen exactly when somebody wanted to look at it. This resolves only the fabricated
   * `0xdead…` addresses, only when `DOKU_CARD_PREVIEW` is set, and says so in a banner. A real
   * address never reaches it, and without the variable neither does anything else.
   */
  const previewPage = (preview: MarketModel) => (
    <>
      <PreviewBanner note="This market is fabricated — the price, the chart, the feed and the holders are all invented. Gated behind DOKU_CARD_PREVIEW." />
      <ClientMarketPage
        data={{
          market: preview,
          swaps: dummySwaps(preview, Date.now()),
          holders: dummyHolders(preview),
        }}
      />
    </>
  );

  if (previewEnabled) {
    const preview = dummyMarketByAddress(address, Date.now());
    if (preview) return previewPage(preview);
  }

  /*
   * The market is the only required fetch. Swaps and holders degrade to empty rather than taking
   * the page down with them — a market with an unreachable trade feed is still worth rendering,
   * and the panels say so themselves.
   *
   * The `catch` is the preview flag's, not the product's: with an unreachable indexer this call
   * rejects rather than resolving empty, so a thrown connection error would 500 the route before
   * the fixture below ever got a chance. Without the flag it rethrows and the route fails the way
   * it always has.
   */
  /*
   * Every deploy of the indexer replaces its container, and for the seconds in between this call
   * fails with a refused connection rather than a 404. This page used to rethrow that into the
   * route's error boundary, which drew the same "no such market" panel a genuinely wrong URL gets
   * — a user-visible outage of every market page, on every indexer deploy. An unreachable
   * indexer now takes the same road as a market it has not indexed yet: the chain probe below,
   * and a screen that retries.
   */
  // A market this site hides is "not found", full stop — never the "still being indexed" screen the
  // chain probe below would pick, since the contract is real. See `lib/markets/hidden-markets`.
  if (isHiddenAddress(address)) return <EmojiNotFoundPage />;

  let unreachable = false;
  const market = await marketForAddress(address).catch((error) => {
    console.error(`Could not reach the indexer for ${address}`, error);
    unreachable = !indexerSaidNotFound(error);
    return null;
  });
  if (!market) {
    /*
     * With the flag set, an address the indexer cannot answer for gets a fixture seeded from that
     * address rather than the "being indexed" screen.
     *
     * This is what makes the board clickable with no backend: every card on it links to a real
     * address, and every one of those links was a dead end the moment the indexer stopped
     * answering — on the one page that carries the chart, the swap widget, the trade feed and the
     * holder table. See `dummyMarketFor`.
     */
    if (previewEnabled) return previewPage(dummyMarketFor(address, Date.now()));
    /**
     * The indexer does not have it. That is three different situations, and telling the person who
     * just paid gas that their market does not exist is the wrong one to guess.
     *
     * The chain settles the first two: a market's address is derived deterministically, so code at
     * that address means the market is real and the indexer is merely behind, and no code means
     * the URL is genuinely wrong. The third is that the chain could not be reached — which is not
     * evidence of either, and used to be spelled exactly like "no code" because `getBytecode`
     * resolves to `undefined` for an empty account and the old `.catch(() => undefined)` resolved
     * to `undefined` for a failed call. See `lib/chain/deployment-state`.
     */
    const probe = await probeCode(serverClient.getBytecode({ address: address }));
    if (!probe.ok) {
      // Logged rather than swallowed: the visitor is sent to a screen that keeps retrying, so
      // nothing else here leaves a trace that the node, not the URL, is the thing that is unwell.
      console.error(`Could not ask the chain about ${address}`, probe.error);
    }
    /*
     * And a fourth situation, which the chain cannot settle at all: the transaction is still in
     * flight. The launch flow navigates as soon as the wallet returns a hash rather than waiting
     * for a block, so this page genuinely runs before the contract exists — the probe answers
     * "absent" truthfully and the old conclusion drawn from it, "nobody has launched this coin",
     * was shown to the one person who knew it was false. Only the launcher's browser knows a
     * launch is pending, which is why that arrives in the URL.
     */
    const justLaunched = searchParams.launched !== undefined;
    const state = classifyDeployment(probe);
    // With the indexer unreachable, "no code at this address" is the only reading that still
    // justifies a "not found"; everything else keeps retrying until the indexer answers again.
    if (fallbackFor(state, justLaunched) === "not-found" && !(unreachable && state !== "absent")) {
      return <EmojiNotFoundPage />;
    }
    // "There is code there", "we could not ask" and "it is still being mined" all land here,
    // because this page retries and therefore recovers on its own in every one of them.
    return <AwaitingIndexPage symbol={params.market} pending={state !== "deployed"} />;
  }

  /*
   * One URL per market: the token's. A curve address in the bar — an old bookmark, a link shared
   * before the route moved — reaches the same market (the indexer answers to either) and is sent
   * on to the token URL, so what a visitor copies out of the bar is always the address the rest
   * of the internet can use. Ticker slugs are readable on purpose and stay as they are.
   */
  const token = market.market.tokenAddress.toLowerCase();
  if (isAddress(params.market, { strict: false }) && address !== token) {
    const launched = searchParams.launched !== undefined ? "?launched=1" : "";
    permanentRedirect(`${marketPath(token)}${launched}`);
  }

  // Everything below the market row is keyed by the CURVE, whichever address the URL carried.
  const curve = market.market.marketAddress;
  const [swaps, holders] = await Promise.all([
    shared(`swaps:${curve}`, () =>
      getSwaps(curve, scaleOf(market), { limit: SWAPS_ON_PAGE_LOAD }).then((r) => r.swaps)
    ).catch(() => []),
    shared(`holders:${curve}`, () =>
      getHolders(curve, { limit: HOLDERS_ON_PAGE_LOAD }).then((r) => r.holders)
    ).catch(() => []),
  ]);

  return <ClientMarketPage data={{ market, swaps, holders }} />;
}
