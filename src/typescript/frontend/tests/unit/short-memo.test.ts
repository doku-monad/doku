import { createShortMemo } from "@/lib/api/short-memo";
import { DEBOUNCE_MS } from "@/lib/hooks/doku/board-refresh";

const EXPLORE_MEMO_MS = 300;

describe("createShortMemo", () => {
  it("shares one in-flight promise across a burst", async () => {
    let t = 0;
    let calls = 0;
    const memo = createShortMemo<number>(300, () => t);
    const produce = async () => ++calls;

    const a = memo("k", produce);
    t = 100;
    const b = memo("k", produce);
    t = 299;
    const c = memo("k", produce);
    expect(await Promise.all([a, b, c])).toEqual([1, 1, 1]);
    expect(calls).toBe(1);
  });

  it("asks again once the window has passed", async () => {
    let t = 0;
    let calls = 0;
    const memo = createShortMemo<number>(300, () => t);
    const produce = async () => ++calls;

    await memo("k", produce);
    t = 300;
    expect(await memo("k", produce)).toBe(2);
  });

  it("keys on the query, not on the route", async () => {
    let calls = 0;
    const memo = createShortMemo<number>(300, () => 0);
    const produce = async () => ++calls;
    await memo("page=1", produce);
    await memo("page=2", produce);
    expect(calls).toBe(2);
  });

  it("evicts a failure so the next caller retries", async () => {
    let calls = 0;
    const memo = createShortMemo<number>(300, () => 0);
    const failing = async () => {
      calls += 1;
      throw new Error("indexer down");
    };
    await expect(memo("k", failing)).rejects.toThrow("indexer down");
    // Same instant, same key: a live answer would be shared, a failure is not.
    await expect(memo("k", failing)).rejects.toThrow("indexer down");
    expect(calls).toBe(2);
  });

  it("keeps the explore window below the board's debounce, or a swap can be served stale", () => {
    // A refresh fires >= DEBOUNCE_MS after the event; a memo entry older than the window cannot
    // predate the event only if the window is shorter than that delay.
    expect(EXPLORE_MEMO_MS).toBeLessThan(DEBOUNCE_MS);
  });
});
