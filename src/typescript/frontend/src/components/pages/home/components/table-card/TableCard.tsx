"use client";

import { CoinCard } from "components/ui/coin-card";
import { motion, type MotionProps } from "framer-motion";
import { toExplorerLink } from "lib/utils/explorer-link";
import { memo, useMemo } from "react";

import { coinExternalLinks } from "@/lib/external-links";
import { capFigure } from "@/lib/market-cap";
import { marketPath } from "@/lib/market-path";
import { identityFor } from "@/lib/token-identity";

import {
  calculateGridData,
  determineGridAnimationVariant,
  LAYOUT_DURATION,
  tableCardVariants,
} from "./animation-variants/grid-variants";
import type { GridLayoutInformation, TableCardProps } from "./types";

/**
 * A market's cell in the grid.
 *
 * This file owns *placement* only — the shuffle when the sort changes, the entrance when a market
 * is new, the flash when a trade lands on it. Everything visible is `CoinCard`, which is
 * standalone and knows nothing about grids.
 *
 * Keeping the two apart is what makes the card reusable somewhere that has no grid, and it is why
 * the layout animation survived the card being rebuilt from scratch: the `layoutId` and variants
 * live out here, on the cell, where they always did.
 */
const TableCard = ({
  index,
  pageOffset,
  market,
  rowLength,
  prevIndex,
  runInitialAnimation,
  sortBy,
  flash,
  ...props
}: TableCardProps & GridLayoutInformation & MotionProps) => {
  /**
   * What this coin is called, resolved in one place.
   *
   * Every surface in the app goes through `identityFor` — this card, the market header, the tape,
   * search. The grid used to derive its own label from the symbol, which is how the same market
   * ended up as "CRESCENT MOON" in the hero and "🌙💎" here.
   */
  const identity = useMemo(() => identityFor(market.market), [market.market]);
  const graduated = Boolean(market.state.poolAddress);

  /**
   * The block-explorer link, built here rather than in the card.
   *
   * The card takes a URL because it has no business knowing which chain it is on; this cell does,
   * through the same helper the market page uses. A card that built its own explorer URL would be
   * a second place to update the day the chain's explorer moves.
   *
   * It opens the TOKEN — the same thing the card's CA chip copies — not the curve. See the
   * masthead's explorer key for the same choice.
   */
  const explorerHref = useMemo(
    () => toExplorerLink({ linkType: "acc", value: market.market.tokenAddress }),
    [market.market.tokenAddress]
  );

  /** The launcher's own account, through the same helper — see `creatorHref` on the card. */
  const creatorHref = useMemo(
    () => toExplorerLink({ linkType: "acc", value: market.market.creator }),
    [market.market.creator]
  );

  /** DexScreener, GMGN and this coin's own trader board. See `lib/external-links`. */
  const external = useMemo(
    () => coinExternalLinks(market.market.tokenAddress),
    [market.market.tokenAddress]
  );

  /*
   * Dollars, because dollars are the only unit that compares.
   *
   * This read `toNominal(marketCap)` and labelled the result "MON". `toNominal` is a fixed
   * eighteen-decimal conversion, so a USDC market's 2,938 cap printed as "0 MON" and a gold
   * market's as "0 MON" — a worthless-looking coin — while a WETH market happened to read
   * correctly and was still labelled MON. The old dollar path then multiplied whatever that was by
   * the MON/USD rate, on markets that hold no MON.
   *
   * `marketCapUsd` comes off the same row and the service computed it per quote, with that quote's
   * decimals and that quote's price. Where a quote has no price the figure falls back to the quote
   * itself, in its own decimals and under its own ticker — a gap in the price feed is not a reason
   * to print a dollar sign on a number that is not dollars.
   */
  const cap = capFigure(market.state.marketCap, market.state.marketCapUsd, identity.quote);

  /**
   * The metric opposite the market cap: the all-time high, and how far below it the market is now.
   *
   * This replaced 24-hour volume, which was turnover — a fact about the last day's activity that
   * says nothing about whether the market is somewhere anyone would buy it. The high plus the
   * distance from it is the pair a trader actually reads: where this got to, and what is left of
   * that. Both come off the same `/markets` row, so it costs no request.
   *
   * The high is `MAX(price)` across both venues, so a market that peaked on its pool after
   * graduating has its high there rather than on the curve it left — see `CAP_COLUMNS` in the
   * indexer. It is therefore never below the current cap, and the delta is zero at a new high and
   * negative everywhere else. The card colours it by sign regardless: pinning it to "always red"
   * here would bake this metric's shape into a component that has no reason to know it.
   *
   * A market with no trades has no high — the indexer sends `0` — and gets an em dash and no
   * percentage rather than a `-100%` invented out of a division by zero.
   */
  /* Both caps are raw units of the SAME quote, so the ratio needs no decimals at all — and
     computing it on the raw values keeps it exact where a float division of two conversions is
     not. A market with no trades has no high and gets no percentage rather than a -100% invented
     out of a division by zero. */
  const secondary = useMemo(() => {
    const ath = market.state.athMarketCap;
    if (ath <= 0n) return { delta: null as number | null };
    return { delta: (Number((market.state.marketCap * 10_000n) / ath) / 10_000 - 1) * 100 };
  }, [market.state.athMarketCap, market.state.marketCap]);

  const { curr, prev, variant, layoutDelay } = useMemo(() => {
    const { curr, prev } = calculateGridData({ index, prevIndex, rowLength });
    const { variant, layoutDelay } = determineGridAnimationVariant({
      curr,
      prev,
      rowLength,
      runInitialAnimation,
    });
    return { variant, curr, prev, layoutDelay };
  }, [prevIndex, index, rowLength, runInitialAnimation]);

  /**
   * The entrance is CSS; the reordering is not.
   *
   * These two animations look similar and are nothing alike. A **reorder** — a card portalling to
   * a new slot when the sort changes, or a new market shouldering its way into the front — can
   * only be expressed in JavaScript, because it needs the card's previous position, which no
   * stylesheet knows. An **entrance** is a fade with a per-cell delay, and CSS has done that since
   * 2009.
   *
   * The difference that matters is *when they can start*. `motion.div` with `initial={{ opacity: 0
   * }}` writes `opacity: 0` into the server's HTML and cannot undo it until React has hydrated —
   * so the entire market grid, which is the reason anyone is on this route, arrived fully
   * rendered and completely invisible and stayed that way for three and a half seconds on a
   * mid-range phone. Measured: the cards were laid out at 1.33s and still at zero opacity at
   * 4.88s. A CSS animation runs off the first paint instead, and needs nothing to have loaded.
   *
   * So the entrance moved to `.doku-rise`, and the reorder machinery stays exactly where it was.
   * Note that `ClientGrid` currently hardcodes `runInitialAnimation`, so the entrance is in fact
   * the only variant any card reaches today — but that is the grid's business, not the cell's, and
   * this component still answers correctly if the grid ever starts reordering again.
   */
  const entering = variant === "initial";

  return (
    <motion.div
      layout
      layoutId={`${sortBy}-${market.market.marketAddress}`}
      initial={entering ? false : variant === "unshift" ? { opacity: 0, scale: 0 } : undefined}
      className={`grid-emoji-card group group/card doku-cell cursor-pointer hover:z-10${
        entering ? " doku-cell-rise" : ""
      }`}
      /* The stagger, on an attribute rather than a custom property — see `.doku-cell-rise`. */
      data-rise={entering ? Math.min(9, curr.col + curr.row) : undefined}
      /*
       * While the card is entering, `framer-motion` is given nothing to animate. It will still
       * write `opacity: 1` to the `style` attribute when it mounts — that is unavoidable — which
       * is why `.doku-cell-rise` is spelled out without any `var()` in its `animation` shorthand.
       * See the note over those keyframes: a rewritten style attribute re-resolves the shorthand,
       * and a re-resolved shorthand restarts the animation.
       */
      {...(entering
        ? { animate: false as const }
        : {
            variants: tableCardVariants,
            animate: variant,
            custom: { curr, prev, layoutDelay },
            transition: {
              type: variant === "portal-backwards" ? ("just" as const) : ("spring" as const),
              delay: layoutDelay,
              duration: variant === "portal-backwards" ? LAYOUT_DURATION * 0.25 : LAYOUT_DURATION,
            },
          })}
      {...props}
    >
      <CoinCard
        name={identity.name}
        ticker={identity.ticker}
        logo={identity.logo}
        banner={identity.banner}
        pair={identity.quote}
        marketCap={cap.value}
        currency={cap.currency}
        currencyPosition={cap.position}
        delta={secondary.delta ?? null}
        deltaLabel="Distance from all-time high"
        contractAddress={market.market.tokenAddress}
        creator={market.market.creator}
        creatorHref={creatorHref}
        launchedAt={market.market.launchedAt}
        rank={pageOffset + index + 1}
        graduationPercentage={market.state.progress * 100}
        isGraduated={graduated}
        links={identity.links}
        explorerHref={explorerHref}
        external={external}
        href={marketPath(market.market.tokenAddress)}
        // The trade pulse stays on the cell: it is about this position in the grid reacting to an
        // event, not about the card's own state, and the keyframes live in `global.css`.
        className={flash ? (flash.isBuy ? "doku-flash-buy" : "doku-flash-sell") : undefined}
      />
    </motion.div>
  );
};

/**
 * Memoised, because the grid re-renders far more often than any one cell changes.
 *
 * `useLiveFeed` replaces the `flashes` map on every swap that lands anywhere on the exchange, which
 * re-renders `Board` → `ClientGrid` → all twenty cells. Nineteen of them have an identical `flash`
 * (usually `undefined`) and identical everything else, and each was re-rendering a `CoinCard` and —
 * because this cell is a `motion.div` with `layout` — being re-measured by framer-motion's layout
 * projection, which reads `getBoundingClientRect` on every commit. That is a forced synchronous
 * layout per card per trade.
 *
 * A shallow prop compare is exactly right here: `market` comes straight off the query cache, so it
 * is referentially stable between fetches, and `flash` is a per-market value from the same map.
 * This was the only `React.memo` the application lacked in the one place it pays for itself.
 */
export default memo(TableCard);
