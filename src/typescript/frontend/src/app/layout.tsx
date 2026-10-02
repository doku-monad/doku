import "react-toastify/dist/ReactToastify.css";
import "../app/global.css";

import { getDefaultMetadata } from "configs/meta";
import Providers from "context/providers";
import StyledComponentsRegistry from "lib/registry";
import type { Metadata, Viewport } from "next";
import {
  fontsStyle,
  geistPixel,
  jetBrainsMono,
  NOTO_COLOR_EMOJI_STYLESHEET,
  notoColorEmoji,
  plexSans,
} from "styles/fonts";

import { DEFAULT_THEME, THEME_BOOTSTRAP_SCRIPT, THEME_COLORS } from "@/lib/theme/bootstrap";
import { USER_AGENT_BOOTSTRAP_SCRIPT } from "@/lib/utils/user-agent-bootstrap";

export const metadata: Metadata = getDefaultMetadata();
export const viewport: Viewport = {
  /*
   * The canvas, as a literal colour.
   *
   * It was `var(--canvas)`. `<meta name="theme-color">` takes a CSS *colour*, and custom
   * properties are not resolved in a meta attribute — so the value was invalid, browsers ignored
   * it, and the one piece of chrome this exists to tint has never been tinted. On a phone that is
   * the status bar and the address bar: the most visible surface on the page, defaulting to white
   * above a near-black app.
   *
   * `THEME_COLORS.dark` rather than a hex written out here, because the server renders the default
   * theme and this has to be the same near-black `DEFAULT_THEME` paints. A visitor who chose Lite
   * Mode gets the correct value before first paint from the bootstrap script, which now sets this
   * meta alongside the attribute — see `lib/theme/bootstrap`.
   */
  themeColor: THEME_COLORS[DEFAULT_THEME],
  /*
   * Lets the page paint under the notch and the home indicator, which is what makes
   * `env(safe-area-inset-*)` report anything but zero. The bottom tab bar reads that inset to keep
   * its labels clear of the indicator; without this it would sit under the system furniture — both
   * untappable and the most recognisable tell of a web app pretending to be native.
   */
  viewportFit: "cover",
};

/*
 * No `headers()` here, and none may return.
 *
 * This layout read the request's `user-agent` so the server could pick the emoji font and the
 * picker per visitor. A request header read in the root layout makes every route in the app
 * dynamic — nothing under it can be prerendered or cached, and every visit to the board, to a
 * market, even to the maintenance screen, was a full server render. The user agent is now read in
 * the browser (`lib/utils/user-agent-bootstrap`, `context/UserAgentSeed`), and the routes that
 * carry no request-specific data are static again. Confirm with `next build`: `/explore` must be
 * listed `○`, not `ƒ`.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    /*
     * `dark` here is the *default*, not a constant — the app ships two themes now (see
     * `lib/theme/bootstrap.ts`). The server has no way to know which one this visitor chose, so it
     * renders the default and the bootstrap script below corrects the attribute and the class
     * before the first paint.
     *
     * Tailwind is set to class-based dark mode (see `tailwind.config.js`) so that the `dark:`
     * variants every Cult UI component ships with resolve against *this app's* theme rather than
     * against the visitor's OS preference. A registry component keyed to `prefers-color-scheme`
     * would render its light half on a machine set to light while the page around it stayed dark.
     *
     * The font variables define `--font-geist-sans` and `--font-geist-mono` among others; Cult UI
     * components reference those names directly, and `styles/fonts` maps this app's own role
     * variables onto the same faces.
     *
     * `suppressHydrationWarning` on this element and nowhere else. `THEME_BOOTSTRAP_SCRIPT` runs in
     * `<head>`, before React, and rewrites `data-theme` and the class to the visitor's stored
     * choice — so on every Lite-mode visit React found a DOM that no longer matched the HTML it was
     * hydrating and logged `Prop data-theme did not match`. The mismatch is the bootstrap working
     * as designed; the warning was the only thing wrong with it, and left in place it would mask
     * the next real one. It is scoped to this element's own attributes and does not reach the tree.
     */
    <html
      suppressHydrationWarning
      lang="en"
      data-theme="dark"
      /* The entrance animations are switched on by this and retired by `EntranceGuard`, which
         explains why. Present in the server's markup so the fold rises on the first paint rather
         than waiting for a bundle. */
      data-entering=""
      className={`${plexSans.variable} ${jetBrainsMono.variable} ${geistPixel.variable} dark`}
    >
      <head>
        {/* Blocking, and in `<head>` on purpose: an effect runs after the first paint, which is the
            one frame a theme flash is visible in. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
        {/* Same reason, same place: the emoji face has to be right on the first frame, and only
            the browser knows the platform now. */}
        <script dangerouslySetInnerHTML={{ __html: USER_AGENT_BOOTSTRAP_SCRIPT }} />
        {/*
          The emoji face, fetched at runtime rather than at build — see `styles/fonts`.

          In `<head>`, and preconnecting to the host it is actually fetched from. It sat in `<body>`,
          where a stylesheet link is render-blocking for everything after it, and the `preconnect`
          beside it named `fonts.gstatic.com` — which serves the font FILES, not the CSS. The
          request that had to happen first, to `fonts.googleapis.com`, had no warmed connection at
          all: measured at 205 ms against 6–14 ms for the self-hosted faces.

          Both hosts are named now, because the sequence needs both: the stylesheet comes from
          `googleapis`, and the `woff2` it points at comes from `gstatic`.
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href={NOTO_COLOR_EMOJI_STYLESHEET} />
      </head>
      <body>
        {/* This is used to avoid React escaping the quotes in `fontsStyle`. */}
        <style dangerouslySetInnerHTML={{ __html: fontsStyle }} />
        <StyledComponentsRegistry>
          <Providers>{children}</Providers>
        </StyledComponentsRegistry>
        {/* Load the font regardless of the user agent string so that there's no flashing. */}
        <div className={notoColorEmoji.className + " absolute top-0 left-0 hidden"}>{"👽"}</div>
      </body>
    </html>
  );
}
