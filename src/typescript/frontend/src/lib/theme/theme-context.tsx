"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { applyTheme, DEFAULT_THEME, type Theme, THEME_STORAGE_KEY } from "./bootstrap";

interface ThemeContextValue {
  theme: Theme;
  /** `false` until the stored preference has been read, so nothing renders the wrong icon first. */
  ready: boolean;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * The theme's React face.
 *
 * The DOM is already correct before this mounts — `THEME_BOOTSTRAP_SCRIPT` set the attribute and
 * the class in `<head>`. This provider exists so components can *read* the current theme (an icon,
 * an aria-label, a chart's stroke colour) and change it, not so it can apply it on mount.
 *
 * Which is why the first render deliberately reports `DEFAULT_THEME` with `ready: false` rather
 * than reading the DOM: reading it during render would give the server one answer and the client
 * another and produce a hydration mismatch on every visitor who chose the non-default. The real
 * value arrives in an effect, one paint later, by which point the *page* has been correct the
 * whole time — only the toggle's own icon settles late, and it renders neutral until it does.
 */
export const ThemeProvider = ({ children }: { children: React.ReactNode }) => {
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = document.documentElement.dataset.theme;
    setThemeState(stored === "lite" ? "lite" : "dark");
    setReady(true);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    applyTheme(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Private-mode Safari throws here. The theme still applies for this page view.
    }
  }, []);

  const toggleTheme = useCallback(
    () => setTheme(theme === "dark" ? "lite" : "dark"),
    [setTheme, theme]
  );

  const value = useMemo(
    () => ({ theme, ready, setTheme, toggleTheme }),
    [theme, ready, setTheme, toggleTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = () => {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
};
