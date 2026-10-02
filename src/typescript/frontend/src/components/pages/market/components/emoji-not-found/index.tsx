"use client";

import StatusPage from "components/pages/status-page";
import { ROUTES } from "router/routes";

/**
 * A market URL whose symbol has never been launched.
 *
 * It was one line — "Emoji not found. 😳" in `display2`, coloured `warning` — centred in the page
 * with no way forward. The symbol not existing is not a warning; it's an invitation, since on this
 * product an unclaimed symbol is precisely the thing you can go and claim.
 */
export const EmojiNotFound = () => (
  <StatusPage
    eyebrow="No such market"
    title="Nobody has launched this coin"
    code="404"
    actions={[
      { label: "Launch it", href: ROUTES.launch },
      { label: "Browse markets", href: ROUTES.explore, variant: "secondary" },
    ]}
  >
    <p>
      This symbol has no market yet. Symbols can only ever be claimed once, so it&apos;s still
      available — for now.
    </p>
  </StatusPage>
);

export default EmojiNotFound;
