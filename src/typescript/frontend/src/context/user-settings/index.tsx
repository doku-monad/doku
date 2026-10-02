"use client";

import { createContext, type ReactNode, useContext, useRef } from "react";
import type { StoreApi } from "zustand";
import { useStore } from "zustand";

import createUserSettingsStore, { type UserSettingsStore } from "@/store/user-settings-store";

/**
 * User settings, in their own context.
 *
 * They used to live inside the event-store context, which also owned the websocket connection and
 * every market's event history. That store is gone with the websocket, and settings — bar display,
 * currency, user agent — have nothing to do with either.
 *
 * The user agent starts out unknown on both sides of the render and is written in by
 * `UserAgentSeed` after mount; see `lib/utils/user-agent-bootstrap` for why it no longer comes off
 * the request.
 */
const UserSettingsContext = createContext<StoreApi<UserSettingsStore> | null>(null);

export const UserSettingsProvider = ({ children }: { children: ReactNode }) => {
  const store = useRef<StoreApi<UserSettingsStore>>();
  if (!store.current) {
    store.current = createUserSettingsStore();
  }
  return (
    <UserSettingsContext.Provider value={store.current}>{children}</UserSettingsContext.Provider>
  );
};

export function useUserSettings<T>(selector: (store: UserSettingsStore) => T): T {
  const context = useContext(UserSettingsContext);
  if (!context) throw new Error("useUserSettings must be used inside UserSettingsProvider");
  return useStore(context, selector);
}
