"use client";

import { ToastContainer } from "react-toastify";

import { useTheme } from "@/lib/theme/theme-context";

/**
 * The app's notifications.
 *
 * ## What was here
 *
 * A `ToastContainer` with three inline styles — `--surface`, a `--line` border, `--ink` text — and
 * `theme="dark"` written as a literal. So every toast was a flat grey rectangle with a sentence in
 * it: no icon, no severity beyond whatever colour react-toastify's default progress bar happened to
 * be, and, because of that hardcoded theme, a *dark* rectangle on the paper canvas with the
 * library's own dark close button on it. On a page where every other surface is a tray, a rim and a
 * bezel, it read as a system dialog that had wandered in.
 *
 * It also sat at `bottom-left` on every width, which on a phone is directly underneath the floating
 * dock — a notification behind the tab bar is a notification nobody reads.
 *
 * ## What it is now
 *
 * The construction lives in `global.css` under `.Toastify__toast`, because it needs the library's
 * own class names and its per-type variants: the surface, rim and shadow of a card; a 3px accent
 * rail down the leading edge in the type's own hue; the icon plated in a tinted well; and the
 * progress bar reduced to a hairline in the same hue rather than a 7px band.
 *
 * Everything is a token, so both themes are deliberate rather than inverted — on paper the toast is
 * a white card with a coloured rail and a real shadow, which is how paper shows something floating.
 *
 * The container keeps only what is genuinely its business: where the stack lives, how many are
 * shown at once, and how long each stays.
 */
const StyledToaster = () => {
  /*
   * `theme` follows the app rather than being a literal.
   *
   * react-toastify uses it to pick its own close button and default icon colours; pinned to `dark`
   * it painted a cream close glyph on the near-white card. `useTheme` is safe here because this
   * renders inside `ThemeProvider` — see `providers.tsx`.
   */
  const { theme } = useTheme();

  return (
    <ToastContainer
      /*
       * Bottom-right on a desktop, top-centre on a phone.
       *
       * The bottom of a phone screen belongs to the dock and the thumb. A toast there is either
       * behind the tab bar or under the hand that just tapped it; the top is the only edge on a
       * phone that is reliably both visible and out of the way — and it is where every mobile OS
       * puts its own notifications, so it is the place people already look.
       *
       * The offsets that keep it clear of the top bar and the safe-area inset are in `global.css`
       * with the rest of the construction, because `env()` cannot be written as an inline style
       * that also has to change at a breakpoint.
       */
      position="top-center"
      className="doku-toast-stack"
      toastClassName="doku-toast"
      progressClassName="doku-toast-bar"
      /* 5s, not 7.1. Long enough to read two lines, short enough that a burst of three clears
         before it becomes a wall. Errors are the ones people need longer with, and those are
         dismissible rather than pinned — an error nobody can get rid of is worse than one that
         leaves. */
      autoClose={5000}
      closeOnClick
      newestOnTop
      /* Three is the point at which a stack stops being informative and starts being a takeover. */
      limit={3}
      theme={theme === "lite" ? "light" : "dark"}
    />
  );
};

export default StyledToaster;
