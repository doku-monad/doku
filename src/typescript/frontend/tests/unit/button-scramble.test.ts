/**
 * @jest-environment node
 */
import { canScramble } from "../../src/components/button/can-scramble";

/**
 * When the button's text-scramble effect may run.
 *
 * The effect works by writing characters into the DOM node itself, so the button renders an empty
 * `<Text>` and lets the library fill it. That only works if there is text to scramble: handed a
 * JSX label it stringifies it, and the button reads "[object Object]" — which is exactly what the
 * live Buy button did, in capitals, because the button style uppercases its label.
 */
describe("canScramble", () => {
  it("scrambles a plain string label", () => {
    expect(canScramble(true, "Buy")).toBe(true);
  });

  it("scrambles a number, which has a sensible text form", () => {
    expect(canScramble(true, 42)).toBe(true);
  });

  /// The case that broke: a label with an emoji beside the word is an element, not a string.
  it("refuses an element, however simple", () => {
    expect(canScramble(true, { type: "span", props: {} } as unknown as React.ReactNode)).toBe(
      false
    );
  });

  it("refuses an array of children", () => {
    expect(canScramble(true, ["Buy", " ", "now"])).toBe(false);
  });

  it("refuses nothing at all", () => {
    expect(canScramble(true, null)).toBe(false);
    expect(canScramble(true, undefined)).toBe(false);
  });

  it("stays off when the button asked for it to be off", () => {
    expect(canScramble(false, "Buy")).toBe(false);
  });
});
