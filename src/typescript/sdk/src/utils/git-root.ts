import findGitRoot from "find-git-root";
import path from "path";

/**
 * The repository root.
 *
 * Lifted out of the SDK's Aptos test helpers, which needed a full chain client to load. A test
 * that only wants to walk the `app` directory should not have to instantiate a wallet.
 */
export function getGitRoot(): string {
  return path.dirname(findGitRoot(process.cwd()));
}
