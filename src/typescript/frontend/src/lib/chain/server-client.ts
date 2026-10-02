import "server-only";

import { createPublicClient, type PublicClient } from "viem";

import { CHAIN_TRANSPORT, dokuChain } from "./wagmi";

/** A read-only client for server components, on the same proxy-then-public transport the browser uses. */
export const serverClient: PublicClient = createPublicClient({
  chain: dokuChain,
  transport: CHAIN_TRANSPORT,
}) as PublicClient;
