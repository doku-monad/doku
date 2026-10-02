import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/legacy.js";
import { SINK_BURN, SINK_REWARDS } from "../src/indexer/generations.js";
import {
  BURN_MAX_TX_COST_WEI,
  BURN_MIN_BALANCE_WEI,
  BURN_MIN_GAP_MS,
  MAX_INGEST_LAG_BLOCKS,
  MAX_STATUS_AGE_MS,
  SWEEP_GAS_PAD,
  type BurnChain,
  burnedRecently,
  burnWorth,
  findBurnMarkets,
  ingestIsCurrent,
  runBurnPass,
  startBurnJob,
  worthBurning,
} from "../src/indexer/processing/burn.js";
import { KeeperState, MAX_ATTEMPTS, MONAD_RESERVE_WEI } from "../src/indexer/processing/keeper.js";
import { memoryDb, seedMarket } from "./helpers.js";

/**
 * The burn pass's policy, against a chain it is told about.
 *
 * Every decision that sends a transaction — the day between burns, the dollar floor, what needs a
 * sweep and what does not, the reserve, the backoff — is exercised here with a fake hook and sink,
 * so a wrong decision costs nothing. The adapter's `burn` is one `simulateContract` +
 * `writeContract` like the other writes and is not repeated here.
 */

const KEEPER = "0x00000000000000000000000000000000000000ee" as const;
const MON = 10n ** 18n;
const TOKEN = 10n ** 18n;
const SWEEP_GAS = 260_000n;
const BURN_GAS = 90_000n;
const POOL = "0x0000000000000000000000000000000000009001" as const;
const NATIVE = "0x0000000000000000000000000000000000000000";
/** Half a MON per whole token, at generation 2's scale: `quote_raw * 1e36 / token_raw`. */
const HALF_MON = 5n * 10n ** 35n;
const T0 = Date.parse("2026-09-19T12:00:00Z");

function fakeChain(opts: {
  pending?: Record<string, bigint>;
  owed?: Record<string, bigint>;
  balance?: bigint;
  gasPrice?: bigint;
  failSweep?: Error | null;
  failBurn?: Error | null;
  sweepGas?: bigint;
  burnGas?: bigint;
} = {}) {
  const pending = new Map(Object.entries(opts.pending ?? {}));
  const owed = new Map(Object.entries(opts.owed ?? {}));
  /** Every write the pass sent, in order. */
  const calls: string[] = [];
  /** The gas LIMIT each write was sent with, in the same order as `calls`. */
  const limits: bigint[] = [];
  /** The fee per gas each write was told to SIGN with, in the same order as `calls`. */
  const fees: (bigint | undefined)[] = [];
  const burnedAmounts: bigint[] = [];
  let balance = opts.balance ?? 100n * MON;
  let gasPrice = opts.gasPrice ?? 100n * 10n ** 9n;
  const failSweep = opts.failSweep ?? null;
  let failBurn = opts.failBurn ?? null;
  let reads = 0;
  /** sink → the pool it pulls from. A sink has exactly one, fixed at construction. */
  const poolOf = new Map<string, string>();
  /** pool → what the HOOK says its sink is: `DokuHook.markets(id)`, written once by the graduator. */
  const registry = new Map<string, { registered: boolean; kind: number; sinkAddr: `0x${string}` }>();
  const failingSinks = new Set<string>();
  /** Writes that are BROADCAST, billed at the limit, and then fail: a revert on chain, or out of gas. */
  let billedSweepFailures = 0;
  let billedBurnFailures = 0;
  let sinkOfFailures = 0;
  let balanceFailures = 0;
  const chain: BurnChain = {
    address: KEEPER,
    balance: async () => {
      if (balanceFailures > 0) {
        balanceFailures -= 1;
        throw new Error("rpc: balance unavailable");
      }
      return balance;
    },
    feePerGas: async () => gasPrice,
    sinkOf: async (id) => {
      reads += 1;
      if (sinkOfFailures > 0) {
        sinkOfFailures -= 1;
        throw new Error("rpc: timeout");
      }
      return registry.get(id) ?? { registered: false, kind: 0, sinkAddr: "0x0000000000000000000000000000000000000000" };
    },
    pendingSink: async (id) => {
      reads += 1;
      return pending.get(id) ?? 0n;
    },
    owedSink: async (id) => {
      reads += 1;
      return owed.get(id) ?? 0n;
    },
    estimateSweep: async () => opts.sweepGas ?? SWEEP_GAS,
    sweep: async (id, gas, fee) => {
      if (failSweep) throw failSweep;
      if (billedSweepFailures > 0) {
        billedSweepFailures -= 1;
        calls.push(`sweep:${id}`);
        limits.push(gas);
        balance -= gas * gasPrice;
        throw new Error(`sweep(${id}) reverted in 0xdead`);
      }
      // The contract's own rule: a sweep with nothing accrued reverts, at the full limit.
      if ((pending.get(id) ?? 0n) === 0n) throw new Error("NothingToSweep");
      calls.push(`sweep:${id}`);
      limits.push(gas);
      fees.push(fee);
      balance -= gas * gasPrice;
      owed.set(id, (owed.get(id) ?? 0n) + (pending.get(id) ?? 0n));
      pending.set(id, 0n);
      return `0xsweep${calls.length}` as `0x${string}`;
    },
    estimateBurn: async () => opts.burnGas ?? BURN_GAS,
    burn: async (sink, gas, fee) => {
      if (failBurn) throw failBurn;
      if (billedBurnFailures > 0) {
        billedBurnFailures -= 1;
        calls.push(`burn:${sink}`);
        limits.push(gas);
        balance -= gas * gasPrice;
        throw new Error(`burn() on ${sink} reverted in 0xdead`);
      }
      if (failingSinks.has(sink)) throw new Error("burn reverted in simulation");
      const id = poolOf.get(sink) ?? "";
      if ((owed.get(id) ?? 0n) === 0n) throw new Error("NothingToBurn");
      calls.push(`burn:${sink}`);
      limits.push(gas);
      fees.push(fee);
      balance -= gas * gasPrice;
      burnedAmounts.push(owed.get(id) ?? 0n);
      owed.set(id, 0n);
      return `0xburn${calls.length}` as `0x${string}`;
    },
  };
  return {
    chain,
    calls,
    limits,
    fees,
    burnedAmounts,
    /** Wire a sink to its pool on both sides: the sink's own immutable, and the hook's registry. */
    bind: (sink: string, poolId: string, kind: number = SINK_BURN) => {
      poolOf.set(sink, poolId);
      registry.set(poolId, { registered: true, kind, sinkAddr: sink as `0x${string}` });
    },
    /** What the hook names as this pool's sink, when it is NOT what the database says. */
    hookSays: (poolId: string, sinkAddr: string, kind: number = SINK_BURN) =>
      registry.set(poolId, { registered: true, kind, sinkAddr: sinkAddr as `0x${string}` }),
    /** The hook answers with this sink address and kind, but says the pool is NOT registered. */
    unregistered: (poolId: string, sinkAddr: string) =>
      registry.set(poolId, { registered: false, kind: SINK_BURN, sinkAddr: sinkAddr as `0x${string}` }),
    breakSink: (sink: string) => failingSinks.add(sink),
    billSweepThenFail: (times: number) => (billedSweepFailures = times),
    billBurnThenFail: (times: number) => (billedBurnFailures = times),
    failSinkOf: (times: number) => (sinkOfFailures = times),
    failBalance: (times: number) => (balanceFailures = times),
    setGasPrice: (p: bigint) => (gasPrice = p),
    accrue: (id: string, amount: bigint) => pending.set(id, (pending.get(id) ?? 0n) + amount),
    reads: () => reads,
    healBurn: () => (failBurn = null),
  };
}

/** A graduated market with a sink, a pool id, a last price and a priced quote. */
async function graduate(
  db: Db,
  market: string,
  opts: {
    sink?: string;
    sinkKind?: number;
    poolId?: string;
    lastPrice?: bigint;
    usdPrice?: number | null;
    quote?: string;
    quoteDecimals?: number;
  } = {},
): Promise<{ sink: string; poolId: string }> {
  const sink = opts.sink ?? `${market}-sink`;
  const poolId = opts.poolId ?? `${market}-pid`;
  await seedMarket(db, market, `${market}-token`, 100);
  const quote = opts.quote ?? NATIVE;
  await db.query(
    "UPDATE markets SET generation = 2, quote_asset = $2, quote_decimals = $3 WHERE market_address = $1",
    [market, quote, opts.quoteDecimals ?? 18],
  );
  await db.query("UPDATE market_state SET last_price = $2 WHERE market_address = $1", [
    market,
    (opts.lastPrice ?? HALF_MON).toString(),
  ]);
  await db.query(
    `INSERT INTO graduations (market_address, pool_address, pool_id, sink, sink_kind, token_id,
                              quote_amount, base_amount, liquidity, block_number, block_hash,
                              log_index, tx_hash, ts)
     VALUES ($1,$2,$3,$4,$5,7,0,0,0,101,'0xbb',0,$6,NOW())`,
    [market, POOL, poolId, sink, opts.sinkKind ?? SINK_BURN, `0xgtx-${market}`],
  );
  if (opts.usdPrice !== null) {
    await db.query(
      `INSERT INTO quote_assets (id, address, symbol, decimals, usd_price)
       VALUES ($1, $2, 'Q', $3, $4)
       ON CONFLICT (id) DO UPDATE SET usd_price = EXCLUDED.usd_price`,
      [`q-${quote}`, quote, opts.quoteDecimals ?? 18, opts.usdPrice ?? 1],
    );
  }
  return { sink, poolId };
}

/** The ingest loop's own record of where it is, as of `at`: `lag` blocks behind a head of 1,000,000. */
async function ingestStatus(db: Db, at: number, lag = 2n): Promise<void> {
  await db.query(
    `INSERT INTO indexer_status (id, last_block, chain_head, updated_at) VALUES (1, $1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET last_block = EXCLUDED.last_block, chain_head = EXCLUDED.chain_head,
                                    updated_at = EXCLUDED.updated_at`,
    [(1_000_000n - lag).toString(), "1000000", new Date(at).toISOString()],
  );
}

/** A `Burned` the indexer ingested for this market at `at`, as `gen2/sinks.ts` writes it. */
async function ingestedBurn(db: Db, market: string, at: number, n = 0): Promise<void> {
  await db.query(
    `INSERT INTO fee_events (market_address, kind, recipient, quote_asset, amount, venue,
                             block_number, block_hash, log_index, tx_hash, ts)
     VALUES ($1,'burn',NULL,$2,1,'sink',200,'0xcc',$3,$4,$5)`,
    [market, `${market}-token`, n, `0xburned-${market}-${n}`, new Date(at).toISOString()],
  );
}

describe("what a burn is worth", () => {
  it("values tokens in the quote at the stored price, quote_raw × 1e36 / token_raw", () => {
    expect(burnWorth(1_000n * TOKEN, HALF_MON)).toBe(500n * MON);
    expect(burnWorth(0n, HALF_MON)).toBe(0n);
    expect(burnWorth(1_000n * TOKEN, 0n)).toBe(0n);
  });

  it("holds on a quote that is not eighteen decimals", () => {
    // One raw unit of an 8-decimal quote per whole token.
    const price = 10n ** 18n;
    expect(burnWorth(250n * TOKEN, price)).toBe(250n);
  });

  it("reproduces the live TB1 figure measured on 2026-09-19", () => {
    // 748,666.9 TB1 pending at last_price 1.839e29 is 0.1377 MON — read from mainnet, not derived.
    expect(burnWorth(748666905480200719571993n, 183921093688965072142895292862n)).toBe(137695636064651554n);
  });

  const priced = (usdPrice: number | null) => ({ lastPrice: HALF_MON, quoteDecimals: 18, usdPrice });

  it("burns at the floor, not under it, and never an unpriced quote while a floor is set", () => {
    // 1,000 tokens at half a MON, MON at a cent: five dollars exactly.
    expect(worthBurning(1_000n * TOKEN, priced(0.01), 5)).toBe(true);
    expect(worthBurning(999n * TOKEN, priced(0.01), 5)).toBe(false);
    expect(worthBurning(10n ** 12n * TOKEN, priced(null), 5)).toBe(false);
  });

  it("reads a floor of zero as no floor: any amount, priced or not, even one that rounds to no quote", () => {
    expect(burnWorth(1n, HALF_MON)).toBe(0n);
    expect(worthBurning(1n, priced(null), 0)).toBe(true);
  });

  it("never calls nothing worth burning, whatever the floor", () => {
    expect(worthBurning(0n, priced(1), 0)).toBe(false);
    expect(worthBurning(0n, priced(1), 5)).toBe(false);
  });
});

describe("which markets have something to burn", () => {
  let db: Db;
  beforeEach(async () => {
    db = await memoryDb();
  });

  it("names every graduated BURN market with its sink, pool, price and quote", async () => {
    await graduate(db, "0xm1", { usdPrice: 0.025 });
    const found = await findBurnMarkets(db);
    expect(found).toEqual([
      {
        market: "0xm1",
        sink: "0xm1-sink",
        poolId: "0xm1-pid",
        lastPrice: HALF_MON,
        quoteDecimals: 18,
        usdPrice: 0.025,
        lastBurnAt: null,
      },
    ]);
  });

  it("leaves out dividend markets, markets still on the curve, and half-written graduations", async () => {
    await graduate(db, "0xrewards", { sinkKind: SINK_REWARDS });
    await seedMarket(db, "0xcurve", "0xcurve-token", 100);
    await db.query("UPDATE markets SET generation = 2 WHERE market_address = '0xcurve'");
    await graduate(db, "0xnopool", { poolId: "" });
    await graduate(db, "0xnosink", { sink: "" });
    expect(await findBurnMarkets(db)).toEqual([]);
  });

  it("carries the newest ingested burn as the market's clock", async () => {
    await graduate(db, "0xm1");
    await ingestedBurn(db, "0xm1", T0 - 3 * 3_600_000, 0);
    await ingestedBurn(db, "0xm1", T0 - 1 * 3_600_000, 1);
    const [m] = await findBurnMarkets(db);
    expect(m!.lastBurnAt?.getTime()).toBe(T0 - 3_600_000);
  });

  it("keeps each market's clock its own: another market's burn is not this one's", async () => {
    await graduate(db, "0xm1");
    await graduate(db, "0xm2");
    await ingestedBurn(db, "0xm2", T0 - 60_000);
    const found = await findBurnMarkets(db);
    expect(found.find((m) => m.market === "0xm1")!.lastBurnAt).toBeNull();
    expect(found.find((m) => m.market === "0xm2")!.lastBurnAt?.getTime()).toBe(T0 - 60_000);
  });

  it("reports a quote with no price as unpriced rather than free", async () => {
    await graduate(db, "0xm1", { usdPrice: null });
    const [m] = await findBurnMarkets(db);
    expect(m!.usdPrice).toBeNull();
  });
});

describe("the day between burns", () => {
  it("is counted from the newer of the database's burn and this process's own", () => {
    expect(burnedRecently(null, null, T0)).toBe(false);
    expect(burnedRecently(new Date(T0 - BURN_MIN_GAP_MS + 1), null, T0)).toBe(true);
    expect(burnedRecently(new Date(T0 - BURN_MIN_GAP_MS), null, T0)).toBe(false);
    expect(burnedRecently(null, T0 - 1_000, T0)).toBe(true);
    expect(burnedRecently(new Date(T0 - 3 * BURN_MIN_GAP_MS), T0 - 1_000, T0)).toBe(true);
  });

  it("fails closed: a burn time it cannot read is a burn it assumes was recent", () => {
    expect(burnedRecently(new Date("not a date"), null, T0)).toBe(true);
    expect(burnedRecently(null, Number.NaN, T0)).toBe(true);
  });

  it("treats a burn stamped in the future as recent rather than as never", () => {
    expect(burnedRecently(new Date(T0 + 60_000), null, T0)).toBe(true);
  });
});

describe("a burn pass", () => {
  let db: Db;
  let state: KeeperState;
  const now = () => T0;
  const opts = { minUsd: 1 };

  beforeEach(async () => {
    db = await memoryDb();
    state = new KeeperState(KEEPER);
  });

  /** One pass with the ingest loop caught up as of the pass's own clock, which is production's normal state. */
  const pass: typeof runBurnPass = async (d, chain, st, o, clock = now) => {
    await ingestStatus(d, clock());
    return runBurnPass(d, chain, st, o, clock);
  };

  it("sweeps what the hook has accrued and then burns it, in that order", async () => {
    const { sink, poolId } = await graduate(db, "0xm1");
    const f = fakeChain({ pending: { [poolId]: 1_000n * TOKEN } });
    f.bind(sink, poolId);

    const r = await pass(db, f.chain, state, opts, now);

    expect(f.calls).toEqual([`sweep:${poolId}`, `burn:${sink}`]);
    expect(f.burnedAmounts).toEqual([1_000n * TOKEN]);
    expect(r).toEqual({ behind: false, low: false, candidates: 1, swept: [sink], burned: [sink], skipped: [], failed: [] });
    expect(state.snapshot().burns).toBe(1);
    expect(state.snapshot().lastBurnTx).toBe("0xburn2");
  });

  it("sends the sweep with room for the legs a swap can add between the estimate and inclusion", async () => {
    // Measured on a fork of mainnet: an estimate of 153,250 needed 208,074 once a maker leg had
    // landed and the treasury had been pulled — 1.36x, more than the usual quarter. Out of gas on
    // Monad is billed in full, so the sweep's limit is (estimate + pad) x 1.25; the burn's is not
    // padded, because nothing a stranger does changes what `burn()` costs.
    const { sink, poolId } = await graduate(db, "0xm1");
    const f = fakeChain({ pending: { [poolId]: 1_000n * TOKEN } });
    f.bind(sink, poolId);

    await pass(db, f.chain, state, opts, now);

    const padded = SWEEP_GAS + SWEEP_GAS_PAD;
    expect(f.limits).toEqual([padded + padded / 4n, BURN_GAS + BURN_GAS / 4n]);
    expect(Number(f.limits[0]) / Number(SWEEP_GAS)).toBeGreaterThan(1.4);
  });

  it("burns without sweeping when somebody else already swept", async () => {
    const { sink, poolId } = await graduate(db, "0xm1");
    const f = fakeChain({ owed: { [poolId]: 1_000n * TOKEN } });
    f.bind(sink, poolId);

    await pass(db, f.chain, state, opts, now);

    expect(f.calls).toEqual([`burn:${sink}`]);
  });

  it("does not sweep when what somebody else swept already clears the floor: the rest waits a day", async () => {
    // Nothing this process did: no sweep clock is running, so only the floor rule can hold it back.
    const { sink, poolId } = await graduate(db, "0xm1", { usdPrice: 1 });
    const f = fakeChain({ owed: { [poolId]: 1_000n * TOKEN }, pending: { [poolId]: 500n * TOKEN } });
    f.bind(sink, poolId);

    await pass(db, f.chain, state, opts, now);

    expect(f.calls).toEqual([`burn:${sink}`]);
    expect(f.burnedAmounts).toEqual([1_000n * TOKEN]);
  });

  it("holds the burn itself to the same ceiling as the sweep", async () => {
    const { sink, poolId } = await graduate(db, "0xm1");
    const f = fakeChain({ owed: { [poolId]: 1_000n * TOKEN } });
    f.bind(sink, poolId);
    f.setGasPrice(BURN_MAX_TX_COST_WEI / (BURN_GAS + BURN_GAS / 4n) + 1n);

    const r = await pass(db, f.chain, state, opts, now);

    expect(f.calls).toEqual([]);
    expect(r.skipped).toEqual([sink]);
    expect(r.failed).toEqual([]);
  });

  it("sends nothing when nothing has accrued", async () => {
    const { sink, poolId } = await graduate(db, "0xm1");
    const f = fakeChain();
    f.bind(sink, poolId);

    const r = await pass(db, f.chain, state, opts, now);

    expect(f.calls).toEqual([]);
    expect(r.skipped).toEqual([sink]);
    expect(state.snapshot().failed).toBe(0);
  });

  it("leaves dust to accrue: under the floor, no transaction", async () => {
    // 1 token at half a MON, MON at a dollar: fifty cents against a one dollar floor.
    const { sink, poolId } = await graduate(db, "0xm1", { usdPrice: 1 });
    const f = fakeChain({ pending: { [poolId]: 1n * TOKEN } });
    f.bind(sink, poolId);

    const r = await pass(db, f.chain, state, opts, now);

    expect(f.calls).toEqual([]);
    expect(r.skipped).toEqual([sink]);
  });

  it("values what is pending and what is already owed together", async () => {
    // Sixty cents pending and sixty owed: neither clears a dollar alone, the burn destroys both.
    const { sink, poolId } = await graduate(db, "0xm1", { usdPrice: 1 });
    const amount = (12n * TOKEN) / 10n;
    const f = fakeChain({ pending: { [poolId]: amount }, owed: { [poolId]: amount } });
    f.bind(sink, poolId);

    await pass(db, f.chain, state, opts, now);

    expect(f.burnedAmounts).toEqual([2n * amount]);
  });

  it("does not burn a market whose quote has no price while a floor is set", async () => {
    const { sink, poolId } = await graduate(db, "0xm1", { usdPrice: null });
    const f = fakeChain({ pending: { [poolId]: 10n ** 9n * TOKEN } });
    f.bind(sink, poolId);

    await pass(db, f.chain, state, opts, now);

    expect(f.calls).toEqual([]);
  });

  it("burns any amount when the floor is zero", async () => {
    const { sink, poolId } = await graduate(db, "0xm1", { usdPrice: null });
    const f = fakeChain({ pending: { [poolId]: 1n } });
    f.bind(sink, poolId);

    await pass(db, f.chain, state, { minUsd: 0 }, now);

    expect(f.calls).toEqual([`sweep:${poolId}`, `burn:${sink}`]);
  });

  it("leaves a market alone for a day after its last ingested burn, without reading the chain", async () => {
    const { sink, poolId } = await graduate(db, "0xm1");
    await ingestedBurn(db, "0xm1", T0 - BURN_MIN_GAP_MS + 60_000);
    const f = fakeChain({ pending: { [poolId]: 1_000n * TOKEN } });
    f.bind(sink, poolId);

    const r = await pass(db, f.chain, state, opts, now);

    expect(f.calls).toEqual([]);
    expect(f.reads()).toBe(0);
    expect(r.skipped).toEqual([sink]);
  });

  it("burns again once the day has passed", async () => {
    const { sink, poolId } = await graduate(db, "0xm1");
    await ingestedBurn(db, "0xm1", T0 - BURN_MIN_GAP_MS);
    const f = fakeChain({ pending: { [poolId]: 1_000n * TOKEN } });
    f.bind(sink, poolId);

    await pass(db, f.chain, state, opts, now);

    expect(f.calls).toEqual([`sweep:${poolId}`, `burn:${sink}`]);
  });

  it("remembers its own burn before the indexer has ingested it", async () => {
    const { sink, poolId } = await graduate(db, "0xm1");
    const f = fakeChain({ pending: { [poolId]: 1_000n * TOKEN } });
    f.bind(sink, poolId);
    await pass(db, f.chain, state, opts, now);
    f.accrue(poolId, 1_000n * TOKEN);

    // No `fee_events` row was written: the database still says this market has never burned.
    const r = await pass(db, f.chain, state, opts, () => T0 + 60_000);

    expect(f.calls).toHaveLength(2);
    expect(r.skipped).toEqual([sink]);
  });

  it("a fresh process takes the clock from the database, so a redeploy is not a burn", async () => {
    const { sink, poolId } = await graduate(db, "0xm1");
    const f = fakeChain({ pending: { [poolId]: 1_000n * TOKEN } });
    f.bind(sink, poolId);
    await pass(db, f.chain, state, opts, now);
    await ingestedBurn(db, "0xm1", T0);
    f.accrue(poolId, 1_000n * TOKEN);

    await pass(db, f.chain, new KeeperState(KEEPER), opts, () => T0 + 3_600_000);

    expect(f.calls).toHaveLength(2);
  });

  it("stops burning altogether under its own balance floor, long before the reserve: burns never starve a graduation", async () => {
    const { sink, poolId } = await graduate(db, "0xm1");
    const f = fakeChain({ pending: { [poolId]: 1_000n * TOKEN }, balance: BURN_MIN_BALANCE_WEI - 1n });
    f.bind(sink, poolId);

    const r = await pass(db, f.chain, state, opts, now);

    expect(BURN_MIN_BALANCE_WEI).toBeGreaterThan(MONAD_RESERVE_WEI);
    expect(f.calls).toEqual([]);
    expect(f.reads()).toBe(0);
    expect(r.low).toBe(true);
    expect(state.snapshot().lastError).toMatch(/burn/i);
    expect(state.due(sink, T0)).toBe(true);
  });

  it("burns at the floor exactly", async () => {
    const { sink, poolId } = await graduate(db, "0xm1");
    const f = fakeChain({ owed: { [poolId]: 1_000n * TOKEN }, balance: BURN_MIN_BALANCE_WEI });
    f.bind(sink, poolId);

    expect((await pass(db, f.chain, state, opts, now)).burned).toEqual([sink]);
  });

  it("signs each write at the very fee its ceiling and reserve were priced at, never a second estimate", async () => {
    const { sink, poolId } = await graduate(db, "0xm1");
    const f = fakeChain({ pending: { [poolId]: 1_000n * TOKEN }, gasPrice: 123n * 10n ** 9n });
    f.bind(sink, poolId);

    await pass(db, f.chain, state, opts, now);

    expect(f.calls).toEqual([`sweep:${poolId}`, `burn:${sink}`]);
    expect(f.fees).toEqual([123n * 10n ** 9n, 123n * 10n ** 9n]);
  });

  it("keeps an RPC address, and any key inside it, out of what /status shows", async () => {
    const { sink, poolId } = await graduate(db, "0xm1");
    const f = fakeChain({
      owed: { [poolId]: 1_000n * TOKEN },
      failBurn: new Error("HTTP request failed. URL: https://monad-mainnet.example.com/v2/s3cr3t-k3y Details: timeout"),
    });
    f.bind(sink, poolId);

    await pass(db, f.chain, state, opts, now);

    const shown = JSON.stringify(state.snapshot());
    expect(shown).not.toContain("s3cr3t-k3y");
    expect(shown).not.toContain("example.com");
    expect(state.snapshot().lastError).toMatch(/HTTP request failed/);
  });

  it("finishes a burn whose sweep landed on an earlier pass — the next day, and without sweeping again", async () => {
    const { sink, poolId } = await graduate(db, "0xm1");
    const f = fakeChain({ pending: { [poolId]: 1_000n * TOKEN }, failBurn: new Error("rpc dropped") });
    f.bind(sink, poolId);

    const first = await pass(db, f.chain, state, opts, now);
    expect(first.failed).toEqual([sink]);
    expect(f.calls).toEqual([`sweep:${poolId}`]);

    // An hour later the burn would work. It is not tried: from here the policy cannot tell a send
    // that failed for free from one that was billed, so a failed attempt is the day's attempt. The
    // cost of being wrong in this direction is a day's delay on tokens already out of circulation.
    f.healBurn();
    f.accrue(poolId, 500n * TOKEN);
    const sameDay = await pass(db, f.chain, state, opts, () => T0 + 60 * 60_000);
    expect(sameDay.skipped).toEqual([sink]);
    expect(f.calls).toEqual([`sweep:${poolId}`]);

    // The next day: what is already owed clears the floor by itself, so it is a burn and nothing
    // else; the new accrual waits for its own sweep.
    const nextDay = await pass(db, f.chain, state, opts, () => T0 + BURN_MIN_GAP_MS);
    expect(f.calls).toEqual([`sweep:${poolId}`, `burn:${sink}`]);
    expect(f.burnedAmounts).toEqual([1_000n * TOKEN]);
    expect(nextDay.burned).toEqual([sink]);
  });

  it("sweeps a market once inside the day, however often its burn fails and whatever the price does", async () => {
    const { sink, poolId } = await graduate(db, "0xm1", { usdPrice: 1 });
    const f = fakeChain({ pending: { [poolId]: 1_000n * TOKEN } });
    f.bind(sink, poolId);
    f.breakSink(sink);
    await pass(db, f.chain, state, opts, now);
    expect(f.calls).toEqual([`sweep:${poolId}`]);

    // The price collapses, so what is owed no longer clears the floor alone; more accrues, so the
    // two together do. Without its own clock the pass would buy a second sweep here, and a third.
    await db.query("UPDATE market_state SET last_price = $2 WHERE market_address = $1", [
      "0xm1",
      (HALF_MON / 1_000n).toString(),
    ]);
    f.accrue(poolId, 10n ** 7n * TOKEN);
    const r = await pass(db, f.chain, state, opts, () => T0 + 60 * 60_000);

    // One sweep, still. And what that sweep left owed is now under the floor, so no burn is sent
    // for it either: the hundred-dollar rule holds for the burn that is actually sent.
    expect(f.calls).toEqual([`sweep:${poolId}`]);
    expect(r.skipped).toEqual([sink]);
    expect(r.failed).toEqual([]);
  });

  it("burns only at the sink the hook itself names, and refuses when the database disagrees", async () => {
    const { sink, poolId } = await graduate(db, "0xm1");
    const f = fakeChain({ pending: { [poolId]: 1_000n * TOKEN } });
    f.bind(sink, poolId);
    f.hookSays(poolId, "0x00000000000000000000000000000000000bad00");

    const r = await pass(db, f.chain, state, opts, now);

    expect(f.calls).toEqual([]);
    expect(r.failed).toEqual([sink]);
    expect(state.snapshot().lastError).toMatch(/hook names .*bad00/i);
  });

  it("refuses a pool the hook has not registered, or registered with a sink that is not BURN", async () => {
    const a = await graduate(db, "0xunregistered");
    const b = await graduate(db, "0xrewards");
    const f = fakeChain({ pending: { [a.poolId]: 1_000n * TOKEN, [b.poolId]: 1_000n * TOKEN } });
    f.bind(b.sink, b.poolId, SINK_REWARDS);

    const r = await pass(db, f.chain, state, opts, now);

    expect(f.calls).toEqual([]);
    expect([...r.failed].sort()).toEqual([a.sink, b.sink].sort());
  });

  it("refuses on 'not registered' alone, even when the address and the kind both agree", async () => {
    const { sink, poolId } = await graduate(db, "0xm1");
    const f = fakeChain({ pending: { [poolId]: 1_000n * TOKEN } });
    f.bind(sink, poolId);
    f.unregistered(poolId, sink);

    const r = await pass(db, f.chain, state, opts, now);

    expect(f.calls).toEqual([]);
    expect(r.failed).toEqual([sink]);
    expect(state.snapshot().lastError).toMatch(/no registered pool/);
  });

  it("matches the hook's sink whatever the case either side writes the address in", async () => {
    const { poolId } = await graduate(db, "0xm1", { sink: "0x00000000000000000000000000000000000abc01" });
    const f = fakeChain({ pending: { [poolId]: 1_000n * TOKEN } });
    f.bind("0x00000000000000000000000000000000000ABC01", poolId);

    const r = await pass(db, f.chain, state, opts, now);

    expect(r.burned).toHaveLength(1);
  });

  it("will not pay more than the ceiling for one transaction when gas spikes, and that is not a failure", async () => {
    const { sink, poolId } = await graduate(db, "0xm1");
    const f = fakeChain({ pending: { [poolId]: 1_000n * TOKEN } });
    f.bind(sink, poolId);
    const padded = SWEEP_GAS + SWEEP_GAS_PAD;
    const limit = padded + padded / 4n;
    f.setGasPrice(BURN_MAX_TX_COST_WEI / limit + 1n);

    const r = await pass(db, f.chain, state, opts, now);

    expect(f.calls).toEqual([]);
    expect(r.skipped).toEqual([sink]);
    expect(r.failed).toEqual([]);
    expect(state.due(sink, T0)).toBe(true);

    // And when gas is back to a price worth paying, the same market burns.
    f.setGasPrice(100n * 10n ** 9n);
    const later = await pass(db, f.chain, state, opts, now);
    expect(later.burned).toEqual([sink]);
  });

  it("will not pay for a transaction whose gas has been inflated past the ceiling", async () => {
    const { sink, poolId } = await graduate(db, "0xm1");
    const f = fakeChain({ pending: { [poolId]: 1_000n * TOKEN }, sweepGas: 25_000_000n });
    f.bind(sink, poolId);

    const r = await pass(db, f.chain, state, opts, now);

    expect(f.calls).toEqual([]);
    expect(r.skipped).toEqual([sink]);
  });

  it("backs off a sink that keeps failing, gives up at the limit, and still burns the next market", async () => {
    const bad = await graduate(db, "0xbad");
    const good = await graduate(db, "0xgood");
    const f = fakeChain({ pending: { [bad.poolId]: 1_000n * TOKEN, [good.poolId]: 1_000n * TOKEN } });
    f.bind(good.sink, good.poolId);
    f.bind(bad.sink, bad.poolId);
    // Only the bad sink's burn fails, every time, in simulation.
    f.breakSink(bad.sink);

    let t = T0;
    const first = await pass(db, f.chain, state, opts, () => t);
    expect(first.failed).toEqual([bad.sink]);
    expect(first.burned).toEqual([good.sink]);

    // Inside the backoff window the sink is not retried.
    const inside = await pass(db, f.chain, state, opts, () => t + 1_000);
    expect(inside.failed).toEqual([]);

    for (let i = 1; i < MAX_ATTEMPTS; i += 1) {
      t += 24 * 60 * 60_000;
      await pass(db, f.chain, state, opts, () => t);
    }
    expect(state.gaveUp(bad.sink)).toBe(true);
    expect(state.snapshot().givenUp).toBe(1);

    t += 24 * 60 * 60_000;
    const after = await pass(db, f.chain, state, opts, () => t);
    expect(after.failed).toEqual([]);
    expect(after.skipped).toContain(bad.sink);
  });

  const HALF_HOUR = 30 * 60_000;

  it("a sweep that is billed and fails is the day's sweep: six passes at the job's cadence buy one, not six", async () => {
    const { sink, poolId } = await graduate(db, "0xm1");
    const f = fakeChain({ pending: { [poolId]: 1_000n * TOKEN } });
    f.bind(sink, poolId);
    f.billSweepThenFail(99);

    for (let i = 0; i < 6; i += 1) await pass(db, f.chain, state, opts, () => T0 + i * HALF_HOUR);

    expect(f.calls).toEqual([`sweep:${poolId}`]);
  });

  it("a burn that is billed and fails is the day's burn, and a restart buys at most one more", async () => {
    const { sink, poolId } = await graduate(db, "0xm1");
    const f = fakeChain({ owed: { [poolId]: 1_000n * TOKEN } });
    f.bind(sink, poolId);
    f.billBurnThenFail(99);

    for (let i = 0; i < 6; i += 1) await pass(db, f.chain, state, opts, () => T0 + i * HALF_HOUR);
    expect(f.calls).toEqual([`burn:${sink}`]);

    const restarted = new KeeperState(KEEPER);
    for (let i = 6; i < 12; i += 1) await pass(db, f.chain, restarted, opts, () => T0 + i * HALF_HOUR);
    expect(f.calls).toEqual([`burn:${sink}`, `burn:${sink}`]);
  });

  it("counts a burn that landed even when the balance cannot be read afterwards, and does not send it again", async () => {
    const { sink, poolId } = await graduate(db, "0xm1");
    const f = fakeChain({ owed: { [poolId]: 1_000n * TOKEN } });
    f.bind(sink, poolId);
    await ingestStatus(db, T0);
    // The pass reads the balance once at the top; the second read is the one after the send.
    const balance = f.chain.balance;
    let n = 0;
    f.chain.balance = async () => {
      n += 1;
      if (n === 2) throw new Error("rpc: balance unavailable");
      return balance();
    };

    const r = await runBurnPass(db, f.chain, state, opts, now);

    expect(r.burned).toEqual([sink]);
    expect(r.failed).toEqual([]);
    expect(state.snapshot().burns).toBe(1);
    f.accrue(poolId, 1_000n * TOKEN);
    await pass(db, f.chain, state, opts, () => T0 + HALF_HOUR);
    expect(f.calls).toEqual([`burn:${sink}`]);
  });

  it("forgets a transient failure once a pass reads the market cleanly: six unrelated hiccups are not six strikes", async () => {
    const { sink, poolId } = await graduate(db, "0xm1", { usdPrice: 1 });
    const f = fakeChain({ pending: { [poolId]: 1n * TOKEN } }); // fifty cents: healthy, and under the floor
    f.bind(sink, poolId);
    const DAY = 24 * 60 * 60_000;

    for (let d = 0; d < MAX_ATTEMPTS + 2; d += 1) {
      f.failSinkOf(1);
      await pass(db, f.chain, state, opts, () => T0 + d * DAY);
      await pass(db, f.chain, state, opts, () => T0 + d * DAY + HALF_HOUR);
    }
    expect(state.gaveUp(sink)).toBe(false);

    f.accrue(poolId, 1_000n * TOKEN);
    const r = await pass(db, f.chain, state, opts, () => T0 + 30 * DAY);
    expect(r.burned).toEqual([sink]);
  });

  it("says so when a sweep was sent and the burn then refused: swept, and not burned", async () => {
    const { sink, poolId } = await graduate(db, "0xm1");
    const f = fakeChain({ pending: { [poolId]: 1_000n * TOKEN }, burnGas: 25_000_000n });
    f.bind(sink, poolId);

    const r = await pass(db, f.chain, state, opts, now);

    expect(f.calls).toEqual([`sweep:${poolId}`]);
    expect(r).toEqual({ behind: false, low: false, candidates: 1, swept: [sink], burned: [], skipped: [sink], failed: [] });
  });

  it("does nothing at all while the database is behind the chain: its clock cannot be trusted", async () => {
    const { sink, poolId } = await graduate(db, "0xm1");
    const f = fakeChain({ pending: { [poolId]: 1_000n * TOKEN } });
    f.bind(sink, poolId);
    await ingestStatus(db, T0, MAX_INGEST_LAG_BLOCKS + 1n);

    const r = await runBurnPass(db, f.chain, state, opts, now);

    expect(r.behind).toBe(true);
    expect(f.calls).toEqual([]);
    expect(f.reads()).toBe(0);
  });

  it("does nothing while the ingest loop has not reported for too long, or has never reported", async () => {
    const { sink, poolId } = await graduate(db, "0xm1");
    const f = fakeChain({ pending: { [poolId]: 1_000n * TOKEN } });
    f.bind(sink, poolId);

    expect((await runBurnPass(db, f.chain, state, opts, now)).behind).toBe(true);
    await ingestStatus(db, T0 - MAX_STATUS_AGE_MS - 1);
    expect((await runBurnPass(db, f.chain, state, opts, now)).behind).toBe(true);
    expect(f.calls).toEqual([]);

    await ingestStatus(db, T0 - MAX_STATUS_AGE_MS);
    expect((await runBurnPass(db, f.chain, state, opts, now)).burned).toEqual([sink]);
  });
});

describe("whether the database can be trusted as a clock", () => {
  const at = (lag: bigint, ageMs: number) => ({
    lastBlock: 1_000_000n - lag,
    chainHead: 1_000_000n,
    updatedAt: new Date(T0 - ageMs),
  });

  it("is current within the lag and the age, and not a block or a millisecond past either", () => {
    expect(ingestIsCurrent(at(0n, 0), T0)).toBe(true);
    expect(ingestIsCurrent(at(MAX_INGEST_LAG_BLOCKS, MAX_STATUS_AGE_MS), T0)).toBe(true);
    expect(ingestIsCurrent(at(MAX_INGEST_LAG_BLOCKS + 1n, 0), T0)).toBe(false);
    expect(ingestIsCurrent(at(0n, MAX_STATUS_AGE_MS + 1), T0)).toBe(false);
  });

  it("fails closed on no row, an unreadable time, and a head it has never seen", () => {
    expect(ingestIsCurrent(null, T0)).toBe(false);
    expect(ingestIsCurrent({ ...at(0n, 0), updatedAt: new Date("nope") }, T0)).toBe(false);
    expect(ingestIsCurrent({ lastBlock: 0n, chainHead: 0n, updatedAt: new Date(T0) }, T0)).toBe(false);
  });
});

describe("the burn job", () => {
  it("does not run at boot, when the database is least likely to be current, and carries its floor into every pass", async () => {
    const db = await memoryDb();
    const state = new KeeperState(KEEPER);
    const { sink, poolId } = await graduate(db, "0xm1", { usdPrice: 1 });
    const f = fakeChain({ pending: { [poolId]: 100n * TOKEN } }); // fifty dollars
    f.bind(sink, poolId);
    await ingestStatus(db, Date.now());
    const errors: unknown[] = [];

    const job = startBurnJob(db, f.chain, state, { minUsd: 100 }, (e) => errors.push(e), 3_600_000);
    try {
      await new Promise((r) => setTimeout(r, 50));
      expect(f.reads()).toBe(0);

      await job.runNow();
      expect(f.reads()).toBeGreaterThan(0);
      expect(f.calls).toEqual([]); // fifty dollars against a hundred dollar floor

      f.accrue(poolId, 100n * TOKEN); // a hundred dollars
      await ingestStatus(db, Date.now());
      await job.runNow();
      expect(f.calls).toEqual([`sweep:${poolId}`, `burn:${sink}`]);
      expect(errors).toEqual([]);
    } finally {
      job.stop();
    }
  });
});
