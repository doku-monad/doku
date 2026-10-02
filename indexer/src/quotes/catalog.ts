import type { Db } from "../db/legacy.js";
import { createLogger } from "../utils/logger.js";
import { NATIVE_QUOTE } from "../indexer/generations.js";

const log = createLogger().child({ component: "quote-catalog" });

/**
 * What the UI shows about a quote asset, which the chain does not carry.
 *
 * Mirrors `src/lib/assets/quote-assets.ts` in the frontend, row for row, so `/quotes` can replace
 * that constant without changing a chip. `address` is only set where a legitimate asset exists on
 * Monad mainnet (spec Appendix B); the counterfeit "NVDAX"/"AAPLX" contracts are never listed.
 */
export interface CatalogRow {
  id: string;
  symbol: string;
  name: string;
  kind: "native" | "stablecoin" | "crypto" | "stock" | "rwa";
  decimals: number;
  address: string | null;
  blurb: string;
  underlying?: string;
  iconDomain?: string;
}

export const QUOTE_CATALOG: CatalogRow[] = [
  {
    id: "mon",
    symbol: "MON",
    name: "Monad",
    kind: "native",
    decimals: 18,
    address: NATIVE_QUOTE,
    blurb: "The chain's native asset — the default quote on DOKU",
    iconDomain: "monad.xyz",
  },
  {
    id: "usdc",
    symbol: "USDC",
    name: "USD Coin",
    kind: "stablecoin",
    decimals: 6,
    address: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
    blurb: "Dollar-denominated launches, so a coin's price is a price and not a MON ratio",
    iconDomain: "circle.com",
  },
  {
    id: "usdt",
    symbol: "USDT0",
    name: "Tether USD",
    kind: "stablecoin",
    decimals: 6,
    address: "0xe7cd86e13ac4309349f30b3435a9d337750fc82d",
    blurb: "The second dollar rail, for desks that settle in it",
    iconDomain: "tether.to",
  },
  {
    id: "weth",
    symbol: "WETH",
    name: "Wrapped Ether",
    kind: "crypto",
    decimals: 18,
    address: "0xee8c0e9f1bffb4eb878d8f15f368a02a35481242",
    blurb: "Pair against ETH for coins whose thesis is ETH",
    iconDomain: "ethereum.org",
  },
  {
    id: "wbtc",
    symbol: "WBTC",
    name: "Wrapped Bitcoin",
    kind: "crypto",
    decimals: 8,
    address: "0x0555e30da8f98308edb960aa94c0db47230d2b9c",
    blurb: "The hard-money quote",
    iconDomain: "bitcoin.org",
  },
  {
    id: "cbbtc",
    symbol: "cbBTC",
    name: "Coinbase Wrapped BTC",
    kind: "crypto",
    decimals: 8,
    address: "0xd18b7ec58cdf4876f6afebd3ed1730e4ce10414b",
    blurb: "The other bitcoin rail on Monad",
    iconDomain: "coinbase.com",
  },
  {
    id: "nvdax",
    symbol: "NVDAx",
    name: "NVIDIA Corporation",
    kind: "stock",
    decimals: 18,
    address: null,
    underlying: "NVDA",
    blurb: "Tokenized NVIDIA exposure as the quote side of a launch",
    iconDomain: "nvidia.com",
  },
  {
    id: "aaplx",
    symbol: "AAPLx",
    name: "Apple Inc.",
    kind: "stock",
    decimals: 18,
    address: null,
    underlying: "AAPL",
    blurb: "Tokenized Apple exposure as the quote side of a launch",
    iconDomain: "apple.com",
  },
  {
    id: "tslax",
    symbol: "TSLAx",
    name: "Tesla, Inc.",
    kind: "stock",
    decimals: 18,
    address: null,
    underlying: "TSLA",
    blurb: "Tokenized Tesla exposure as the quote side of a launch",
    iconDomain: "tesla.com",
  },
  {
    id: "googlx",
    symbol: "GOOGLx",
    name: "Alphabet Inc.",
    kind: "stock",
    decimals: 18,
    address: null,
    underlying: "GOOGL",
    blurb: "Tokenized Alphabet exposure as the quote side of a launch",
    iconDomain: "google.com",
  },
  {
    id: "spyx",
    symbol: "SPYx",
    name: "S&P 500 Index",
    kind: "stock",
    decimals: 18,
    address: null,
    underlying: "SPY",
    blurb: "Broad-market exposure, for a coin that wants to trade against the index",
    iconDomain: "spglobal.com",
  },
  {
    id: "tbillx",
    symbol: "TBILLx",
    name: "US Treasury Bills",
    kind: "rwa",
    decimals: 18,
    address: null,
    underlying: "1-3 month T-bills",
    blurb: "A yield-bearing quote — the pair earns while it sits",
    iconDomain: "treasury.gov",
  },
  // Real, live, and the coarsest quote on the chain: ONE TOKEN IS ONE TROY OUNCE at SIX decimals,
  // so a dollar buys ~300 raw units against USDC's 1,000,000. The frontend catalogue calls this
  // `xaux` at 18 decimals, which is wrong on both counts — `decimals` here is presentational only;
  // `quote_assets.decimals` is overwritten by whatever `QuoteAssetRegistered` reports from the
  // token itself, and that is the number every amount is scaled by.
  {
    id: "xaut0",
    symbol: "XAUt0",
    name: "Tether Gold",
    kind: "rwa",
    decimals: 6,
    address: "0x01bff41798a0bcf287b996046ca68b395dbc1071",
    underlying: "XAU",
    blurb: "Gold, Just Pure Gold",
    iconDomain: "tether.to",
  },
];

/**
 * Seed the presentational columns. Runs on every boot; fills only what is NULL, so an admin's
 * edit through scripts/quote-admin.ts is never undone by a restart. On-chain columns
 * (registered/enabled/quote_target) are never touched here, and `decimals` is filled only while it
 * is still null — a registration reports what the token itself says and that always wins.
 */
export async function ensureQuoteCatalog(db: Db): Promise<void> {
  for (const [i, c] of QUOTE_CATALOG.entries()) {
    /**
     * Adopt a row the chain created before the catalogue knew this asset's name.
     *
     * `handleRegistryEvent` inserts an unlisted asset with its ADDRESS as the id. When the
     * catalogue later names that address, the insert below carries a different id for an address
     * that is UNIQUE — and its conflict target is `id`, so nothing catches the collision. The seed
     * throws, and it throws at BOOT, before the service serves anything.
     *
     * Renaming first turns that collision into the ordinary `ON CONFLICT (id)` update. Guarded on
     * `id = address` so it only ever claims a row the registry auto-created: an id an operator
     * chose is a deliberate name and is left alone, which leaves the insert to fail loudly rather
     * than silently reassigning somebody's asset.
     */
    if (c.address) {
      const { rows } = await db.query<{ id: string }>(
        "SELECT id FROM quote_assets WHERE address = $1",
        [c.address],
      );
      const held = rows[0]?.id;
      if (held !== undefined && held !== c.id) {
        if (held.toLowerCase() !== c.address.toLowerCase()) {
          /**
           * Somebody named this asset deliberately. Skipping costs only the presentational columns
           * — the row keeps its name, its target and its registered flag — where inserting would
           * throw and taking the id would rename an operator's asset behind their back.
           */
          log.warn("catalogue skipped: address already held under another id", {
            address: c.address,
            held,
            catalogue: c.id,
          });
          continue;
        }
        await db.query("UPDATE quote_assets SET id = $1 WHERE address = $2 AND id = $2", [
          c.id,
          c.address,
        ]);
      }
    }
    await db.query(
      `INSERT INTO quote_assets (id, address, symbol, name, kind, decimals, blurb, underlying, icon_domain, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         address     = COALESCE(quote_assets.address, EXCLUDED.address),
         symbol      = COALESCE(quote_assets.symbol, EXCLUDED.symbol),
         name        = COALESCE(quote_assets.name, EXCLUDED.name),
         kind        = COALESCE(quote_assets.kind, EXCLUDED.kind),
         decimals    = COALESCE(quote_assets.decimals, EXCLUDED.decimals),
         blurb       = COALESCE(quote_assets.blurb, EXCLUDED.blurb),
         underlying  = COALESCE(quote_assets.underlying, EXCLUDED.underlying),
         icon_domain = COALESCE(quote_assets.icon_domain, EXCLUDED.icon_domain)`,
      [
        c.id,
        c.address,
        c.symbol,
        c.name,
        c.kind,
        c.decimals,
        c.blurb,
        c.underlying ?? null,
        c.iconDomain ?? null,
        i,
      ],
    );
  }
}
