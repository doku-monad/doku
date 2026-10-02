"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { pruneFlashes, recordFlash, type TradeFlashes } from "@/lib/trade-flash";

import { connectLiveFeed, type LiveEvent } from "./live-connection";
import { createSharedLiveFeed, type SharedLiveFeed } from "./live-shared";

/**
 * The page's socket, not a component's — see `live-shared.ts`. Created on first use so the
 * module is importable during a server render, where there is no `WebSocket`.
 */
let shared: SharedLiveFeed | undefined;
const sharedFeed = (): SharedLiveFeed =>
  (shared ??= createSharedLiveFeed({
    connect: connectLiveFeed,
    createSocket: (target) => new WebSocket(target) as never,
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  }));

/**
 * The indexer's live feed.
 *
 * An accelerator over polling, not a replacement for it. A websocket that dies silently is the
 * classic way a "live" view goes stale while still looking connected, so the polling underneath
 * stays on and the worst a broken socket can do is make updates slower.
 *
 * Messages carry only what changed and which market. This invalidates the matching queries and
 * lets TanStack Query refetch, so a duplicated or dropped message costs one request rather than
 * corrupting what is on screen — which is why this is not a state-replication protocol.
 *
 * The connection state machine lives in `live-connection.ts` and is tested there.
 */
export function useLiveFeed(
  url: string | undefined,
  /**
   * Fired for every event after the query invalidations. The board uses it to refresh its
   * server-rendered rows (`use-board-refresh`), which no query key reaches. Kept as a stable ref
   * so a caller passing an inline function does not reconnect the socket on every render.
   */
  onEvent?: (event: LiveEvent) => void
): {
  connected: boolean;
  flashes: TradeFlashes;
} {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  /**
   * Which markets just traded, and which way.
   *
   * Held here rather than in the grid because the socket is the only thing that knows a trade was
   * a buy or a sell *as it happens* — by the time the refetched market list arrives, the trade is
   * one row among many and its direction is no longer distinguishable from the previous one's.
   */
  const [flashes, setFlashes] = useState<TradeFlashes>({});

  useEffect(() => {
    if (!url) return;

    const invalidate = (event: LiveEvent) => {
      if (event.type === "swap") {
        setFlashes((current) => recordFlash(current, event.market, event.isBuy, Date.now()));
      }
      // Invalidate rather than write. The socket says *that* something changed; the API stays the
      // only thing that says what it changed to.
      queryClient.invalidateQueries({ queryKey: ["swaps", event.market] });
      queryClient.invalidateQueries({ queryKey: ["market", event.market] });
      queryClient.invalidateQueries({ queryKey: ["market-list"] });
      if (event.type !== "swap") {
        queryClient.invalidateQueries({ queryKey: ["holders", event.market] });
      }
      onEventRef.current?.(event);
    };

    return sharedFeed().attach(url, { onEvent: invalidate, onStatus: setConnected });
  }, [url, queryClient]);

  /*
   * Swept rather than expired per flash: one timer for the grid instead of one per card, and it
   * stops entirely once nothing is lit.
   *
   * The dependency is the *boolean* "is anything lit", not `flashes` itself. Keyed on the object,
   * every incoming swap replaced `flashes`, which tore the 400 ms interval down and started a new
   * one — so on a board where trades land more often than every 400 ms the sweep never reached its
   * first tick. Flashes then never expired: cards stayed lit long after their trade and the map
   * only grew. That is precisely the busy market this effect exists for.
   */
  const anyLit = Object.keys(flashes).length > 0;
  useEffect(() => {
    if (!anyLit) return;
    const sweep = window.setInterval(() => {
      setFlashes((current) => pruneFlashes(current, Date.now()));
    }, 400);
    return () => window.clearInterval(sweep);
  }, [anyLit]);

  return { connected, flashes };
}
