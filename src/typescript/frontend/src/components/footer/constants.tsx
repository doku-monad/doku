import { LINKS } from "lib/env";

import Discord from "@/icons/Discord";

import { TelegramMark, XMark } from "./social-marks";

/**
 * DOKU's own channels.
 *
 * These are the real accounts, so they are defaults rather than env-only. `LINKS` is parsed from
 * `NEXT_PUBLIC_LINKS` and is `undefined` on every local build and on the default deployment — which
 * meant the footer's Community column rendered its "channels are announced as they open" fallback
 * on a product whose channels are open. A deployment can still override either one; it just no
 * longer has to configure something to get the truth.
 */
export const SOCIAL = {
  x: LINKS?.x ?? "https://x.com/dokufamily",
  telegram: LINKS?.telegram ?? "https://t.me/dokufamily",
} as const;

/** Where the chain's own site lives, for the badge in the identity cell. */
export const MONAD_URL = "https://monad.xyz/";

/**
 * The social keys, and only the ones that go somewhere.
 *
 * Each unconfigured entry used to fall back to `ROUTES["not-found"]` — rendered anyway, with
 * `target="_blank"`, so on any deployment without `NEXT_PUBLIC_LINKS` the footer showed icons that
 * opened a new tab onto a 404. Filtering here is what keeps the icon strip and the Community column
 * telling the same story.
 *
 * X and Telegram are always present now (see `SOCIAL`); Discord stays env-gated because there is no
 * channel to point it at yet.
 *
 * `label` because an icon link has no text to name it. Both were unlabelled `<a>` elements wrapping
 * a bare `<svg>`, which is a link a screen reader announces as its URL.
 */
export const SOCIAL_ICONS = (
  [
    { icon: XMark, href: SOCIAL.x, label: "DOKU on X" },
    { icon: TelegramMark, href: SOCIAL.telegram, label: "DOKU on Telegram" },
    { icon: Discord, href: LINKS?.discord, label: "DOKU on Discord" },
  ] as const
).filter((entry): entry is typeof entry & { href: string } => Boolean(entry.href));
