/**
 * The user agent, read in the browser rather than off the request.
 *
 * ## Why the request header is no longer read
 *
 * `app/layout.tsx` used to call `headers().get("user-agent")` so the server could decide two things
 * per visitor: whether to draw emoji with the Noto webfont (every platform but Apple's) and whether
 * the emoji picker should be the native one (phones and tablets). Reading a request header inside
 * the ROOT layout opts every route under it out of static rendering — Next cannot cache a render
 * that depends on the request — so the board, every market page and every other page was rendered
 * from scratch on each visit. At ten to twenty-five renders a second per instance, that was the
 * ceiling on the whole site.
 *
 * Both decisions are now made in the browser from `navigator.userAgent`, which carries exactly the
 * string the header did. `UserAgentSeed` (in `context/providers.tsx`) writes it into the settings
 * store after mount, and the same `getBooleanUserAgentSelectors` parse runs on it as before. What
 * changed is only WHEN the answer is known: the server renders as if the agent were unknown, and
 * the store is corrected in the first effect.
 *
 * ## The one thing that cannot wait for an effect
 *
 * The emoji font. With an unknown agent the hook picks the Noto class, which on a Mac or an iPhone
 * would draw the first frame in Noto and the second in Apple Color Emoji — a visible flicker on
 * every emoji on every page load. So a blocking script in `<head>` stamps `data-apple-emoji` on the
 * root element before anything paints, and one CSS rule (`global.css`) neutralises the Noto class
 * under it. After hydration the hook drops the class on Apple devices anyway; the attribute only
 * covers the frames before it runs.
 *
 * `tests/unit/user-agent.test.ts` pins this: every agent is classified explicitly, and the regex
 * inside the shipped script must be the one `isAppleUserAgent` uses — otherwise the pre-paint
 * attribute and the hydrated hook disagree and the flicker this exists to prevent comes back on
 * that device. (The test used to assert that agreement against `react-device-detect`'s
 * `isIOS || isMacOs`; that package is gone and the hook calls this function directly now.)
 */

/** Set on `<html>` before first paint when the browser draws its own colour emoji. */
export const APPLE_EMOJI_ATTRIBUTE = "data-apple-emoji";

/**
 * Whether this agent is one `useEmojiFontConfig` will leave on the platform emoji face.
 *
 * Mirrors `isIOS || isMacOs` from `react-device-detect`: iPhone, iPad and iPod agents, Macintosh
 * agents (which is also what an iPad in desktop mode sends), and the `Mac OS X` token that every
 * iOS agent carries in its "like Mac OS X" clause.
 */
export const isAppleUserAgent = (userAgent: string): boolean =>
  /iPhone|iPad|iPod|Macintosh|Mac OS X/i.test(userAgent);

/**
 * Inline, blocking, in `<head>`: runs before the first paint, which is the one frame an effect is
 * too late for. The regex is spelled out again here because this string is shipped as-is, so
 * nothing but `tests/unit/user-agent.test.ts` ("ships the same regex it tests") stops the two
 * copies drifting apart.
 */
export const USER_AGENT_BOOTSTRAP_SCRIPT = `
(function(){
  try {
    if (/iPhone|iPad|iPod|Macintosh|Mac OS X/i.test(navigator.userAgent)) {
      document.documentElement.setAttribute(${JSON.stringify(APPLE_EMOJI_ATTRIBUTE)}, "");
    }
  } catch (e) {}
})();
`.trim();
