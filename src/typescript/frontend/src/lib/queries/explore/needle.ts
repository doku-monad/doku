import { symbolBytesToEmojis } from "@/sdk/emoji_data";

/**
 * What the search box is actually looking for.
 *
 * Free text, lower-cased. The one special case is a leading `0x`: the board's search used to carry
 * hex-encoded emoji bytes, and links in that form are already out in the world, so a query that
 * decodes to emoji is turned back into its glyphs and sent as the needle. Anything else starting
 * with `0x` — a pasted contract address, which is the other thing people put in this box — decodes
 * to nothing and falls through unchanged, which is what the service wants: it matches a `0x` needle
 * against the market and token addresses as a PREFIX rather than as a substring.
 *
 * This still happens here rather than in SQL because the decoding is the client's own history. The
 * indexer has never heard of emoji-byte symbols in a query string and should not have to.
 *
 * Shared between the API route (the real board) and the preview fixture (the fabricated one), so
 * both read the box the same way.
 */
export const queryToNeedle = (q: string): string => {
  if (q.startsWith("0x")) {
    const glyphs = symbolBytesToEmojis(q)
      .emojis.map((e) => e.emoji)
      .join("");
    if (glyphs) return glyphs;
  }
  return q.toLowerCase();
};
