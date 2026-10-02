import type { RoutingName } from "@/lib/api/types";

import { PROTOCOL_FEE_PCT } from "./submit";

/** The creator-routed share of the trade fee; the protocol keeps the rest. Fixed in the contracts. */
const ROUTED_SHARE = 0.7;

const pct = (n: number): string => `${Number(n.toFixed(2))}%`;

const RECIPIENT: Record<RoutingName, string> = {
  creator: "this coin's creator",
  holders: "this coin's holders as dividends",
  buyback: "burning this coin",
};

/**
 * Who a trade on this market pays, in one sentence.
 *
 * `PROTOCOL_FEE_PCT` is the whole 1% trade fee, of which the protocol keeps 0.3% and 0.7% goes
 * wherever the creator routed it at launch. Calling all of it "the protocol's" told a buyer on a
 * creator-routed market that the creator takes nothing while the creator took most of the fee.
 */
export function tradeFeeSentence(input: { feeRouting: RoutingName | null; creatorFeePct: number }): string {
  const routed = PROTOCOL_FEE_PCT * ROUTED_SHARE;
  const kept = PROTOCOL_FEE_PCT - routed;
  const to = input.feeRouting ? RECIPIENT[input.feeRouting] : "where this coin's creator routed it";
  const head = `Every trade, buy or sell, pays ${pct(PROTOCOL_FEE_PCT + input.creatorFeePct)}: ${pct(kept)} to the protocol`;
  if (input.creatorFeePct > 0) {
    return `${head}, ${pct(routed)} to ${to}, and a ${pct(input.creatorFeePct)} tax to this coin's creator.`;
  }
  return `${head} and ${pct(routed)} to ${to}.`;
}
