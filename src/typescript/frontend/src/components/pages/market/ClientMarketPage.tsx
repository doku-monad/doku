"use client";

import React, { useMemo } from "react";

import { Box } from "@/containers";
import { LIVE_FEED_URL } from "@/lib/chain/wagmi";
import { useLiveFeed } from "@/lib/hooks/doku/use-live-feed";
import { deriveLiveState, useLiveHolders, useLiveSwaps } from "@/lib/hooks/doku/use-market-live";

import DesktopGrid from "./components/desktop-grid";
import type { MarketProps } from "./types";

/**
 * The market page.
 *
 * Server data seeds the polling caches, so the first paint is complete and the poll only ever
 * replaces content that is already on screen. Curve state is derived from the trade feed rather
 * than fetched separately — every swap carries the post-trade total, which is why the contract
 * emits it.
 */
const ClientMarketPage = ({ data }: MarketProps) => {
  const address = data.market.market.marketAddress;

  // The socket only invalidates; the queries below remain the source of truth, and keep polling
  // whether or not it connects.
  useLiveFeed(LIVE_FEED_URL);

  const { data: swaps } = useLiveSwaps(address, data.swaps);
  const { data: holders } = useLiveHolders(address, data.holders);

  const market = useMemo(() => deriveLiveState(data.market, swaps), [data.market, swaps]);
  const live = useMemo(() => ({ market, swaps, holders }), [market, swaps, holders]);

  /*
   * No rail of its own.
   *
   * Every block here used to be wrapped in `mx-auto max-w-[1240px] px-4 md:px-6` — *inside*
   * `ContentWrapper`, which is already `max-w-[1240px] px-4 sm:px-6`, and inside `PageFrame`,
   * which gives that padding back again. So the page paid for the same rail three times and its
   * content sat 16px inboard of the page frame at 700px and 24px inboard at 900px, on a different
   * breakpoint (`md`, 768px here) from the one the rest of the app aligns to (`sm`, 640px). The
   * market card, the chart and the tab deck lined up with each other and with nothing else in the
   * product — not the top bar's dock, not the home grid, not the footer.
   *
   * The rail is the wrapper's job. This is a plain column on it, and the gap is the page's only
   * vertical rhythm: one value, everywhere.
   */
  return (
    <Box className="flex w-full flex-col gap-4">
      {/*
        One layout at every width.

        There used to be two — `MobileGrid` and `DesktopGrid` — chosen by a JS breakpoint hook,
        which meant two component trees to keep in step and a layout that could not settle until
        the hook had measured the viewport. The replacement is a single CSS grid that collapses to
        one column below `lg`, so the server render is already correct and there is only one file
        to change when the page changes.
      */}
      <DesktopGrid data={live} market={market} />
    </Box>
  );
};

export default ClientMarketPage;
