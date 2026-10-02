"use client";

import { useUserSettings } from "context/user-settings";
import { useEffect } from "react";

/**
 * Writes the browser's user agent into the settings store, which used to receive it from the
 * request.
 *
 * Renders nothing. One effect, after mount: the store gets the raw string and `useEmojiFontConfig`
 * reads it. The store starts from "unknown", which is what the server rendered, so hydration sees
 * the same tree on both sides and the correction lands in the first effect pass — the same moment
 * the theme, the wallet and every other browser-only fact are read. See
 * `lib/utils/user-agent-bootstrap` for the one part of this that cannot wait that long.
 *
 * It also used to parse the agent for `isMobile || isTablet` and push the verdict into the emoji
 * picker store as `nativePicker`. Nothing anywhere read `nativePicker` — that store was written and
 * never read — so both the parse and the store are gone.
 */
export default function UserAgentSeed() {
  const setUserAgent = useUserSettings((s) => s.setUserAgent);

  useEffect(() => {
    setUserAgent(typeof navigator === "undefined" ? "" : navigator.userAgent || "");
  }, [setUserAgent]);

  return null;
}
