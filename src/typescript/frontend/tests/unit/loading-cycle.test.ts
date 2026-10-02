/**
 * @jest-environment node
 */
import { seededEmojiCycle } from "../../src/lib/loading-cycle";

describe("loading splash emoji cycle", () => {
  it("is the same for the same path, so the server and the client hydrate the same emoji", () => {
    expect(seededEmojiCycle("/explore")).toEqual(seededEmojiCycle("/explore"));
  });
  it("differs between paths and holds twenty distinct entries", () => {
    const a = seededEmojiCycle("/explore");
    const b = seededEmojiCycle("/pools");
    expect(a).toHaveLength(20);
    expect(new Set(a.map((e) => e.emoji)).size).toBe(20);
    expect(a[0].emoji).not.toBe(b[0].emoji);
  });
});
