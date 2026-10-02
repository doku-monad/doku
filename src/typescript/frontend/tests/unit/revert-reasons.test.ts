import { shorten } from "../../src/lib/chain/revert-reason";

/**
 * What the panel puts in its red box.
 *
 * The regression these pin is a live one: adding liquidity to 🎏 reverted with
 * `TRANSFER_FROM_FAILED`, viem reported it correctly, and the panel rendered
 * "The contract function "modifyLiquidities" reverted with the following reason:" — a heading, a
 * colon, and nothing after it, because the reason lives on the line BELOW the first.
 */
const VIEM_REVERT = [
  'The contract function "modifyLiquidities" reverted with the following reason:',
  "TRANSFER_FROM_FAILED",
  "",
  "Contract Call:",
  "  address:   0x5b7ec4a94ff9bedb700fb82ab09d5846972f4016",
  "  function:  modifyLiquidities(bytes unlockData, uint256 deadline)",
].join("\n");

describe("revert reasons", () => {
  it("never renders a heading with the reason cut off it", () => {
    const shown = shorten(new Error(VIEM_REVERT));
    expect(shown.trimEnd().endsWith(":")).toBe(false);
  });

  it("says what the person can do about a failed token pull", () => {
    const shown = shorten(new Error(VIEM_REVERT));
    expect(shown).toMatch(/entry fee/i);
    expect(shown).not.toMatch(/TRANSFER_FROM_FAILED/);
  });

  it("keeps the reason attached to its heading for anything unrecognised", () => {
    const shown = shorten(
      new Error(
        [
          'The contract function "x" reverted with the following reason:',
          "Something novel",
          "",
          "Docs: …",
        ].join("\n")
      )
    );
    expect(shown).toContain("Something novel");
  });

  it("leaves a plain one-line message alone", () => {
    expect(shorten(new Error("User rejected the request."))).toBe("User rejected the request.");
  });

  it("takes a non-Error", () => {
    expect(shorten("nope")).toBe("nope");
  });

  it("caps the length so the panel is not overrun", () => {
    expect(shorten(new Error("x".repeat(500))).length).toBeLessThanOrEqual(200);
  });
});
