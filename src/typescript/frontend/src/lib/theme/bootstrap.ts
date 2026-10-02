/**
 * Lite Mode — the light half of the app's two themes.
 *
 * Two names, and they are not interchangeable:
 *
 *   `dark`  The default. The near-black stage the whole product was designed on.
 *   `lite`  DOKU's paper canvas — `brand.md`'s light token set, the palette the design system was
 *           originally written in.
 *
 * ## Why an attribute *and* a class
 *
 * `data-theme` is what this app's own tokens key off. The `dark` class is what Tailwind keys off,
 * and it exists because every component pulled from the Cult UI / shadcn registries expresses its
 * dark treatment with `dark:` variants. Those two have to move together or a registry card renders
 * its dark half on the paper canvas. `applyTheme` is the only place that knows this, so there is
 * one implementation of "the page is now light" rather than one per consumer.
 */

export type Theme = "dark" | "lite";

/**
 * Where a visitor's choice is kept — versioned, and the version is the point.
 *
 * Dark has always been the default here, but only for a visitor with NOTHING stored, and a Lite
 * choice made once persisted for good. Dark is the product's look and the one it is designed on,
 * so the key moved: every choice stored under the old `doku-theme` is left behind and everybody
 * opens on dark again. Picking Lite from the toggle still sticks — under this key, from now on.
 * Bump it again only to reset everyone's theme a second time.
 */
export const THEME_STORAGE_KEY = "doku-theme-v2";

/** The default when nothing is stored. The product's own look, not the visitor's OS preference. */
export const DEFAULT_THEME: Theme = "dark";

/** The `<meta name="theme-color">` value per theme, so the browser chrome matches the page. */
export const THEME_COLORS: Record<Theme, string> = {
  dark: "#0E100F",
  lite: "#F6F7F6",
};

export const applyTheme = (theme: Theme) => {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle("dark", theme === "dark");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[theme]);
};

/**
 * The pre-paint fix-up.
 *
 * The server renders the default theme because it cannot know what this visitor chose — the choice
 * lives in `localStorage`, which does not exist until the document does. Without this the page
 * paints dark and then flips to paper a frame later, which is the single most visible tell of a
 * bolted-on theme switch.
 *
 * Inlined into `<head>` as a blocking script rather than run from an effect: an effect runs after
 * the first paint by definition, which is exactly the frame we are trying to avoid. It is wrapped
 * in a `try` because Safari's private mode throws on `localStorage` access rather than returning
 * null, and a theme preference is not worth a blank page.
 */
export const THEME_BOOTSTRAP_SCRIPT = `
(function(){
  try {
    var t = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    if (t !== "lite" && t !== "dark") t = ${JSON.stringify(DEFAULT_THEME)};
    var r = document.documentElement;
    r.setAttribute("data-theme", t);
    r.classList.toggle("dark", t === "dark");
    /* The browser chrome, corrected in the same pre-paint pass as the page itself.
       applyTheme sets this too, but only ever after a render, so a Lite Mode visitor got the dark
       status bar for the first frame and, on any route that never calls it, for the whole visit.
       No backticks in here: this comment lives inside a template literal. */
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute("content", ${JSON.stringify(THEME_COLORS)}[t]);
  } catch (e) {}
})();
`.trim();
