import { ROUTES } from "router/routes";

/**
 * The path of a market's page, keyed by its TOKEN address.
 *
 * ## Why the token and not the curve
 *
 * A market is two contracts: the bonding curve, which the indexer keys every row on and which
 * every internal reference carries, and the token, which is the only one of the two the rest of
 * the internet has a word for. "CA" means the token on X, in a wallet, on a scanner and in every
 * trading terminal. The page's URL used to carry the curve, so the address a visitor copied out
 * of the bar — the one thing a URL is for — was an address nothing outside DOKU could do anything
 * with, and pasting a token address INTO the bar, which is what those visitors did, was a 404.
 *
 * So the route carries the token. The indexer's `/markets/:address` answers to either address,
 * the page redirects a curve URL to the token URL, and nothing that links here has to know a
 * curve exists. Lowercased, because the object key the metadata document is published under is
 * lowercase and one spelling of an address is worth having.
 *
 * Every `href` and `router.push` to a market goes through here so the shape lives in one place.
 */
export const marketPath = (tokenAddress: string): string => `${ROUTES.market}/${tokenAddress.toLowerCase()}`;
