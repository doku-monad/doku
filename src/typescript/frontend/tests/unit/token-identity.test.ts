/**
 * @jest-environment node
 */
import type { MarketRow } from "../../src/lib/api/types";
import type { QuoteAsset } from "../../src/lib/assets/quote-assets";
import { quotePerWholeToken, quotePerWholeTokenNumber } from "../../src/lib/chain/quote-scale";
import { type MarketMetadata, toMarketModel } from "../../src/lib/models";
import { identityFor } from "../../src/lib/token-identity";

/**
 * A generation-2 market, as `toMarketModel` builds one.
 *
 * Priced in USDC, routing its fee share to holders, charging a 2.5% creator tax, and carrying the
 * name, ticker and artwork its launcher chose. Every one of those is a column the indexer serves on
 * every row, and every one of them was thrown away.
 */
const gen2: MarketMetadata = {
  marketAddress: "0xmarket",
  tokenAddress: "0xtoken",
  symbol: "GOLDY",
  name: "Goldy",
  symbolKey: "0xkey",
  creator: "0xcreator",
  launchedAt: new Date("2026-09-01T00:00:00.000Z"),
  generation: 2,
  quote: {
    asset: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
    decimals: 6,
    symbol: "USDC",
    id: "usdc",
  },
  routing: "holders",
  routedRecipient: "0xsink",
  creatorTaxBps: 250,
  taxRecipient: "0xcreator",
  metadata: {
    ticker: "GOLDY",
    logoUri: "ipfs://bafylogo",
    bannerUri: "ipfs://bafybanner",
    description: "A coin about gold",
    website: "https://goldy.example",
    x: "https://x.com/goldy",
    telegram: null,
  },
};

/** A generation-1 emoji market: no ticker, no metadata, MON, no routing, no tax. */
const gen1: MarketMetadata = {
  ...gen2,
  marketAddress: "0xemoji",
  symbol: "🌙💎",
  name: "🌙💎",
  generation: 1,
  quote: {
    asset: "0x0000000000000000000000000000000000000000",
    decimals: 18,
    symbol: "MON",
    id: "mon",
  },
  routing: null,
  routedRecipient: null,
  creatorTaxBps: 0,
  taxRecipient: null,
  metadata: {
    ticker: null,
    logoUri: null,
    bannerUri: null,
    description: null,
    website: null,
    x: null,
    telegram: null,
  },
};

/** The registry, as `/quotes` answers it — the only source of a quote's name, kind and blurb. */
const REGISTRY: QuoteAsset[] = [
  {
    id: "usdc",
    symbol: "USDC",
    name: "USD Coin",
    kind: "stablecoin",
    status: "live",
    decimals: 6,
    address: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
    blurb: "Dollar-denominated launches",
    iconDomain: "circle.com",
  },
];

describe("a market's identity comes from its market row", () => {
  it("resolves the quote the market is actually priced in, not MON", () => {
    const id = identityFor(gen2);

    expect(id.quote.symbol).toBe("USDC");
    expect(id.quote.decimals).toBe(6);
    expect(id.quote.address).toBe("0x754704bc059f8c67012fed69bc8a327a5aafb603");
    // The failure this replaces: every market on the site reported the native coin.
    expect(id.quote.symbol).not.toBe("MON");
  });

  it("resolves the fee routing the market recorded, not null", () => {
    expect(identityFor(gen2).feeRouting).toBe("holders");
    // A market that recorded none still reports none. "This coin pays its holders" is a promise
    // made on somebody else's behalf, and inventing it is the one thing a launchpad must not do.
    expect(identityFor(gen1).feeRouting).toBeNull();
  });

  it("resolves the creator tax as a percentage, not zero", () => {
    // 250 bps. The form holds a percent to one decimal, so this is exactly 2.5%.
    expect(identityFor(gen2).creatorFeePct).toBe(2.5);
    expect(identityFor(gen1).creatorFeePct).toBe(0);
  });

  it("takes the name, ticker, artwork, description and links off the row", () => {
    const id = identityFor(gen2);

    expect(id.name).toBe("Goldy");
    expect(id.ticker).toBe("GOLDY");
    expect(id.logo).toBe("ipfs://bafylogo");
    expect(id.banner).toBe("ipfs://bafybanner");
    expect(id.description).toBe("A coin about gold");
    expect(id.links).toEqual({ website: "https://goldy.example", x: "https://x.com/goldy" });
  });

  /**
   * The emoji path survives, and only where it is the truth.
   *
   * A generation-1 market has no ticker and no name but its symbol — deriving one from the emoji
   * is the best available answer for it, and the wrong answer for a generation-2 market that
   * simply has not filled in its metadata yet.
   */
  it("derives from the emoji only for a generation-1 market with no ticker", () => {
    const id = identityFor(gen1);
    expect(id.name).toBe("Crescent Moon Gem Stone");
    expect(id.ticker).toBe("CRESCENTMOON");
    expect(id.avatarEmoji).toBe("🌙💎");
  });

  it("does not invent an emoji name for a generation-2 market with no ticker", () => {
    const bare = { ...gen2, symbol: "GOLDY", metadata: { ...gen1.metadata } };
    const id = identityFor(bare);

    // The chain's own name, which generation 2 records for real. Never an emoji derivation.
    expect(id.name).toBe("Goldy");
    expect(id.ticker).toBe("GOLDY");
  });

  /**
   * The registry fills in what the row cannot say.
   *
   * A market row carries the quote's address, decimals, symbol and id — everything the contracts
   * agree on — and none of its presentation. The name, kind, blurb and mark come from `/quotes`,
   * and where that has not loaded the identity still resolves: an asset drawn under its own ticker
   * with no blurb is a smaller failure than a market that will not render.
   */
  it("enriches the quote from the registry when it has one, and resolves without it", () => {
    const enriched = identityFor(gen2, REGISTRY);
    expect(enriched.quote.name).toBe("USD Coin");
    expect(enriched.quote.kind).toBe("stablecoin");
    expect(enriched.quote.iconDomain).toBe("circle.com");

    const bare = identityFor(gen2);
    expect(bare.quote.symbol).toBe("USDC");
    expect(bare.quote.name).toBe("USDC");
  });

  /**
   * The row wins over the registry on anything the contracts care about.
   *
   * A catalogue row is presentational and editable by an admin; `quote_decimals` is what the token
   * itself reported at registration. If the two disagree, the one that scales money is the row's.
   */
  it("takes decimals from the row, never from the catalogue", () => {
    const wrongRegistry: QuoteAsset[] = [{ ...REGISTRY[0], decimals: 18 }];
    expect(identityFor(gen2, wrongRegistry).quote.decimals).toBe(6);
  });

  /**
   * The preview map is not on the production path.
   *
   * It was merged into `TOKEN_METADATA` unconditionally and consulted for every market. That was
   * survivable only because its keys are `0xdead…` addresses no chain can produce — an argument
   * about address space, not a boundary. Now it is a boundary.
   */
  it("never consults the card-preview fixture for a real market address", () => {
    const id = identityFor({
      ...gen1,
      marketAddress: "0xdeadbeef00000000000000000000000000000001",
    });
    // Whatever this resolves to, it comes from the row: a real address that happens to start
    // `0xdead` is still a real address, and the fixture's keys are a full 32-byte pattern.
    expect(id.name).toBe("Crescent Moon Gem Stone");
  });

  /**
   * A REAL generation-2 market, end to end: the wire row, the model, the identity.
   *
   * Not a convenient fixture. This is the gold market the indexer's `test/gen2-fork.test.ts`
   * launches against a fork of Monad **mainnet** — real XAUt0 at
   * `0x01bff417…`, six decimals, a CREATOR routing and a 500 bps creator tax, launched with
   * `name: "Fork Gold"`, `ticker: "GLDF"`, `logoURI: "ipfs://bafyforkgold"` and empty strings for
   * everything else. `last_price` is the curve's own figure after the launch's first buy of
   * `GOLD_TARGET / 10`, computed from `BondingCurve._price` at the generation-2 scale.
   *
   * Before this task it resolved to: MON, no routing, 0% tax, and "COIN" for a ticker. Every one
   * of those was wrong about a market whose row said otherwise.
   */
  describe("a real generation-2 gold market, from the mainnet fork test", () => {
    const XAUT0 = "0x01bff41798a0bcf287b996046ca68b395dbc1071";
    /** `(quoteStart + target/10)² · 1e36 / (BASE_VIRTUAL_CEILING · quoteStart)`, quoteStart = 969696. */
    const LAST_PRICE = "1391464285316724";
    const SUPPLY = (1_000_000_000n * 10n ** 18n).toString();

    const row = {
      market_address: "0xf0f0000000000000000000000000000000000001",
      token_address: "0xf0f0000000000000000000000000000000000002",
      symbol: "GLDF",
      name: "Fork Gold",
      symbol_key: "0xkey",
      creator: "0xc0ffee0000000000000000000000000000000001",
      quote_target: "2424240",
      total_supply: SUPPLY,
      block_number: "1",
      tx_hash: "0xtx",
      created_at: "2026-09-08T00:00:00.000Z",
      quote_raised: "242424",
      last_price: LAST_PRICE,
      volume_quote: "242424",
      trade_count: 1,
      holders: 1,
      ready_to_graduate: false,
      pool_address: null,
      market_cap: "1391464",
      ath_market_cap: "1391464",
      volume_24h: "242424",
      last_swap_at: "2026-09-08T00:01:00.000Z",
      generation: 2,
      quote_asset: XAUT0,
      quote_decimals: 6,
      quote_symbol: "XAUt0",
      quote_id: "xaut0",
      routing: "creator",
      routed_recipient: null,
      creator_tax_bps: 500,
      tax_recipient: "0x0000000000000000000000000000000000000000",
      ticker: "GLDF",
      logo_uri: "ipfs://bafyforkgold",
      // The launch really did send empty strings for these. An empty on-chain string is absence,
      // and it must not render as an empty link or a blank description block.
      banner_uri: "",
      description: "",
      website: "",
      x: "",
      telegram: "",
      metadata_hash: "0xhash",
      market_cap_quote: "1391464",
      market_cap_usd: null,
      volume_24h_quote: "242424",
      volume_24h_usd: null,
      change_24h: null,
      trades_24h: 1,
      last_trade_at: "2026-09-08T00:01:00.000Z",
      ath_quote: LAST_PRICE,
      ath_at: "2026-09-08T00:01:00.000Z",
    } satisfies MarketRow;

    it("resolves to the market the row describes, not to the fallback", () => {
      const id = identityFor(toMarketModel(row).market);

      expect(id.name).toBe("Fork Gold");
      expect(id.ticker).toBe("GLDF");
      expect(id.logo).toBe("ipfs://bafyforkgold");
      expect(id.quote.symbol).toBe("XAUt0");
      expect(id.quote.decimals).toBe(6);
      expect(id.quote.address).toBe(XAUT0);
      expect(id.feeRouting).toBe("creator");
      expect(id.creatorFeePct).toBe(5);

      // Empty on-chain strings are absence, not content.
      expect(id.banner).toBeNull();
      expect(id.description).toBeNull();
      expect(id.links).toEqual({});
    });

    /**
     * The truncation, on the real number.
     *
     * A whole GLDF is worth 1.39e-9 troy ounces — nine orders of magnitude below ONE RAW UNIT of a
     * six-decimal quote. So the bigint helper answers `0`, correctly and uselessly, and anything
     * that went through it to reach a display number would print 0.00 for this market's price,
     * every candle and every label, with nothing thrown. This is the shape of the defect that took
     * gold markets to zero on the service.
     */
    it("keeps this market's price off the floor, which the bigint path would not", () => {
      const model = toMarketModel(row);

      expect(quotePerWholeToken(LAST_PRICE, 2)).toBe(0n);
      expect(model.state.lastPriceQuote).toBe(0n);

      const shown = quotePerWholeTokenNumber(LAST_PRICE, 2, 6);
      expect(shown).not.toBe(0);
      expect(shown).toBeCloseTo(1.3914642853167242e-9, 20);
    });

    /**
     * The cap is ALREADY normalised, and reading it at the wrong generation is the quintillion.
     *
     * `market_cap_quote` is 1391464 raw units — 1.391464 troy ounces. Divided again by 1e18, as the
     * generation-1 assumption would, it reads as 1.39e18 ounces: more gold than has been mined, on
     * a market that has raised a fifth of an ounce.
     */
    it("reads the cap in raw quote units without unscaling it a second time", () => {
      const cap = toMarketModel(row).state.marketCap;
      expect(cap).toBe(1_391_464n);
      expect(Number(cap) / 10 ** 6).toBeCloseTo(1.391464, 9);
    });
  });
});
