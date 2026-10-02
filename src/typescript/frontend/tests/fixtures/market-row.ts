import type { MarketRow } from "../../src/lib/api/types";

/**
 * A complete `MarketRow`, typed as one.
 *
 * ## Why the annotation matters more than the values
 *
 * Every suite that touched a market row built its own partial literal and cast it. That compiles
 * forever: the service grew twenty columns — the generation, the quote asset and its decimals, the
 * launcher's metadata, the normalised caps — and not one fixture noticed, because a cast is a
 * promise the compiler is told to believe. The suite was also excluded from `tsconfig`, so nothing
 * checked the casts either.
 *
 * Typing this `MarketRow` is what makes the next column a compile error in the fixtures rather than
 * an `undefined` reaching a `BigInt()` at run time in whichever test happens to read it first.
 *
 * ## The numbers are a generation-1 MON market
 *
 * Deliberately, because that is the case whose scale is the easy one to get right by accident.
 * A suite asserting against a six-decimal quote at generation 2 is the one that catches a scale
 * defect — `overrides` is there so a test can ask for exactly that, and several do.
 */
export const MARKET_ROW: MarketRow = {
  market_address: "0xcurve",
  token_address: "0xtoken",
  symbol: "🐳",
  name: "🐳",
  symbol_key: "0xkey",
  creator: "0xcreator",
  quote_target: "1000000000000000000000",
  total_supply: "45000000000000000000000000",
  block_number: "1234",
  tx_hash: "0xtx",
  created_at: "2026-08-18T00:00:00.000Z",
  quote_raised: "500000000000000000000",
  last_price: "123456789012345678",
  volume_quote: "900000000000000000000",
  trade_count: 7,
  holders: 3,
  ready_to_graduate: false,
  pool_address: null,
  market_cap: "5000000000000000000000",
  ath_market_cap: "10000000000000000000000",
  volume_24h: "42000000000000000000",
  last_swap_at: null,
  // Generation 1: the emoji launchpad, MON-quoted, prices stored at `quote * 1e18 / base`.
  generation: 1,
  quote_asset: "0x0000000000000000000000000000000000000000",
  quote_decimals: 18,
  quote_symbol: "MON",
  quote_id: "mon",
  routing: null,
  routed_recipient: null,
  creator_tax_bps: 0,
  tax_recipient: null,
  // All null on a generation-1 market: there was nowhere on chain to put any of it.
  ticker: null,
  logo_uri: null,
  banner_uri: null,
  description: null,
  website: null,
  x: null,
  telegram: null,
  metadata_hash: null,
  market_cap_quote: "5000000000000000000000",
  market_cap_usd: null,
  volume_24h_quote: "42000000000000000000",
  volume_24h_usd: null,
  change_24h: null,
  trades_24h: 0,
  last_trade_at: null,
  ath_quote: "123456789012345678",
  ath_at: null,
};

/** The same row with a few columns changed, still typed as a whole row. */
export const marketRow = (overrides: Partial<MarketRow> = {}): MarketRow => ({
  ...MARKET_ROW,
  ...overrides,
});
