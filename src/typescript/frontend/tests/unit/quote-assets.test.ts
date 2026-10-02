/**
 * @jest-environment node
 */
import {
  fetchQuoteAssets,
  getQuoteAsset,
  launchableQuoteAssets,
  nativeQuoteAsset,
  quoteAssetFromWire,
  type QuoteAssetWire,
} from "../../src/lib/assets/quote-assets";

/**
 * The registry as `/quotes` actually answers it.
 *
 * Copied from the indexer's `src/quotes/catalog.ts` and `QuoteService.list()` — the ids, symbols,
 * decimals and addresses are that file's, not a convenient invention. The three rows this suite
 * asserts on are the three the hand-written catalogue got wrong.
 */
const WIRE: QuoteAssetWire[] = [
  {
    id: "mon",
    symbol: "MON",
    name: "Monad",
    kind: "native",
    status: "live",
    decimals: 18,
    address: "0x0000000000000000000000000000000000000000",
    blurb: "The chain's native asset — the default quote on DOKU",
    underlying: null,
    iconDomain: "monad.xyz",
    quoteTarget: "1000000000000000000000",
    usdPrice: 2.5,
    usdPriceAt: "2026-09-08T00:00:00.000Z",
    marketCount: 41,
  },
  {
    id: "cbbtc",
    symbol: "cbBTC",
    name: "Coinbase Wrapped BTC",
    kind: "crypto",
    status: "listed",
    decimals: 8,
    address: "0xd18b7ec58cdf4876f6afebd3ed1730e4ce10414b",
    blurb: "The hard-money quote, Coinbase's wrapper",
    underlying: null,
    iconDomain: "coinbase.com",
    quoteTarget: null,
    usdPrice: null,
    usdPriceAt: null,
    marketCount: 0,
  },
  {
    id: "xaut0",
    symbol: "XAUt0",
    name: "Tether Gold",
    kind: "rwa",
    status: "soon",
    decimals: 6,
    address: "0x01bff41798a0bcf287b996046ca68b395dbc1071",
    blurb: "Gold, Just Pure Gold",
    underlying: "XAU",
    iconDomain: "tether.to",
    quoteTarget: null,
    usdPrice: null,
    usdPriceAt: null,
    marketCount: 0,
  },
];

const stubFetch = (body: unknown, status = 200): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

describe("the quote-asset registry", () => {
  it("gives MON an address — address(0), which is what a PoolKey carries, not null", async () => {
    const assets = await fetchQuoteAssets({ fetchImpl: stubFetch({ items: WIRE }) });
    const mon = getQuoteAsset(assets, "mon");

    expect(mon).toBeDefined();
    // `null` used to mean "not on the launchpad yet", which is a different statement and is no
    // longer true. The launch form has to send exactly this.
    expect(mon!.address).toBe("0x0000000000000000000000000000000000000000");
  });

  it("carries gold as xaut0 / XAUt0 / 6 decimals, not xaux / XAUx / 18", async () => {
    const assets = await fetchQuoteAssets({ fetchImpl: stubFetch({ items: WIRE }) });

    expect(getQuoteAsset(assets, "xaux")).toBeUndefined();

    const gold = getQuoteAsset(assets, "xaut0");
    expect(gold).toBeDefined();
    expect(gold!.symbol).toBe("XAUt0");
    // One token is one troy ounce. At 18 decimals a whole ounce reads as 1e12 ounces.
    expect(gold!.decimals).toBe(6);
    expect(gold!.address).toBe("0x01bff41798a0bcf287b996046ca68b395dbc1071");
  });

  it("has cbBTC, which the hand-written catalogue omitted entirely", async () => {
    const assets = await fetchQuoteAssets({ fetchImpl: stubFetch({ items: WIRE }) });
    const cbbtc = getQuoteAsset(assets, "cbbtc");

    expect(cbbtc).toBeDefined();
    expect(cbbtc!.symbol).toBe("cbBTC");
    expect(cbbtc!.decimals).toBe(8);
  });

  it("offers only a live asset at launch — a `soon` one reverts QuoteNotEnabled", async () => {
    const assets = await fetchQuoteAssets({ fetchImpl: stubFetch({ items: WIRE }) });

    expect(launchableQuoteAssets(assets).map((a) => a.id)).toEqual(["mon"]);
  });

  it("finds the native quote by its address, not by the id `mon`", () => {
    const assets = WIRE.map(quoteAssetFromWire);
    expect(nativeQuoteAsset(assets)?.symbol).toBe("MON");
  });

  it("does not invent a registry when the indexer is unreachable", async () => {
    await expect(
      fetchQuoteAssets({ fetchImpl: stubFetch({ error: "nope" }, 502) })
    ).rejects.toThrow(/502/);
  });
});
