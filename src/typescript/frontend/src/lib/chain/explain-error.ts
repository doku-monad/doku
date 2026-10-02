/**
 * A chain error, as one sentence somebody can act on — with the original kept.
 *
 * ## What this replaces
 *
 * `error.message`, printed whole. viem's messages are diagnostics, not copy: a failed
 * `predictMarket` read arrives as the headline, the RPC URL, the JSON request body, the raw call
 * arguments, the decoded contract call, a docs link, a `Details:` line and a version stamp —
 * roughly six hundred characters of hex and JSON, which the launch page rendered under its button
 * as the explanation for what had just gone wrong. It overflowed its panel, it named a localhost
 * port, and the one useful token in it (`Failed to fetch`) was the second-to-last line.
 *
 * The failure still has to be *reportable*, so nothing is discarded: `detail` is the original, and
 * the surface decides whether to show it. What changes is which of the two a reader meets first.
 *
 * ## The rules are ordered, and the order is the point
 *
 * A viem message can match several of these at once — an unreachable node produces a message that
 * also contains the word "call", a revert carries the request body too. They are checked from most
 * specific cause to least, and the first match wins, because the first *cause* is the one a person
 * can do something about.
 */

export interface ChainFailure {
  /** One sentence, in the product's voice. Safe to render anywhere. */
  headline: string;
  /** The original message, for a disclosure and for a bug report. Never rendered by default. */
  detail: string;
}

/** The first line, which is the only part of a viem message written for a human. */
const firstLine = (raw: string) => raw.split("\n")[0]?.trim() ?? "";

/**
 * A revert's own reason, where the node gave one.
 *
 * Two shapes: a `require` string, and a named custom error. Both are the contract *saying* why,
 * which beats any sentence written here.
 */
const revertReason = (raw: string): string | null => {
  const named = /reverted with the following reason:\s*\n?\s*(.+)/i.exec(raw);
  if (named?.[1]) return named[1].trim();
  const custom = /reverted with the following signature:|Error:\s*([A-Za-z_][\w]*)\(/.exec(raw);
  if (custom?.[1]) return `${custom[1]}()`;
  return null;
};

export function explainChainError(error: unknown): ChainFailure {
  const detail = error instanceof Error ? error.message : String(error);
  const lower = detail.toLowerCase();

  const of = (headline: string): ChainFailure => ({ headline, detail });

  /* The node is not answering. This is the one that produced the six-hundred-character dump: a read
     that could not leave the browser, reported as though the contract had said something. */
  if (
    /failed to fetch|http request failed|fetch failed|networkerror|err_connection|load failed/i.test(
      lower
    )
  ) {
    return of(
      "Could not reach the network. Nothing was signed and nothing was spent — check your connection, then try again."
    );
  }

  if (/timed out|timeout|took too long/i.test(lower)) {
    return of("The network did not answer in time. Nothing was signed; try again in a moment.");
  }

  if (/chain.*mismatch|does not match the target chain|wrong network/i.test(lower)) {
    return of("This wallet is on a different network. Switch it to Monad and try again.");
  }

  if (/insufficient funds|exceeds the balance/i.test(lower)) {
    return of("This wallet cannot cover the transaction and its gas.");
  }

  if (/nonce too low|already known|replacement transaction underpriced/i.test(lower)) {
    return of(
      "Another transaction from this wallet is still in flight. Wait for it to land, then try again."
    );
  }

  if (/intrinsic gas too low|gas required exceeds|out of gas/i.test(lower)) {
    return of("The transaction ran out of gas before it finished.");
  }

  if (/execution reverted|reverted with|contractfunctionexecutionerror/i.test(lower)) {
    const reason = revertReason(detail);
    return of(
      reason
        ? `The contract refused the transaction: ${reason}`
        : "The contract refused the transaction. Nothing was spent beyond gas."
    );
  }

  /*
   * Everything else: the first line, capped.
   *
   * Not the whole message and not a generic apology. The first line of a viem error is its
   * headline — "Execution reverted", "The contract function returned no data" — and it is the one
   * part written to be read. 160 characters is two lines at this width; past that it is a paragraph
   * that belongs behind the disclosure with the rest.
   */
  const head = firstLine(detail);
  if (!head) return of("Something went wrong. Nothing was signed.");
  return of(head.length > 160 ? `${head.slice(0, 157)}…` : head);
}
