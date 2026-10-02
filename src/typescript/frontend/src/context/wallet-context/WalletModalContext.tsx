"use client";

import { createContext, type PropsWithChildren, useContext, useMemo, useState } from "react";

type WalletModalContextState = {
  isWalletModalOpen: boolean;
  openWalletModal: () => void;
  closeWalletModal: () => void;
};

const WalletModalContext = createContext<WalletModalContextState | undefined>(undefined);

export function WalletModalContextProvider({ children }: PropsWithChildren) {
  const [isWalletModalOpen, setOpen] = useState(false);

  // The modal reads its own open state from this context rather than taking it as a prop, so
  // "connected — close the dialog" is one call from anywhere instead of prop-drilling a setter.
  const value = useMemo<WalletModalContextState>(
    () => ({
      isWalletModalOpen,
      openWalletModal: () => setOpen(true),
      closeWalletModal: () => setOpen(false),
    }),
    [isWalletModalOpen]
  );

  /*
   * The dialog is *not* rendered here.
   *
   * It reads this context, so rendering it from inside created an import cycle — each module
   * importing the other, resolved by whichever the bundler happened to evaluate first. It is
   * mounted by the provider tree instead, one level up, where it can read the context like any
   * other consumer.
   */
  return <WalletModalContext.Provider value={value}>{children}</WalletModalContext.Provider>;
}

export const useWalletModal = (): WalletModalContextState => {
  const context = useContext(WalletModalContext);
  if (context == null) {
    throw new Error("useWalletModal must be used within a WalletModalContext.");
  }
  return context;
};
