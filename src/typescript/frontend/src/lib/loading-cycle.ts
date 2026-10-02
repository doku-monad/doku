import { allSymbolEmojis, type SymbolEmojiData } from "@/sdk/emoji_data";

/**
 * Twenty symbol emoji chosen by the path, not by chance.
 *
 * This component renders on the server and again on the client to hydrate, and `Math.random`
 * gave the two a different first emoji — a hydration mismatch, which React answers by throwing
 * the whole streamed page away and rendering it again from the client (errors 425 then 422,
 * intermittently on every market page). A cycle seeded from the pathname is the same on both
 * sides, still differs between routes, and still spins.
 */
export const seededEmojiCycle = (seed: string, count = 20): SymbolEmojiData[] => {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  const n = allSymbolEmojis.length;
  const step = 7919; // prime, so the walk visits distinct entries before wrapping
  return Array.from({ length: count }, (_, i) => allSymbolEmojis[(h + i * step) % n]);
};
