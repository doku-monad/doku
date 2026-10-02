import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/legacy.js";
import { SINK_BURN, SINK_CREATOR, SINK_REWARDS } from "../src/indexer/generations.js";
import {
  BACKOFF_BASE_MS,
  findRewardsMarkets,
  findStranded,
  type FundingChain,
  graduationGasLimit,
  type KeeperChain,
  KeeperState,
  MAX_ATTEMPTS,
  MONAD_RESERVE_WEI,
  runFundPass,
  runKeeperPass,
  withHeadroom,
} from "../src/indexer/processing/keeper.js";
import { memoryDb, seedMarket } from "./helpers.js";

/**
 * The keeper's policy, against a chain it is told about.
 *
 * Everything that decides whether a transaction is sent — the served cut, the on-chain
 * double-check, the reserve guard, the backoff — is exercised here with a fake, so a wrong
 * decision costs nothing. `keeper-anvil.test.ts` pays for one real transaction to prove the
 * adapter and the contract agree about what a stranded market is.
 */

const KEEPER = "0x00000000000000000000000000000000000000ee" as const;
const MON = 10n ** 18n;
const HINT = 2_500_000n;

type Call = { curve: string; gas: bigint };

/** A chain that answers what it is told and remembers what it was asked to send. */
function fakeChain(opts: {
  graduated?: Set<string>;
  notReady?: Set<string>;
  balance?: bigint;
  gasPrice?: bigint;
  fail?: (curve: string) => Error | null;
}) {
  const sent: Call[] = [];
  let balance = opts.balance ?? 20n * MON;
  const chain: KeeperChain = {
    address: KEEPER,
    graduated: async (c) => opts.graduated?.has(c) ?? false,
    ready: async (c) => !(opts.notReady?.has(c) ?? false),
    gasHint: async () => HINT,
    balance: async () => balance,
    gasPrice: async () => opts.gasPrice ?? 100n * 10n ** 9n,
    feePerGas: async () => opts.gasPrice ?? 100n * 10n ** 9n,
    graduate: async (curve, gas) => {
      const err = opts.fail?.(curve);
      if (err) throw err;
      sent.push({ curve, gas });
      balance -= gas * (opts.gasPrice ?? 100n * 10n ** 9n);
      opts.graduated?.add(curve);
      return `0xhash${sent.length}` as `0x${string}`;
    },
  };
  return { chain, sent, setBalance: (b: bigint) => (balance = b) };
}

async function strand(db: Db, market: string, block = 100, generation = 2): Promise<void> {
  await seedMarket(db, market, `${market}-token`, block);
  await db.query("UPDATE markets SET generation = $2 WHERE market_address = $1", [market, generation]);
  await db.query(
    "UPDATE market_state SET ready_to_graduate = TRUE, ready_block = $2 WHERE market_address = $1",
    [market, block + 1],
  );
}

describe("finding stranded markets", () => {
  let db: Db;
  beforeEach(async () => {
    db = await memoryDb();
    delete process.env.START_BLOCK;
  });

  it("names a served market that is ready and has no pool", async () => {
    await strand(db, "0xstranded");
    expect(await findStranded(db)).toEqual(["0xstranded"]);
  });

  it("ignores a market that is still bonding, and one that has a pool", async () => {
    await seedMarket(db, "0xbonding", "0xt1");
    await strand(db, "0xdone");
    await db.query("UPDATE market_state SET pool_address = '0xpm' WHERE market_address = '0xdone'");
    expect(await findStranded(db)).toEqual([]);
  });

  /**
   * The served cut. A retired generation's market may be stranded too, and it is not this
   * keeper's to touch: its graduator is a different contract, and this process is not pointed
   * at it. The cut is the same `START_BLOCK` every read makes.
   */
  it("does not reach past the served cut into a retired generation", async () => {
    await strand(db, "0xretired", 50);
    await strand(db, "0xserved", 150);
    process.env.START_BLOCK = "100";
    expect(await findStranded(db)).toEqual(["0xserved"]);
  });

  /** Generation 1 has no swallowed auto-graduation and a different graduator. */
  it("only considers pairs-style curves", async () => {
    await strand(db, "0xgen1", 100, 1);
    expect(await findStranded(db)).toEqual([]);
  });
});

describe("a keeper pass", () => {
  let db: Db;
  beforeEach(async () => {
    db = await memoryDb();
    delete process.env.START_BLOCK;
  });

  it("graduates a stranded market with the protocol's own gas hint plus a quarter", async () => {
    await strand(db, "0xstranded");
    const { chain, sent } = fakeChain({});
    const state = new KeeperState(KEEPER);
    const r = await runKeeperPass(db, chain, state);
    expect(r.graduated).toEqual(["0xstranded"]);
    expect(sent).toEqual([{ curve: "0xstranded", gas: graduationGasLimit(HINT) }]);
    expect(graduationGasLimit(HINT)).toBe(3_125_000n);
    expect(state.snapshot()).toMatchObject({ graduated: 1, failed: 0, lastTx: "0xhash1" });
  });

  /**
   * The race this must never lose. The database lags the chain by the confirmation window, so a
   * filling buy that DID graduate reads as stranded until its `Graduated` is ingested — and a
   * second graduation sent at it buys nothing but an `AlreadyGraduated` revert, billed in full.
   */
  it("sends nothing at a market the chain says has already graduated", async () => {
    await strand(db, "0xracing");
    const { chain, sent } = fakeChain({ graduated: new Set(["0xracing"]) });
    const r = await runKeeperPass(db, chain, new KeeperState(KEEPER));
    expect(sent).toEqual([]);
    expect(r.skipped).toEqual(["0xracing"]);
  });

  it("sends nothing at a market the chain no longer calls ready", async () => {
    await strand(db, "0xreorged");
    const { chain, sent } = fakeChain({ notReady: new Set(["0xreorged"]) });
    await runKeeperPass(db, chain, new KeeperState(KEEPER));
    expect(sent).toEqual([]);
  });

  /**
   * Monad refuses a transaction that would leave the sender below 10 MON, and bills the gas
   * limit either way. Refusing it here costs nothing and says why; sending it costs the limit and
   * says "reserve balance violation".
   */
  it("holds rather than dip under the reserve, and says so on the snapshot", async () => {
    await strand(db, "0xstranded");
    // 10.2 MON: the reserve plus less than one attempt at 3.125M gas × 100 gwei (0.3125 MON).
    const { chain, sent } = fakeChain({ balance: 10n * MON + (2n * MON) / 10n });
    const state = new KeeperState(KEEPER);
    const r = await runKeeperPass(db, chain, state);
    expect(sent).toEqual([]);
    expect(r.skipped).toEqual(["0xstranded"]);
    expect(state.snapshot()).toMatchObject({ heldByReserve: 1 });
    expect(state.snapshot().lastError).toMatch(/reserve/);
  });

  it("proceeds when the balance clears the reserve with one attempt to spare", async () => {
    await strand(db, "0xstranded");
    const { chain, sent } = fakeChain({ balance: MONAD_RESERVE_WEI + MON });
    await runKeeperPass(db, chain, new KeeperState(KEEPER));
    expect(sent).toHaveLength(1);
  });

  /**
   * A market that keeps failing is backed off, then abandoned — not retried every ten seconds at
   * a third of a MON a time. The clock is injected so the backoff is asserted, not waited for.
   */
  it("backs off a failing market and gives up after the limit", async () => {
    await strand(db, "0xbroken");
    const { chain } = fakeChain({ fail: () => new Error("NotReady()") });
    const state = new KeeperState(KEEPER);
    let now = 1_000_000;
    const clock = () => now;

    const first = await runKeeperPass(db, chain, state, clock);
    expect(first.failed).toEqual(["0xbroken"]);

    // Too soon: skipped without a call.
    now += BACKOFF_BASE_MS - 1;
    expect((await runKeeperPass(db, chain, state, clock)).skipped).toEqual(["0xbroken"]);

    // Due again, fails again, and the wait doubles.
    now += 1;
    expect((await runKeeperPass(db, chain, state, clock)).failed).toEqual(["0xbroken"]);
    now += BACKOFF_BASE_MS * 2 - 1;
    expect((await runKeeperPass(db, chain, state, clock)).skipped).toEqual(["0xbroken"]);

    // Exhaust the attempts.
    for (let i = state.snapshot().failed; i < MAX_ATTEMPTS; i++) {
      now += 60 * 60_000;
      await runKeeperPass(db, chain, state, clock);
    }
    expect(state.gaveUp("0xbroken")).toBe(true);
    expect(state.snapshot()).toMatchObject({ failed: MAX_ATTEMPTS, givenUp: 1, graduated: 0 });

    now += 24 * 60 * 60_000;
    expect((await runKeeperPass(db, chain, state, clock)).skipped).toEqual(["0xbroken"]);
  });

  it("forgets a market's failures once it graduates", async () => {
    await strand(db, "0xflaky");
    let attempts = 0;
    const { chain } = fakeChain({ fail: () => (attempts++ === 0 ? new Error("rpc hiccup") : null) });
    const state = new KeeperState(KEEPER);
    let now = 0;
    await runKeeperPass(db, chain, state, () => now);
    now += BACKOFF_BASE_MS;
    const r = await runKeeperPass(db, chain, state, () => now);
    expect(r.graduated).toEqual(["0xflaky"]);
    expect(state.snapshot()).toMatchObject({ graduated: 1, failed: 1, givenUp: 0 });
  });

  it("handles several stranded markets in launch order, one transaction each", async () => {
    await strand(db, "0xsecond", 200);
    await strand(db, "0xfirst", 100);
    const { chain, sent } = fakeChain({});
    const r = await runKeeperPass(db, chain, new KeeperState(KEEPER));
    expect(r.graduated).toEqual(["0xfirst", "0xsecond"]);
    expect(sent.map((c) => c.curve)).toEqual(["0xfirst", "0xsecond"]);
  });

  it("does nothing, and records the pass, when nothing is stranded", async () => {
    await seedMarket(db, "0xquiet", "0xt");
    const { chain, sent } = fakeChain({});
    const state = new KeeperState(KEEPER);
    const r = await runKeeperPass(db, chain, state);
    expect(r).toEqual({ candidates: 0, graduated: [], skipped: [], failed: [] });
    expect(sent).toEqual([]);
    expect(state.snapshot().lastPassAt).not.toBeNull();
    expect(state.snapshot().balanceWei).toBe((20n * MON).toString());
  });
});

/**
 * The funding pass's policy, against a chain it is told about.
 *
 * Same shape as the graduation tests above and for the same reason: everything that decides
 * whether a transaction is sent — the once-per-interval rule, the startup fallback, the
 * hook-side gate, the reserve, the backoff — is decided here, so a wrong decision costs a test
 * rather than a gas limit. Money is in wei and intervals are `bigint`; nothing is a float.
 */

const COLLECT_GAS = 200_000n;
const COLLECT_FEES_GAS = 140_000n;
const SWEEP_GAS = 150_000n;
const FUND_GAS = 120_000n;
const OPEN_GAS = 180_000n;

type Sent = { what: "collect" | "collectFees" | "sweep" | "fund" | "createEpochs"; gas: bigint; n?: bigint };

/**
 * A hook, a locker and a vault that behave like the real ones about the only thing that matters:
 * `fund()` can reach `owedSink` and nothing else, `sweep` is what moves `pendingSink` into it, and
 * a `collect` credits whatever its position had — which is usually nothing.
 */
function fakeFunding(opts: {
  interval?: bigint;
  pendingSink?: bigint;
  owedSink?: bigint;
  /** `undefined` means the chain answers `null`: not quotable, which is production today. */
  seedFees?: bigint | null;
  /** What a `collect` actually forwards. Zero is the no-op case, and it is the common one. */
  collectCredits?: bigint;
  /** `BondingCurve.pendingFees()`: the holders' share of every CURVE trade, left behind at graduation. */
  curveFees?: bigint;
  balance?: bigint;
  gasPrice?: bigint;
  fail?: (what: string) => Error | null;
  /** Which vault owns which pool and which seed position. One shared ledger when omitted. */
  markets?: { vault: string; poolId: string; tokenId: bigint; curve?: string }[];
  /** The head, and the vault's epoch grid: epoch k closes at `genesis + (k + 1) * EPOCH`. */
  blockNumber?: bigint;
  epochGenesis?: bigint;
  epochCount?: bigint;
}) {
  const EPOCH = 216_000n;
  const head = opts.blockNumber ?? 0n;
  const genesis = opts.epochGenesis ?? 0n;
  const epochCounts = new Map<string, bigint>();
  const epochCountOf = (vault: string): bigint => epochCounts.get(vault) ?? opts.epochCount ?? 0n;
  const sent: Sent[] = [];
  let balance = opts.balance ?? 20n * MON;
  const gasPrice = opts.gasPrice ?? 100n * 10n ** 9n;
  let interval = opts.interval ?? 0n;

  /*
   * Both hook ledgers are per POOL and the vault's buckets are per VAULT, exactly as on chain —
   * `opts.markets` says which vault owns which pool, the way `DokuHook._markets[id].sinkAddr`
   * does. A test that names no markets gets one shared ledger instead, because a single-market
   * test that had to declare its own wiring would be testing the fake.
   */
  const pools = new Map(opts.markets?.map((m) => [m.vault, m.poolId]));
  const one = pools.size === 0;
  const key = (k: string): string => (one ? "" : k);
  const ledgers = { accrued: new Map<string, bigint>(), owed: new Map<string, bigint>() };
  const buckets = new Map<string, bigint>();
  const read = (m: Map<string, bigint>, id: string, fallback: bigint): bigint => {
    if (!m.has(key(id))) m.set(key(id), fallback);
    return m.get(key(id)) ?? 0n;
  };
  const owed = (id: string): bigint => read(ledgers.owed, id, opts.owedSink ?? 0n);
  const accrued = (id: string): bigint => read(ledgers.accrued, id, opts.pendingSink ?? 0n);
  const bucketKey = (vault: string, k: bigint): string => `${key(vault)}:${k}`;

  const burn = (gas: bigint): void => {
    balance -= gas * gasPrice;
  };
  const guard = (what: string): void => {
    const e = opts.fail?.(what);
    if (e) throw e;
  };

  let curveFees = opts.curveFees ?? 0n;
  let curveReads = 0;

  const chain: FundingChain = {
    address: KEEPER,
    balance: async () => balance,
    gasPrice: async () => gasPrice,
    feePerGas: async () => gasPrice,
    currentInterval: async () => interval,
    curveFees: async () => {
      curveReads += 1;
      return curveFees;
    },
    estimateCollectFees: async () => COLLECT_FEES_GAS,
    collectFees: async (curve, gas) => {
      guard("collectFees");
      // The contract's own rule: nothing to collect reverts, at the full limit.
      if (curveFees === 0n) throw new Error("ZeroAmount");
      sent.push({ what: "collectFees", gas });
      burn(gas);
      // `collectFees` credits the hook's OWED ledger through the graduator, with no sweep in between.
      const pool = opts.markets?.find((m) => m.curve === curve)?.poolId ?? "";
      ledgers.owed.set(key(pool), owed(pool) + curveFees);
      curveFees = 0n;
      return "0xcollectfees";
    },
    pendingSink: async (poolId) => accrued(poolId),
    owedSink: async (poolId) => owed(poolId),
    seedFees: async () => (opts.seedFees === undefined ? null : opts.seedFees),
    estimateCollect: async () => COLLECT_GAS,
    collect: async (tokenId, gas) => {
      guard("collect");
      sent.push({ what: "collect", gas });
      burn(gas);
      // `SeedLocker.collect` credits the hook's OWED ledger directly, with no sweep in between.
      const pool = opts.markets?.find((m) => m.tokenId === tokenId)?.poolId ?? "";
      ledgers.owed.set(key(pool), owed(pool) + (opts.collectCredits ?? 0n));
      return "0xcollect";
    },
    estimateSweep: async () => SWEEP_GAS,
    sweep: async (poolId, gas) => {
      guard("sweep");
      sent.push({ what: "sweep", gas });
      burn(gas);
      ledgers.owed.set(key(poolId), owed(poolId) + accrued(poolId));
      ledgers.accrued.set(key(poolId), 0n);
      return "0xsweep";
    },
    estimateFund: async () => FUND_GAS,
    fund: async (vault, gas) => {
      guard("fund");
      sent.push({ what: "fund", gas });
      burn(gas);
      const pool = pools.get(vault) ?? "";
      const k = bucketKey(vault, interval);
      buckets.set(k, (buckets.get(k) ?? 0n) + owed(pool));
      ledgers.owed.set(key(pool), 0n);
      return "0xfund";
    },
    blockNumber: async () => head,
    epochCount: async (vault) => epochCountOf(vault),
    snapshotBlockFor: async (_vault, k) => genesis + k * EPOCH,
    estimateCreateEpochs: async () => OPEN_GAS,
    createEpochs: async (vault, n, gas) => {
      guard("createEpochs");
      // The contract's own rule: an epoch opens only once the head has passed its close.
      const count = epochCountOf(vault);
      for (let k = count; k < count + n; k += 1n) {
        if (head <= genesis + (k + 1n) * EPOCH) throw new Error("TooEarly");
      }
      sent.push({ what: "createEpochs", gas, n });
      burn(gas);
      epochCounts.set(vault, count + n);
      return "0xopen";
    },
  };

  return {
    chain,
    sent,
    /** The interval turns over. On Monad that is 216,000 blocks, about a day. */
    advance: (): void => {
      interval += 1n;
    },
    /** A swap accrues the sink's share. Unreachable by `fund()` until somebody sweeps. */
    accrue: (n: bigint, poolId = ""): void => {
      ledgers.accrued.set(key(poolId), accrued(poolId) + n);
    },
    setBalance: (b: bigint): void => {
      balance = b;
    },
    bucket: (k: bigint, vault = ""): bigint => buckets.get(bucketKey(vault, k)) ?? 0n,
    curveReads: (): number => curveReads,
    /** Somebody else released the curve's pot first. */
    drainCurve: (): void => {
      curveFees = 0n;
    },
  };
}

/** A graduated market, with the graduation row the funding pass reads its addresses from. */
async function graduate(
  db: Db,
  market: string,
  opts: {
    vault?: string;
    poolId?: string;
    tokenId?: bigint;
    block?: number;
    sinkKind?: number;
    generation?: number;
  } = {},
): Promise<void> {
  const block = opts.block ?? 100;
  await seedMarket(db, market, `${market}-token`, block);
  await db.query("UPDATE markets SET generation = $2 WHERE market_address = $1", [
    market,
    opts.generation ?? 2,
  ]);
  await db.query(
    `INSERT INTO graduations (market_address, pool_address, pool_id, sink, sink_kind, token_id,
                              quote_amount, base_amount, liquidity, block_number, block_hash,
                              log_index, tx_hash, ts)
     VALUES ($1,'0xpm',$2,$3,$4,$5,0,0,0,$6,'0xbb',0,$7,NOW())`,
    [
      market,
      opts.poolId ?? `${market}-pool`,
      opts.vault ?? `${market}-vault`,
      opts.sinkKind ?? SINK_REWARDS,
      (opts.tokenId ?? 7n).toString(),
      block + 1,
      `0xgtx-${market}`,
    ],
  );
}

/** A trade ON THE POOL, which is the only thing that moves a v4 position's fee growth. */
async function poolSwap(db: Db, market: string, block: number): Promise<void> {
  await db.query(
    `INSERT INTO swaps (market_address, trader, is_buy, venue, quote_amount, base_amount, fee,
                        quote_raised, price, block_number, block_hash, log_index, tx_hash, ts)
     VALUES ($1,$2,TRUE,'pool',1,1,0,0,0,$3,'0xbb',0,$4,NOW())`,
    [market, KEEPER, block, `0xswap-${market}-${block}`],
  );
}

describe("finding the markets whose vaults need funding", () => {
  let db: Db;
  beforeEach(async () => {
    db = await memoryDb();
    delete process.env.START_BLOCK;
  });

  it("names a graduated REWARDS market with its vault, pool id and seed position", async () => {
    await graduate(db, "0xholders", { vault: "0xvault", poolId: "0xpool", tokenId: 42n });
    await poolSwap(db, "0xholders", 180);
    expect(await findRewardsMarkets(db)).toEqual([
      {
        market: "0xholders",
        vault: "0xvault",
        poolId: "0xpool",
        tokenId: 42n,
        lastSwapBlock: 180n,
      },
    ]);
  });

  /** The other two sinks are funded by other routes and must never take a `fund()`. */
  it("ignores a buyback market and a creator market", async () => {
    await graduate(db, "0xburn", { sinkKind: SINK_BURN });
    await graduate(db, "0xcreator", { sinkKind: SINK_CREATOR, block: 110 });
    expect(await findRewardsMarkets(db)).toEqual([]);
  });

  /** No graduation row means no pool, no vault and nothing to fund. */
  it("ignores a market that has not graduated", async () => {
    await seedMarket(db, "0xbonding", "0xt1");
    await db.query("UPDATE markets SET generation = 2 WHERE market_address = '0xbonding'");
    expect(await findRewardsMarkets(db)).toEqual([]);
  });

  /**
   * `sink` and `pool_id` both default to the empty string, so a graduation row written before the
   * deferred `PoolRegistered` landed carries one. Acting on it would spend a full gas limit on an
   * address and a pool id that are not there.
   */
  it("ignores a graduation whose sink and pool id have not arrived yet", async () => {
    await graduate(db, "0xearly", { vault: "", poolId: "" });
    expect(await findRewardsMarkets(db)).toEqual([]);
  });

  it("does not reach past the served cut into a retired generation", async () => {
    await graduate(db, "0xretired", { block: 50 });
    await graduate(db, "0xserved", { block: 150 });
    process.env.START_BLOCK = "100";
    expect((await findRewardsMarkets(db)).map((m) => m.market)).toEqual(["0xserved"]);
  });

  it("only considers pairs-style markets", async () => {
    await graduate(db, "0xgen1", { generation: 1 });
    expect(await findRewardsMarkets(db)).toEqual([]);
  });
});

describe("a funding pass", () => {
  let db: Db;
  beforeEach(async () => {
    db = await memoryDb();
    delete process.env.START_BLOCK;
  });

  /**
   * The whole point of the job: the interval the audit's "timing lever" turns on is funded by
   * somebody who is always there, so a newcomer arriving late finds it already accounted for.
   */
  it("funds a vault whose hook is holding something, once, with a measured limit", async () => {
    await graduate(db, "0xm", { vault: "0xvault" });
    const f = fakeFunding({ owedSink: 3n * MON });
    const state = new KeeperState(KEEPER);

    const r = await runFundPass(db, f.chain, state);

    expect(r.funded).toEqual(["0xvault"]);
    expect(f.sent).toEqual([{ what: "fund", gas: withHeadroom(FUND_GAS) }]);
    expect(f.bucket(0n)).toBe(3n * MON);
    expect(state.snapshot()).toMatchObject({
      funded: 1,
      failed: 0,
      lastTx: "0xfund",
      lastFundedInterval: { "0xvault": "0" },
    });
  });

  /**
   * A second `fund()` in the same interval loses no money — it lands in the same bucket — but it
   * is a gas limit spent on nothing, every pass, for ever.
   */
  it("does not fund the same interval twice, and funds again when the interval turns over", async () => {
    await graduate(db, "0xm", { vault: "0xvault" });
    const f = fakeFunding({ owedSink: 3n * MON });
    const state = new KeeperState(KEEPER);

    await runFundPass(db, f.chain, state);
    f.accrue(1n * MON);
    const second = await runFundPass(db, f.chain, state);
    expect(second.funded).toEqual([]);
    expect(second.skipped).toEqual(["0xvault"]);
    expect(f.sent).toHaveLength(1);

    f.advance();
    const third = await runFundPass(db, f.chain, state);
    expect(third.funded).toEqual(["0xvault"]);
    expect(f.sent.map((s) => s.what)).toEqual(["fund", "sweep", "fund"]);
    expect(state.snapshot()).toMatchObject({
      funded: 2,
      lastFundedInterval: { "0xvault": "1" },
    });
  });

  /**
   * `fund()` with nothing owed succeeds, emits `Funded(0)` and costs the full limit. The interval
   * is deliberately NOT marked funded, so money arriving later in the same interval is still
   * picked up rather than waiting a whole day.
   */
  it("sends nothing when the hook is holding nothing, and looks again next pass", async () => {
    await graduate(db, "0xm", { vault: "0xvault" });
    const f = fakeFunding({ seedFees: 0n });
    const state = new KeeperState(KEEPER);

    const r = await runFundPass(db, f.chain, state);
    expect(f.sent).toEqual([]);
    expect(r.funded).toEqual([]);
    expect(r.skipped).toEqual(["0xvault"]);
    expect(state.snapshot().lastFundedInterval).toEqual({});

    f.accrue(2n * MON);
    expect((await runFundPass(db, f.chain, state)).funded).toEqual(["0xvault"]);
  });

  /**
   * `fund()` pulls `owedSink` and only `owedSink`. After the hook change that credits the LP share
   * straight to `pendingSink`, this is the entire money path, and a pass that skipped the sweep
   * would fund zero for ever while the ledger filled up.
   */
  it("sweeps what fund() cannot reach, then funds it", async () => {
    await graduate(db, "0xm", { vault: "0xvault" });
    const f = fakeFunding({ pendingSink: 5n * MON, seedFees: 0n });
    const state = new KeeperState(KEEPER);

    const r = await runFundPass(db, f.chain, state);
    expect(f.sent).toEqual([
      { what: "sweep", gas: withHeadroom(SWEEP_GAS) },
      { what: "fund", gas: withHeadroom(FUND_GAS) },
    ]);
    expect(r.funded).toEqual(["0xvault"]);
    expect(f.bucket(0n)).toBe(5n * MON);
  });

  /** The seed position is read, not assumed: nothing accrued means no transaction. */
  it("does not collect a seed position the chain says has earned nothing", async () => {
    await graduate(db, "0xm", { vault: "0xvault" });
    const f = fakeFunding({ seedFees: 0n, owedSink: MON });
    await runFundPass(db, f.chain, new KeeperState(KEEPER));
    expect(f.sent.map((s) => s.what)).toEqual(["fund"]);
  });

  it("collects it first when the chain says it has", async () => {
    await graduate(db, "0xm", { vault: "0xvault", tokenId: 9n });
    const f = fakeFunding({ seedFees: 4n * MON, collectCredits: 4n * MON });
    const state = new KeeperState(KEEPER);

    const r = await runFundPass(db, f.chain, state);
    expect(f.sent).toEqual([
      { what: "collect", gas: withHeadroom(COLLECT_GAS) },
      { what: "fund", gas: withHeadroom(FUND_GAS) },
    ]);
    expect(r.funded).toEqual(["0xvault"]);
    expect(f.bucket(0n)).toBe(4n * MON);
  });

  /**
   * The state this has to survive, because it is where the protocol is going: once the hook credits
   * the LP share straight to `pendingSink`, the seed position stops earning and `collect` forwards
   * nothing. The pass must not then fund zero, and must not treat the interval as done.
   */
  it("survives a collect that forwards nothing", async () => {
    await graduate(db, "0xm", { vault: "0xvault" });
    const f = fakeFunding({ seedFees: 4n * MON, collectCredits: 0n });
    const state = new KeeperState(KEEPER);

    const r = await runFundPass(db, f.chain, state);
    expect(f.sent.map((s) => s.what)).toEqual(["collect"]);
    expect(r.funded).toEqual([]);
    expect(state.snapshot()).toMatchObject({ funded: 0, failed: 0 });
    expect(state.snapshot().lastFundedInterval).toEqual({});
  });

  /**
   * The cost this closes. After the hook change the seed position stops earning, but the pool keeps
   * trading — so the swap watermark keeps saying "a collect might move something" and would buy one
   * pointless collect per interval, for ever. One collect that moves the hook's owed ledger by zero
   * settles it.
   */
  it("stops collecting a seed position that has proven it forwards nothing", async () => {
    await graduate(db, "0xm", { vault: "0xvault" });
    await poolSwap(db, "0xm", 200);
    const f = fakeFunding({ collectCredits: 0n });
    const state = new KeeperState(KEEPER);

    // First sight seeds the watermark, so nothing is collected yet.
    await runFundPass(db, f.chain, state);
    expect(f.sent).toEqual([]);

    // A swap lands: worth one collect, which forwards nothing.
    await poolSwap(db, "0xm", 300);
    f.advance();
    await runFundPass(db, f.chain, state);
    expect(f.sent.map((x) => x.what)).toEqual(["collect"]);

    // More swaps, more intervals, and never another collect.
    await poolSwap(db, "0xm", 400);
    f.advance();
    await runFundPass(db, f.chain, state);
    await poolSwap(db, "0xm", 500);
    f.advance();
    await runFundPass(db, f.chain, state);
    expect(f.sent.map((x) => x.what)).toEqual(["collect"]);
  });

  /**
   * With no fee getter on the chain, the only proof available that a collect would move nothing is
   * that the pool has not traded since the last one. A fresh process seeds that watermark rather
   * than assuming every market it has ever seen is owed a collect — otherwise a restart is one
   * transaction per market at the full limit before it has watched a single swap.
   */
  it("collects on a swap it has watched, and not merely on one it found in the database", async () => {
    await graduate(db, "0xm", { vault: "0xvault" });
    await poolSwap(db, "0xm", 200);
    const f = fakeFunding({ owedSink: MON });
    const state = new KeeperState(KEEPER);

    await runFundPass(db, f.chain, state);
    expect(f.sent.map((s) => s.what)).toEqual(["fund"]);

    await poolSwap(db, "0xm", 300);
    f.advance();
    f.accrue(MON);
    await runFundPass(db, f.chain, state);
    expect(f.sent.map((s) => s.what)).toEqual(["fund", "collect", "sweep", "fund"]);
  });

  /**
   * A restart trusts its own memory and nothing on chain about whether the interval was funded.
   * Generation 4's keeper read `pending(k) != 0` as "already funded"; generation 5's `fund()`
   * spreads forward, so that bucket is non-zero on every interval after a vault's first funding and
   * the test would have skipped one interval per vault per redeploy. The price of the other error
   * is exactly one extra transaction, taken here on purpose — and taken ONLY when something is
   * owed, and only once: the same interval is not funded twice by the same process.
   */
  it("funds again after a restart when something is owed, and once only", async () => {
    await graduate(db, "0xm", { vault: "0xvault" });
    const f = fakeFunding({ owedSink: 3n * MON, seedFees: 0n });
    const state = new KeeperState(KEEPER);

    const r = await runFundPass(db, f.chain, state);
    expect(f.sent.map((s) => s.what)).toEqual(["fund"]);
    expect(r.funded).toEqual(["0xvault"]);
    expect(state.snapshot()).toMatchObject({ funded: 1, lastFundedInterval: { "0xvault": "0" } });

    // Same interval, same process: the memory is the guard now, and it holds.
    f.accrue(MON);
    const again = await runFundPass(db, f.chain, state);
    expect(again.skipped).toEqual(["0xvault"]);
    expect(f.sent.map((s) => s.what)).toEqual(["fund"]);

    f.advance();
    expect((await runFundPass(db, f.chain, state)).funded).toEqual(["0xvault"]);
  });

  /**
   * Same guard as a graduation, over the same counter: Monad refuses a transaction that would end
   * below 10 MON and bills the limit either way, so the refusal has to happen here.
   */
  it("holds rather than dip under the reserve, and says so on the shared counter", async () => {
    await graduate(db, "0xm", { vault: "0xvault" });
    // 10.01 MON: the reserve plus less than one fund at 150,000 gas x 100 gwei.
    const f = fakeFunding({ owedSink: 3n * MON, balance: MONAD_RESERVE_WEI + MON / 100n });
    const state = new KeeperState(KEEPER);

    const r = await runFundPass(db, f.chain, state);
    expect(f.sent).toEqual([]);
    expect(r.skipped).toEqual(["0xvault"]);
    expect(state.snapshot()).toMatchObject({ heldByReserve: 1, funded: 0 });
    expect(state.snapshot().lastError).toMatch(/reserve/);
  });

  /** A vault that keeps failing is backed off on the same clock, and abandoned on the same count. */
  it("backs off a failing vault and gives up after the limit", async () => {
    await graduate(db, "0xm", { vault: "0xvault" });
    const f = fakeFunding({ owedSink: 3n * MON, fail: () => new Error("NothingToSweep()") });
    const state = new KeeperState(KEEPER);
    let now = 1_000_000;
    const clock = (): number => now;

    expect((await runFundPass(db, f.chain, state, clock)).failed).toEqual(["0xvault"]);

    now += BACKOFF_BASE_MS - 1;
    expect((await runFundPass(db, f.chain, state, clock)).skipped).toEqual(["0xvault"]);

    now += 1;
    expect((await runFundPass(db, f.chain, state, clock)).failed).toEqual(["0xvault"]);

    for (let i = state.snapshot().failed; i < MAX_ATTEMPTS; i++) {
      now += 60 * 60_000;
      await runFundPass(db, f.chain, state, clock);
    }
    expect(state.gaveUp("0xvault")).toBe(true);
    expect(state.snapshot()).toMatchObject({ failed: MAX_ATTEMPTS, givenUp: 1, funded: 0 });

    now += 24 * 60 * 60_000;
    expect((await runFundPass(db, f.chain, state, clock)).skipped).toEqual(["0xvault"]);
  });

  it("handles several markets in graduation order, one vault each", async () => {
    await graduate(db, "0xsecond", { vault: "0xv2", block: 200 });
    await graduate(db, "0xfirst", { vault: "0xv1", block: 100 });
    const f = fakeFunding({
      owedSink: 3n * MON,
      seedFees: 0n,
      markets: [
        { vault: "0xv1", poolId: "0xfirst-pool", tokenId: 7n },
        { vault: "0xv2", poolId: "0xsecond-pool", tokenId: 7n },
      ],
    });
    const r = await runFundPass(db, f.chain, new KeeperState(KEEPER));
    expect(r.funded).toEqual(["0xv1", "0xv2"]);
    expect(f.sent.map((x) => x.what)).toEqual(["fund", "fund"]);
    expect(f.bucket(0n, "0xv1")).toBe(3n * MON);
    expect(f.bucket(0n, "0xv2")).toBe(3n * MON);
  });

  it("does nothing, and records the pass, when no market routes to holders", async () => {
    await graduate(db, "0xburn", { sinkKind: SINK_BURN });
    const f = fakeFunding({ owedSink: 3n * MON });
    const state = new KeeperState(KEEPER);
    const r = await runFundPass(db, f.chain, state);
    expect(r).toEqual({ candidates: 0, funded: [], skipped: [], failed: [] });
    expect(f.sent).toEqual([]);
    expect(state.snapshot().lastPassAt).not.toBeNull();
    expect(state.snapshot().balanceWei).toBe((20n * MON).toString());
  });
});

/**
 * A vault only materialises an epoch when somebody calls `createEpochs`, and nobody can claim
 * until it has. The keeper is that somebody: measured on the live TR1 vault, three intervals had
 * closed with `epochCount` still 0.
 */
describe("releasing the holders' share a curve is still holding", () => {
  let db: Db;
  let state: KeeperState;
  const DAY = 24 * 60 * 60_000;
  beforeEach(async () => {
    db = await memoryDb();
    state = new KeeperState(KEEPER);
  });

  it("collects the curve's pot into the hook and funds the vault with it in the same pass", async () => {
    // 0.7% of every trade a dividends market made ON THE CURVE waits in `pendingFees`, and neither
    // graduation nor any trade moves it. On a production market it is the largest dividend there
    // will ever be, and until this it waited for somebody to call `collectFees()` by hand.
    await graduate(db, "0xm1");
    const f = fakeFunding({ curveFees: 2_000n * MON });

    const r = await runFundPass(db, f.chain, state);

    expect(f.sent.map((s) => s.what)).toEqual(["collectFees", "fund"]);
    expect(f.bucket(0n)).toBe(2_000n * MON);
    expect(r.funded).toEqual(["0xm1-vault"]);
  });

  it("sends the collect with a quarter's headroom, like every other write", async () => {
    await graduate(db, "0xm1");
    const f = fakeFunding({ curveFees: 1n * MON });
    await runFundPass(db, f.chain, state);
    expect(f.sent[0]).toEqual({ what: "collectFees", gas: COLLECT_FEES_GAS + COLLECT_FEES_GAS / 4n });
  });

  it("reads an empty curve once and never again: a graduated curve is closed and cannot accrue", async () => {
    await graduate(db, "0xm1");
    const f = fakeFunding({ curveFees: 0n });

    for (let i = 0; i < 4; i += 1) {
      await runFundPass(db, f.chain, state);
      f.advance();
    }

    expect(f.curveReads()).toBe(1);
    expect(f.sent).toEqual([]);
  });

  it("does not read it again after releasing it either", async () => {
    await graduate(db, "0xm1");
    const f = fakeFunding({ curveFees: 5n * MON });
    await runFundPass(db, f.chain, state, () => 1_000_000);
    f.advance();
    // Two days on, well past the retry gate: only "drained" can be what keeps it from looking.
    await runFundPass(db, f.chain, state, () => 1_000_000 + 2 * DAY);
    expect(f.curveReads()).toBe(1);
    expect(f.sent.filter((s) => s.what === "collectFees")).toHaveLength(1);
  });

  it("a collect that fails is the day's attempt: the passes after it fund as usual and do not resend it", async () => {
    await graduate(db, "0xm1");
    const f = fakeFunding({ curveFees: 5n * MON, fail: (what) => (what === "collectFees" ? new Error("reverted in 0xdead") : null) });
    let t = 1_000_000;

    const first = await runFundPass(db, f.chain, state, () => t);
    expect(first.failed).toEqual(["0xm1-vault"]);

    // An hour on, past the backoff: the levy still gets funded, the collect is not tried again.
    t += 60 * 60_000;
    f.accrue(3n * MON);
    await runFundPass(db, f.chain, state, () => t);
    expect(f.sent.map((s) => s.what)).toEqual(["sweep", "fund"]);
  });

  it("tries the collect again the next day", async () => {
    await graduate(db, "0xm1");
    let broken = true;
    const f = fakeFunding({ curveFees: 5n * MON, fail: (what) => (broken && what === "collectFees" ? new Error("rpc dropped") : null) });
    let t = 1_000_000;
    await runFundPass(db, f.chain, state, () => t);

    broken = false;
    t += DAY;
    f.advance();
    await runFundPass(db, f.chain, state, () => t);

    expect(f.sent.map((s) => s.what)).toEqual(["collectFees", "fund"]);
  });

  it("finds the pot already released by somebody else on its retry, and sends nothing for it", async () => {
    await graduate(db, "0xm1");
    const f = fakeFunding({ curveFees: 5n * MON, fail: (what) => (what === "collectFees" ? new Error("rpc dropped") : null) });
    let t = 1_000_000;
    await runFundPass(db, f.chain, state, () => t);

    f.drainCurve();
    t += DAY;
    await runFundPass(db, f.chain, state, () => t);

    expect(f.sent).toEqual([]);
    expect(f.curveReads()).toBe(2);
  });

  it("holds the collect for the reserve without spending the day's attempt", async () => {
    await graduate(db, "0xm1");
    const cost = (COLLECT_FEES_GAS + COLLECT_FEES_GAS / 4n) * 100n * 10n ** 9n;
    const f = fakeFunding({ curveFees: 5n * MON, balance: MONAD_RESERVE_WEI + cost - 1n });

    const held = await runFundPass(db, f.chain, state);
    expect(f.sent).toEqual([]);
    expect(held.skipped).toEqual(["0xm1-vault"]);

    f.setBalance(20n * MON);
    await runFundPass(db, f.chain, state);
    expect(f.sent.map((s) => s.what)).toEqual(["collectFees", "fund"]);
  });

  it("releases each market's own curve into its own pool", async () => {
    await graduate(db, "0xm1", { vault: "0xv1", poolId: "0xp1", tokenId: 1n });
    await graduate(db, "0xm2", { vault: "0xv2", poolId: "0xp2", tokenId: 2n, block: 200 });
    const f = fakeFunding({
      curveFees: 7n * MON,
      markets: [
        { vault: "0xv1", poolId: "0xp1", tokenId: 1n, curve: "0xm1" },
        { vault: "0xv2", poolId: "0xp2", tokenId: 2n, curve: "0xm2" },
      ],
    });

    await runFundPass(db, f.chain, state);

    // One shared pot in this fake, so the first market's collect takes it and the second finds none.
    expect(f.bucket(0n, "0xv1")).toBe(7n * MON);
    expect(f.bucket(0n, "0xv2")).toBe(0n);
  });
});

describe("opening matured epochs", () => {
  let db: Db;
  beforeEach(async () => {
    db = await memoryDb();
    delete process.env.START_BLOCK;
  });
  const EPOCH = 216_000n;

  it("opens exactly the epochs the head has passed, in one call, and reports them", async () => {
    await graduate(db, "0xm", { vault: "0xvault" });
    // Three closes behind the head (epochs 0, 1, 2), the fourth just ahead.
    const f = fakeFunding({ blockNumber: 3n * EPOCH + 1n, epochGenesis: 0n, epochCount: 0n });
    const state = new KeeperState(KEEPER);

    await runFundPass(db, f.chain, state);

    expect(f.sent).toEqual([{ what: "createEpochs", gas: withHeadroom(OPEN_GAS), n: 3n }]);
    expect(state.snapshot()).toMatchObject({ epochsOpened: 3, epochCount: { "0xvault": "3" }, lastTx: "0xopen" });
  });

  it("sends nothing while no epoch has matured", async () => {
    await graduate(db, "0xm", { vault: "0xvault" });
    const f = fakeFunding({ blockNumber: EPOCH, epochGenesis: 0n, epochCount: 0n });
    const state = new KeeperState(KEEPER);

    await runFundPass(db, f.chain, state);

    expect(f.sent).toEqual([]);
    expect(state.snapshot().epochsOpened).toBe(0);
  });

  it("caps one call at the vault's forward spread of seven", async () => {
    await graduate(db, "0xm", { vault: "0xvault" });
    const f = fakeFunding({ blockNumber: 20n * EPOCH + 1n, epochGenesis: 0n, epochCount: 2n });
    const state = new KeeperState(KEEPER);

    await runFundPass(db, f.chain, state);

    expect(f.sent).toEqual([{ what: "createEpochs", gas: withHeadroom(OPEN_GAS), n: 7n }]);
    expect(state.snapshot().epochCount).toEqual({ "0xvault": "9" });
  });

  it("a revert while opening backs off that vault and does not block funding the next one", async () => {
    await graduate(db, "0xa", { vault: "0xva", poolId: "0xpa", tokenId: 1n, block: 100 });
    await graduate(db, "0xb", { vault: "0xvb", poolId: "0xpb", tokenId: 2n, block: 200 });
    let failedOnce = false;
    const f = fakeFunding({
      blockNumber: 2n * EPOCH + 1n,
      epochGenesis: 0n,
      epochCount: 0n,
      owedSink: MON,
      markets: [
        { vault: "0xva", poolId: "0xpa", tokenId: 1n },
        { vault: "0xvb", poolId: "0xpb", tokenId: 2n },
      ],
      // The first vault's open reverts; the second vault's must still go through.
      fail: (what) => {
        if (what !== "createEpochs" || failedOnce) return null;
        failedOnce = true;
        return new Error("boom");
      },
    });
    const state = new KeeperState(KEEPER);

    const r = await runFundPass(db, f.chain, state);

    // The first vault's open threw; the second vault still opened its epochs and got funded.
    expect(r.failed).toEqual(["0xva"]);
    expect(r.funded).toEqual(["0xvb"]);
    expect(f.sent.map((x) => x.what)).toEqual(["createEpochs", "fund"]);
    expect(state.snapshot()).toMatchObject({ failed: 1, funded: 1, epochsOpened: 2 });
  });
});
