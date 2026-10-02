/**
 * @jest-environment node
 */

/**
 * The upload endpoint's two cost bounds.
 *
 * It is the only route in the app that does real work for an anonymous caller — a `sharp` decode
 * and a write to object storage — and it cannot ask for a credential, because an image has to
 * exist at a URL before the launch that references it is signed. The app's Upstash limiter has
 * never been enabled on this deployment, so until it is, these two numbers are the whole defence.
 */
import {
  MAX_INPUT_PIXELS,
  overLimitForTest,
  UPLOADS_PER_MINUTE,
} from "../../src/lib/uploads/limits";

describe("what an anonymous upload is allowed to cost", () => {
  it("holds one address to a rate a launcher never reaches", () => {
    // A launch needs two: a logo and a banner. Ten a minute is five launches.
    expect(UPLOADS_PER_MINUTE).toBeGreaterThanOrEqual(4);
    expect(UPLOADS_PER_MINUTE).toBeLessThanOrEqual(30);
  });

  it("lets a launcher through and stops a flood", () => {
    const now = 1_000_000;
    const state = new Map<string, number[]>();
    for (let i = 0; i < UPLOADS_PER_MINUTE; i++) {
      expect(overLimitForTest(state, "1.2.3.4", now + i)).toBe(false);
    }
    expect(overLimitForTest(state, "1.2.3.4", now + UPLOADS_PER_MINUTE)).toBe(true);
  });

  it("forgets an address once its window has passed", () => {
    const state = new Map<string, number[]>();
    for (let i = 0; i < UPLOADS_PER_MINUTE + 1; i++)
      overLimitForTest(state, "1.2.3.4", 1_000_000 + i);
    expect(overLimitForTest(state, "1.2.3.4", 1_000_000 + 61_000)).toBe(false);
  });

  it("counts each address on its own", () => {
    const state = new Map<string, number[]>();
    for (let i = 0; i < UPLOADS_PER_MINUTE + 1; i++) overLimitForTest(state, "1.1.1.1", 1_000_000);
    expect(overLimitForTest(state, "2.2.2.2", 1_000_000)).toBe(false);
  });

  /**
   * A flood of DISTINCT addresses must not grow the map without bound — that is the same denial of
   * service arriving through the defence rather than around it.
   */
  it("prunes addresses that have gone quiet", () => {
    const state = new Map<string, number[]>();
    for (let i = 0; i < 6_000; i++) overLimitForTest(state, `10.0.${i >> 8}.${i & 255}`, 1_000_000);
    overLimitForTest(state, "9.9.9.9", 1_000_000 + 120_000);
    expect(state.size).toBeLessThan(6_000);
  });

  /**
   * A SMALL FILE IS NOT A SMALL IMAGE. An SVG is text: `<svg width="20000" height="20000">` is 123
   * bytes and 400 megapixels once rasterised, and this route rasterises SVG at 384 DPI, which
   * multiplies the nominal size by another 5.3. Measured against the real pipeline, 119 bytes of
   * SVG costs 31ms of CPU on an endpoint that needs no credential.
   */
  it("caps the decode well under what a hostile vector reaches, and well over a real photograph", () => {
    const largestPhone = 8000 * 6000; // 48MP
    expect(MAX_INPUT_PIXELS).toBeGreaterThan(largestPhone);
    expect(MAX_INPUT_PIXELS).toBeLessThan(268_402_689); // sharp's own default
  });
});
