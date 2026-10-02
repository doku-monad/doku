/**
 * The parts of wallet handling that are worth testing on their own: what state a connection is
 * actually in, and what to tell someone when a transaction does not go through.
 *
 * Kept as pure functions rather than living inside the provider, because both are decision logic
 * that a React test would exercise only incidentally.
 */

export type WalletStatus = "disconnected" | "wrong-chain" | "ready";

/**
 * Wrong-chain is a first-class state, not an edge case.
 *
 * A wallet left on Ethereum mainnet connects happily, reports an address, and signs — and the
 * transaction lands on a chain this app cannot see. Folded into "connected", the UI shows a zero
 * balance and a button that appears to do nothing, which is indistinguishable from a bug in the
 * app. An unknown chain id counts as wrong: assuming the right one is exactly how a wrong-chain
 * wallet slips through while a session is reconnecting.
 */
export function deriveWalletStatus(input: {
  isConnected: boolean;
  chainId: number | undefined;
  expected: number;
}): WalletStatus {
  if (!input.isConnected) return "disconnected";
  return input.chainId === input.expected ? "ready" : "wrong-chain";
}

export type TxErrorKind =
  | "rejected"
  | "reverted"
  | "insufficient-funds"
  | "reserve"
  | "unknown";

export interface DescribedTxError {
  kind: TxErrorKind;
  message: string;
}

/**
 * Turns whatever a wallet or viem threw into something worth showing a person.
 *
 * The distinction that matters most is the first one: someone who clicked "reject" has not hit an
 * error. Reporting it as a failure trains people to dismiss the messages that do matter.
 */
export function describeTxError(error: unknown): DescribedTxError {
  const e = (error ?? {}) as { name?: string; message?: string; shortMessage?: string };
  const text = e.shortMessage ?? e.message ?? "";

  if (e.name === "UserRejectedRequestError" || /user rejected|user denied/i.test(text)) {
    return { kind: "rejected", message: "Transaction cancelled." };
  }

  /*
   * Monad's reserve rule, named before the generic revert branch can swallow it.
   *
   * The chain refuses a transaction that decrements the balance and ends below 10 MON, unless it
   * qualifies as an "emptying transaction" — which needs the wallet to have been quiet for a few
   * blocks. The raw text is "reserve balance violation", which names a rule most traders have never
   * heard of and reads as a fault in this app. See `lib/chain/monad-reserve`.
   */
  if (/reserve balance/i.test(text)) {
    return {
      kind: "reserve",
      message:
        "Monad keeps 10 MON in reserve, and this trade would leave you under it. Trade a little less, or wait a couple of seconds and try again.",
    };
  }

  if (/insufficient funds/i.test(text)) {
    return {
      kind: "insufficient-funds",
      message: "Not enough MON to cover the amount plus gas.",
    };
  }

  if (/revert/i.test(text) || e.name?.includes("ContractFunctionExecutionError")) {
    // The revert reason is the only part that says what actually went wrong — a slippage guard, a
    // closed deadline, a paused factory. Passing it through beats a generic failure message.
    return { kind: "reverted", message: text || "The contract rejected this transaction." };
  }

  return { kind: "unknown", message: text || "The transaction did not go through." };
}
