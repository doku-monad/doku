"use client";

import LivelineChart from "components/charts/LivelineChart";
import { Panel } from "components/ui/panel";
import { translationFunction } from "context/language-context";
import { useEmojiColor } from "lib/hooks/doku/use-emoji-color";
import React, { useMemo, useState } from "react";

import { identityFor } from "@/lib/token-identity";

import type { GridProps } from "../../types";
import AddLiquidityCta from "../cta/AddLiquidityCta";
import { CoinHolders } from "../holders/coin-holders";
import MarketMasthead from "../masthead/MarketMasthead";
import { PersonalTradeHistory } from "../personal-trade-history/personal-trade-history";
import RewardsModule from "../rewards/RewardsModule";
import TokenSpecSheet from "../spec/TokenSpecSheet";
import TradeFeed from "../trade-history/TradeFeed";
import SwapComponent from "../trade-token/SwapComponent";

/**
 * The token page.
 *
 * ## The shape
 *
 * **Two rails, split by verb.** Left is everything you *look at* — who this coin is, what it costs,
 * what the price has done, what has been traded. Right is everything you *do*, and everything you
 * need to know before doing it: the trade module at the very top of the page, the token's facts
 * under it, and the one alternative use of the same money at the foot.
 *
 * That is the whole layout argument, and it replaced two of them. The first was the default every
 * explorer ships — chart, swap box beside it, table underneath — which answers "what is the price
 * doing" and "do you want to trade" and then stops. The second was a three-register console that
 * fixed the *content* gap (see `TokenSpecSheet`) and left seven panels arranged in two rows of
 * unequal height, with the trade module stranded in the middle of the right column below a
 * chart-height card. Correct information, scattered composition.
 *
 * ## Why the modules are bands, not more panels
 *
 * Each rail is a short stack of *objects*, and each object is built from bands divided by seams
 * rather than from further panels divided by gaps:
 *
 *   - The masthead is one object: identity, the two headline figures, the vitals strip.
 *   - The trade module is one object: the venue rail, the sides, the two amounts, the receipt, the
 *     CTA, and the curve as its foot band — because the curve is the state of the thing the control
 *     operates, not a separate subject filed beside it.
 *   - The deck is one object: the tab rail and whichever list it is showing.
 *   - The spec sheet is one object: a header band and ruled rows.
 *
 * A gap between two panels says "these are unrelated". A seam inside one panel says "these are two
 * parts of the same instrument". The page had eleven of the first and almost none of the second,
 * which is exactly what "scattered" means when somebody points at a screen and cannot say why.
 *
 * ## What deliberately did not change
 *
 * Anything that computes a number. `SwapComponent`, `TradeFeed`, `PersonalTradeHistory` and
 * `CoinHolders` compute exactly what they always did: quoting, slippage, decimal handling and the
 * anti-sniper tax window are where a redesign that "starts from scratch" silently changes what a
 * trade costs.
 *
 * ## The spacing
 *
 * One gap value, `gap-4`, between every object at every breakpoint, and none inside them. Panels own
 * their padding, the page owns the gaps, and nothing here sets a horizontal margin: the rail belongs
 * to `ContentWrapper`, so both columns land on the same edges as the top bar's dock and the home
 * grid.
 */

const TABS = [
  { key: "trades", label: "Trades" },
  { key: "mine", label: "My trades" },
  { key: "holders", label: "Holders" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const DesktopGrid = (props: GridProps) => {
  const [tab, setTab] = useState<TabKey>("trades");
  const { t } = translationFunction();
  const { css: accent } = useEmojiColor(props.market.market.symbol);
  /* The coin's name, resolved once for the panels that print it — the feed's amount column and the
     holders table both say what this market is, and they have to say the same thing. */
  const identity = useMemo(() => identityFor(props.market.market), [props.market.market]);

  /**
   * Counts beside the labels.
   *
   * "My trades" is deliberately absent: it depends on a connected wallet, and a confident `0`
   * before that resolves reads as "you have never traded this" when the honest answer is "not
   * known yet".
   */
  const counts: Partial<Record<TabKey, number>> = {
    trades: props.data.swaps.length,
    holders: props.data.holders.length,
  };

  return (
    /*
      Two rails, and the split is by *verb*.
      ------------------------------------------------------------------------------------------
      Left is everything you look at: who this coin is, what it costs, what the price has done,
      what has been traded. Right is everything you do and everything you need to know before doing
      it: the trade module at the very top, then the facts, then the other thing you could do with
      the same money.

      The previous pass had the swap in the middle of the right column, under a chart-height card,
      and seven separate panels arranged in two rows of unequal height — which is what made the page
      read as scattered. Two rails of stacked objects, each object built from bands rather than from
      more panels, is one composition instead of a grid of boxes.

      `items-start` matters: without it the two rails stretch to the taller one and every panel in
      the shorter rail grows dead space at its foot.
    */
    <div className="pb-4">
      {/*
        Two rails on a laptop, and a deliberate order on a phone.

        Placement is explicit at `lg` — the left rail spans both rows of column one, the trade module
        takes row one of column two and the facts take row two — precisely so the *source* order can
        be the mobile order without disturbing the desktop one.

        On a phone that order is: identity, then the trade module, then the chart, then the record,
        then the facts. Somebody who opens a coin on a phone came to buy it or to look at the price,
        in that order; the previous stack put a 420px chart and a 400px trade feed between the name
        and the only control on the page.
      */}
      {/*
        `lg:grid-rows-[auto_1fr]`, because the right column spans both rows. CSS grid hands a
        spanning item's EXCESS height to the rows it spans in equal parts, so on a page whose right
        column is the taller one — every graduated market, which carries the dividends panel and the
        pool's token facts — half the excess landed in row one, as ninety pixels of nothing between
        the masthead and the chart. `items-start` cannot help: the track itself grew. Pinning row
        one to its content sends the whole excess to row two, under the trade feed, where the rail
        already ends and nothing is left waiting.
      */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.68fr)_minmax(366px,1fr)] lg:grid-rows-[auto_1fr]">
        {/* Row one of the left column: who this coin is. */}
        <MarketMasthead
          market={props.market}
          className="order-1 lg:order-none lg:col-start-1 lg:row-start-1"
        />

        {/* ============================================================================
          The left rail — identity, price, history.
         ============================================================================ */}
        <div className="order-3 flex min-w-0 flex-col gap-4 lg:order-none lg:col-start-1 lg:row-start-2">
          {/*
          The chart, with no header of its own.

          It had two: a `PanelHeader` reading "Price · Realtime", and then the chart's own readout —
          the live figure, the change chip and the range switch — immediately beneath it. Two header
          rows stacked on one panel is half the reason this page felt loose. `LivelineChart` owns the
          row, because the row is made of the chart's own state.
        */}
          {/*
            The height lands on the BODY, which is the rule `Panel` states and this line broke.

            `className` goes on the wrapper and the body is `h-full` — and a percentage height does
            not resolve against a parent that has only `min-height`. So the body fell back to its
            content: a 360px face inside a 420px box, with the rim correctly drawn at 426 around the
            whole thing. Sixty pixels of bare panel under the chart, inside its own border, which is
            precisely the "dead space at the bottom" `Panel`'s own docstring warns about.

            The `<Suspense>` that wrapped this is gone too. `LivelineChart` never suspends — it holds
            `status` in `useState` and fetches in an effect, rendering its own loading branches — so
            the boundary could not fire; and if it ever did, the fallback it named is the FULL-SCREEN
            route splash, a 300px card with a 72px emoji well, dropped into a chart cell.
          */}
          <Panel bodyClassName="flex min-h-[420px] flex-col">
            <LivelineChart
              marketAddress={props.market.market.marketAddress}
              accent={accent}
              /* The market's own quote, because the chart printed "MON" on every market's price
                 whatever it was actually denominated in. */
              quoteSymbol={identity.quote.symbol}
              /* ALL picks its own bucket size from this — see `resolveRange`. Without it the range
                 falls back to daily candles, which on a five-day-old market is four segments. */
              launchedAt={Math.floor(props.market.market.launchedAt.getTime() / 1000)}
              className="min-h-0 flex-1"
            />
          </Panel>

          {/* The record: what has actually happened, in one deck. */}
          <Panel padded={false} className="min-w-0">
            <div
              role="tablist"
              aria-label={t("Market activity")}
              className="doku-deck-rail flex items-center gap-1.5 overflow-x-auto rounded-t-[20px] px-3 py-3 sm:px-4"
            >
              {/* The keys sit in a well — the same segmented control the chart's range switch and the
                feed's filter are cut from. See `.doku-seg`. */}
              <div className="doku-seg flex min-w-0 items-center gap-1 rounded-[13px] p-1">
                {TABS.map((item) => {
                  const selected = tab === item.key;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      data-active={selected}
                      onClick={() => setTab(item.key)}
                      className="doku-seg-key inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-[10px] px-3.5 font-ui text-[13.5px] font-semibold"
                    >
                      {t(item.label)}
                      {counts[item.key] !== undefined && (
                        <span
                          className={
                            selected
                              ? "rounded-full bg-[var(--film-3)] px-1.5 py-0.5 font-numeric text-[11px] font-medium leading-none tabular-nums text-ash"
                              : "rounded-full bg-[var(--film-1)] px-1.5 py-0.5 font-numeric text-[11px] font-medium leading-none tabular-nums text-mute"
                          }
                        >
                          {counts[item.key]}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/*
              One padding AND one height for every tab's body.

              The padding was already shared: each panel used to bring its own inside this
              container's, so a tab was inset twice as far as its neighbour.

              The height was not, and that was a worse bug. The deck was as tall as whichever tab
              was open — measured 575 / 580 / 519 across Trades, My trades and Holders, because the
              first two carry a side filter and the third does not. Every switch moved the chart
              above it, the footer below it, and on a short viewport the tab rail itself out from
              under the pointer that had just clicked it. A fixed box with `min-h-0 flex-1`
              children is what makes each list scroll in place instead of resizing the page — the
              same fix `WalletClientPage` already applies to its own deck, for the same reason.
            */}
            <div
              role="tabpanel"
              aria-label={TABS.find((item) => item.key === tab)?.label}
              className="flex h-[508px] flex-col p-4 sm:p-5"
            >
              {tab === "trades" && (
                <TradeFeed
                  swaps={props.data.swaps}
                  ticker={identity.ticker}
                  quoteDecimals={props.data.market.market.quote.decimals}
                  quoteSymbol={props.data.market.market.quote.symbol ?? "MON"}
                />
              )}
              {tab === "mine" && <PersonalTradeHistory data={props.data} />}
              {tab === "holders" && (
                <CoinHolders ticker={identity.ticker} holders={props.data.holders} />
              )}
            </div>
          </Panel>
        </div>

        {/* ============================================================================
          The right rail, in two placements: the trade module above the chart on a phone, the
          facts below the record.
         ============================================================================ */}
        <div className="order-2 flex min-w-0 flex-col gap-4 lg:order-none lg:col-start-2 lg:row-span-2 lg:row-start-1">
          {/*
          The trade module — the top of the right rail, level with the coin's own name.

          It is the reason the route exists, so it sits at the height of the masthead rather than
          under a chart. On a phone it follows the masthead directly, ahead of the chart and the
          record: somebody opening a coin on a phone came to buy it or to check the price, in that
          order. The curve lives inside it as its foot band rather than as a panel underneath — see
          `SwapComponent`.

          It is built from the card's material rather than the page's glass.

          `Panel` is a translucent pane with a blur behind it — right for a chart or a table, and
          wrong for the one control on the page you press to spend money. This is the tray, rim,
          bezel and edge the masthead and every board card are cut from, so the object you trade
          with is built like the object you clicked to get here. It is also the only way to get real
          depth: a blurred pane has no lit lip and no recess, and a widget with no recess is a
          drawing of a widget.
        */}
          <section className="doku-token-tray relative rounded-[19px] p-[3px]">
            <span
              aria-hidden
              className="doku-token-rim pointer-events-none absolute -inset-[3px] rounded-[22px]"
            />
            <div className="doku-token-face relative overflow-hidden rounded-[16px]">
              <SwapComponent market={props.market} initNumSwaps={props.data.swaps.length} />
            </div>
            <span
              aria-hidden
              className="doku-token-edge pointer-events-none absolute inset-[3px] rounded-[16px]"
            />
          </section>

          {/* Where the creator's share of every trade goes, when the launcher pointed it somewhere.
            Nothing at all when they kept it — see `RewardsModule`. */}
          <RewardsModule market={props.market} />

          {/*
            The dossier — what this coin *is*.

            In the same tray-rim-bezel stack as the trade module above it rather than in a glass
            `Panel`: a sidebar of three blocks in two materials reads as two of them belonging and
            one visiting. See `TokenSpecSheet` for why every row states a mechanism rather than a
            verdict.
          */}
          <section className="doku-token-tray relative rounded-[17px] p-[3px]">
            <span
              aria-hidden
              className="doku-token-rim pointer-events-none absolute -inset-[3px] rounded-[20px]"
            />
            <div className="doku-token-face relative overflow-hidden rounded-[14px]">
              <div className="doku-swap-head flex items-center justify-between gap-3 px-4 py-3">
                <span className="font-ui font-semibold text-[12px] uppercase leading-none tracking-[0.04em] text-ash">
                  {t("Token facts")}
                </span>
                <span className="doku-swap-venue flex shrink-0 items-center gap-1.5 rounded-doku-lg px-2 py-1 font-pixel text-[11px] uppercase leading-none tracking-[0.04em] text-mute">
                  {t("On-chain")}
                </span>
              </div>
              <div className="px-4 pb-3 pt-1">
                <TokenSpecSheet market={props.market} />
              </div>
            </div>
            <span
              aria-hidden
              className="doku-token-edge pointer-events-none absolute inset-[3px] rounded-[14px]"
            />
          </section>

          <AddLiquidityCta label={t("Add liquidity")} />
        </div>
      </div>
    </div>
  );
};

export default DesktopGrid;
