import { type NextRequest, NextResponse } from "next/server";

import { proofsFor } from "@/lib/allowlist/server";

/** The longest symbol the factory accepts, mirroring `DokuFactory.MAX_SYMBOL_LENGTH`. */
const MAX_SYMBOL_LENGTH = 10;

/**
 * Merkle proofs for the emoji in a symbol.
 *
 * `emojis` is passed as a JSON array rather than a joined string: emoji are multi-codepoint and
 * several contain characters that would be eaten by any separator worth choosing.
 */
export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("emojis");
  if (!raw) return NextResponse.json({ error: "emojis is required" }, { status: 400 });

  let emojis: unknown;
  try {
    emojis = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "emojis must be a JSON array" }, { status: 400 });
  }

  if (!Array.isArray(emojis) || emojis.some((e) => typeof e !== "string")) {
    return NextResponse.json({ error: "emojis must be an array of strings" }, { status: 400 });
  }
  if (emojis.length === 0 || emojis.length > MAX_SYMBOL_LENGTH) {
    return NextResponse.json(
      { error: `a symbol is 1 to ${MAX_SYMBOL_LENGTH} emoji` },
      { status: 400 },
    );
  }

  const entries = proofsFor(emojis as string[]);
  if (!entries) {
    // Named as the caller's problem, not ours: they picked an emoji the protocol does not support.
    return NextResponse.json({ error: "unsupported emoji in symbol" }, { status: 404 });
  }

  return NextResponse.json({
    indices: entries.map((e) => e.index),
    bytes: entries.map((e) => e.bytes),
    proofs: entries.map((e) => e.proof),
  });
}
