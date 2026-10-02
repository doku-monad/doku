/**
 * A link that came off the chain, made safe to put in an `href`.
 *
 * ## Why this exists
 *
 * `Metadata.website`, `.x` and `.telegram` are written by whoever launched the market, and
 * `DokuFactory` validates them for **byte length and nothing else** — no scheme check, no charset.
 * They then land in `identity.links` and go straight into `<IconLink href={...}>` on the market
 * masthead and the board card.
 *
 * React 18 does not save you here. Passing `javascript:` to `href` logs "A future version of React
 * will block javascript: URLs as a security risk" and **renders the link anyway**. So a market
 * creator could put script in a link that every visitor to that market's page sees, and the only
 * thing standing between them and that was a length cap in an immutable contract.
 *
 * The contract cannot be fixed — it is deployed. This is the layer that can.
 *
 * ## The rule
 *
 * An allowlist, not a blocklist. `http:` and `https:` are the only schemes that reach an `href`;
 * everything else becomes `null` and the link is simply not rendered. A blocklist of `javascript:`
 * and `data:` would be a game of whack-a-mole against `vbscript:`, control characters inside the
 * scheme, `java\tscript:`, and whatever the next browser quirk turns out to be. An allowlist has
 * no such surface: a scheme either is one of two strings or it is not.
 *
 * Parsing is delegated to `URL`, which is the browser's own parser and therefore agrees with the
 * thing that will eventually follow the link — a hand-rolled regex agreeing with a browser is a
 * coincidence, not a property.
 */

/** The only two schemes that may reach an `href`. */
const ALLOWED = new Set(["http:", "https:"]);

/**
 * `value` if it is a link a browser may safely follow, otherwise `null`.
 *
 * `null` rather than an empty string, because every call site already treats a missing link as "do
 * not render the icon" — so a refused link disappears rather than becoming a dead control.
 */
export function safeExternalUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // Not a URL at all — including a bare "example.com", which has no scheme. Refusing it is the
    // conservative half of the trade: a creator who wants a link can write the scheme, and nothing
    // here should be guessing one on their behalf.
    return null;
  }

  if (!ALLOWED.has(parsed.protocol)) return null;

  // `href` rather than the input: the parser has normalised it, so what is stored is what a browser
  // would actually go to. That closes the gap where a string is checked in one form and followed in
  // another.
  return parsed.href;
}

/** Hosts that are the launchpad itself. A coin's website is never one of these. */
const OWN_HOSTS = ["doku.family"];

/**
 * A coin's own website, or null.
 *
 * The launchpad's domain is refused as well as unsafe URLs: a website field that points at
 * doku.family is not the coin's site, it is a default or a mistake, and the globe icon it would
 * draw sends a reader to the homepage they are already on.
 */
export function safeCoinWebsite(value: string | null | undefined): string | null {
  const href = safeExternalUrl(value);
  if (!href) return null;
  const host = new URL(href).hostname.toLowerCase();
  for (const own of OWN_HOSTS) {
    if (host === own || host.endsWith(`.${own}`)) return null;
  }
  return href;
}

/**
 * A creator-supplied image URL, or null.
 *
 * `setMetadata` on chain accepts any string for `logo_uri` and `banner_uri`, and both used to go
 * straight into an `<img src>`. That is not script execution, but it is a tracking pixel on
 * every board visitor, a mixed-content failure on an `http:` URL, or a 50 MB image. Only `https:`
 * is drawn; anything else renders as the emoji mark, which is what a missing logo renders as
 * anyway; `ipfs:` content ids are kept, because that is what a launch writes on chain and the
 * mark resolves them to the CDN. A preview fixture's own paths are not routed through here.
 */
export function safeImageUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  // `ipfs:` is the scheme a launch writes on chain for an uploaded image; the mark component
  // resolves it to the CDN before drawing, so it is a content id here, never a fetch.
  return parsed.protocol === "https:" || parsed.protocol === "ipfs:" ? trimmed : null;
}
