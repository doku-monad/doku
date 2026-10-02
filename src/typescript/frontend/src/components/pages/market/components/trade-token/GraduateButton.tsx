"use client";

import ButtonWithConnectWalletFallback from "components/header/wallet-button/ConnectWalletButton";
import { ActionKey } from "components/ui/action-key";
import { translationFunction } from "context/language-context";
import { useDokuWallet, useDokuWalletClient } from "context/wallet-context/DokuWalletProvider";
import { useCallback, useState } from "react";
import { toast } from "react-toastify";
import { usePublicClient } from "wagmi";

import { CONTRACTS } from "@/lib/chain/addresses";
import { shorten } from "@/lib/chain/revert-reason";
import { graduateMarket } from "@/lib/chain/writes";

/**
 * Finishes a graduation the filling buy could not.
 *
 * ## Why a market ever needs this
 *
 * Graduation runs INSIDE the buy that fills the curve, behind a wrapper that swallows any failure
 * so that buyer's own trade can never be taken down by it. That is the right trade — nobody should
 * lose a purchase because the market they filled had an expensive migration attached — and it has a
 * consequence: a buy that carries an ordinary gas limit into a transaction which also has to create
 * a Uniswap pool, mint a position and lock it will starve that inner call and succeed anyway. The
 * market is then filled, closed for good, and has no pool.
 *
 * `DokuGraduation.graduate` is permissionless precisely for this, and the contract has always been
 * able to recover. What was missing was anyone to ask it: nothing in this app called it, nothing
 * listened for `AutoGraduationFailed`, and the panel presented the result as a greyed-out button.
 *
 * ## Why the caller is not out of pocket
 *
 * Whoever presses this pays the gas for somebody else's migration — a real cost, about half a MON
 * at the limit Monad bills. It is offered to everyone rather than to the creator alone because the
 * people who want it most are the holders, who cannot sell until it lands, and because a market
 * waiting on one specific person is a market that waits as long as that person is asleep.
 */
export const GraduateButton = ({
  curve,
  onDone,
}: {
  curve: `0x${string}`;
  onDone?: () => void;
}) => {
  const { t } = translationFunction();
  const { wrongChain, switchToMonad } = useDokuWallet();
  const wallet = useDokuWalletClient();
  const publicClient = usePublicClient();
  const [pending, setPending] = useState(false);

  const onClick = useCallback(async () => {
    if (!wallet || !publicClient || wrongChain) return;
    setPending(true);
    try {
      const hash = await graduateMarket(wallet, publicClient, {
        graduation: CONTRACTS.graduation,
        curve,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      toast.success(t("Market graduated — trading is open"));
      onDone?.();
    } catch (error) {
      /*
       * The failure worth naming separately: somebody else got there first. It is not an error from
       * the presser's point of view — the thing they wanted has happened — so it reads as the good
       * news it is rather than as a revert.
       */
      const message = error instanceof Error ? error.message : String(error);
      if (/AlreadyGraduated/i.test(message)) {
        toast.success(t("Already graduated — somebody else finished it"));
        onDone?.();
      } else if (/user rejected|denied transaction|rejected the request/i.test(message)) {
        // Their decision, not a fault. Say nothing.
      } else {
        toast.error(shorten(message));
      }
    } finally {
      setPending(false);
    }
  }, [wallet, publicClient, wrongChain, curve, onDone, t]);

  /*
   * `ActionKey`, because `.doku-swap-cta` was never a thing.
   *
   * Both of these buttons carried that class and no stylesheet in the repository defines it — so
   * the one control that finishes a curve rendered as transparent text, in the panel where every
   * other key is filled, and its pending state was the word "Graduating…" where every sibling shows
   * a spinner. It looked like a link somebody had forgotten to style, which is roughly what it was.
   *
   * `warn` for the chain switch and `buy` for the graduation itself, following the rule
   * `ActionKey` states: amber is a detour, green is the commitment. `SwapButton` — the key directly
   * above this one in the same column — already does exactly this.
   */
  if (wrongChain) {
    return (
      <ButtonWithConnectWalletFallback block variant="solid">
        <ActionKey onClick={switchToMonad} tone="warn">
          {t("Switch to Monad")}
        </ActionKey>
      </ButtonWithConnectWalletFallback>
    );
  }

  return (
    <ButtonWithConnectWalletFallback block variant="solid">
      <ActionKey onClick={onClick} disabled={pending} loading={pending} tone="buy">
        {pending ? t("Graduating…") : t("Graduate this market")}
      </ActionKey>
    </ButtonWithConnectWalletFallback>
  );
};

export default GraduateButton;
