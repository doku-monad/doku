import { isAddress } from "viem";

/**
 * Resolves whatever is in a wallet URL into an address.
 *
 * The Aptos version also resolved ANS names, which is why it returned a name alongside the
 * address. There is no name service wired up here, so the name is always undefined — kept in the
 * shape so a naming service can be added later without touching every caller.
 */
export type ResolvedOwner =
  | { address: `0x${string}`; name: undefined }
  | { address: undefined; name: undefined };

const INVALID: ResolvedOwner = { address: undefined, name: undefined };

export const resolveOwnerNameCached = async (input?: string | null): Promise<ResolvedOwner> => {
  if (!input) return INVALID;
  // Shape only, not EIP-55 checksum: an address pasted from an explorer or a URL is usually
  // lowercase, and rejecting it would read as "no such wallet".
  if (!isAddress(input, { strict: false })) return INVALID;
  return { address: input.toLowerCase() as `0x${string}`, name: undefined };
};

/** Shortens an address for display. */
export const customTruncateAddress = (address: string) =>
  address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
