/**
 * @jest-environment node
 */
import { deriveWalletStatus, describeTxError } from "../../src/lib/chain/wallet-state";

describe("wallet status", () => {
  it("is disconnected when there is no account", () => {
    expect(deriveWalletStatus({ isConnected: false, chainId: undefined, expected: 143 })).toBe(
      "disconnected"
    );
  });

  it("is ready on the expected chain", () => {
    expect(deriveWalletStatus({ isConnected: true, chainId: 143, expected: 143 })).toBe("ready");
  });

  /**
   * The case that matters.
   *
   * A wallet left on Ethereum mainnet connects, reports an address, and signs — and the
   * transaction goes to a chain this app cannot see. Treated as connected, the UI shows a balance
   * of zero and a button that appears to do nothing. It has to be its own state so it can be said
   * out loud.
   */
  it("is wrong-chain when connected somewhere else", () => {
    expect(deriveWalletStatus({ isConnected: true, chainId: 1, expected: 143 })).toBe(
      "wrong-chain"
    );
  });

  /// Connected but with no chain reported yet is not the same as connected to the right one.
  /// Assuming the right chain here is how a wrong-chain wallet slips through during reconnection.
  it("does not assume the right chain while the chain id is still unknown", () => {
    expect(deriveWalletStatus({ isConnected: true, chainId: undefined, expected: 143 })).toBe(
      "wrong-chain"
    );
  });
});

describe("transaction error messages", () => {
  /// A user who clicked "reject" has not hit an error, and telling them something failed trains
  /// them to distrust messages that matter.
  it("recognises a rejected signature as a cancellation", () => {
    expect(describeTxError({ name: "UserRejectedRequestError" }).kind).toBe("rejected");
    expect(describeTxError({ message: "User rejected the request" }).kind).toBe("rejected");
  });

  it("surfaces a contract revert reason rather than the raw error", () => {
    const described = describeTxError({
      name: "ContractFunctionExecutionError",
      shortMessage: "execution reverted: SlippageExceeded",
    });
    expect(described.kind).toBe("reverted");
    expect(described.message).toContain("SlippageExceeded");
  });

  it("names insufficient funds specifically", () => {
    expect(describeTxError({ message: "insufficient funds for gas * price + value" }).kind).toBe(
      "insufficient-funds"
    );
  });

  it("falls back to something printable rather than [object Object]", () => {
    const described = describeTxError({});
    expect(described.kind).toBe("unknown");
    expect(described.message).not.toContain("[object Object]");
    expect(described.message.length).toBeGreaterThan(0);
  });
});
