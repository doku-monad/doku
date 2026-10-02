import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Merkle proofs for the emoji allowlist.
 *
 * The tree is 2.2MB — 2,286 emoji each with a twelve-node proof. Shipping it to the browser to
 * launch a market with one emoji would be absurd, so it is read here and only the requested
 * entries are returned. The index map the browser *does* need (35KB, for deriving market
 * addresses) is generated separately.
 *
 * Read once and memoised: it is a build artifact and cannot change while the process is alive.
 */

export interface AllowlistEntry {
  index: number;
  emoji: string;
  bytes: `0x${string}`;
  proof: `0x${string}`[];
}

let cache: Map<string, AllowlistEntry> | null = null;

function table(): Map<string, AllowlistEntry> {
  if (cache) return cache;
  // Resolved from the working directory, with an explicit override for a deployment that puts it
  // elsewhere. It used to reach across the repo into `contracts/`, which does not exist in the
  // built image — the app is built from this directory alone.
  const path = process.env.DOKU_ALLOWLIST_PATH ?? join(process.cwd(), "data/allowlist.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { entries: AllowlistEntry[] };
  cache = new Map(parsed.entries.map((e) => [e.emoji, e]));
  return cache;
}

/**
 * Entries for a symbol, or null if any emoji is not on the allowlist.
 *
 * All-or-nothing on purpose: a partial result would build a launch transaction with mismatched
 * array lengths, which the factory rejects with `ProofLengthMismatch` — an error about our bug,
 * shown to someone who simply picked an unsupported emoji.
 */
export function proofsFor(emojis: readonly string[]): AllowlistEntry[] | null {
  const entries: AllowlistEntry[] = [];
  for (const emoji of emojis) {
    const entry = table().get(emoji);
    if (!entry) return null;
    entries.push(entry);
  }
  return entries.length ? entries : null;
}
