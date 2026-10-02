import { normalizeQuery, safeParsePageWithDefault } from "../../src/lib/routes/home-page-params";

/**
 * The `?page=` parse, pinned to what the zod schema it replaced accepted.
 *
 * `safeParsePageWithDefault` used `Schemas["PositiveInteger"]` from the SDK, which put zod on the
 * client for one query-string integer (it is reached from `query-params.ts`, which the board
 * imports). The replacement is four comparisons, and this is the proof that it accepts and rejects
 * exactly the same inputs — including the string round-trip rule, which is the non-obvious half:
 * the schema required `Number(s).toString() === s`, so `"03"` and `"3.0"` were never page 3.
 */
describe("safeParsePageWithDefault", () => {
  it.each([
    [1, 1],
    [3, 3],
    ["1", 1],
    ["42", 42],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    [10n, 10],
  ])("accepts %p", (input, expected) => {
    expect(safeParsePageWithDefault(input)).toBe(expected);
  });

  it.each([
    ["0", "zero is not a page"],
    [0, "zero is not a page"],
    [-1, "negative"],
    ["-1", "negative string"],
    ["03", "does not round-trip"],
    ["3.0", "does not round-trip"],
    [" 3", "does not round-trip"],
    ["3abc", "not a number"],
    ["", "empty"],
    [1.5, "not an integer"],
    [Infinity, "not finite"],
    [NaN, "not a number"],
    [Number.MAX_SAFE_INTEGER + 2, "beyond the safe range"],
    [undefined, "absent"],
    [null, "null"],
    [["2"], "a repeated query parameter arrives as an array"],
    [{}, "an object"],
    [true, "a boolean"],
  ])("falls back to 1 for %p (%s)", (input, _why) => {
    expect(safeParsePageWithDefault(input)).toBe(1);
  });
});

describe("normalizeQuery", () => {
  it.each([
    [undefined, undefined],
    [null, undefined],
    ["", undefined],
    ["   ", undefined],
    ["0x", undefined],
    [" 0x ", undefined],
    ["doku", "doku"],
    ["  doku  ", "doku"],
  ])("normalises %p", (input, expected) => {
    expect(normalizeQuery(input)).toBe(expected);
  });
});
