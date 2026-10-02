/**
 * Which wallets this dialog knows something about, and how a discovered one is ordered.
 *
 * Separate from `WalletModal` for one reason: the split below is the logic the reported bug lived
 * in, and the modal imports wagmi at runtime, which the unit runner cannot parse — so nothing in
 * that file can be tested. This module imports nothing at all, which is why
 * `tests/unit/wallet-list.test.ts` can hold the guarantee that every wallet the browser announced
 * is offered.
 */

export type Featured = {
  key: string;
  label: string;
  /**
   * EIP-6963 reverse-DNS identifiers. wagmi uses the rdns as the connector id for discovered
   * providers, which is the only stable handle a wallet has — display names get rebranded, and
   * several wallets ship a name that changes with the extension's locale.
   */
  rdns: string[];
  /** Fallback for connectors that arrive without an rdns (a plain injected provider). */
  match: RegExp;
  /**
   * The wallet's own download page, used only when the extension is absent.
   *
   * Hardcoded outbound links: worth confirming these are the URLs you want to send people to, and
   * worth revisiting if a wallet moves its download page.
   */
  install: string;
  /**
   * The wallet's own domain, which is where its mark comes from when the extension is absent.
   *
   * A detected wallet publishes its icon over EIP-6963 and that is what gets drawn. An absent one
   * publishes nothing — and a monogram is not good enough here. Every row in this list is a *brand*
   * a person is looking for by sight, and on a phone, where no provider is ever injected, all five
   * rows are absent ones: a list of five coloured letters is a list nobody can scan.
   *
   * So the mark is fetched from the wallet's own domain through `faviconUrl`, the same mechanism
   * the quote-asset registry and the card's lookup links use, for the same reason: this repository
   * ships no copies of anybody's trademark, and a domain never goes stale.
   */
  domain: string;
  /**
   * The wallet's brand hue.
   *
   * Now the third source rather than the second — it paints the monogram when a fetch fails, and
   * it tints the well the mark sits in either way, which is what keeps a row recognisable in
   * peripheral vision before the image has decoded.
   */
  brand: string;
};

export const FEATURED: Featured[] = [
  {
    key: "metamask",
    domain: "metamask.io",
    label: "MetaMask",
    rdns: ["io.metamask", "io.metamask.mobile"],
    match: /meta\s*mask/i,
    install: "https://metamask.io/download/",
    brand: "#F6851B",
  },
  {
    key: "rabby",
    domain: "rabby.io",
    label: "Rabby",
    rdns: ["io.rabby"],
    match: /rabby/i,
    install: "https://rabby.io/",
    brand: "#7084FF",
  },
  {
    key: "zerion",
    domain: "zerion.io",
    label: "Zerion",
    rdns: ["io.zerion.wallet"],
    match: /zerion/i,
    install: "https://zerion.io/download",
    brand: "#2461ED",
  },
  {
    key: "backpack",
    domain: "backpack.app",
    label: "Backpack",
    rdns: ["app.backpack"],
    match: /backpack/i,
    install: "https://backpack.app/download",
    brand: "#E33E3F",
  },
  {
    key: "coinbase",
    domain: "coinbase.com",
    label: "Coinbase Wallet",
    rdns: ["com.coinbase.wallet"],
    match: /coinbase/i,
    install: "https://www.coinbase.com/wallet/downloads",
    brand: "#0052FF",
  },
];

/**
 * The three fields the split actually reads.
 *
 * A wagmi `Connector` satisfies it, and so does a two-line fixture — which is the point. Naming the
 * shape rather than importing `Connector` keeps this module free of anything that has to run.
 */
export type WalletIdentity = { uid: string; id: string; name: string };

/**
 * Everything discovery found, in a stable order, plus the featured wallets it did not find.
 *
 * `detected` is the list the dialog offers and it contains EVERY connector passed in. That is the
 * invariant: `FEATURED` decides where a wallet sits, never whether it is there. It used to decide
 * both, and a Monad user whose wallet was not one of the five found a dialog that appeared to offer
 * MetaMask and nothing else.
 *
 * Generic in the connector type so a caller gets its own objects back rather than this module's
 * narrowed view of them.
 */
export function splitWallets<T extends WalletIdentity>(
  connectors: readonly T[]
): { detected: { connector: T; spec?: Featured }[]; missing: Featured[] } {
  /*
   * Which featured spec a discovered connector turned out to BE — resolved once, then read twice:
   * by the sort below, and by the row, for a mark and a brand hue the wallet itself may not publish.
   * One pass over `FEATURED` rather than a lookup per connector, because the match is first-come:
   * two connectors can both answer to `/coinbase/i` and only one of them is it.
   */
  const specOf = new Map<string, Featured>();
  const claimed = new Set<string>();

  for (const spec of FEATURED) {
    const connector = connectors.find(
      (c) =>
        !claimed.has(c.uid) && (spec.rdns.includes(c.id.toLowerCase()) || spec.match.test(c.name))
    );
    if (!connector) continue;
    claimed.add(connector.uid);
    specOf.set(connector.uid, spec);
  }

  /*
   * A rank, not the announcement order.
   *
   * Extensions announce over EIP-6963 whenever they finish loading, so the raw order is a race the
   * user loses differently on every reload — the wallet at the top of the dialog would keep moving.
   * Featured wallets take their position in `FEATURED`; everything else sorts by name behind them,
   * which is arbitrary but at least the same arbitrary every time.
   */
  const rank = (c: T) => {
    const spec = specOf.get(c.uid);
    return spec ? FEATURED.indexOf(spec) : FEATURED.length;
  };

  const detected = [...connectors]
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .map((connector) => ({ connector, spec: specOf.get(connector.uid) }));

  const found = new Set(specOf.values());
  return { detected, missing: FEATURED.filter((f) => !found.has(f)) };
}
