/**
 * A memo that lives for a few hundred milliseconds, to collapse a burst into one call.
 *
 * `/api/explore` is polled by every open board, and every open board asks again within ~0.4–1.5 s
 * of the same live-feed event (`board-refresh.ts`). Before the board moved to the browser, those
 * were `router.refresh()` renders — one indexer round trip per viewer per event — and the load test
 * put the ceiling at about twenty renders a second per instance. With the page static, the burst
 * lands here instead, and this hands the same in-flight (or just-answered) promise to everyone
 * who asks within `ttlMs`.
 *
 * ## Why the TTL is shorter than the debounce
 *
 * `DEBOUNCE_MS` is 400: a refresh fires at least 400 ms after the event that caused it. A memo
 * older than that cannot predate the event, so an answer served from it already contains the
 * trade — provided `ttlMs` stays below the debounce. That is the whole freshness argument, and it
 * is why this is not a cache with a comfortable TTL: at two seconds a swap could land on the board
 * one poll late, which is the exact defect `lib/api/client.ts` documents against `no-store`.
 *
 * A rejected promise is evicted the moment it rejects, so a failed answer is retried by the next
 * caller rather than shared with everyone for the rest of the window.
 */
export function createShortMemo<T>(ttlMs: number, now: () => number = () => Date.now()) {
  const entries = new Map<string, { at: number; value: Promise<T> }>();

  const sweep = (): void => {
    const t = now();
    for (const [key, entry] of entries) {
      if (t - entry.at >= ttlMs) entries.delete(key);
    }
  };

  return (key: string, produce: () => Promise<T>): Promise<T> => {
    const hit = entries.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;

    const value = produce();
    entries.set(key, { at: now(), value });
    value.catch(() => {
      if (entries.get(key)?.value === value) entries.delete(key);
    });
    // Keys are query strings and there are only so many boards anyone looks at, but a scanner
    // walking `?page=1..N` must not grow this without bound.
    if (entries.size > 256) sweep();
    return value;
  };
}
