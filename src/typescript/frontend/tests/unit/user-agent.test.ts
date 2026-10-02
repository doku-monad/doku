// cspell:word KHTML
// cspell:word jsbridge
import {
  APPLE_EMOJI_ATTRIBUTE,
  isAppleUserAgent,
  USER_AGENT_BOOTSTRAP_SCRIPT,
} from "lib/utils/user-agent-bootstrap";

/*
 * The pre-paint emoji-face decision, and the hydrated one.
 *
 * `USER_AGENT_BOOTSTRAP_SCRIPT` decides the emoji face before React runs; `useEmojiFontConfig`
 * decides it again after. A disagreement is a font flicker on that device — the exact thing moving
 * user-agent detection off the request header must not reintroduce.
 *
 * ## Why this file was rewritten rather than restored
 *
 * It used to assert the agreement by comparing `isAppleUserAgent` against `react-device-detect`'s
 * `isIOS || isMacOs`. That package is gone: the hook it backed now calls `isAppleUserAgent`
 * directly, which is what `lib/utils/user-agent-bootstrap` always documented it as mirroring. With
 * the second implementation removed there is nothing left to compare against, so the agents are
 * pinned to explicit expectations instead — which is the stronger test anyway, since it states what
 * the answer should be rather than deferring to a library's opinion of it.
 *
 * The "ships the same regex" case is the one that matters most and it is kept verbatim: the inline
 * `<head>` script is a STRING, so nothing but this test stops it drifting from the function.
 */

const AGENTS: Record<string, { ua: string; apple: boolean }> = {
  iphoneSafari: {
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    apple: true,
  },
  iphoneChrome: {
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1",
    apple: true,
  },
  iphoneInAppWebview: {
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 OKEx/6.96.1 (iPhone;U;iOS 18.0.1;en-ID/en-US) jsbridge/1.1.0 theme/dark",
    apple: true,
  },
  ipadMobile: {
    ua: "Mozilla/5.0 (iPad; CPU OS 12_5_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1",
    apple: true,
  },
  /* An iPad in desktop mode sends a Macintosh agent, which is why the pattern has to match both. */
  ipadDesktopMode: {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    apple: true,
  },
  macChrome: {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    apple: true,
  },
  macFirefox: {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:127.0) Gecko/20100101 Firefox/127.0",
    apple: true,
  },
  windowsChrome: {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    apple: false,
  },
  windowsEdge: {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
    apple: false,
  },
  androidChrome: {
    ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.71 Mobile Safari/537.36",
    apple: false,
  },
  androidSamsung: {
    ua: "Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36",
    apple: false,
  },
  linuxFirefox: {
    ua: "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
    apple: false,
  },
  linuxChrome: {
    ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    apple: false,
  },
  googlebot: {
    ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    apple: false,
  },
  empty: { ua: "", apple: false },
};

describe("isAppleUserAgent", () => {
  for (const [name, { ua, apple }] of Object.entries(AGENTS)) {
    it(`classifies ${name}`, () => {
      expect(isAppleUserAgent(ua)).toBe(apple);
    });
  }

  it("treats an unknown agent as not Apple, which is what the server renders", () => {
    // The server renders with `""`; the Noto class is applied and the attribute neutralises it on
    // Apple devices. If this ever became `true`, non-Apple first paints would lose the webfont.
    expect(isAppleUserAgent("")).toBe(false);
  });
});

describe("the bootstrap script", () => {
  it("ships the same regex it tests", () => {
    // The script is a string; the regex inside it must be the one `isAppleUserAgent` uses.
    const inScript = /if \((\/[^/]+\/i)\.test\(navigator\.userAgent\)\)/.exec(
      USER_AGENT_BOOTSTRAP_SCRIPT
    );
    expect(inScript).not.toBeNull();
    const shipped = new RegExp(inScript![1].slice(1, -2), "i");
    for (const { ua } of Object.values(AGENTS)) {
      expect(shipped.test(ua)).toBe(isAppleUserAgent(ua));
    }
    expect(USER_AGENT_BOOTSTRAP_SCRIPT).toContain(APPLE_EMOJI_ATTRIBUTE);
  });
});
