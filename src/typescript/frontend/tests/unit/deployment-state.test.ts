/** @jest-environment node */
import {
  classifyDeployment,
  type CodeProbe,
  fallbackFor,
} from "../../src/lib/chain/deployment-state";

/**
 * Three answers, where the market page used to get two.
 *
 * The page asks the chain whether a market the indexer has never heard of is nonetheless real —
 * code at the derived address means the indexer is behind, no code means the URL is wrong. It read
 * that answer as `await client.getBytecode(...).catch(() => undefined)`, and viem returns
 * `undefined` for "no code there" as well, so a transient RPC failure was indistinguishable from a
 * definitive absence. The person it tells "nobody has launched this coin" is, by construction, the
 * person who just paid gas to launch it.
 */
describe("classifyDeployment", () => {
  const probe = (p: CodeProbe) => classifyDeployment(p);

  it("reports a contract when the node returns code", () => {
    expect(probe({ ok: true, bytecode: "0x60806040523480156100" })).toBe("deployed");
  });

  it("reports absence when the node says there is no code", () => {
    expect(probe({ ok: true, bytecode: undefined })).toBe("absent");
  });

  /**
   * `"0x"` is the same answer spelled differently.
   *
   * viem normalises an empty `eth_getCode` result to `undefined`, but not every node and not every
   * transport gets that far — some hand back the raw `"0x"`. Treating that as code present would
   * park a genuinely wrong URL on the awaiting-index page forever, retrying a market that will
   * never appear.
   */
  it("treats an empty 0x as absence, not as code", () => {
    expect(probe({ ok: true, bytecode: "0x" })).toBe("absent");
  });

  /**
   * The case the old code could not express, and the only one where being wrong costs somebody
   * their confidence in a launch they already paid for.
   */
  it("reports that it could not ask when the call failed", () => {
    expect(probe({ ok: false, error: new Error("HTTP request failed") })).toBe("unknown");
    // A rejection need not be an Error; viem and fetch both throw other shapes.
    expect(probe({ ok: false, error: "socket hang up" })).toBe("unknown");
  });

  /**
   * Could-not-ask must never land on the not-found page.
   *
   * This is the whole point of the third case: "unknown" and "deployed" both send the visitor to
   * the awaiting-index screen, which retries, and only a definitive "absent" renders a 404. Stated
   * as its own assertion so a future refactor that folds `unknown` back into `absent` fails here
   * rather than in production.
   */
  it("keeps could-not-ask on the recoverable side of the split", () => {
    const recoverable = (p: CodeProbe) => classifyDeployment(p) !== "absent";
    expect(recoverable({ ok: false, error: new Error("boom") })).toBe(true);
    expect(recoverable({ ok: true, bytecode: "0x6080" })).toBe(true);
    expect(recoverable({ ok: true, bytecode: undefined })).toBe(false);
  });
});

/**
 * What the market page shows when the indexer has no row yet.
 *
 * The launch flow navigates the moment the wallet hands back a hash — it does not wait for the
 * transaction to be mined — so the page runs while there is genuinely no code at the address. The
 * bytecode probe says "absent", truthfully, and the page told whoever had just paid gas that
 * nobody had launched the coin. That is the screenshot this exists to prevent.
 *
 * A launch the user has just submitted is the missing evidence. It cannot come from the chain,
 * because the whole problem is that the chain does not know yet.
 */
describe("choosing the fallback when the indexer has no market", () => {
  it("waits when there is code, which means the indexer is merely behind", () => {
    expect(fallbackFor("deployed", false)).toBe("awaiting");
    expect(fallbackFor("deployed", true)).toBe("awaiting");
  });

  it("waits when the chain could not be asked, rather than inventing an absence", () => {
    expect(fallbackFor("unknown", false)).toBe("awaiting");
    expect(fallbackFor("unknown", true)).toBe("awaiting");
  });

  it("waits on an absent address when the visitor just launched it", () => {
    // The transaction is in flight. Code will appear within a block or two, and the awaiting page
    // polls until it does.
    expect(fallbackFor("absent", true)).toBe("awaiting");
  });

  it("still answers not-found for a wrong URL, which is the case that must not regress", () => {
    // Nothing on chain and nobody claiming to have just launched it: the URL is simply wrong, and
    // showing a hopeful spinner forever would be worse than saying so.
    expect(fallbackFor("absent", false)).toBe("not-found");
  });

  it("has exactly one path to not-found, so a new state cannot fall into it by accident", () => {
    const states = ["deployed", "absent", "unknown"] as const;
    const notFound = states.flatMap((s) =>
      [true, false].filter((launched) => fallbackFor(s, launched) === "not-found").map(() => s)
    );
    expect(notFound).toEqual(["absent"]);
  });
});
