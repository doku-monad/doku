import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/legacy.js";
import { SINK_BURN, SINK_REWARDS } from "../src/indexer/generations.js";
import { KeeperState, MAX_ATTEMPTS, MONAD_RESERVE_WEI } from "../src/indexer/processing/keeper.js";
import {
  findHolders,
  findPayoutMarkets,
  meetsMinimum,
  type PayoutChain,
  type PlannedEpoch,
  planClaim,
  runPayoutPass,
  shareOf,
  usdOf,
  type VaultEpoch,
} from "../src/indexer/processing/payout.js";
import { memoryDb, seedMarket } from "./helpers.js";

/**
 * The payout pass's policy, against a chain it is told about.
 *
 * Every decision that sends a transaction — which epochs count, whose weight counts, the dollar
 * floor, the reserve, the backoff — is exercised here with a fake vault, so a wrong decision
 * costs nothing. The adapter's `claim` is one `simulateContract` + `writeContract` like the other
 * five writes and is not repeated here.
 */

const KEEPER = "0x00000000000000000000000000000000000000ee" as const;
const MON = 10n ** 18n;
const EPOCH = 216_000n;
const CLAIM_GAS = 120_000n;
const A = "0x00000000000000000000000000000000000000a1" as const;
const B = "0x00000000000000000000000000000000000000b2" as const;
const POOL = "0x0000000000000000000000000000000000009001" as const;

type Sent = { holder: string; from: bigint; to: bigint; gas: bigint };

function fakeVault(opts: {
  genesis?: bigint;
  head: bigint;
  epochs: VaultEpoch[];
  /** holder → epoch → weight. Absent means zero. */
  weights?: Record<string, Record<string, bigint>>;
  claimed?: Record<string, bigint[]>;
  excluded?: string[];
  balance?: bigint;
  gasPrice?: bigint;
  failClaim?: Error | null;
}) {
  const genesis = opts.genesis ?? 0n;
  const sent: Sent[] = [];
  let balance = opts.balance ?? 20n * MON;
  const gasPrice = opts.gasPrice ?? 100n * 10n ** 9n;
  const claimed = new Map<string, Set<bigint>>();
  for (const [h, ks] of Object.entries(opts.claimed ?? {})) claimed.set(h.toLowerCase(), new Set(ks));
  const epochs = opts.epochs.map((e) => ({ ...e }));
  const chain: PayoutChain = {
    address: KEEPER,
    balance: async () => balance,
    gasPrice: async () => gasPrice,
    blockNumber: async () => opts.head,
    epochCount: async () => BigInt(epochs.length),
    snapshotBlockFor: async (_v, k) => genesis + (k + 1n) * EPOCH,
    epoch: async (_v, k) => epochs[Number(k)]!,
    sweepableFrom: async (_v, k) => genesis + (k + 2n) * EPOCH + 26n * EPOCH + 1n,
    feePerGas: async () => gasPrice,
    // One round trip per holder, as the adapter's Multicall3 batch answers it.
    holderEpochs: async (_v, holder, ks) => ({
      excluded: (opts.excluded ?? []).map((x) => x.toLowerCase()).includes(holder.toLowerCase()),
      weights: ks.map((k) => opts.weights?.[holder.toLowerCase()]?.[k.toString()] ?? 0n),
      claimed: ks.map((k) => claimed.get(holder.toLowerCase())?.has(k) ?? false),
    }),
    estimateClaim: async () => CLAIM_GAS,
    claim: async (_v, holder, from, to, gas) => {
      if (opts.failClaim) throw opts.failClaim;
      sent.push({ holder, from, to, gas });
      balance -= gas * gasPrice;
      // The contract's own bookkeeping: each claimable epoch in the range is paid and marked.
      for (let k = from; k <= to; k += 1n) {
        const e = epochs[Number(k)]!;
        const w = opts.weights?.[holder.toLowerCase()]?.[k.toString()] ?? 0n;
        const set = claimed.get(holder.toLowerCase()) ?? new Set<bigint>();
        if (set.has(k) || w === 0n) continue;
        e.claimed += shareOf(e, w);
        set.add(k);
        claimed.set(holder.toLowerCase(), set);
      }
      return `0xclaim${sent.length}` as `0x${string}`;
    },
  };
  return { chain, sent, setBalance: (b: bigint) => (balance = b) };
}

/** A graduated REWARDS market on MON, with two holders on its token and a price on its quote. */
async function graduateWithHolders(
  db: Db,
  market: string,
  opts: { vault?: string; sinkKind?: number; usdPrice?: number | null; holders?: [string, bigint][]; quote?: string } = {},
): Promise<void> {
  const token = `${market}-token`;
  await seedMarket(db, market, token, 100);
  const quote = opts.quote ?? "0x0000000000000000000000000000000000000000";
  await db.query(
    "UPDATE markets SET generation = 2, quote_asset = $2, quote_decimals = 18 WHERE market_address = $1",
    [market, quote],
  );
  await db.query(
    `INSERT INTO graduations (market_address, pool_address, pool_id, sink, sink_kind, token_id,
                              quote_amount, base_amount, liquidity, block_number, block_hash,
                              log_index, tx_hash, ts)
     VALUES ($1,$2,'0xpid',$3,$4,7,0,0,0,101,'0xbb',0,$5,NOW())`,
    [market, POOL, opts.vault ?? `${market}-vault`, opts.sinkKind ?? SINK_REWARDS, `0xgtx-${market}`],
  );
  if (opts.usdPrice !== null) {
    await db.query(
      `INSERT INTO quote_assets (id, address, symbol, decimals, usd_price)
       VALUES ($1, $2, 'MON', 18, $3)
       ON CONFLICT (id) DO UPDATE SET usd_price = EXCLUDED.usd_price`,
      [`q-${quote}`, quote, opts.usdPrice ?? 1],
    );
  }
  for (const [holder, balance] of opts.holders ?? [
    [A, 600n * MON],
    [B, 400n * MON],
  ]) {
    await db.query("INSERT INTO token_balances (token_address, holder, balance) VALUES ($1, $2, $3)", [
      token,
      holder,
      balance.toString(),
    ]);
  }
}

/** Epoch k with a 10 MON pot over 1,000 eligible tokens, opened at grid line k. */
const pot = (k: number, amount = 10n * MON, claimed = 0n): VaultEpoch => ({
  snapshotBlock: BigInt(k + 1) * EPOCH,
  amount,
  eligibleSupply: 1000n * MON,
  claimed,
});

const planned = (k: number, e: VaultEpoch = pot(k)): PlannedEpoch => ({
  ...e,
  index: BigInt(k),
  closes: BigInt(k + 2) * EPOCH,
  sweepableFrom: BigInt(k + 2) * EPOCH + 26n * EPOCH + 1n,
});

describe("the contract's arithmetic", () => {
  it("pays amount × weight / eligibleSupply in integers, and nothing on a zero", () => {
    expect(shareOf(pot(0), 600n * MON)).toBe(6n * MON);
    expect(shareOf(pot(0), 0n)).toBe(0n);
    expect(shareOf({ ...pot(0), eligibleSupply: 0n }, 1n)).toBe(0n);
  });

  it("values a raw amount at the catalogue price and refuses without one", () => {
    expect(usdOf(2n * MON, 18, 0.5)).toBe(1);
    expect(usdOf(2n * MON, 18, null)).toBeNull();
    expect(meetsMinimum(10n * MON, 18, 0.5, 5)).toBe(true);
    expect(meetsMinimum(9n * MON, 18, 0.5, 5)).toBe(false);
    expect(meetsMinimum(1_000_000n * MON, 18, null, 5)).toBe(false);
  });
});

describe("planning one holder's claim", () => {
  const weights = new Map<bigint, bigint>([
    [0n, 600n * MON],
    [1n, 600n * MON],
    [2n, 600n * MON],
    [3n, 600n * MON],
  ]);

  it("claims every matured, unclaimed epoch the holder has weight in, as one range", () => {
    const head = 4n * EPOCH + 1n; // past epoch 2's close, not epoch 3's
    const plan = planClaim([planned(0), planned(1), planned(2), planned(3)], weights, new Set(), head);
    expect(plan.epochs).toEqual([0n, 1n, 2n]);
    expect(plan.range).toEqual({ from: 0n, to: 2n });
    expect(plan.total).toBe(18n * MON);
  });

  it("skips what is claimed, weightless or spent, and spans the gap", () => {
    const head = 5n * EPOCH + 1n;
    const w = new Map(weights);
    w.set(1n, 0n);
    const plan = planClaim(
      [planned(0), planned(1), planned(2, pot(2, 10n * MON, 10n * MON)), planned(3)],
      w,
      new Set([0n]),
      head,
    );
    expect(plan.epochs).toEqual([3n]);
    expect(plan.range).toEqual({ from: 3n, to: 3n });
  });

  it("does not claim an epoch past its sweep, and returns nothing when nothing qualifies", () => {
    const head = 2n * EPOCH + 26n * EPOCH + 1n; // epoch 0 is sweepable from exactly here
    const plan = planClaim([planned(0)], weights, new Set(), head);
    expect(plan.range).toBeNull();
    expect(plan.total).toBe(0n);
  });
});

describe("finding the markets and holders to pay", () => {
  let db: Db;
  beforeEach(async () => {
    db = await memoryDb();
  });

  it("names a graduated REWARDS market with its token, decimals and quote price", async () => {
    await graduateWithHolders(db, "0xm1", { usdPrice: 0.02 });
    const markets = await findPayoutMarkets(db);
    expect(markets).toEqual([
      { market: "0xm1", vault: "0xm1-vault", token: "0xm1-token", quoteDecimals: 18, usdPrice: 0.02 },
    ]);
  });

  it("carries a null price for a quote the catalogue cannot value, and ignores a burn market", async () => {
    await graduateWithHolders(db, "0xm1", { usdPrice: null });
    await graduateWithHolders(db, "0xm2", { sinkKind: SINK_BURN, quote: "0x00000000000000000000000000000000000000c1" });
    const markets = await findPayoutMarkets(db);
    expect(markets.map((m) => [m.market, m.usdPrice])).toEqual([["0xm1", null]]);
  });

  it("lists holders largest first and never the zero or dead address", async () => {
    await graduateWithHolders(db, "0xm1", {
      holders: [
        [A, 1n],
        [B, 5n],
        ["0x000000000000000000000000000000000000dead", 999n],
        ["0x0000000000000000000000000000000000000000", 999n],
      ],
    });
    expect(await findHolders(db, "0xm1-token")).toMatchObject({ holders: [B, A], next: null });
  });

  it("pages through a long holder list by balance and holder, and says when the tail is reached", async () => {
    const C = "0x00000000000000000000000000000000000000c3" as const;
    await graduateWithHolders(db, "0xm1", { holders: [[A, 5n], [B, 5n], [C, 1n]] });
    const first = await findHolders(db, "0xm1-token", 2);
    expect(first.holders).toEqual([B, A]);
    expect(first.next).toBe(`5:${A}`);
    const second = await findHolders(db, "0xm1-token", 2, first.next);
    expect(second).toMatchObject({ holders: [C], next: null });
    // A page exactly full still hands out a cursor; the next page is empty and closes the walk.
    const exact = await findHolders(db, "0xm1-token", 3);
    expect(exact.next).toBe(`1:${C}`);
    expect(await findHolders(db, "0xm1-token", 3, exact.next)).toMatchObject({ holders: [], next: null });
  });
});

describe("a payout pass", () => {
  let db: Db;
  let state: KeeperState;
  beforeEach(async () => {
    db = await memoryDb();
    state = new KeeperState(KEEPER);
  });

  const twoEpochs = { head: 3n * EPOCH + 1n, epochs: [pot(0), pot(1)] };
  const bothHold = {
    [A]: { "0": 600n * MON, "1": 600n * MON },
    [B]: { "0": 400n * MON, "1": 400n * MON },
  };

  it("claims for every holder over the floor, one range each, and reports it", async () => {
    await graduateWithHolders(db, "0xm1", { usdPrice: 1 });
    const vault = fakeVault({ ...twoEpochs, weights: bothHold });
    const result = await runPayoutPass(db, vault.chain, state, { minUsd: 5 });
    expect(vault.sent).toEqual([
      { holder: A, from: 0n, to: 1n, gas: expect.any(BigInt) },
      { holder: B, from: 0n, to: 1n, gas: expect.any(BigInt) },
    ]);
    expect(result.claimed.map((c) => [c.holder, c.amount])).toEqual([
      [A, 12n * MON],
      [B, 8n * MON],
    ]);
    const snap = state.snapshot();
    expect(snap.payouts).toBe(2);
    expect(snap.payoutEpochs).toBe(4);
    expect(snap.lastPayoutTx).toBe("0xclaim2");
  });

  it("leaves a holder under the floor alone, and counts them", async () => {
    // B's 8 MON at $0.50 is $4: under a $5 floor. A's 12 MON is $6.
    await graduateWithHolders(db, "0xm1", { usdPrice: 0.5 });
    const vault = fakeVault({ ...twoEpochs, weights: bothHold });
    const result = await runPayoutPass(db, vault.chain, state, { minUsd: 5 });
    expect(vault.sent.map((s) => s.holder)).toEqual([A]);
    expect(result.belowMinimum).toBe(1);
  });

  it("sends nothing for a quote it cannot value, and says so", async () => {
    await graduateWithHolders(db, "0xm1", { usdPrice: null });
    const vault = fakeVault({ ...twoEpochs, weights: bothHold });
    const result = await runPayoutPass(db, vault.chain, state, { minUsd: 5 });
    expect(vault.sent).toEqual([]);
    expect(result.unpriced).toBe(1);
  });

  it("does not claim twice: the second pass finds everything claimed", async () => {
    await graduateWithHolders(db, "0xm1", { usdPrice: 1 });
    const vault = fakeVault({ ...twoEpochs, weights: bothHold });
    await runPayoutPass(db, vault.chain, state, { minUsd: 5 });
    const again = await runPayoutPass(db, vault.chain, state, { minUsd: 5 });
    expect(vault.sent).toHaveLength(2);
    expect(again.claimed).toEqual([]);
  });

  it("sends nothing while no epoch has matured, without reading a single holder", async () => {
    await graduateWithHolders(db, "0xm1", { usdPrice: 1 });
    let asked = 0;
    const vault = fakeVault({ head: 2n * EPOCH, epochs: [pot(0)], weights: bothHold });
    const chain: PayoutChain = { ...vault.chain, holderEpochs: async (...a) => (asked += 1, vault.chain.holderEpochs(...a)) };
    const result = await runPayoutPass(db, chain, state, { minUsd: 5 });
    expect(result.claimed).toEqual([]);
    expect(asked).toBe(0);
  });

  it("never pays an excluded address", async () => {
    await graduateWithHolders(db, "0xm1", { usdPrice: 1, holders: [[POOL, 500n * MON], [A, 600n * MON]] });
    const vault = fakeVault({ ...twoEpochs, weights: { ...bothHold, [POOL]: { "0": 500n * MON, "1": 500n * MON } }, excluded: [POOL] });
    await runPayoutPass(db, vault.chain, state, { minUsd: 5 });
    expect(vault.sent.map((s) => s.holder)).toEqual([A]);
  });

  it("reads each holder in one round trip and covers every open epoch in it", async () => {
    await graduateWithHolders(db, "0xm1", { usdPrice: 1 });
    const vault = fakeVault({ ...twoEpochs, weights: bothHold });
    const asked: bigint[][] = [];
    const chain: PayoutChain = {
      ...vault.chain,
      holderEpochs: async (v, h, ks) => (asked.push([...ks]), vault.chain.holderEpochs(v, h, ks)),
    };
    await runPayoutPass(db, chain, state, { minUsd: 5 });
    expect(asked).toEqual([
      [0n, 1n],
      [0n, 1n],
    ]);
  });

  it("walks a market with more holders than one pass reads across passes, then starts over", async () => {
    const C = "0x00000000000000000000000000000000000000c3" as const;
    await graduateWithHolders(db, "0xm1", { usdPrice: 1, holders: [[A, 600n * MON], [B, 400n * MON], [C, 300n * MON]] });
    const many = { ...bothHold, [C]: { "0": 300n * MON, "1": 300n * MON } };
    const vault = fakeVault({ ...twoEpochs, weights: many });
    const cursors: (string | null)[] = [];
    const walk = async () => {
      cursors.push(state.payoutCursor("0xm1"));
      return runPayoutPass(db, vault.chain, state, { minUsd: 5 });
    };
    // With the page size forced to two holders via the module constant, a pass reads A and B ...
    const { holders: page } = await findHolders(db, "0xm1-token", 2);
    expect(page).toEqual([A, B]);
    state.setPayoutCursor("0xm1", `${400n * MON}:${B}`);
    const rest = await walk();
    expect(rest.claimed.map((c) => c.holder)).toEqual([C]);
    expect(state.payoutCursor("0xm1")).toBeNull();
    expect(cursors).toEqual([`${400n * MON}:${B}`]);
  });

  it("prices the reserve guard at the fee a send is reserved at, not the legacy gas price", async () => {
    await graduateWithHolders(db, "0xm1", { usdPrice: 1 });
    // Legacy price says the claim fits; the 1559 max fee says it would breach the reserve.
    const vault = fakeVault({ ...twoEpochs, weights: bothHold, balance: MONAD_RESERVE_WEI + CLAIM_GAS * 130n * 10n ** 9n });
    const chain: PayoutChain = { ...vault.chain, feePerGas: async () => 200n * 10n ** 9n };
    const result = await runPayoutPass(db, chain, state, { minUsd: 5 });
    expect(vault.sent).toEqual([]);
    expect(result.capped).toBe(true);
    expect(state.snapshot().heldByReserve).toBe(1);
  });

  it("holds rather than dip under the reserve, and stops the pass", async () => {
    await graduateWithHolders(db, "0xm1", { usdPrice: 1 });
    const vault = fakeVault({ ...twoEpochs, weights: bothHold, balance: MONAD_RESERVE_WEI + 1n });
    const result = await runPayoutPass(db, vault.chain, state, { minUsd: 5 });
    expect(vault.sent).toEqual([]);
    expect(result.capped).toBe(true);
    expect(state.snapshot().heldByReserve).toBe(1);
  });

  it("stops at the per-pass cap and picks up the rest next pass", async () => {
    await graduateWithHolders(db, "0xm1", { usdPrice: 1 });
    const vault = fakeVault({ ...twoEpochs, weights: bothHold });
    const first = await runPayoutPass(db, vault.chain, state, { minUsd: 5, maxClaims: 1 });
    expect(first.capped).toBe(true);
    expect(vault.sent.map((s) => s.holder)).toEqual([A]);
    const second = await runPayoutPass(db, vault.chain, state, { minUsd: 5, maxClaims: 1 });
    expect(second.claimed.map((c) => c.holder)).toEqual([B]);
  });

  it("backs off a holder whose claim fails and gives up after the limit, without blocking the next holder", async () => {
    await graduateWithHolders(db, "0xm1", { usdPrice: 1 });
    const vault = fakeVault({ ...twoEpochs, weights: bothHold, failClaim: new Error("boom") });
    let now = 1_000_000;
    const clock = () => now;
    const first = await runPayoutPass(db, vault.chain, state, { minUsd: 5 }, clock);
    expect(first.failed).toBe(2);
    // Inside the backoff nothing is retried.
    now += 1_000;
    expect((await runPayoutPass(db, vault.chain, state, { minUsd: 5 }, clock)).failed).toBe(0);
    for (let i = 1; i < MAX_ATTEMPTS; i += 1) {
      now += 60 * 60_000;
      await runPayoutPass(db, vault.chain, state, { minUsd: 5 }, clock);
    }
    expect(state.gaveUp(`0xm1-vault:${A}`.toLowerCase())).toBe(true);
    expect(state.snapshot().givenUp).toBe(2);
  });
});

describe("a claim somebody else sent first", () => {
  let db: Db;
  let state: KeeperState;
  beforeEach(async () => {
    db = await memoryDb();
    state = new KeeperState(KEEPER);
  });

  it("is not a failure: the holder is paid, nothing is backed off, and the pass says so", async () => {
    await graduateWithHolders(db, "0xm1", { usdPrice: 1 });
    const vault = fakeVault({ head: 3n * EPOCH + 1n, epochs: [pot(0), pot(1)], weights: { [A]: { "0": 600n * MON, "1": 600n * MON } } });
    // The holder's own claim lands between the keeper's plan and its send: the chain then
    // answers NothingToClaim, which the adapter surfaces as a reverted receipt.
    const preempting: PayoutChain = { ...vault.chain };
    preempting.claim = async (v, holder, from, to, gas) => {
      await vault.chain.claim(v, holder, from, to, gas); // somebody else's claim, paid to the holder
      throw new Error("claim(...) reverted in 0xdead");
    };
    const result = await runPayoutPass(db, preempting, state, { minUsd: 5 });
    expect(result.preempted).toBe(1);
    expect(result.failed).toBe(0);
    expect(state.snapshot().givenUp).toBe(0);
    expect(state.snapshot().payoutsPreempted).toBe(1);
    expect(state.due(`0xm1-vault:${A}`.toLowerCase(), Date.now())).toBe(true);
  });
});

describe("a capped pass and the holder cursor", () => {
  let db: Db;
  let state: KeeperState;
  beforeEach(async () => {
    db = await memoryDb();
    state = new KeeperState(KEEPER);
  });

  it("parks the cursor on the last holder it visited, so the next pass carries on from there", async () => {
    const C = "0x00000000000000000000000000000000000000c3" as const;
    await graduateWithHolders(db, "0xm1", {
      usdPrice: 1,
      holders: [
        [A, 600n * MON],
        [B, 400n * MON],
        [C, 300n * MON],
      ],
    });
    // Three holders of 600, 400 and 300 over an eligible supply of 1,300, so the pots cover all three.
    const supply = 1300n * MON;
    const epochs = [{ ...pot(0), eligibleSupply: supply }, { ...pot(1), eligibleSupply: supply }];
    const weights = {
      [A]: { "0": 600n * MON, "1": 600n * MON },
      [B]: { "0": 400n * MON, "1": 400n * MON },
      [C]: { "0": 300n * MON, "1": 300n * MON },
    };
    const vault = fakeVault({ head: 3n * EPOCH + 1n, epochs, weights });
    // One page holds all three; one claim per pass. Nobody may be skipped.
    const paid = async () =>
      (await runPayoutPass(db, vault.chain, state, { minUsd: 1, maxClaims: 1, pageSize: 3 })).claimed.map((c) => c.holder);
    expect(await paid()).toEqual([A]);
    expect(state.payoutCursor("0xm1")).toBe(`${600n * MON}:${A}`);
    expect(await paid()).toEqual([B]);
    expect(await paid()).toEqual([C]);
    // The page was walked to its end on that pass, so the walk starts over next time.
    expect(state.payoutCursor("0xm1")).toBeNull();
    expect(await paid()).toEqual([]);
  });
});
