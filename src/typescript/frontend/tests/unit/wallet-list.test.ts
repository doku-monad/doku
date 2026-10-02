import { FEATURED, splitWallets } from "../../src/components/wallet/wallet-catalogue";

/**
 * The connect dialog offers what the browser has.
 *
 * This is the test for the bug the owner reported as "the wallet connection is coming only
 * metamask". Nothing was misconfigured and nothing was broken: wagmi's EIP-6963 discovery was on
 * and it found every injected wallet. The dialog then rendered a hardcoded list of five instead,
 * with MetaMask first, and collapsed everything discovery actually turned up behind a disclosure —
 * so a Phantom user saw five wallets they did not have and not the one they did.
 *
 * That failure is invisible from the outside: no error, no empty list, a dialog that looks
 * deliberate. The only thing that catches it is an assertion that the offered list contains every
 * connector handed in, which is what most of this file is.
 */

/** A wallet as EIP-6963 announces it. `uid` is wagmi's per-connector handle. */
const wallet = (id: string, name: string) => ({ uid: `uid-${id}`, id, name });

const names = (detected: { connector: { name: string } }[]) =>
  detected.map(({ connector }) => connector.name);

describe("the wallets the connect dialog offers", () => {
  /**
   * The Monad case, and the reason this file exists.
   *
   * Phantom is not one of the five featured wallets and is the single most common wallet on this
   * chain. It has to be in the offered list, not behind a disclosure, and not absent.
   */
  it("offers a discovered wallet that is not a featured one", () => {
    const { detected, missing } = splitWallets([wallet("app.phantom", "Phantom")]);

    expect(names(detected)).toEqual(["Phantom"]);
    // And the featured five are all install suggestions, because none of them is installed.
    expect(missing.map((f) => f.key)).toEqual(FEATURED.map((f) => f.key));
  });

  /**
   * The invariant, stated once: `FEATURED` reorders the list and never filters it.
   *
   * Every connector in, every connector out. A wallet dropped here is a user who cannot trade, and
   * the dialog gives no sign that anything was dropped.
   */
  it("offers every wallet it is given, featured or not", () => {
    const connectors = [
      wallet("app.phantom", "Phantom"),
      wallet("io.metamask", "MetaMask"),
      wallet("com.okex.wallet", "OKX Wallet"),
      wallet("io.rabby", "Rabby Wallet"),
      wallet("com.bitget.web3", "Bitget Wallet"),
    ];

    const { detected } = splitWallets(connectors);
    expect(detected).toHaveLength(connectors.length);
    expect(new Set(names(detected))).toEqual(new Set(connectors.map((c) => c.name)));
  });

  /**
   * Order cannot come from the announcement.
   *
   * Extensions announce whenever they finish loading, so two reloads of the same browser hand this
   * function the same wallets in a different order. A dialog whose first row moves every time is a
   * dialog people mistrust, so the same set must always produce the same list.
   */
  it("puts the same wallets in the same order however they announced", () => {
    const connectors = [
      wallet("io.rabby", "Rabby Wallet"),
      wallet("app.phantom", "Phantom"),
      wallet("io.metamask", "MetaMask"),
      wallet("com.okex.wallet", "OKX Wallet"),
    ];

    const forwards = names(splitWallets(connectors).detected);
    const backwards = names(splitWallets([...connectors].reverse()).detected);

    expect(forwards).toEqual(backwards);
    // Featured wallets by their position in `FEATURED` — MetaMask then Rabby — then the rest by
    // name. Asserted in full rather than as a property, because "stable" and "stable at the right
    // order" are different claims.
    expect(forwards).toEqual(["MetaMask", "Rabby Wallet", "OKX Wallet", "Phantom"]);
  });

  /**
   * A featured wallet is recognised by its rdns, and by its name only as a fallback.
   *
   * The rdns is the stable handle; display names get rebranded and some change with the extension's
   * locale. Both paths have to resolve to the spec, because that is where the row's install link
   * and brand hue come from.
   */
  it("recognises a featured wallet by rdns or by name", () => {
    const byRdns = splitWallets([wallet("io.metamask", "MetaMask")]);
    expect(byRdns.detected[0].spec?.key).toBe("metamask");

    const byName = splitWallets([wallet("some.vendor.wallet", "Meta Mask Browser")]);
    expect(byName.detected[0].spec?.key).toBe("metamask");
  });

  /**
   * One spec, one wallet.
   *
   * Several wallets carry "coinbase" somewhere in their name, and the spec contributes an install
   * URL and a brand colour — so a second connector claiming the same spec would be drawn as
   * Coinbase Wallet and link to Coinbase's download page. The first match takes it; the rest are
   * offered as themselves.
   */
  it("does not let two wallets claim one featured spec", () => {
    const { detected, missing } = splitWallets([
      wallet("com.coinbase.wallet", "Coinbase Wallet"),
      wallet("org.example.cb", "Coinbase Wallet Clone"),
    ]);

    expect(detected.filter((d) => d.spec?.key === "coinbase")).toHaveLength(1);
    expect(
      detected.find((d) => d.connector.name === "Coinbase Wallet Clone")?.spec
    ).toBeUndefined();
    expect(missing.map((f) => f.key)).not.toContain("coinbase");
  });

  /**
   * No wallet at all — a headless browser, or any phone outside a wallet's own app.
   *
   * The dialog reads `detected.length === 0` to show its install state, so an empty input must
   * yield an empty list and the full install catalogue. Yielding nothing at all is what turns this
   * state into an empty box that looks like a broken dialog.
   */
  it("yields nothing detected and everything installable for a browser with no wallet", () => {
    const { detected, missing } = splitWallets([]);
    expect(detected).toEqual([]);
    expect(missing).toEqual(FEATURED);
  });

  /** Install rows are outbound links, so a blank or relative one sends the user nowhere. */
  it("has a real download page and a mark for every featured wallet", () => {
    for (const f of FEATURED) {
      expect(f.install).toMatch(/^https:\/\//);
      expect(f.domain).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
      expect(f.brand).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
    expect(new Set(FEATURED.map((f) => f.key)).size).toBe(FEATURED.length);
  });
});
