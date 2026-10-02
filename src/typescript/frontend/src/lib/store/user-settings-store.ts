import { readLocalStorageCache, writeLocalStorageCache } from "configs/local-storage-keys";
import { createStore } from "zustand";

type UserSettingsState = {
  showEmptyBars: boolean;
  showUsd: boolean;
};

type UserSettingsActions = {
  setShowEmptyBars: (fn: (prev: boolean) => boolean) => void;
  setShowUsd: (value: boolean) => void;
  /**
   * The browser's `navigator.userAgent`, or `""` until the first effect has run.
   *
   * It arrived from the request header once, which made every route dynamic — see
   * `lib/utils/user-agent-bootstrap`. Empty means "unknown", and every reader of it must render
   * something sensible for unknown, because that is what the server renders and what the client
   * hydrates against.
   */
  userAgent: string;
  setUserAgent: (value: string) => void;
  getShowEmptyBars: () => boolean;
  getShowUsd: () => boolean;
};

export type UserSettingsStore = UserSettingsState & UserSettingsActions;

const saveSettings = (state: UserSettingsState) => {
  writeLocalStorageCache("settings", state);
};

const defaultValues: UserSettingsState = {
  showEmptyBars: true,
  showUsd: false,
};

const readSettings = (): UserSettingsState => readLocalStorageCache("settings") ?? defaultValues;

const createUserSettingsStore = (userAgent = "") =>
  createStore<UserSettingsStore>()((set, get) => ({
    ...readSettings(),
    userAgent,
    // Not persisted: it describes the browser, and the browser says so on every visit.
    setUserAgent: (value) => set({ userAgent: value }),
    getShowUsd: () => get().showUsd,
    setShowUsd: (value) =>
      set((state) => {
        const newState = { ...state, showUsd: value };
        saveSettings(newState);
        return newState;
      }),
    getShowEmptyBars: () => get().showEmptyBars,
    setShowEmptyBars: (fn: (prev: boolean) => boolean) =>
      set((state) => {
        const newState = { ...state, showEmptyBars: fn(state.showEmptyBars) };
        saveSettings(newState);
        return newState;
      }),
  }));

export default createUserSettingsStore;
