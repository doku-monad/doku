/**
 * Whether a contract is at an address, and whether we actually found out.
 *
 * The market page derives a market's address, asks the chain for its code, and uses the answer to
 * decide between "the indexer is behind, keep waiting" and "this URL is wrong". That decision was
 * made directly on `await client.getBytecode({ address }).catch(() => undefined)`, which collapses
 * two opposite outcomes into one value: viem returns `undefined` when there is NO CODE, and the
 * `catch` returns `undefined` when the RPC call FAILED. A momentary RPC hiccup therefore rendered
 * "nobody has launched this coin" to the one person guaranteed to know otherwise — whoever had
 * just paid gas to launch it, which is precisely when this path runs.
 *
 * Splitting the probe from the verdict is what makes the third case expressible at all, and keeps
 * the verdict a pure function that a unit test can exercise without a server component or a node.
 */

/** The outcome of one `eth_getCode`, with the failure kept distinct from an empty result. */
export type CodeProbe =
  | { ok: true; bytecode: `0x${string}` | undefined }
  | { ok: false; error: unknown };

/**
 * - `deployed`: there is code at the address, so the market is real and the indexer is behind.
 * - `absent`: the chain says there is nothing there, so the URL is genuinely wrong.
 * - `unknown`: we could not ask. Not evidence of anything, and must not be reported as absence.
 */
export type DeploymentState = "deployed" | "absent" | "unknown";

export function classifyDeployment(probe: CodeProbe): DeploymentState {
  if (!probe.ok) return "unknown";
  // `"0x"` is the empty result some nodes return where viem would normally hand back `undefined`.
  // Reading it as code present would strand a genuinely wrong URL on the retrying screen forever.
  if (!probe.bytecode || probe.bytecode === "0x") return "absent";
  return "deployed";
}

/**
 * `getBytecode`'s result as a `CodeProbe`.
 *
 * The `.then(onFulfilled, onRejected)` two-argument form rather than `.catch`: it is the shape
 * that cannot accidentally swallow a rejection into the success branch, which is the exact mistake
 * this module exists to undo.
 */
export function probeCode(read: Promise<`0x${string}` | undefined>): Promise<CodeProbe> {
  return read.then(
    (bytecode) => ({ ok: true, bytecode }) as const,
    (error: unknown) => ({ ok: false, error }) as const
  );
}

/** What the market page renders when the indexer has no row for the address yet. */
export type MarketPageFallback = "awaiting" | "not-found";

/**
 * Which of the two to show.
 *
 * `not-found` is reachable from exactly one place: the chain said there is nothing at this address
 * AND nobody is claiming to have just launched it. Everything else waits, because the awaiting page
 * polls and will correct itself, while a wrong "nobody has launched this coin" is final and is read
 * by the one person who knows it is false.
 *
 * `justLaunched` is evidence the chain cannot supply. The launch flow navigates as soon as the
 * wallet returns a transaction hash rather than waiting for a block, so the page genuinely runs
 * before the contract exists: the probe answers "absent" truthfully and the conclusion drawn from
 * it was wrong. Only the launcher's own browser knows a transaction is in flight, so only it can
 * say so — which is why this arrives from the URL rather than from a node.
 */
export function fallbackFor(state: DeploymentState, justLaunched: boolean): MarketPageFallback {
  if (state === "absent" && !justLaunched) return "not-found";
  return "awaiting";
}
