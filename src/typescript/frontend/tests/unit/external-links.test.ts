/** @jest-environment node */
import { coinExternalLinks } from "../../src/lib/external-links";

// The chain definition reaches wagmi, which ships ESM Jest cannot parse; the links only read the
// chain's name, so the module is replaced by exactly that. (`jest.mock` is hoisted above the import.)
jest.mock("../../src/lib/chain/wagmi", () => ({ dokuChain: { name: "Monad" } }));

/**
 * The three venue links on every card. Each is a URL pattern owned by somebody else, so each is
 * pinned here to the pattern read from that venue's own site.
 */
describe("coin external links", () => {
  const token = "0xe342d395ff9a7cdc3b62042d60b3d7004a80fe1e";
  const links = coinExternalLinks(token);

  it("sends FOMO to Fomo's own token route, not to a DOKU page", () => {
    // `tokens/:chain/:tokenAddress` in Fomo's route manifest; `monad` is one of its chain slugs.
    expect(links.fomo).toBe(`https://fomo.family/tokens/monad/${token}`);
    expect(new URL(links.fomo).host).toBe("fomo.family");
  });

  it("keys DexScreener and GMGN on the chain slug", () => {
    expect(links.dexscreener).toBe(`https://dexscreener.com/monad/${token}`);
    expect(links.gmgn).toBe(`https://gmgn.ai/monad/token/${token}`);
  });
});
