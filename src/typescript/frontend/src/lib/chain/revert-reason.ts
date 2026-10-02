/**
 * Turning a revert into a sentence, in a module with no wagmi in it.
 *
 * It lived in `use-liquidity-actions.ts`, which imports wagmi — ESM, which the unit runner cannot
 * parse — so the one function whose whole job is producing a string could not be tested against
 * the string a real revert produces. That is the same reason `addresses.ts` is not in `wagmi.ts`.
 */

/**
 * Revert reasons a person can do something about.
 *
 * The left side is what the chain says; the right side is what it means for the deposit in front
 * of them. `TRANSFER_FROM_FAILED` is solmate's, raised inside Permit2 when the token move fails,
 * and by the time it reaches a panel it names a mechanism three contracts away from anything the
 * person chose. Keyed on a substring because the message arrives wrapped differently depending on
 * whether it came from a simulation or a sent transaction.
 */
const PLAIN_REASONS: [needle: string, plain: string][] = [
  [
    "TRANSFER_FROM_FAILED",
    "Not enough tokens for this deposit once the pool's entry fee is added. Use Max, which leaves room for it.",
  ],
  ["AllowanceExpired", "The Permit2 approval has expired. Approve again and retry."],
  [
    "MaximumAmountExceeded",
    "The price moved past the slippage limit while this was being sent. Retry.",
  ],
  ["DeadlinePassed", "This took longer than five minutes to sign. Retry."],
];

/**
 * A revert reason, trimmed to something a person can act on.
 *
 * viem's errors carry the whole request — ABI, arguments, docs link — which is exactly right in a
 * console and unreadable in a panel four inches wide.
 *
 * The first line is not the reason. viem's contract errors open with a HEADING —
 * `The contract function "modifyLiquidities" reverted with the following reason:` — and put the
 * reason on the line after it, so taking the first non-empty line renders a sentence that ends in
 * a colon and says nothing. That is what a live `TRANSFER_FROM_FAILED` looked like from this panel:
 * a red box announcing that there was a reason, and no reason.
 */
export function shorten(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);

  for (const [needle, plain] of PLAIN_REASONS) {
    if (message.includes(needle)) return plain;
  }

  const lines = message.split("\n").filter((l) => l.trim().length > 0);
  const first = lines[0] ?? message;
  // A heading ends in a colon and is followed by the thing it introduces. Keep both, or the panel
  // shows the announcement without the news.
  const detail = first.trimEnd().endsWith(":") ? lines[1]?.trim() : undefined;
  const full = detail ? `${first.trim()} ${detail}` : first.trim();
  return full.length > 200 ? `${full.slice(0, 197)}…` : full;
}
