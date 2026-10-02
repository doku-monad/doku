import packageInfo from "../../package.json";

/**
 * Environment, validated at import.
 *
 * The Aptos version of this module required a network name, two module addresses, an integrator
 * address and a websocket broker URL. None of those exist here: DOKU has contract addresses (which
 * live in `lib/chain/wagmi.ts`, next to the code that calls them), one protocol fee taken on chain,
 * and no broker.
 *
 * What remains is genuinely app-level configuration.
 */

type Links = {
  x?: string | undefined;
  telegram?: string | undefined;
  github?: string | undefined;
  discord?: string | undefined;
  tos?: string | undefined;
};

export const LINKS: Links | undefined =
  typeof process.env.NEXT_PUBLIC_LINKS === "string" && process.env.NEXT_PUBLIC_LINKS !== ""
    ? JSON.parse(process.env.NEXT_PUBLIC_LINKS)
    : undefined;

/**
 * Gates launching behind a merkle allowlist.
 *
 * Off unless explicitly enabled — a launchpad that silently rejects everyone is a worse failure
 * than one that lets everyone in.
 */
export const IS_ALLOWLIST_ENABLED: boolean =
  process.env.NEXT_PUBLIC_IS_ALLOWLIST_ENABLED === "true";

/**
 * Optional. Blank means images are served from the app's own origin, which is the correct
 * behaviour for local development and for any deployment without a CDN in front of it.
 */
export const CDN_URL: string = process.env.NEXT_PUBLIC_CDN_URL ?? "";

/** Where market-metadata requests are routed. Absent simply hides the prompt. */
export const DISCORD_METADATA_REQUEST_CHANNEL: string | undefined =
  process.env.NEXT_PUBLIC_DISCORD_METADATA_REQUEST_CHANNEL;

/*
 * The build's version, as the string it already is.
 *
 * It was `parse(packageInfo.version)` — a `SemVer` object — and its single consumer prints
 * `VERSION.version`, i.e. the string it was parsed from. That round trip was the last thing
 * holding `semver` (~24 kB minified) in the client graph, alongside the copy in
 * `configs/local-storage-keys.ts` that has since stopped needing it.
 */
export const VERSION = packageInfo.version;
