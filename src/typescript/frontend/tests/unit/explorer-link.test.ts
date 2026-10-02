/** @jest-environment node */
import { defineDokuChain } from "../../src/lib/chain/config";

/**
 * Every "view on the explorer" link in the product, pinned to a host that resolves.
 *
 * The mainnet base was `https://explorer.monad.xyz`, which has no DNS record at all — curl gets a
 * connection failure, not a 404 — so every explorer link the mainnet app rendered was dead, on
 * every transaction receipt, holder row and token header. Nothing in the app notices: the link is
 * a string, it builds fine, and the failure only happens in someone else's browser tab.
 *
 * The live explorer is MonadScan. Every market's token and curve is an EIP-1167 minimal proxy,
 * and MonadScan is the explorer that resolves the proxy and shows the implementation's verified
 * source on the clone's own page; MonadVision (BlockVision's Sourcify) has no proxy resolution,
 * so every market it linked to read as unverified. The `/token/`, `/address/` and `/tx/` paths
 * were fetched on `monadscan.com` before the switch; `/token/` sits behind a Cloudflare browser
 * check and answers 403 to any non-browser request, as MonadVision's whole site does.
 */
describe("explorer links", () => {
  it("points mainnet at MonadScan, which shows a clone as verified", () => {
    const chain = defineDokuChain("https://rpc.example", 143);
    expect(chain.blockExplorers?.default.url).toBe("https://monadscan.com");
    // The name is rendered next to the link in the UI, so a stale one mislabels a live explorer.
    expect(chain.blockExplorers?.default.name).toBe("MonadScan");
  });

  /**
   * Testnet moved too, and to its own subdomain rather than to a network parameter.
   *
   * `testnet.monadexplorer.com` answers 308 to `testnet.monadvision.com`. Following a permanent
   * redirect on every link works but costs a round trip and leaves the old host in every shared
   * URL, which is what makes it worth chasing down here rather than letting the browser do it.
   */
  it("points testnet at the testnet MonadScan", () => {
    const chain = defineDokuChain("https://rpc.example", 10143);
    expect(chain.blockExplorers?.default.url).toBe("https://testnet.monadscan.com");
  });

  /**
   * The three path segments, built off the chain definition rather than a second copy of the host.
   *
   * `explorerLink` is the whole of `toExplorerLink` minus the module-level chain read, so pinning
   * it here pins what ships without needing a browser-shaped module graph in a node test.
   */
  it("builds a well-formed link for each of the three link types", async () => {
    const { explorerLink } = await import("../../src/lib/utils/explorer-link");
    const base = defineDokuChain("https://rpc.example", 143).blockExplorers?.default.url ?? "";
    const address = "0x1234567890abcdef1234567890abcdef12345678";
    const tx = `0x${"ab".repeat(32)}`;

    expect(explorerLink(base, "coin", address)).toBe(`https://monadscan.com/token/${address}`);
    expect(explorerLink(base, "acc", address)).toBe(`https://monadscan.com/address/${address}`);
    expect(explorerLink(base, "transaction", tx)).toBe(`https://monadscan.com/tx/${tx}`);

    for (const url of [
      explorerLink(base, "coin", address),
      explorerLink(base, "acc", address),
      explorerLink(base, "transaction", tx),
    ]) {
      // A single missing or doubled slash still parses as a URL, so assert the shape of the parts
      // rather than that the string is parseable.
      const parsed = new URL(url);
      expect(parsed.host).toBe("monadscan.com");
      expect(parsed.pathname.split("/").filter(Boolean)).toHaveLength(2);
    }
  });

  /**
   * The end-to-end path, with the app configured for mainnet.
   *
   * `toExplorerLink` reads the chain at module load, so the environment has to be in place before
   * the import — hence `resetModules` and a dynamic import rather than a top-level one. Without
   * this case the wiring between the chain definition and the link builder is untested, which is
   * exactly where the dead host lived.
   */
  it("resolves the mainnet host through the real module graph", async () => {
    jest.resetModules();
    process.env.NEXT_PUBLIC_MONAD_CHAIN_ID = "143";
    process.env.NEXT_PUBLIC_MONAD_RPC_URL = "https://rpc.example";
    const { toExplorerLink } = await import("../../src/lib/utils/explorer-link");

    expect(toExplorerLink({ value: "0xfeed", linkType: "txn" })).toBe(
      "https://monadscan.com/tx/0xfeed"
    );
  });
});
