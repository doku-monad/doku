"use client";

import { createContext, type PropsWithChildren, useCallback, useContext, useMemo } from "react";
import {
  useAccount,
  useBalance,
  useDisconnect,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from "wagmi";

import { EXPECTED_CHAIN_ID } from "@/lib/chain/wagmi";
import { deriveWalletStatus, type WalletStatus } from "@/lib/chain/wallet-state";
import { copyText } from "@/lib/utils/copy-text";

/**
 * The app's single view of the connected wallet.
 *
 * Replaces `AptosContextProvider`. The surface is deliberately narrower: the Aptos version also
 * owned transaction submission, sequence numbers and three separate coin balances, none of which
 * survive the move — EVM wallets manage nonces, and there is one native currency.
 */
export interface DokuWalletState {
  address: `0x${string}` | undefined;
  status: WalletStatus;
  /** True when a wallet is connected but pointed at another chain. Its own state, on purpose. */
  wrongChain: boolean;
  connectedWalletName: string | undefined;
  /** Native MON, in base units. `undefined` until the first read resolves. */
  monBalance: bigint | undefined;
  /*
   * No `connect`. Opening the dialog is the only way in — `useWalletModal().openWalletModal`.
   *
   * There was one, and it called `connect({ connector: connectors[0] })`: whichever wallet happened
   * to announce itself over EIP-6963 first, which on a machine with four installed is a race. A
   * caller reaching for a one-line connect would have got a wallet the user never chose, and no way
   * to tell which. Nothing called it, so it is gone rather than documented.
   */
  disconnect: () => void;
  switchToMonad: () => void;
  copyAddress: () => Promise<void>;
  refetchBalance: () => void;
}

const DokuWalletContext = createContext<DokuWalletState | undefined>(undefined);

export function DokuWalletProvider({ children }: PropsWithChildren) {
  const { address, isConnected, chainId, connector } = useAccount();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();

  const status = deriveWalletStatus({ isConnected, chainId, expected: EXPECTED_CHAIN_ID });

  // Only read a balance for a wallet on the right chain. Querying across chains returns a real
  // number for a different asset, which displays as a MON balance and is not one.
  const { data: balance, refetch } = useBalance({
    address,
    chainId: EXPECTED_CHAIN_ID,
    query: { enabled: status === "ready" },
  });

  const copyAddress = useCallback(async () => {
    /* `copyText` swallows the synchronous throw `navigator.clipboard` raises outside a secure
       context — this is an `async` callback whose rejection nobody handles, so that throw became
       an unhandled rejection rather than a copy that quietly did not happen. */
    if (address) await copyText(address);
  }, [address]);

  // Each wrapped in `useCallback` so the context value below only changes when something a
  // consumer actually reads has changed. Recreated inline, they would give every consumer a new
  // function identity on every balance poll — and any `useCallback` depending on one would be
  // invalidated with it.
  const disconnectWallet = useCallback(() => disconnect(), [disconnect]);
  const switchToMonad = useCallback(
    () => switchChain({ chainId: EXPECTED_CHAIN_ID }),
    [switchChain]
  );
  const refetchBalance = useCallback(() => void refetch(), [refetch]);

  const value = useMemo<DokuWalletState>(
    () => ({
      address,
      status,
      wrongChain: status === "wrong-chain",
      connectedWalletName: connector?.name,
      monBalance: balance?.value,
      disconnect: disconnectWallet,
      switchToMonad,
      copyAddress,
      refetchBalance,
    }),
    [
      address,
      status,
      connector,
      balance,
      disconnectWallet,
      switchToMonad,
      copyAddress,
      refetchBalance,
    ]
  );

  return <DokuWalletContext.Provider value={value}>{children}</DokuWalletContext.Provider>;
}

export function useDokuWallet(): DokuWalletState {
  const context = useContext(DokuWalletContext);
  if (!context) throw new Error("useDokuWallet must be used inside DokuWalletProvider");
  return context;
}

/** The read client, for view calls that do not need a wallet. */
export function useDokuPublicClient() {
  return usePublicClient({ chainId: EXPECTED_CHAIN_ID });
}

/** The write client. Undefined until a wallet is connected on the right chain. */
export function useDokuWalletClient() {
  const { data } = useWalletClient({ chainId: EXPECTED_CHAIN_ID });
  return data;
}
