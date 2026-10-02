"use client";

import { FormattedNumber } from "components/FormattedNumber";
import { GeneratedBanner, GlobeGlyph, IconLink, VenueGroup, XGlyph } from "components/ui/coin-card";
import { CoinMark } from "components/ui/coin-mark";
import { translationFunction } from "context/language-context";
import { cn } from "lib/utils/class-name";
import { toExplorerLink } from "lib/utils/explorer-link";
import { formatAge, formatCompact } from "lib/utils/format-compact";
import React, { useMemo } from "react";
import { formatUnits } from "viem";
import { useReadContract } from "wagmi";

import { AssetIcon } from "@/components/ui/asset-icon";
import { displaySymbol, displaySymbolText } from "@/lib/assets/display-symbol";
import { QUOTE_ASSET_KIND_NAMES } from "@/lib/assets/quote-assets";
import { tokenAbi } from "@/lib/chain/abis";
import { TOKEN_DECIMALS as BASE_DECIMALS } from "@/lib/chain/config";
import { quoteAmountNumber, quotePerWholeTokenNumber } from "@/lib/chain/quote-scale";
import { coinExternalLinks } from "@/lib/external-links";
import { usePoolPrice } from "@/lib/hooks/doku/use-pool-price";
import { useQuoteAssets } from "@/lib/hooks/use-quote-assets";
import { useTicker } from "@/lib/hooks/use-ticker";
import { tradeFeeSentence } from "@/lib/launch/fee-sentence";
import { PROTOCOL_FEE_PCT } from "@/lib/launch/submit";
import { identityFor } from "@/lib/token-identity";

import type { MainInfoProps } from "../../types";
import { useAddressCopy } from "../main-info/CopyAddress";

/**
 * The token masthead.
 *
 * ## It is the market card, at page scale
 *
 * The previous version was a `Panel` — frosted glass, a backdrop blur, a rim tinted from the coin's
 * emoji and a radial bloom behind it — sitting one route away from a grid of machined cards built
 * out of a tray, a rim, a bezel and hairline seams. Clicking a card therefore took you to a page
 * made of a different material, which is the loudest way an interface tells somebody it was
 * assembled rather than designed.
 *
 * So this is built from **exactly the card's stack**, at masthead size:
 *
 *   1. a recessed **tray** the whole object is pressed into,
 *   2. a hairline **rim** floating 3px proud of it,
 *   3. a **bezel** with a lit top edge, holding everything,
 *   4. an **edge** drawn over the content, because the bezel clips children that paint grounds and
 *      a border beneath them disappears wherever one reaches the edge.
 *
 * Every division inside is a film seam — a hair of shadow with a hair of light beneath it — which
 * is how two panels meet everywhere else in this product. There is no glow on it anywhere: the
 * emoji-sampled bloom and the tinted rim are gone, and colour is spent only where it carries
 * meaning — the status pill, the delta chip, a curve about to graduate.
 *
 * ## The cover, and the mark
 *
 * The coin's cover runs across the top and **fades into the bezel** rather than being veiled over:
 * a masked dissolve, so the image keeps its own colour where it shows and ends where the type
 * begins, instead of being flattened under a wash. A coin with no cover gets the same generated
 * banner the board card draws, so the two surfaces agree on what a coin without artwork looks like.
 *
 * The mark is an **image** — `CoinMark`, the component the card, the tape and the swap widget all
 * use, falling back to a monogram built from the ticker. It is mounted in a well that overlaps the
 * cover's lower edge, which is what ties the two bands into one object. No emoji: a coin is a name,
 * a ticker and a picture its launcher chose, and rendering a Unicode glyph instead of that picture
 * is left over from when this product's coins *were* emoji.
 *
 * ## The pair badge
 *
 * This is the fact DOKU exists for, and it was a 17px chip wedged between the name and a status
 * pill. It stands alone at the right of the identity row now — an opaque machined tag carrying the
 * issuer's mark in a bevelled well, the symbol at heading size, and the asset's real name and class
 * read from the quote-asset registry, so this badge and `/assets` cannot describe the same asset
 * differently. It is opaque because it overlaps the coin's cover: built from films, as it was, it
 * took the colour of whatever artwork a stranger uploaded and its own label vanished into it.
 *
 * ## One currency, and no switch
 *
 * The headline figures are dollars. There was a MON⇄USD toggle, and a switch under a headline
 * number means every glance at it carries a prior question — *which unit is this one in* — that has
 * to be answered before the number means anything. The market's own denomination is on the pair
 * badge, on the price label, in the trade module and along the curve; the hero states value, and
 * value is a dollar figure. The one exception is a quote nothing has priced, where there is no rate
 * to convert with and the figures stay in that quote's own unit with its symbol beside them.
 *
 * ## What the coin says about itself
 *
 * A launcher writes up to 240 characters at launch and no surface in this product rendered a word
 * of it. It has a band here, sharing a rule with the contract address and the deployer: the left
 * half is what the coin claims, the right half is the two addresses that let you check the claim.
 *
 * ## Four vitals, not seven
 *
 * `Total vol`, `Raised` and `Trades` are each true and none of them is read *here* — the first two
 * are on the trade module's curve band and the third is the length of the feed below. Seven cells
 * across this rail is 84px each, the width at which every figure looks equally unimportant. The
 * four that remain — today's turnover, holders, the cost of a trade, the all-time high — get 150px
 * and their labels back.
 */

/**
 * The bonding-curve state, as the one badge that changes what this page means.
 *
 * ## It was a chip, and a chip is not a state
 *
 * A 1px border, a tinted wash, a 6px dot and a word — the shape every framework ships as
 * `<Badge variant="success">`. On a page whose every other object is machined out of trays, rims
 * and lit lips it was the one element with no relief at all, and it was sitting on top of the
 * loudest surface on the page: a stranger's cover art, with a backdrop blur as its only defence.
 *
 * ## What it is now
 *
 * Three things, in one plate:
 *
 *   1. **A lamp, not a dot.** A domed lens with a white catch-light in its shoulder, a rim, and
 *      its own light pooled around it — and on the two live states it breathes, because bonding is
 *      a thing that is *happening*. Graduated is finished, so its lamp is steady.
 *   2. **The number.** `BONDING` on its own asks "how far?" and sends you to the trade panel to
 *      find out. The percentage sits behind a seam in the plate's second cell, which is this
 *      product's own idiom for two facts in one control, and it is the reason the badge has enough
 *      to say to be built rather than drawn.
 *   3. **The curve, along its foot.** A two-pixel fill on a track, in the state's own hue. It is
 *      the same reading as the number for anyone who takes the shape rather than the digits, and
 *      it is what makes the plate an instrument instead of a label.
 *
 * The hue is one custom property — `--st` — set by `data-tone`, so all three states are one recipe
 * and none of them can drift from the others. See `.doku-token-status`.
 */
const StatusPill = ({ graduated, progress }: { graduated: boolean; progress: number }) => {
  // "Graduating" is the interesting state and deserves its own colour: past 90% the market is
  // about to leave the curve, which changes how a trade behaves.
  const graduating = !graduated && progress >= 90;
  const tone = graduated ? "done" : graduating ? "soon" : "live";
  const label = graduated ? "Graduated" : graduating ? "Graduating" : "Bonding";
  // Clamped, because `progress` is a ratio of two figures the indexer supplies and a curve that
  // has just filled reports a hair over 100.
  const pct = graduated ? 100 : Math.max(0, Math.min(100, progress));

  return (
    <span
      data-tone={tone}
      title={
        graduated
          ? "Graduated — this market trades on its pool"
          : `Bonding curve · ${pct.toFixed(0)}% filled`
      }
      className="doku-token-status relative inline-flex h-7 shrink-0 items-center overflow-hidden rounded-doku-lg font-numeric text-[11px] font-semibold uppercase leading-none tracking-[0.09em]"
    >
      <span className="flex shrink-0 items-center gap-2 pl-2.5 pr-2.5">
        <span aria-hidden className="doku-token-status-lamp relative h-[7px] w-[7px] shrink-0" />
        {label}
      </span>

      {/* The second cell, behind the same seam two panels meet on everywhere else here. Graduated
          has no number to give — the curve is spent — so it keeps the one cell it needs. */}
      {!graduated && (
        <span className="doku-token-status-cell shrink-0 px-2.5 tabular-nums opacity-90">
          {pct.toFixed(0)}%
        </span>
      )}

      {/* The curve along the foot. `--pct` rather than a width utility because the value is a
          number this component computes, and Tailwind cannot emit an arbitrary value it will only
          learn at runtime. */}
      <span aria-hidden className="doku-token-status-track absolute inset-x-0 bottom-0 h-[2px]">
        <span
          className="doku-token-status-fill block h-full"
          style={{ "--pct": `${pct}%` } as React.CSSProperties}
        />
      </span>
    </span>
  );
};

/**
 * The label voice for every figure on this object.
 *
 * ## Why the pixel face and not tracked mono
 *
 * Every label here was JetBrains Mono, upper-cased, letter-spaced — which is the house style of
 * every crypto dashboard built in the last three years, and reads as a default rather than as a
 * decision. This product already owns a signature face: Geist Pixel Square, the Cult UI display
 * face, which `fonts.ts` calls "the face that makes the product look like itself".
 *
 * It was being spent on the two headlines and nothing else. Labels are exactly what a pixel face is
 * for — short, upper case, read as a *marker* rather than as prose — and moving them onto it is
 * what separates this page from a template. The figures stay in JetBrains Mono, because a price is
 * read digit by digit and a pixel face at 12px is not a number you want to check twice.
 */
/**
 * The label voice for every figure on this object.
 *
 * Geist Pixel Square — the Cult UI display face this app ships and which `fonts.ts` calls "the face
 * that makes the product look like itself". Every label here used to be JetBrains Mono, upper-cased
 * and letter-spaced, which is the house style of every crypto dashboard of the last three years and
 * reads as a default rather than as a decision.
 *
 * `--ash` rather than `--mute`, and 11.5px rather than 10.5: a pixel face is a *drawn* face, its
 * strokes are one pixel wide by construction, and at 10.5px in the mute grey these labels were
 * technically present and practically unreadable. The figures stay in JetBrains Mono, because a
 * price is read digit by digit and a pixel face is not a number anybody wants to check twice.
 */
/** How often the age re-reads the clock — the interval `RunnerBoard` uses. */
const AGE_TICK_MS = 10_000;

const FIGURE_LABEL = "font-pixel text-[12px] uppercase leading-none tracking-[0.05em] text-ash";

export const MarketMasthead = ({ market, className }: MainInfoProps & { className?: string }) => {
  const { t } = translationFunction();
  const { market: meta, state } = market;

  /*
   * The age needs a clock, because `formatAge` reading `Date.now()` during render is not one.
   *
   * Nothing re-rendered this component on a timer, so a market opened the moment it launched said
   * `0m old` and went on saying it for as long as the tab stayed open — directly above a trade feed
   * polling every four seconds and visibly moving. `RunnerBoard` already does this correctly; this
   * is the same ten-second tick, seeded on the client so the server pass and the first client pass
   * agree rather than trading a frozen figure for a hydration mismatch.
   */
  const now = useTicker(AGE_TICK_MS);
  /*
   * Dollars, and nothing to switch.
   *
   * The masthead opened in the quote asset — `27.1M MON`, `48.5K MON`, a price in MON — which is
   * the market's own denomination and the wrong default for the question people arrive with: "is
   * this big" and "is this expensive" are both answered in dollars. That was fixed with a toggle,
   * and a toggle is the wrong instrument for it. A switch under a headline figure means every
   * glance, every screenshot and every comparison between two markets carries a prior question —
   * *which unit is this one in* — before the number means anything, and asking it cost a cell in
   * the figures band on the desktop and a control on the phone's pair rail.
   *
   * So the hero is USD, full stop. The market's own denomination has not gone anywhere: it is on
   * the pair badge, on the price label, in the trade module and along the curve. Where a quote has
   * no price feed there is nothing to convert with, and `amount` prints that quote's own unit with
   * its symbol beside it rather than inventing a rate — the one case a symbol still appears up
   * here, and it appears because it is the truth rather than because a switch was flipped.
   */

  /**
   * The contract segment of the on-chain rail copies itself, and says so for 1400ms.
   *
   * It copies the TOKEN, not the curve. The market page is keyed by the curve address, and the
   * chip used to copy that key — which is what a trader pasted into a wallet, a scanner or a
   * terminal, none of which know what a curve is. "CA" means the token everywhere else on the
   * internet, so it means the token here.
   */
  const { copied: contractCopied, copy: copyContract } = useAddressCopy(meta.tokenAddress);

  const { data: totalSupply } = useReadContract({
    address: meta.tokenAddress as `0x${string}`,
    abi: tokenAbi,
    functionName: "totalSupply",
  });

  /**
   * The price, from whichever venue is live.
   *
   * The indexer's `last_price` comes from curve swaps, so for a graduated market it is frozen at
   * the moment it left the curve — and it can differ from the pool by a lot, because graduation
   * seeds the pool with the escrowed tax as well as the raise. Reading the pool once it exists is
   * the difference between a live price and a permanent snapshot that looks live.
   */
  const poolPrice = usePoolPrice(market);
  /**
   * The curve's last price, with BOTH divisions done in one step.
   *
   * `state.lastPrice` is the raw column, stored at the market's GENERATION scale — `quote * 1e36 /
   * base` on generation 2, a further 1e18 above generation 1. Dividing it by eighteen decimals, as
   * this did, is the generation scale mistaken for the quote's decimals: right by coincidence on
   * every generation-1 MON market, and wrong by a quintillion on everything launched since.
   *
   * The two divisions are combined rather than applied one after the other. Scaling the integer
   * first and dividing by the decimals second floors any token worth less than one raw unit of its
   * quote to zero — and one whole token of a young gold market is worth about 1.39e-9 troy ounces,
   * some nine orders of magnitude below a single raw unit of its own six-decimal quote. The price,
   * the market cap and every label built on them would read 0.00 with nothing thrown.
   */
  const curvePrice = useMemo(
    () => quotePerWholeTokenNumber(state.lastPrice, meta.generation, meta.quote.decimals) ?? 0,
    [state.lastPrice, meta.generation, meta.quote.decimals]
  );
  const price = poolPrice ?? curvePrice;

  /**
   * Supply from the chain, falling back to what the indexer saw minted.
   *
   * The chain read is authoritative and wins whenever it lands. The fallback covers the two cases
   * where it does not: the seconds before the RPC answers, and preview mode, where there is no
   * chain at all and the page read "—" where its headline figure belongs.
   */
  const marketCap = useMemo(() => {
    const supply = (totalSupply as bigint | undefined) ?? state.totalSupply;
    if (!supply) return null;
    // Whole quote units per whole token, times whole tokens. Every launched token is eighteen
    // decimals; the quote asset is the side that varies, and it was scaled out of `price` already.
    return price * Number(formatUnits(supply, BASE_DECIMALS));
  }, [price, totalSupply, state.totalSupply]);

  /**
   * The highest this market has ever been worth.
   *
   * The indexer computes it from the best price it ever recorded, on the curve or in the pool. That
   * trails the live price by however long it takes the last swap to be indexed, so a market
   * printing a new high right now would briefly show a cap above its own all-time high — which
   * reads as a bug rather than as latency. Taking the larger of the two makes the pair consistent
   * at every instant, and the indexer catches up on its own.
   */
  const athMarketCap = useMemo(() => {
    // A cap is ALREADY normalised — the service takes the generation scale off the caps and
    // leaves it on the prices — so this takes the quote's decimals and nothing else. Putting it
    // through the price helper would divide it by 1e18 a second time.
    const indexed = quoteAmountNumber(state.athMarketCap, meta.quote.decimals);
    return marketCap === null ? indexed : Math.max(indexed, marketCap);
  }, [state.athMarketCap, marketCap, meta.quote.decimals]);

  const curve = state.progress * 100;
  const graduated = Boolean(state.poolAddress);

  /**
   * The quote-asset catalogue, read *before* the identity rather than after it.
   *
   * The market's row carries its quote's address, decimals and symbol and nothing else — no name,
   * no class, no price, because those are registry facts on their own clock. `identityFor` takes
   * the catalogue as a second argument and merges the two, so handing it over here is what lets the
   * pair badge say "MON — Monad, native asset" instead of printing one ticker three times over. It
   * is the same catalogue the dollar rate is read out of a few lines down.
   */
  const { assets: quoteAssets } = useQuoteAssets();

  /**
   * What this coin is called.
   *
   * Resolved through `identityFor`, the same function the board card and the tape use, so the name
   * on this page and the name on the card that linked here cannot disagree.
   */
  const identity = useMemo(() => identityFor(meta, quoteAssets), [meta, quoteAssets]);
  const name = identity.name;
  const quote = identity.quote;

  /* `GOLD` rather than `XAUt0`, `BTC` rather than `cbBTC`, and `TSLA` + a dimmed `x` — the
     same reading the launch picker and the board's pair filter give. The masthead was the one
     surface still printing the raw registry symbol, so a market quoted in gold called itself
     two different things depending on which page you were standing on. */
  const quoteDisplay = useMemo(() => displaySymbol(quote), [quote]);

  /**
   * Dollars per whole unit of this market's quote, or `null` where nothing has priced it.
   *
   * Looked up by id, falling back to the address for an asset the catalogue has never been told
   * about. `null` — never `0` — because "worth nothing" and "not known" are different facts and
   * only one of them may be multiplied by.
   */
  const quoteUsdPrice = useMemo(() => {
    const key = (meta.quote.id ?? meta.quote.asset ?? "").toLowerCase();
    const match = quoteAssets.find(
      (a) => a.id.toLowerCase() === key || (a.address ?? "").toLowerCase() === key
    );
    const price = match?.usdPrice;
    return typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null;
  }, [quoteAssets, meta.quote.id, meta.quote.asset]);

  /** The three places a trader checks before buying. The same three the card links to. */
  const external = useMemo(() => coinExternalLinks(meta.tokenAddress), [meta.tokenAddress]);

  // The way out beside the CA chip opens the same thing the chip copies: the token.
  const explorerHref = useMemo(
    () => toExplorerLink({ linkType: "acc", value: meta.tokenAddress }),
    [meta.tokenAddress]
  );

  /**
   * A figure in the market's own quote, printed in dollars at that quote's rate.
   *
   * The rate is the QUOTE's, never MON's. Converting a figure denominated in USDC, in cbBTC or in
   * troy ounces at the MON price prints a dollar sign over a number that is not dollars, and on a
   * stablecoin market the answer looks plausible while being wrong by the whole MON price.
   *
   * With no rate there is nothing to convert with. That case falls back to the market's own unit
   * with its symbol set beside it — the honest reading, and the only reason a ticker appears among
   * these figures now that the currency switch is gone.
   */
  const amount = (inQuote: number) =>
    quoteUsdPrice === null ? (
      <span className="inline-flex items-baseline gap-1.5">
        {formatCompact(inQuote)}
        <span className="font-numeric text-[0.6em] font-medium tracking-[0.06em] text-mute">
          {quote.symbol}
        </span>
      </span>
    ) : (
      <span>{`$${formatCompact(inQuote * quoteUsdPrice)}`}</span>
    );

  /** A raw amount in the market's own quote asset — volume, turnover, what the curve has raised. */
  const quoteAmount = (value: bigint) => amount(quoteAmountNumber(value, meta.quote.decimals));

  /**
   * How far below its own high this market is trading.
   *
   * The card in the grid states it and the page it opens did not, which is the wrong way round —
   * the card has 280px and the page has a whole masthead. `null` when there is no high to compare
   * against rather than a `0%` invented out of a market that has never traded.
   */
  const fromAth =
    marketCap !== null && athMarketCap > 0 ? (marketCap / athMarketCap - 1) * 100 : null;

  /**
   * The vitals — four cells, down from seven, on one line each.
   *
   * Seven was a specification sheet rather than a set of vitals. `Total vol`, `Raised` and `Trades`
   * are each a true number and none of them is a number anybody reads *here*: turnover since launch
   * and the curve's take are on the trade module's own curve band a rail away, and the trade count
   * is the length of the feed immediately below. Their real cost was what they did to the other
   * four — seven cells across this rail is 84px each, the width at which a figure and its label
   * both truncate and every cell looks equally unimportant.
   *
   * ## And why the strip is half the height it was
   *
   * The band was 82px: a stacked label and figure with 14px of padding on both sides, and one cell
   * — fees — carrying a second line under its figure that set the height for all four. The
   * breakdown is a *qualifier*, not a vital: nobody scanning this strip is comparing fee splits,
   * and the person who wants one is asking a question that a tooltip answers in a whole sentence
   * rather than in eleven abbreviated characters. So the split moved into `title`, and with every
   * cell down to one line the label and figure sit on that line together — 183px per cell is far
   * more than `ATH MCAP $69.5M` needs — and the strip closes to about 40px.
   *
   * Market cap is deliberately absent. It is a headline directly above, and restating a headline in
   * the strip beneath it is the kind of duplication that makes a page look generated.
   */
  const vitals: { label: string; value: React.ReactNode; title?: string }[] = [
    { label: t("24h vol"), value: quoteAmount(state.volume24h) },
    { label: t("Holders"), value: state.holders.toLocaleString() },
    {
      /*
        What a trade costs — the total, and only the total.

        The label was "Tax", which is what the contract calls the creator's cut and not what this
        cell holds: it is the protocol's one percent *plus* that cut, and "tax" for the sum reads as
        somebody's charge rather than the price of trading here.

        The face carries `3%`. The breakdown is on the tooltip, in words, naming who takes each
        half — which is the part that matters and the part `1% + 2%` could not say. A figure whose
        second half is set by a stranger deserves a sentence, not an abbreviation.
      */
      label: t("Fees"),
      // Not "1% to the protocol": the protocol keeps 0.3% and 0.7% goes where the creator routed
      // it — to the creator, on a creator-routed market, which this used to call "takes nothing".
      title: t(tradeFeeSentence({ feeRouting: identity.feeRouting, creatorFeePct: identity.creatorFeePct })),
      value: `${(PROTOCOL_FEE_PCT + identity.creatorFeePct).toFixed(identity.creatorFeePct % 1 === 0 ? 0 : 1)}%`,
    },
    { label: t("ATH mcap"), value: athMarketCap > 0 ? amount(athMarketCap) : "—" },
  ];

  /**
   * The on-chain rail — who deployed it, what its contract is, the way out to the explorer.
   *
   * Three segments in one machined channel, divided by seams rather than spaced apart. They are one
   * subject — *this market, on chain* — and three separate pills said three separate things at the
   * weight of three separate controls. Each segment is still its own target: the deployer opens
   * their account, the contract copies itself and reports back by swapping its glyph for a tick,
   * and the key at the end opens the market in the explorer.
   *
   * ## Two homes
   *
   * A function rather than markup in place, because this object has two homes and they are in
   * different parents. Above `mobile-lg` it closes the meta line beside the ticker and the age,
   * which is where it reads as the small print qualifying the name. Below that width there is not
   * room for it there: at 390px the identity column is about 250px wide beside a 90px mark and the
   * rail is 293, so it hung 44px past the masthead's right edge — inside a bezel that clips. The
   * contract address was sheared mid-glyph and the explorer key was drawn entirely off screen,
   * where no pointer could reach it. That is the phone's hero overflow, and it cost precisely the
   * two controls this masthead is most used for.
   *
   * So on a phone it drops into the band below, where it has the object's full width. That band is
   * the one the pair badge and the links already move into for the same reason, so this adds no
   * row — the masthead is four bands on a phone exactly as it is on a desktop.
   *
   * The duplicate matches the pair badge and the link cluster above it: one copy is `display: none`
   * at any given width, so the accessibility tree only ever holds one of each.
   */
  const onChainRail = (className: string) => (
    <span
      className={cn(
        /*
          `w-fit max-w-full` rather than `shrink-0`.

          The channel is a machined object and has to hug its three segments: as a block-level flex
          box in the phone's band it would otherwise stretch to the full width and leave a gap of
          bare metal between the contract and the explorer key, which reads as a stretched container
          rather than a rail. `w-fit` keeps it content-sized in both homes.

          And `max-w-full` rather than `shrink-0`, so that when it genuinely cannot fit — a 320px
          phone, where the band is 250px and this is 293 — it gives ground instead of shearing its
          last segment off the masthead's edge. See the deployer segment below for which part gives.
        */
        "doku-token-rail flex w-fit max-w-full items-stretch overflow-hidden rounded-doku-lg",
        className
      )}
    >
      {/*
        The segment that gives ground, and the only one.

        At 320px the band is 250px wide and this rail is 293, so something has to. It is this: a
        deployer address is a thing you glance at, and the contract beside it is the thing people
        came to copy — `min-w-0` here with `shrink-0` on the contract puts every pixel of the
        shortfall on the glance rather than on the address somebody is about to paste into a
        wallet. Above about 470px nothing gives at all and both read in full.
      */}
      <a
        href={toExplorerLink({ linkType: "acc", value: meta.creator })}
        target="_blank"
        rel="noopener noreferrer"
        title={`${t("Deployed by")} ${meta.creator}`}
        className="doku-token-rail-seg group/by flex min-w-0 items-center gap-1.5 py-[5px] pl-2 pr-2 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-doku"
      >
        {/* A person, because "who deployed this" is a person — a two-letter `BY` in
            front of a hex string spends a third of the segment saying so in words. */}
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="shrink-0 text-mute transition-colors group-hover/by:text-doku-ink"
        >
          <circle cx="12" cy="8" r="3.4" />
          <path d="M5.5 19.5a6.8 6.8 0 0 1 13 0" />
        </svg>
        <span className="truncate font-numeric text-[12px] leading-none text-ash transition-colors group-hover/by:text-ink">
          {`${meta.creator.slice(0, 6)}…${meta.creator.slice(-4)}`}
        </span>
      </a>

      {/*
        The contract, promoted out of the channel.

        It was the middle of three identical segments — same ground, same 12px `--ash`,
        same 13px grey glyph — in a rail whose other two are places to *go*. This is the
        one thing on the masthead people arrive wanting: the address goes into a wallet,
        a scanner or a group chat within seconds of the page loading, and it was
        indistinguishable from the deployer's address sitting immediately to its left.

        So the rail keeps its recessed ground and this segment gets a raised face inside
        it: tray, then key, which is how everything else in this product marks the one
        pressable thing in a channel. It carries a `CA` plate so it can be identified
        without reading the hex, its type is `--ink` rather than `--ash`, and its glyph
        is the brand hue at rest instead of grey-until-hovered — a pointer is not
        something a phone has.

        `data-copied` drives the confirmation: the face flashes to the brand hue, the
        plate reads `OK` — two characters, exactly as wide as `CA`, so nothing on the
        line moves — and the glyph becomes a tick.
      */}
      <button
        type="button"
        onClick={copyContract}
        data-copied={contractCopied || undefined}
        title={meta.tokenAddress}
        aria-label={
          contractCopied
            ? t("Address copied")
            : `${t("Copy contract address")} ${meta.tokenAddress}`
        }
        className="doku-token-rail-seg doku-token-rail-copy group/copy m-[3px] flex shrink-0 items-center gap-2 rounded-[9px] py-[3px] pl-[5px] pr-2 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-doku"
      >
        <span
          aria-hidden
          className="doku-token-rail-tag shrink-0 rounded-[6px] px-1.5 py-[2px] font-numeric text-[11px] font-semibold uppercase leading-none tracking-[0.08em]"
        >
          {contractCopied ? "OK" : "CA"}
        </span>
        <span className="font-numeric text-[12px] font-medium leading-none text-ink">
          {`${meta.tokenAddress.slice(0, 6)}…${meta.tokenAddress.slice(-4)}`}
        </span>
        {contractCopied ? (
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            className="shrink-0 text-doku"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        ) : (
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            className="shrink-0 text-doku-ink/70 transition-colors group-hover/copy:text-doku-ink"
          >
            <rect x="9" y="9" width="12" height="12" rx="2.5" />
            <path d="M5 15V5a2 2 0 0 1 2-2h10" />
          </svg>
        )}
      </button>

      <a
        href={explorerHref}
        target="_blank"
        rel="noopener noreferrer"
        title={`${name} ${t("on the block explorer")}`}
        aria-label={`${name} ${t("on the block explorer")}`}
        className="doku-token-rail-seg group/exp flex shrink-0 items-center px-[7px] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-doku"
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="shrink-0 text-mute transition-colors group-hover/exp:text-doku-ink"
        >
          <path d="M7 17 17 7M9 7h8v8" />
        </svg>
      </a>
    </span>
  );

  return (
    /* 1. The tray the whole object is pressed into — the card's own first layer. */
    <section className={cn("doku-token-tray relative rounded-[19px] p-[3px]", className)}>
      {/* 2. The rim, floating proud of the tray. A hairline drawn *on* a surface reads as a border;
             the same hairline floating three pixels off it reads as a machined edge catching light,
             and it is the cue every premium surface in this product shares. */}
      <span
        aria-hidden
        className="doku-token-rim pointer-events-none absolute -inset-[3px] rounded-[22px]"
      />

      {/* 3. The bezel. Everything below lives inside it. */}
      <div className="doku-token-face relative overflow-hidden rounded-[16px]">
        {/* ============================================================================
            The cover — the coin's own image, dissolving into the surface.
           ============================================================================ */}
        {/*
          The cover's height is a proportion, not a leftover.

          It went 152 → 96 chasing a shorter masthead and overshot: at 96px a 3:1 image is a stripe,
          the dissolve has no room to be a dissolve, and the mark — which overlaps it by design —
          had nowhere to hang from. 116/140 is the band that still reads as a cover while leaving
          the price above the fold.
        */}
        {/* 96/112, down from 116/140.

            The cover is the coin's artwork and it is not the subject of this page — the price, the
            figures and the trade box are. At 140px it was the tallest single element in a masthead
            that already runs four bands deep, and the thirty pixels it gives back come off the top
            of every market page in the product. The mark still straddles its lower edge, which is
            the part that ties the two into one object. */}
        <div className="relative h-[96px] w-full overflow-hidden sm:h-[112px]">
          {/*
            The dissolve is a mask on the cover itself, not a wash over it.

            A gradient overlay has to *match* the surface it fades into, and the bezel is itself a
            gradient — so the overlay's last stop was right at one pixel row and a shade off at
            every other, leaving a faint horizontal step where the cover ended. Masking the image
            fades its alpha instead: the bezel shows through exactly as it is, at any height, in
            either theme, with nothing to keep in sync.
          */}
          <div className="doku-token-cover absolute inset-0">
            {identity.banner ? (
              /* eslint-disable-next-line @next/next/no-img-element -- a launcher's URL, from any
                 host; `next/image` needs an allow-list a permissionless launchpad cannot hold. */
              <img src={identity.banner} alt="" className="h-full w-full object-cover" />
            ) : (
              /* The same generated banner the board card draws, so a coin with no artwork looks
                 like itself on both surfaces rather than like two different fallbacks. */
              <GeneratedBanner seed={identity.ticker} />
            )}
          </div>

          {/* One hair of shade across the top, so a bright cover cannot swallow the status plate. */}
          <span
            aria-hidden
            className="doku-token-cover-shade pointer-events-none absolute inset-0"
          />

          {/* The state, plated on the cover. */}
          <span className="absolute right-3 top-3">
            <StatusPill graduated={graduated} progress={curve} />
          </span>
        </div>

        {/* ============================================================================
            Identity — the mark overlaps the cover, which is what ties the two into one object.
           ============================================================================ */}
        {/*
          One band, not two.

          The mark hangs off the cover, so this band has to be tall enough to hold the part of it
          that hangs *below* — otherwise the next band's seam runs across the mark's foot, which is
          the one object on the page meant to sit on top of everything. `pb-4/5` is that clearance,
          measured rather than guessed: 90px of mounted mark, 46 of it above this band's top edge,
          44 below, against a type stack that wraps to at most 82.

          Everything the previous pass gave a second band to is inside this one now. The contract
          and the deployer are segments on a rail in the meta line, beside the age; the links ride
          under the pair badge. A masthead is an object, and an object does not grow a row every
          time a fact needs somewhere to live.
        */}
        <div className="relative -mt-[42px] px-4 pb-4 sm:-mt-[46px] sm:px-5 sm:pb-5">
          {/* Light pooled behind the mark's shoulder, so the mount reads as standing off the bezel
              rather than being cut out of it. The one soft edge on the object. */}
          <span
            aria-hidden
            className="doku-token-hearth pointer-events-none absolute inset-x-0 bottom-0 top-[46px]"
          />

          <div className="relative flex items-end gap-4 sm:gap-5">
            {/*
              96px of mounted mark, not 78.

              The coin's own artwork is the reason most people stop on this page, and at 78 it was
              smaller than the app icon of the browser it renders in. The overlap moves with it —
              half the mark's height, so it still sits astride the cover's lower edge — and the
              band's bottom padding with that.
            */}
            <span className="doku-token-mount relative shrink-0 rounded-[22px] p-[3px]">
              <CoinMark
                logo={identity.logo}
                ticker={identity.ticker}
                name={name}
                size={84}
                className="rounded-[16px]"
              />
              {/* The specular: one sheet of light across the mark's upper-left corner, drawn over
                  the artwork so the mount and what is in it read as one milled piece rather than a
                  picture sitting in a frame. The same treatment the pair badge's well gets. */}
              <span
                aria-hidden
                className="doku-token-mount-gloss pointer-events-none absolute inset-[3px] rounded-[16px]"
              />
            </span>

            {/*
              The identity column: the name, and the line of facts that qualifies it.

              The meta line carries the ticker, the age and then the on-chain rail — the deployer,
              the contract and the way out to the explorer. Those had a band of their own for one
              pass, which is a row of masthead spent on two hex strings; and before that they were
              two 32px pills stacked directly under a 28px headline, so the first thing under the
              coin's name was a pair of grey buttons. On the meta line they are what they are: the
              small print that qualifies the name, sitting with the rest of the small print.

              `flex-wrap` rather than a breakpoint. Beside a 230px pair badge this column is about
              220px, so the rail drops to a line of its own on a narrow masthead and sits directly
              after the age on a wide one — and either way the column stays under the mark's 90px,
              so nothing about the cover overlap moves.
            */}
            <div className="flex min-w-0 flex-1 flex-col gap-2.5">
              <h1 className="min-w-0 truncate font-ui text-[24px] uppercase leading-none tracking-[0.02em] text-ink sm:text-[28px]">
                {name}
              </h1>

              <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-2">
                {/* No middots between these three. A separator earns its place when the items
                    beside it could otherwise be read as one string; a ticker, an age and a machined
                    rail cannot, and the two dots were 18px the rail needed to sit on this line. */}
                <span className="font-numeric text-[13px] leading-none text-ink">
                  <span className="text-mute">$</span>
                  {identity.ticker}
                </span>
                <span className="font-numeric text-[13px] leading-none text-ash">
                  {now === 0 ? "—" : formatAge(meta.launchedAt, now)} {t("old")}
                </span>

                {/* Beside the age where there is room for it, and in the band below where there is
                    not — the same `sm` line the pair badge and the links split on, so the masthead
                    has one mobile layout rather than three overlapping ones. See `onChainRail`. */}
                {onChainRail("hidden shrink-0 sm:flex")}
              </div>
            </div>

            {/*
              ---- The pair badge --------------------------------------------------------------

              At the right edge of the band, alone. Inline after the age it was the fourth item in a
              list of metadata and read as one — and this is not metadata, it is the fact DOKU
              exists for. With the right half of the band to itself it has nothing to be fourth *of*.

              ## Why the previous build could not be read

              It was made of `--film-*` — translucent white over whatever is behind it — and what is
              behind it here is *the coin's cover art*, because the badge overlaps it the way the
              mark does. On a violet banner the plate went violet, the interior seam dissolved into
              it, and `PAIRED WITH` in `--mute` over that lilac was rendered and unreadable.
              Contrast that depends on which image a stranger uploaded is not contrast.

              ## What it is now

              An opaque machined tag, pinned on the artwork rather than tinted by it: its own solid
              ground so nothing reaches through, a lit top lip with a brand hairline, a drop shadow
              with the brand's light pooled in it so it sits *above* the cover, a seam splitting the
              mark from the type, and the mark itself pressed into a bevelled well under a gloss.

              And it says something. Three lines: what the relationship is, the ticker you trade
              against, and the asset's real name and class out of the registry — `quote.name` falls
              back to the symbol for an asset the catalogue has never heard of, so the third line
              drops the name when it would only repeat the second.
            */}
            <div className="hidden shrink-0 flex-col items-end gap-2.5 sm:flex">
              <span
                title={`${t("Paired with")} ${displaySymbolText(quote)} — ${quote.name}, ${QUOTE_ASSET_KIND_NAMES[quote.kind].toLowerCase()}`}
                className="doku-token-pair relative flex shrink-0 items-center gap-3 overflow-hidden rounded-doku-xl p-[7px] pr-[18px]"
              >
                {/* The milled face, and the brand light leaking in from the mark's corner. Drawn as
                    a layer rather than as more background stops so the plate's own ground token
                    stays the one thing that decides its colour in each theme. */}
                <span
                  aria-hidden
                  className="doku-token-pair-face pointer-events-none absolute inset-0"
                />

                <span className="doku-token-pair-well relative grid h-[46px] w-[46px] shrink-0 place-items-center rounded-[13px]">
                  <AssetIcon asset={quote} size={28} className="rounded-[8px]" />
                </span>

                {/* Two lines, not three. It carried the asset's class — `Native asset` — under
                    the ticker, which is a fact the tooltip already states and which nobody reads
                    off a badge whose whole job is to answer "what does this trade against". */}
                <span className="doku-token-pair-seam relative flex flex-col gap-[7px] py-0.5 pl-3.5">
                  <span className="doku-token-pair-eyebrow font-numeric text-[11px] font-semibold uppercase leading-none">
                    {t("Paired with")}
                  </span>
                  <span className="flex items-baseline gap-[1px] font-pixel text-[19px] uppercase leading-none tracking-[0.01em] text-ink">
                    {quoteDisplay.base}
                    {quoteDisplay.suffix && (
                      <span className="text-[12px] text-mute">{quoteDisplay.suffix}</span>
                    )}
                  </span>
                </span>
              </span>

              {/*
                Every way off this page, under the badge rather than in a band of its own.

                The coin's own identity on one side of the divide and the three lookup venues on the
                other — "who is this" against "where do I go and look", the split the board card
                already makes. Stacked under the pair badge they fill the room an 84px mark leaves
                in this band, which is why the footer they used to live in no longer exists.
              */}
              <div className="flex shrink-0 items-center gap-2">
                {/*
                  The coin's own links, and only the coin's own links.

                  The block explorer used to be the third key here, which put the same destination
                  on the masthead twice: once as the arrow that closes the on-chain rail beside the
                  age, and again as a cube glyph two elements to the right, immediately beside
                  DexScreener. Two controls, one href, eighteen pixels apart — and the copy that
                  people actually come to this masthead for was the quietest thing on the line.

                  It stays on the rail, where it belongs: that is the segment about the contract,
                  and "open this contract somewhere else" is the last thing that channel says.

                  The row renders only when the coin has a link of its own, so a coin with neither
                  does not leave an empty flex child putting eight pixels of gap in front of the
                  venue group.
                */}
                {(identity.links?.website || identity.links?.x) && (
                  <div className="flex shrink-0 items-center gap-1.5">
                    {identity.links?.website && (
                      <IconLink href={identity.links.website} label={`${name} website`}>
                        <GlobeGlyph />
                      </IconLink>
                    )}
                    {identity.links?.x && (
                      <IconLink href={identity.links.x} label={`${name} on X`}>
                        <XGlyph />
                      </IconLink>
                    )}
                  </div>
                )}

                <VenueGroup external={external} coin={name} graduated={graduated} />
              </div>
            </div>
          </div>
        </div>

        {/*
          The phone's pair rail.

          Below `sm` the badge cannot share the identity row — a 46px well plus three lines of type
          beside a 96px mark leaves the name about forty pixels — so it takes a line of its own, and
          it takes the links with it. Those were a second band underneath; with the currency switch
          gone there was half a rail free and no reason for two bands where one holds both. The
          badge is content-sized and pushed left, the links are pushed right, and the row wraps
          rather than shears if a coin carries every link there is.

          It is a column of two rows now rather than one wrapping row, because the on-chain rail
          joins it below `mobile-lg` — see `onChainRail`. The rail is a 293px object and the pair
          and the links between them already fill a 390px band, so letting all three wrap against
          each other would put the rail wherever the coin's link count happened to leave it. Two
          rows says where each belongs: what it trades against, then where to go and check it.
        */}
        <div className="doku-token-band flex flex-col gap-3 px-4 py-3 sm:hidden">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-3">
            <span
              title={`${t("Paired with")} ${quote.name} · ${QUOTE_ASSET_KIND_NAMES[quote.kind]}`}
              className="doku-token-pair relative flex min-w-0 shrink items-center gap-2.5 overflow-hidden rounded-doku-xl p-1.5 pr-4"
            >
              <span
                aria-hidden
                className="doku-token-pair-face pointer-events-none absolute inset-0"
              />

              <span className="doku-token-pair-well relative grid h-10 w-10 shrink-0 place-items-center rounded-doku-lg">
                <AssetIcon asset={quote} size={24} className="rounded-[7px]" />
              </span>
              <span className="doku-token-pair-seam relative flex min-w-0 flex-col gap-[6px] py-0.5 pl-3">
                <span className="doku-token-pair-eyebrow font-numeric text-[11px] font-semibold uppercase leading-none">
                  {t("Paired with")}
                </span>
                <span className="flex items-baseline gap-[1px] truncate font-pixel text-[17px] uppercase leading-none tracking-[0.01em] text-ink">
                  {quoteDisplay.base}
                  {quoteDisplay.suffix && (
                    <span className="text-[11px] text-mute">{quoteDisplay.suffix}</span>
                  )}
                </span>
              </span>
            </span>

            <div className="flex shrink-0 items-center gap-2">
              {/* Same two rules as the desktop row above: no second explorer key, and no empty
                cluster when the coin carries no links of its own. */}
              {(identity.links?.website || identity.links?.x) && (
                <div className="flex shrink-0 items-center gap-1.5">
                  {identity.links?.website && (
                    <IconLink href={identity.links.website} label={`${name} website`}>
                      <GlobeGlyph />
                    </IconLink>
                  )}
                  {identity.links?.x && (
                    <IconLink href={identity.links.x} label={`${name} on X`}>
                      <XGlyph />
                    </IconLink>
                  )}
                </div>
              )}

              <VenueGroup external={external} coin={name} graduated={graduated} />
            </div>
          </div>

          {/* The rail, at the object's full width — the widths where the identity column cannot
              hold it. `sm:hidden` against the inline copy's `sm:flex`, so the two never both draw
              and never both vanish. */}
          {onChainRail("sm:hidden")}
        </div>

        {/* ============================================================================
            The two figures the page is about.
           ============================================================================ */}
        {/*
          Two equal columns, at every width.

          There is nothing else in this band now — the currency switch was the third cell, and it is
          gone with the toggle it operated — so the price and the market cap take half the rail
          each, on a phone and on a desktop alike. As a flex row with a `shrink-0` control beside
          them, a 390px screen gave these two ~125px apiece and both broke: the price elided to
          `0.000…` and the cap was clipped mid-glyph to `5.4|`, which are the two numbers the whole
          page is *for*.

          `items-stretch` is kept so the two cells share a height and their seam runs the full band.
        */}
        <div className="doku-token-figures grid grid-cols-2 items-stretch">
          <div className="flex min-w-0 flex-col gap-2.5 px-4 py-4 sm:px-5">
            {/* The unit is stated rather than switchable. It is USD wherever the market's quote
                has a rate, and the quote's own ticker where nothing has priced it. */}
            <span className={cn(FIGURE_LABEL, "truncate")}>
              {`${t("Price")} · ${quoteUsdPrice !== null ? "USD" : quote.symbol}`}
            </span>
            {/* Cut to four significant figures: a full 18-decimal price is twice the width of the
                market cap beside it and impossible to compare between markets. Not scrambled — that
                animation cycles digits, so for its duration the headline price reads as a number
                which is simply wrong. */}
            {/* The headline price, in the same unit as everything else on the object — which is
                now guaranteed rather than maintained, because there is one branch and both figures
                take it. */}
            <span className="truncate font-numeric text-[27px] font-semibold leading-none tracking-[-0.01em] tabular-nums text-ink sm:text-[31px]">
              {quoteUsdPrice !== null ? (
                <>
                  <span className="text-[0.62em] text-mute">$</span>
                  <FormattedNumber value={price * quoteUsdPrice} decimals={4} />
                </>
              ) : (
                <FormattedNumber value={price} decimals={4} />
              )}
            </span>
          </div>

          <div className="doku-token-channel flex min-w-0 flex-col gap-2.5 px-4 py-4 sm:px-5">
            <span className={FIGURE_LABEL}>{t("Market cap")}</span>
            {/* `flex-wrap`: the delta chip drops under the figure rather than stealing width from
                it. On a 179px phone column `5.4K MON` plus a `−1.7%` pill does not fit on one line,
                and the figure is the one that must not give. */}
            <span className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1.5">
              <span className="truncate font-numeric text-[27px] font-semibold leading-none tracking-[-0.01em] tabular-nums text-ink sm:text-[31px]">
                {marketCap === null ? "—" : amount(marketCap)}
              </span>
              {/* The distance from the high, as a chip. A signed percentage beside a larger figure
                  in green or red is two values competing at one weight; a tinted pill is a different
                  *object*, picked out by shape before it is read. The card does this too. */}
              {fromAth !== null && (
                <span
                  aria-label={t("Distance from all-time high")}
                  className={cn(
                    "shrink-0 rounded-doku-sm border border-solid px-1.5 py-[3px] font-numeric text-[11px] font-semibold leading-none",
                    fromAth < -0.5
                      ? "border-loss/30 bg-loss/10 text-loss-ink"
                      : "border-doku/30 bg-doku/10 text-doku-ink"
                  )}
                >
                  {`${fromAth < 0 ? "−" : "+"}${Math.abs(fromAth).toFixed(fromAth === 0 ? 0 : 1)}%`}
                </span>
              )}
            </span>
          </div>
        </div>

        {/* ============================================================================
            The vitals grid.

            Cells that wrap, each drawing a seam on its top and left edge, with the track pulled a
            pixel up and left inside a clipped box so the outermost seams land outside it. That
            keeps the ruling correct at *any* wrap point without an `nth-child` exception per
            breakpoint — the same construction the footer's grid uses.
           ============================================================================ */}
        <div className="doku-token-vitals overflow-hidden">
          <dl className="-ml-px -mt-px grid grid-cols-2 sm:grid-cols-4">
            {vitals.map(({ label, value, title }) => (
              <div
                key={label}
                title={title}
                className="doku-token-cell flex min-w-0 items-baseline gap-2 px-4 py-3 sm:px-5"
              >
                <dt className={cn(FIGURE_LABEL, "shrink-0")}>{label}</dt>
                <dd className="min-w-0 flex-1 truncate text-right font-numeric text-[14px] font-semibold leading-none tabular-nums text-ink">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </div>

        {/*
          There is no foot band.

          It carried the contract, the deployer and six links across the full width of the masthead,
          *under* the vitals — the last thing on the object, which is the wrong place for the two
          facts that say what this market is. The links went up beside the pair badge, where "who is
          this" and "where do I go and look" sit together the way the board card already puts them.
          The addresses went into the description band, where they answer the sentence beside them.
          The phone keeps both as wrapping rails in bands of their own, for the width.
        */}
      </div>

      {/* 4. The object's own edge, drawn over everything inside it.
             The bezel clips its children and those children paint grounds — the cover, the bands —
             so a border on the bezel is painted *under* them and vanishes wherever a ground reaches
             the edge, which is most of this object's height. */}
      <span
        aria-hidden
        className="doku-token-edge pointer-events-none absolute inset-[3px] rounded-[16px]"
      />
    </section>
  );
};

export default MarketMasthead;
