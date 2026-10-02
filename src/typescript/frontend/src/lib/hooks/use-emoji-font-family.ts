// cspell:word noto
import { useUserSettings } from "context/user-settings";
import { isAppleUserAgent } from "lib/utils/user-agent-bootstrap";
import { useMemo } from "react";
import { notoColorEmoji } from "styles/fonts";

/**
 * Which emoji face to use, given the user agent in global state.
 *
 * ## Why this no longer parses the agent
 *
 * It asked `react-device-detect` for `isIOS || isMacOs`, which runs `ua-parser-js` over the whole
 * string and answers thirty-odd questions to get two — and it brought **33.6 kB minified** into
 * the shell of every route to do it, because `providers.tsx` is on every route.
 *
 * `isAppleUserAgent` in `lib/utils/user-agent-bootstrap` is the same test as a single regex, and it
 * is not a new one: that module's docblock already states it mirrors `isIOS || isMacOs`, and the
 * blocking `<head>` script this app ships runs the identical pattern before first paint so the
 * platform face is chosen without waiting for hydration. Two copies of one question, one of which
 * cost 33 kB.
 *
 * The hook returned `isIOS` and `isMacOs` alongside the class name and nothing read either.
 */
export const useEmojiFontConfig = () => {
  const userAgent = useUserSettings((s) => s.userAgent);

  return useMemo(
    () => ({ emojiFontClassName: isAppleUserAgent(userAgent) ? "" : notoColorEmoji.className }),
    [userAgent]
  );
};
