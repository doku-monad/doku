"use client";

import { useDokuWallet } from "context/wallet-context/DokuWalletProvider";
import { erc20Abi } from "viem";
import { useReadContract } from "wagmi";

import { isNativeQuoteAsset, type QuoteAsset } from "@/lib/assets/quote-assets";

/**
 * What the connected wallet holds of one quote asset.
 *
 * ## Why this exists
 *
 * Because the launch bench could not answer it, and the whole dev-buy step was built around not
 * being able to. "DOKU reads no ERC-20 balances" is written into four different comments in this
 * feature: it is why the funding control carried a `Soon` badge, why the percentage keys were dead
 * on a USDC pair, why the amount field said "type the amount you want to spend" instead of showing
 * a ceiling, and why a launcher could fill in a dev buy larger than their wallet and find out from
 * a revert. It was never a hard problem — it is one `balanceOf` call, which the trade panel three
 * directories away has been making all along.
 *
 * ## Two assets, one answer
 *
 * A quote asset is either native MON or an ERC-20, and a caller should not have to branch on which.
 * Native resolves to the provider's own balance — already polled, already keyed to the right chain
 * — and everything else to `balanceOf(you)`. The hook is called unconditionally either way, with
 * `enabled` doing the gating, because a hook behind an `if` is a hook that unmounts the moment
 * somebody switches pairs.
 *
 * ## `undefined` is not zero
 *
 * Three different situations produce it: no wallet, a wallet on the wrong chain, and a read still
 * in flight. None of them is "you hold nothing", and every consumer here has to be able to tell
 * them apart — a form that says "you hold no USDC" to somebody whose balance has not loaded yet is
 * worse than a form that says nothing. Zero is only ever returned when the chain said zero.
 */
export function useQuoteBalance(asset: QuoteAsset | null | undefined): {
  /** Raw units of `asset`. `undefined` until a real answer exists — see above. */
  balance: bigint | undefined;
  /** Whether an answer is still on its way, so a caller can say "reading" rather than "none". */
  isPending: boolean;
  refetch: () => void;
} {
  const { address, status, monBalance, refetchBalance } = useDokuWallet();

  const native = isNativeQuoteAsset(asset);
  /* An asset the registry catalogues but has not deployed has no contract to ask. It cannot be
     launched against either — `launchableQuoteAssets` filters it — so this is belt and braces. */
  const token = !native && asset?.address ? asset.address : undefined;
  const ready = status === "ready" && Boolean(address);

  const erc20 = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: {
      enabled: ready && Boolean(token),
      /* A balance moves on somebody else's transaction as well as your own — a transfer in while
         the bench is open is exactly the case the dev-buy step is asking about. Cheap call, and
         the launcher is deciding how much of it to spend. */
      refetchInterval: 15_000,
    },
  });

  if (!asset || !ready) return { balance: undefined, isPending: false, refetch: () => {} };

  if (native)
    return { balance: monBalance, isPending: monBalance === undefined, refetch: refetchBalance };

  if (!token) return { balance: undefined, isPending: false, refetch: () => {} };

  return {
    balance: erc20.data as bigint | undefined,
    isPending: erc20.isPending,
    refetch: () => void erc20.refetch(),
  };
}

export default useQuoteBalance;
