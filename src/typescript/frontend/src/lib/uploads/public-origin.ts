/**
 * The origin a link written ON CHAIN must use.
 *
 * A market's `logoURI` is a permanent, public string: it is read by this site, by anyone indexing
 * the chain, and by whatever renders a token list years from now. So it cannot be a relative path
 * and it cannot be the internal address a container happens to answer on — a URL that only
 * resolves inside the platform's private network is a broken image everywhere else, and nothing
 * about it looks wrong from inside.
 *
 * `SITE_URL` wins because it is the deliberate answer. The platform's own domain variable is the
 * next best, and it is present without anybody setting it. The request's own origin is last: it is
 * correct in development and behind a proxy that forwards the host, and wrong behind one that does
 * not, which is why it is not preferred.
 */
export function publicOrigin(
  requestUrl: string,
  env: Record<string, string | undefined> = process.env
): string | null {
  const explicit = env.NEXT_PUBLIC_SITE_URL?.trim() || env.SITE_URL?.trim();
  const platform = env.RAILWAY_PUBLIC_DOMAIN?.trim();
  const chosen = explicit || platform;

  if (chosen) {
    const withScheme = /^https?:\/\//.test(chosen) ? chosen : `https://${chosen}`;
    try {
      return new URL(withScheme).origin;
    } catch {
      // A malformed override falls through rather than taking the upload down with it.
    }
  }

  try {
    return new URL(requestUrl).origin;
  } catch {
    return null;
  }
}
