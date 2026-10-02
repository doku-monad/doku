"use client";

import { useEffect } from "react";
import { useCapabilities } from "wagmi";

import { type BatchSupport, readBatchSupport } from "@/lib/chain/sell-batch";
import { EXPECTED_CHAIN_ID } from "@/lib/chain/wagmi";

/**
 * What the connected wallet will do with an EIP-5792 batch on Monad.
 *
 * One hook because two surfaces on the launch page need the SAME answer and must not be able to
 * disagree: the button, which sends the batch, and the dev-buy step, which tells the launcher how
 * many signatures they are about to be asked for and that a batched buy spends the guaranteed
 * minimum. Copy promising one prompt over an action that takes three is worse than no copy at all,
 * and two independent reads of the same capability is exactly how that happens.
 *
 * ## What is actually asked, and what actually comes back
 *
 * The wallet is asked about EVERY chain it knows and the answer is narrowed to Monad here. That is
 * a deliberate reading of `wallet_getCapabilities`, not an oversight: viem sends the chain filter
 * only when it is given a `chainId`, and sending it is the newer and less widely implemented form
 * of the call. Asking broadly and filtering locally is the shape every wallet has answered since
 * the draft. `readBatchSupport` does the narrowing and reads both the map and — defensively — the
 * already-narrowed entry, so adding a `chainId` here later cannot silently switch batching off.
 *
 * `retry: false` is INERT, and left standing as the intent rather than removed as a lie. wagmi
 * builds this query as `{ ...query, ...options }` (`wagmi/src/hooks/useCapabilities.ts:61-64`) and
 * its own `options` carries a `retry` function (`@wagmi/core/src/query/getCapabilities.ts:33-36`),
 * so the spread order overwrites anything passed in: a wallet with no `wallet_getCapabilities` is
 * asked three times, not once. Harmless — the failures are cheap, the result is cached, and a
 * failed query is `undefined` data, which is `"none"` — but it is not what this line says, and the
 * next person to read it should not have to find that out from a network tab. `enabled` DOES
 * survive the same spread, because `options` does not set it.
 *
 * A THROW is an answer, and it is the common one. EIP-5792 says a wallet MUST NOT error on
 * `wallet_getCapabilities`, and several ignore that: Rabby answers `methodNotFound` and Rainbow
 * `METHOD_NOT_SUPPORTED`. Both arrive here as a failed query — `data` `undefined`, which is
 * `"none"` — so the spec violation costs nothing but the three round trips the paragraph above
 * describes. Nothing needs to catch it; it must simply never be mistaken for a bug in this file.
 *
 * Every uncertainty — no wallet, an unanswered query, a failed one, a shape this build has not been
 * read against — is `"none"`, which is the three-transaction path this app has always taken. See
 * `readBatchSupport`, which is where that discipline is written down and tested.
 */
export const useBatchSupport = (account: `0x${string}` | undefined): BatchSupport => {
  const { data, error, isFetching } = useCapabilities({
    account,
    query: { enabled: Boolean(account), retry: false },
  });
  const support = readBatchSupport(data, EXPECTED_CHAIN_ID);

  /**
   * The answer, where a developer can see it.
   *
   * "It still asks for three signatures" is the expected fallback for a wallet that does not
   * advertise the capability and it is also what a broken read looks like, and from the outside the
   * two are the same button. This makes them different: `__dokuBatchSupport` in the console says
   * what the wallet answered, what this build made of it, and whether the query failed at all.
   *
   * Development only, and by a comparison Next replaces at build time rather than by a runtime
   * flag — so the whole body is dead code in a production bundle and nothing here can ship a global
   * or a log to a user.
   */
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (globalThis as { __dokuBatchSupport?: unknown }).__dokuBatchSupport = {
      support,
      chainId: EXPECTED_CHAIN_ID,
      account: account ?? null,
      /* Raw, so a shape this build cannot read is still visible as the thing the wallet said. */
      capabilities: data ?? null,
      error: error ? error.message : null,
      fetching: isFetching,
    };
  }, [support, account, data, error, isFetching]);

  return support;
};

export default useBatchSupport;
