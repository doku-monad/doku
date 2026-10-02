/**
 * The indexer, serving invented markets.
 *
 * Local development without Foundry: no anvil, no contracts, no ingest loop — but the real schema,
 * the real repositories and the real HTTP application, so what the frontend receives is shaped by
 * the same code that shapes it against a chain. A hand-written mock server would agree with the
 * client right up until a column's cast changed.
 *
 *     cd indexer && npx tsx scripts/dev-seed.ts
 *
 * Everything below is derived rather than asserted. Prices come from the curve's own formula, the
 * candles are folded by the indexer's `updateCandles`, and market cap, all-time high and rolling
 * 24-hour volume are computed by the same SQL the API always runs. The numbers are invented; the
 * arithmetic between them is not.
 */
import { serve } from "@hono/node-server";

import { createApi } from "../src/app/index.js";
import { createDatabase } from "../src/db/index.js";
import type { Db } from "../src/db/legacy.js";
import { updateCandles } from "../src/indexer/processing/derive.js";
import {
  recordFeeEvent,
  refreshCreatorBalance,
  refreshMarketRewards,
  splitFee,
} from "../src/indexer/processing/fees.js";
import { rebuildMarketStats } from "../src/indexer/processing/stats.js";
import {
  GEN2_BASE_VIRTUAL_CEILING,
  GEN2_CURVE_SUPPLY,
  GEN2_TOTAL_SUPPLY,
  NATIVE_QUOTE,
  SINK_BURN,
  SINK_CREATOR,
  SINK_REWARDS,
} from "../src/indexer/generations.js";
import { ensureQuoteCatalog } from "../src/quotes/catalog.js";
import { createLogger } from "../src/utils/logger.js";
import { createLiveFeed } from "../src/websocket/live.js";

const PORT = Number(process.env.PORT ?? 3010);
const CHAIN_ID = Number(process.env.MONAD_CHAIN_ID ?? 10143);

/** `LocalScenario`'s target and `DokuToken.TOTAL_SUPPLY`, so the figures match a real deployment. */
const TARGET_MON = 1_000;
const TOTAL_SUPPLY = 45_000_000n * 10n ** 18n;

/** The curve's virtual reserves. See `BondingCurve.sol`. */
const BASE_CEILING = 49_000_000;
const CURVE_SUPPLY = 35_000_000;

const WAD = 10n ** 18n;
const HOUR = 3_600_000;

/** Seeded, so two runs produce the same site. A different site every restart is not a fixture. */
let seed = 0x5eed_d0c0;
const rnd = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x1_0000_0000;
};
const between = (lo: number, hi: number): number => lo + rnd() * (hi - lo);

/** MON to base units, keeping six decimals — more than any figure on the page displays. */
const mon = (value: number): bigint => BigInt(Math.round(value * 1e6)) * 10n ** 12n;

/** A deterministic address, spread by an odd multiplier so consecutive ones do not look adjacent. */
const address = (n: number): string =>
  "0x" + ((BigInt(n) * 0x9e3779b97f4a7c15n) % (1n << 160n)).toString(16).padStart(40, "0");

const hash = (n: number): string =>
  "0x" + ((BigInt(n) * 0xc2b2ae3d27d4eb4fn) % (1n << 256n)).toString(16).padStart(64, "0");

/**
 * The curve's price at a given amount raised, in MON per whole token.
 *
 * Virtual quote over virtual base, as `BondingCurve` computes it: quote runs from 0.4x the target
 * to 1.4x, base from 49M down to 14M. A market at its target therefore prices at 1e-4 MON, which
 * is a ~4,500 MON cap on 45M tokens — the figure a graduated market shows.
 */
const priceAt = (raisedMon: number): number => {
  const sold = CURVE_SUPPLY * (raisedMon / TARGET_MON);
  return (0.4 * TARGET_MON + raisedMon) / (BASE_CEILING - sold);
};

/** The same price as the 18-decimal fixed point the schema stores. */
const priceWad = (raisedMon: number): bigint => mon(priceAt(raisedMon));

interface Seed {
  symbol: string;
  name: string;
  /** How far along its curve, 0 to 1. A graduated market is 1 by definition. */
  progress: number;
  graduated?: boolean;
  /** Hours since launch. Older markets have more history behind them. */
  ageHours: number;
}

/**
 * Fourteen markets, chosen to cover the states the UI renders differently: freshly launched and
 * nearly empty, mid-curve, ready to graduate, and graduated onto a pool. Fourteen identical
 * markets would look fine and prove nothing.
 */
const SEEDS: Seed[] = [
  { symbol: "🚀", name: "rocket", progress: 1, graduated: true, ageHours: 140 },
  { symbol: "🐳", name: "whale", progress: 1, graduated: true, ageHours: 96 },
  { symbol: "🔥", name: "fire", progress: 0.993, ageHours: 61 },
  { symbol: "🌙💎", name: "moon diamond", progress: 0.871, ageHours: 52 },
  { symbol: "🐸", name: "frog", progress: 0.742, ageHours: 44 },
  { symbol: "⚡", name: "zap", progress: 0.615, ageHours: 38 },
  { symbol: "🧠", name: "brain", progress: 0.508, ageHours: 33 },
  { symbol: "🍜", name: "ramen", progress: 0.417, ageHours: 27 },
  { symbol: "👾", name: "invader", progress: 0.331, ageHours: 21 },
  { symbol: "🦊", name: "fox", progress: 0.244, ageHours: 16 },
  { symbol: "🌊", name: "wave", progress: 0.168, ageHours: 11 },
  { symbol: "🍄", name: "mushroom", progress: 0.094, ageHours: 7 },
  { symbol: "🎩", name: "top hat", progress: 0.041, ageHours: 3 },
  { symbol: "🐙", name: "octopus", progress: 0.006, ageHours: 1 },
];

async function seedMarket(db: Db, index: number, spec: Seed, now: number): Promise<void> {
  const market = address(index * 7 + 11);
  const token = address(index * 7 + 12);
  const creator = address(index * 7 + 13);
  const pool = spec.graduated ? address(index * 7 + 14) : null;
  const launchedAt = new Date(now - spec.ageHours * HOUR);
  const block = 1_000_000 + index * 5_000;

  await db.query(
    `INSERT INTO markets (market_address, token_address, symbol, name, symbol_key, creator,
                          quote_target, total_supply, block_number, block_hash, log_index,
                          tx_hash, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12)`,
    [
      market,
      token,
      spec.symbol,
      spec.name,
      hash(index * 31 + 7),
      creator,
      mon(TARGET_MON).toString(),
      TOTAL_SUPPLY.toString(),
      block,
      hash(block),
      hash(index * 97 + 3),
      launchedAt,
    ],
  );

  /**
   * The trades, walked rather than sampled.
   *
   * `quote_raised` on a swap is the curve's total *after* that trade, so the walk has to be
   * continuous: each amount is the step it took, and each price is the curve's price where that
   * step landed. Independent random rows would give a trade feed whose own running total
   * contradicts the market it belongs to.
   */
  const finalRaised = TARGET_MON * spec.progress;
  const trades = Math.max(6, Math.round(finalRaised / between(6, 22)));
  let raised = 0;
  let lastPrice = priceWad(0);
  let volume = 0n;
  let count = 0;
  let logIndex = 0;

  for (let k = 0; k < trades; k++) {
    // Sells pull the curve back down, and a market without any reads as a straight line.
    const isBuy = rnd() > 0.24 || raised <= 0;
    const remaining = finalRaised - raised;
    const step = isBuy
      ? Math.min(remaining + between(0, 4), between(0.4, 2.4) * (finalRaised / trades) * 2)
      : -Math.min(raised, between(0.2, 1.1) * (finalRaised / trades));
    const next = Math.max(0, raised + step);
    const amount = Math.abs(next - raised);
    if (amount <= 0) continue;

    const ts = new Date(
      launchedAt.getTime() + ((k + 1) / (trades + 1)) * (now - launchedAt.getTime()),
    );
    const priceHere = priceWad((raised + next) / 2);
    const quote = mon(amount);
    const base = (quote * WAD) / priceHere;

    /* The anti-sniper tax decays to nothing over the first five minutes, and is never taken on a
       sell. Tax on every row would make the decay impossible to check by eye. */
    const minutesIn = (ts.getTime() - launchedAt.getTime()) / 60_000;
    const taxRate = isBuy && minutesIn < 5 ? 0.05 * (1 - minutesIn / 5) : 0;

    await db.query(
      `INSERT INTO swaps (market_address, trader, is_buy, venue, quote_amount, base_amount,
                          fee, tax, quote_raised, price, block_number, block_hash, log_index,
                          tx_hash, ts)
       VALUES ($1,$2,$3,'curve',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        market,
        address(index * 1_000 + (k % 17) + 500),
        isBuy,
        quote.toString(),
        base.toString(),
        (quote / 100n).toString(),
        mon(amount * taxRate).toString(),
        mon(next).toString(),
        priceHere.toString(),
        block + k + 1,
        hash(block + k + 1),
        logIndex++,
        hash(index * 10_000 + k + 1),
        ts,
      ],
    );
    await updateCandles(db, market, ts, priceHere.toString(), quote);

    raised = next;
    lastPrice = priceHere;
    volume += quote;
    count++;
  }

  /**
   * A graduated market keeps trading, on its pool.
   *
   * Recorded with `venue = 'pool'` because the fee and tax columns mean different things there —
   * and because a feed that stops dead at graduation looks like an indexer that stopped.
   */
  if (pool) {
    const gradAt = new Date(launchedAt.getTime() + 0.6 * (now - launchedAt.getTime()));
    await db.query(
      `INSERT INTO graduations (market_address, pool_address, token_id, quote_amount, base_amount,
                                liquidity, block_number, block_hash, log_index, tx_hash, ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10)`,
      [
        market,
        pool,
        (index + 1).toString(),
        mon(TARGET_MON).toString(),
        (10_000_000n * WAD).toString(),
        (2_000_000n * WAD).toString(),
        block + trades + 2,
        hash(block + trades + 2),
        hash(index * 10_000 + 9_000),
        gradAt,
      ],
    );

    // Drift in both directions afterwards, so the chart does not flatline at the handover.
    let poolPrice = priceAt(TARGET_MON);
    for (let k = 0; k < 26; k++) {
      const isBuy = rnd() > 0.45;
      poolPrice *= 1 + between(-0.035, 0.045);
      const amount = between(0.5, 14);
      const ts = new Date(gradAt.getTime() + ((k + 1) / 27) * (now - gradAt.getTime()));
      const quote = mon(amount);
      const priceHere = mon(poolPrice);
      await db.query(
        `INSERT INTO swaps (market_address, trader, is_buy, venue, quote_amount, base_amount,
                            fee, tax, quote_raised, price, block_number, block_hash, log_index,
                            tx_hash, ts)
         VALUES ($1,$2,$3,'pool',$4,$5,$6,0,$7,$8,$9,$10,$11,$12,$13)`,
        [
          market,
          address(index * 1_000 + (k % 13) + 700),
          isBuy,
          quote.toString(),
          ((quote * WAD) / priceHere).toString(),
          (quote / 100n).toString(),
          mon(TARGET_MON).toString(),
          priceHere.toString(),
          block + trades + 3 + k,
          hash(block + trades + 3 + k),
          logIndex++,
          hash(index * 10_000 + 20_000 + k),
          ts,
        ],
      );
      await updateCandles(db, market, ts, priceHere.toString(), quote);
      lastPrice = priceHere;
      volume += quote;
      count++;
    }
    raised = TARGET_MON;
  }

  /**
   * Holders.
   *
   * The curve — or the pool, once graduated — holds the unsold remainder, and the API excludes it
   * from the holder list by address. It is written here rather than left out, so that exclusion is
   * exercised rather than assumed.
   */
  const holderCount = Math.max(3, Math.round(between(4, 26) * (0.3 + spec.progress)));
  let distributed = 0n;
  for (let k = 0; k < holderCount; k++) {
    const balance = BigInt(Math.round(between(1_000, 900_000))) * WAD;
    distributed += balance;
    await db.query(
      `INSERT INTO token_balances (token_address, holder, balance) VALUES ($1,$2,$3)
       ON CONFLICT (token_address, holder) DO UPDATE SET balance = EXCLUDED.balance`,
      [token, address(index * 1_000 + k + 500), balance.toString()],
    );
  }
  await db.query(`INSERT INTO token_balances (token_address, holder, balance) VALUES ($1,$2,$3)`, [
    token,
    pool ?? market,
    (TOTAL_SUPPLY - distributed).toString(),
  ]);

  await db.query(
    /* No `tax_escrow`: the column was removed with the mechanism it described — the anti-sniper
       tax is spent as it accrues rather than held aside — and this INSERT still named it, so the
       seed could not write its first market. */
    `INSERT INTO market_state (market_address, quote_raised, last_price, volume_quote,
                               trade_count, holders, ready_to_graduate, pool_address, ready_block,
                               block_number)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      market,
      mon(raised).toString(),
      lastPrice.toString(),
      volume.toString(),
      count,
      holderCount,
      spec.progress >= 0.99 && !pool,
      pool,
      spec.progress >= 0.99 && !pool ? block + trades : null,
      block + trades + 30,
    ],
  );
}

/* ------------------------------------------------------------------ generation 2: DOKU Pairs */

/**
 * The registry's targets, taken from `contracts/script/LocalScenario.s.sol` rather than invented.
 *
 * `TARGET = 1_000e18` and `USDC_TARGET = 10_000e6`. The plan asked for 1e18 and 8e9 here, which is
 * one MON and eight thousand dollars — a one-MON target makes every MON market in this seed read as
 * graduated on its first trade, and neither figure is what a market on the chain would be launched
 * with. A dev seed whose targets disagree with the deployment script teaches the frontend the wrong
 * order of magnitude for a progress bar.
 */
const GEN2_TARGET_MON = 1_000n * WAD;
const GEN2_TARGET_USDC = 10_000n * 10n ** 6n;

/** The catalogue's USDC (`src/quotes/catalog.ts`), so `/quotes` and `/markets?pair=usdc` agree. */
const USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603";

/** One PoolManager holds every v4 pool, so a graduated market's `pool_address` is this singleton. */
const POOL_MANAGER = address(9_001);
const HOOK2 = address(9_002);
const REWARD_VAULT = address(9_003);

const BPS = 10_000n;
/** `FEE_BPS` from the shared interface: one percent of every curve trade. */
const FEE_BPS = 100n;

/**
 * The generation-2 curve's post-trade spot price, at the scale the contract emits it.
 *
 * `BondingCurve._price` returns `quoteVirtual * 1e36 / baseVirtual` — a further 1e18 beyond
 * generation 1 — precisely so a six-decimal quote against a 1e27 base reserve does not truncate to
 * a handful of raw units. Computing it here in the same units the chain uses is what makes the
 * seeded market caps land where the contracts would put them: `priceScaleSql` divides gen-2 prices
 * by 1e36, and a price written at 1e18 would read as a market a quintillion times too cheap.
 */
const gen2Price = (raised: bigint, target: bigint): bigint => {
  const sold = (GEN2_CURVE_SUPPLY * raised) / target;
  const quoteVirtual = (target * 4n) / 10n + raised;
  return (quoteVirtual * 10n ** 36n) / (GEN2_BASE_VIRTUAL_CEILING - sold);
};

interface Gen2Seed {
  ticker: string;
  name: string;
  /** `Sinks.sol` kind: BURN, REWARDS or CREATOR. One market of each, because they behave apart. */
  routing: number;
  quote: "mon" | "usdc";
  /** The creator's own tax, in basis points. Only a CREATOR market charges one. */
  taxBps: bigint;
  progress: number;
  ageHours: number;
  graduated?: boolean;
  logo?: string;
  description: string;
}

/**
 * Three markets, one per routing, because the three are not variations on a theme.
 *
 * CREATOR pays a named recipient and is the only one with a creator tax; REWARDS escrows the routed
 * share until graduation and then funds a vault; BURN spends it on the curve as it accrues and has
 * nothing pending, ever. A seed with three CREATOR markets would render identically and prove none
 * of that.
 */
const GEN2_SEEDS: Gen2Seed[] = [
  {
    ticker: "MOON",
    name: "Crescent Moon",
    routing: SINK_CREATOR,
    quote: "usdc",
    taxBps: 250n,
    progress: 0.62,
    ageHours: 30,
    logo: "ipfs://bafyseedlogo",
    description: "A dollar-quoted launch that pays its creator 2.5% of every trade.",
  },
  {
    ticker: "HODL",
    name: "Diamond Hands",
    routing: SINK_REWARDS,
    quote: "mon",
    taxBps: 0n,
    progress: 1,
    ageHours: 72,
    graduated: true,
    description: "Routed fees escrow in MON until graduation, then fund the holder vault.",
  },
  {
    ticker: "BRNT",
    name: "Burnt Offering",
    routing: SINK_BURN,
    quote: "mon",
    taxBps: 0n,
    progress: 0.28,
    ageHours: 14,
    description: "Routed fees buy the token back and burn it as they accrue. Nothing pends.",
  },
];

/**
 * One generation-2 market, its trades, and the ledger rows those trades imply.
 *
 * Every fee row goes through `recordFeeEvent` rather than a hand-written INSERT, and the totals
 * come from `refreshMarketRewards` afterwards, so the seeded `market_rewards` is the projection the
 * ingester would have produced from the same events. Writing the totals directly would let the seed
 * agree with a frontend the ingester disagrees with.
 */
async function seedGen2Market(db: Db, index: number, spec: Gen2Seed, now: number): Promise<void> {
  const n = 500 + index * 7;
  const market = address(n + 1);
  const token = address(n + 2);
  const creator = address(n + 3);
  const launchedAt = new Date(now - spec.ageHours * HOUR);
  const block = 2_000_000 + index * 5_000;
  const quoteAsset = spec.quote === "usdc" ? USDC : NATIVE_QUOTE;
  const quoteDecimals = spec.quote === "usdc" ? 6 : 18;
  const target = spec.quote === "usdc" ? GEN2_TARGET_USDC : GEN2_TARGET_MON;
  // Only a CREATOR market names a recipient for the routed share; on the other two the routed
  // basis points go to a sink contract, and a recipient column would name a person who is owed
  // nothing.
  const routedRecipient = spec.routing === SINK_CREATOR ? creator : null;
  const taxRecipient = spec.taxBps > 0n ? creator : null;

  await db.query(
    `INSERT INTO markets (market_address, token_address, symbol, name, symbol_key, creator,
                          quote_target, total_supply, generation, quote_asset, quote_decimals,
                          routing, routed_recipient, creator_tax_bps, tax_recipient, ticker,
                          logo_uri, description, website, x, telegram, metadata_hash,
                          block_number, block_hash, log_index, tx_hash, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,2,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NULL,$20,
             $21,$22,0,$23,$24)`,
    [
      market,
      token,
      spec.ticker,
      spec.name,
      `gen2-${spec.ticker.toLowerCase()}`,
      creator,
      target.toString(),
      GEN2_TOTAL_SUPPLY.toString(),
      quoteAsset,
      quoteDecimals,
      spec.routing,
      routedRecipient,
      Number(spec.taxBps),
      taxRecipient,
      spec.ticker,
      spec.logo ?? null,
      spec.description,
      `https://doku.family/${spec.ticker.toLowerCase()}`,
      `https://x.com/${spec.ticker.toLowerCase()}`,
      hash(n + 40),
      block,
      hash(block),
      hash(n + 41),
      launchedAt,
    ],
  );

  // The `MetadataSet` this market's columns came from. The columns are the current answer; this row
  // is the history, and the detail page's "edited" marker reads the count rather than the columns.
  await db.query(
    `INSERT INTO metadata_updates (market_address, name, ticker, logo_uri, banner_uri, description,
                                   website, x, telegram, metadata_hash, block_number, block_hash,
                                   log_index, tx_hash, ts)
     VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,NULL,$8,$9,$10,1,$11,$12)`,
    [
      market,
      spec.name,
      spec.ticker,
      spec.logo ?? null,
      spec.description,
      `https://doku.family/${spec.ticker.toLowerCase()}`,
      `https://x.com/${spec.ticker.toLowerCase()}`,
      hash(n + 40),
      block,
      hash(block),
      hash(n + 42),
      launchedAt,
    ],
  );

  const finalRaised = (target * BigInt(Math.round(spec.progress * 10_000))) / 10_000n;
  const trades = 18;
  let raised = 0n;
  let lastPrice = gen2Price(0n, target);
  let volume = 0n;
  let count = 0;
  let logIndex = 0;
  let routedTotal = 0n;
  let taxTotal = 0n;

  for (let k = 0; k < trades; k++) {
    const isBuy = rnd() > 0.25 || raised === 0n;
    const stepUp = finalRaised / BigInt(trades - 3);
    const next = isBuy
      ? raised + stepUp > finalRaised
        ? finalRaised
        : raised + stepUp
      : raised - stepUp / 3n;
    if (next === raised) continue;
    const quote = next > raised ? next - raised : raised - next;
    const ts = new Date(
      launchedAt.getTime() + ((k + 1) / (trades + 1)) * (now - launchedAt.getTime()),
    );
    const price = gen2Price((raised + next) / 2n, target);
    // Base out at the price the trade landed at, in the 1e36 convention: `quote * 1e36 / price`.
    const baseAmt = (quote * 10n ** 36n) / price;
    const fee = (quote * FEE_BPS) / BPS;
    const creatorTax = (quote * spec.taxBps) / BPS;
    const { protocol, routed } = splitFee(fee);
    const base = { block: String(block + k + 1), hash: hash(block + k + 1), idx: logIndex++, tx: hash(n * 100 + k) };

    await db.query(
      `INSERT INTO swaps (market_address, trader, is_buy, venue, quote_amount, base_amount, fee,
                          tax, creator_tax, quote_raised, price, block_number, block_hash,
                          log_index, tx_hash, ts)
       VALUES ($1,$2,$3,'curve',$4,$5,$6,0,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        market,
        address(n * 10 + (k % 11) + 3_000),
        isBuy,
        quote.toString(),
        baseAmt.toString(),
        fee.toString(),
        creatorTax.toString(),
        next.toString(),
        price.toString(),
        base.block,
        base.hash,
        base.idx,
        base.tx,
        ts,
      ],
    );
    await updateCandles(db, market, ts, price.toString(), quote);

    const common = { market, quoteAsset, venue: "curve" as const, ...base, ts };
    await recordFeeEvent(db, { ...common, kind: "protocol", recipient: null, amount: protocol });
    await recordFeeEvent(db, {
      ...common,
      kind: "routed",
      recipient: routedRecipient,
      amount: routed,
    });
    if (creatorTax > 0n) {
      await recordFeeEvent(db, {
        ...common,
        kind: "tax",
        recipient: taxRecipient,
        amount: creatorTax,
      });
    }
    routedTotal += routed;
    taxTotal += creatorTax;

    raised = next;
    lastPrice = price;
    volume += quote;
    count++;
  }

  /**
   * BURN spends the routed share on the curve the moment it accrues, so it has nothing pending.
   *
   * Recorded as a `routed_collected` of the whole routed total rather than by omitting the `routed`
   * rows: the fees WERE generated, and a market whose lifetime routed figure read zero would be
   * telling the rewards page that a burn market never earned anything.
   */
  if (spec.routing === SINK_BURN && routedTotal > 0n) {
    await recordFeeEvent(db, {
      market,
      kind: "routed_collected",
      recipient: null,
      quoteAsset,
      amount: routedTotal,
      venue: "sink",
      block: String(block + trades + 1),
      hash: hash(block + trades + 1),
      idx: logIndex++,
      tx: hash(n * 100 + 90),
      ts: new Date(now - HOUR),
    });
  }

  /**
   * A graduated REWARDS market: the escrow is swept into the vault at graduation.
   *
   * BOTH halves of that move are recorded, because two different logs report it and the rewards
   * page reads them as different lines: `routed_collected` is the money leaving the curve — which
   * is what takes `pending` to zero — and `dividend_funded` is the same money arriving in the vault
   * holders claim from. Writing only the second would leave a graduated market reporting the whole
   * escrow as still pending on a curve that no longer holds it.
   */
  if (spec.graduated) {
    const gradAt = new Date(launchedAt.getTime() + 0.7 * (now - launchedAt.getTime()));
    await db.query(
      `INSERT INTO graduations (market_address, pool_address, pool_id, currency0, currency1, fee,
                                tick_spacing, hooks, sink, sink_kind, quote_asset, token_id,
                                quote_amount, base_amount, liquidity, block_number, block_hash,
                                log_index, tx_hash, ts)
       VALUES ($1,$2,$3,$4,$5,3000,60,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,0,$16,$17)`,
      [
        market,
        POOL_MANAGER,
        hash(n + 70),
        // Native MON sorts below every token address, so it is currency0 on this pool.
        NATIVE_QUOTE,
        token,
        HOOK2,
        REWARD_VAULT,
        spec.routing,
        quoteAsset,
        (index + 1).toString(),
        target.toString(),
        (GEN2_TOTAL_SUPPLY - GEN2_CURVE_SUPPLY).toString(),
        (2_000_000n * WAD).toString(),
        block + trades + 2,
        hash(block + trades + 2),
        hash(n * 100 + 91),
        gradAt,
      ],
    );
    if (routedTotal > 0n) {
      await recordFeeEvent(db, {
        market,
        kind: "routed_collected",
        recipient: null,
        quoteAsset,
        amount: routedTotal,
        venue: "sink",
        block: String(block + trades + 3),
        hash: hash(block + trades + 3),
        idx: logIndex++,
        tx: hash(n * 100 + 92),
        ts: gradAt,
      });
      await recordFeeEvent(db, {
        market,
        kind: "dividend_funded",
        recipient: null,
        quoteAsset,
        amount: routedTotal,
        venue: "sink",
        block: String(block + trades + 3),
        hash: hash(block + trades + 3),
        idx: logIndex++,
        tx: hash(n * 100 + 92),
        ts: gradAt,
      });
    }
  }

  /**
   * A `FeesCollected` on the CREATOR market: the routed share is pulled to the sink and credited.
   *
   * Half of it, so the rewards page has both a collected figure and a pending one — a market where
   * pending is always zero cannot show that pending and collected are different questions.
   */
  if (spec.routing === SINK_CREATOR && routedTotal > 0n) {
    const pulled = routedTotal / 2n;
    const pulledTax = taxTotal / 2n;
    const collectedAt = new Date(now - 2 * HOUR);
    const base = {
      block: String(block + trades + 4),
      hash: hash(block + trades + 4),
      tx: hash(n * 100 + 93),
      ts: collectedAt,
    };
    await recordFeeEvent(db, {
      market,
      kind: "routed_collected",
      recipient: routedRecipient,
      quoteAsset,
      amount: pulled,
      venue: "sink",
      idx: logIndex++,
      ...base,
    });
    await recordFeeEvent(db, {
      market,
      kind: "tax_collected",
      recipient: taxRecipient,
      quoteAsset,
      amount: pulledTax,
      venue: "sink",
      idx: logIndex++,
      ...base,
    });
    /**
     * The creator ledger, in the two kinds a collection on an UNGRADUATED market can produce.
     *
     * `collectFees` and `collectTax` push to the recipient in the same transaction, and
     * `collections.ts` records each successful push as a `pushed` row — lifetime earnings, with
     * nothing left to claim. When the push fails the curve falls back to crediting the shared sink
     * (`BondingCurve._payOrCredit`), which the sink announces as `Credited` and the handler records
     * as a `credited` row: claimable, and not yet earned, because the money is still sitting in the
     * sink waiting for a `claim`.
     *
     * One of each here on purpose. A seed where every collection succeeded would leave
     * `creator_balances.claimable` zero on every row, and the claim button on the creator page
     * would never be rendered against a number.
     */
    const ledger = async (kind: string, claimable: bigint, earned: bigint, idx: number) =>
      db.query(
        `INSERT INTO creator_ledger (who, quote_asset, market_address, kind, claimable_delta,
                                     earned_delta, block_number, block_hash, log_index, tx_hash, ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          creator,
          quoteAsset,
          market,
          kind,
          claimable.toString(),
          earned.toString(),
          base.block,
          base.hash,
          idx,
          base.tx,
          collectedAt,
        ],
      );
    await ledger("pushed", 0n, pulled, logIndex++);
    await ledger("credited", pulledTax, 0n, logIndex++);
  }

  // Holders, and the curve holding the unsold remainder — the same exclusion the gen-1 seed proves.
  const holderCount = 12;
  let distributed = 0n;
  for (let k = 0; k < holderCount; k++) {
    const balance = BigInt(Math.round(between(200_000, 9_000_000))) * WAD;
    distributed += balance;
    await db.query(
      `INSERT INTO token_balances (token_address, holder, balance) VALUES ($1,$2,$3)
       ON CONFLICT (token_address, holder) DO UPDATE SET balance = EXCLUDED.balance`,
      [token, address(n * 10 + k + 3_000), balance.toString()],
    );
  }
  await db.query(`INSERT INTO token_balances (token_address, holder, balance) VALUES ($1,$2,$3)`, [
    token,
    spec.graduated ? POOL_MANAGER : market,
    (GEN2_TOTAL_SUPPLY - distributed).toString(),
  ]);

  await db.query(
    `INSERT INTO market_state (market_address, quote_raised, last_price, volume_quote,
                               trade_count, holders, ready_to_graduate, pool_address, block_number)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      market,
      raised.toString(),
      lastPrice.toString(),
      volume.toString(),
      count,
      holderCount,
      spec.progress >= 0.99 && !spec.graduated,
      spec.graduated ? POOL_MANAGER : null,
      block + trades + 30,
    ],
  );
}

/**
 * The generation-2 half of the seed.
 *
 * `ensureQuoteCatalog` first, because the presentational columns are what `/quotes` renders and the
 * on-chain columns below only make sense written over them. MON and USDC are then marked registered
 * and enabled with the targets `LocalScenario.s.sol` deploys, and given a USD price — without one
 * the board falls back to whole quote units and orders a dollar market against a MON market as if
 * the two were the same size.
 */
async function seedGen2(db: Db, now: number): Promise<void> {
  await ensureQuoteCatalog(db);
  await db.query(
    `UPDATE quote_assets SET registered = TRUE, enabled = TRUE, quote_target = $2,
                             usd_price = $3, usd_price_at = NOW(), block_number = 2000000
      WHERE id = $1`,
    ["mon", GEN2_TARGET_MON.toString(), 2.5],
  );
  await db.query(
    `UPDATE quote_assets SET registered = TRUE, enabled = TRUE, quote_target = $2,
                             usd_price = $3, usd_price_at = NOW(), block_number = 2000000
      WHERE id = $1`,
    ["usdc", GEN2_TARGET_USDC.toString(), 1],
  );

  for (const [index, spec] of GEN2_SEEDS.entries()) await seedGen2Market(db, index, spec, now);

  // The projections, rebuilt from the rows above by the same functions the ingester calls.
  await refreshMarketRewards(db, null);
  await refreshCreatorBalance(db, null, null);
  await rebuildMarketStats(db);
}

async function main(): Promise<void> {
  const log = createLogger();
  const database = createDatabase({ url: process.env.DATABASE_URL });
  await database.connect();
  const db = database.legacy;

  const now = Date.now();
  for (const [index, spec] of SEEDS.entries()) await seedMarket(db, index, spec, now);
  await seedGen2(db, now);

  /* Checkpointed at the present, so `/health` reports a live indexer rather than one stopped at
     the epoch — the badge would otherwise read "stale" over perfectly good data. */
  const head = 1_000_000 + SEEDS.length * 5_000 + 60;
  await db.query(
    `UPDATE indexer_status SET last_block = $1, last_block_hash = $2, chain_head = $1,
                               updated_at = NOW() WHERE id = 1`,
    [head, hash(head)],
  );

  const counts = await db.query<{ markets: string; swaps: string }>(
    "SELECT (SELECT COUNT(*) FROM markets) AS markets, (SELECT COUNT(*) FROM swaps) AS swaps",
  );
  log.info("seeded", {
    markets: Number(counts.rows[0]?.markets ?? 0),
    swaps: Number(counts.rows[0]?.swaps ?? 0),
  });

  const server = serve({
    fetch: createApi(database, { chainId: CHAIN_ID, uploadsToken: process.env.UPLOADS_TOKEN }).fetch,
    port: PORT,
    hostname: "0.0.0.0",
  });
  createLiveFeed(server as unknown as import("node:http").Server, {
    log: log.child({ component: "live-feed" }),
  });
  log.info("listening", { port: PORT, live: "/live", chainId: CHAIN_ID });

  const stop = (): void => {
    server.close(() => void database.disconnect().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((err: unknown) => {
  createLogger().error("dev seed failed", { error: err });
  process.exit(1);
});
