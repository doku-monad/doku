import { erc20Abi as tokenAbi, decodeEventLog, parseAbi, parseEther } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApi } from "../src/app/index.js";
import type { Db } from "../src/db/legacy.js";
import { curve2Abi } from "../src/indexer/abi.js";
import { ingestOnce, type IngestConfig, NATIVE_CURRENCY } from "../src/indexer/ingestion/ingest.js";
import { SINK_BURN, SINK_CREATOR, SINK_REWARDS } from "../src/indexer/generations.js";
import { startScenario, type Scenario } from "./anvil.js";
import { memoryDatabase, transactional } from "./helpers.js";

/**
 * The generation-1 factory, which this chain does not have. See `ingest.test.ts` for why it is a
 * dead address rather than the gen-2 one: attribution must not depend on map insertion order.
 */
const NO_GEN1_FACTORY = "0x0000000000000000000000000000000000000f01" as const;

const curveAbi = parseAbi([
  "function buy(uint256 minBaseOut, uint256 deadline) payable returns (uint256)",
  "function buyWithToken(uint256 quoteIn, uint256 minBaseOut, uint256 deadline) returns (uint256)",
  "function collectFees()",
  "function collectTax()",
  "function collectProtocolFees()",
  "function pendingFees() view returns (uint256)",
  "function pendingProtocol() view returns (uint256)",
  "function pendingTax() view returns (uint256)",
  "function readyToGraduate() view returns (bool)",
]);
const hookAbi = parseAbi([
  "function sweep(bytes32 id)",
  "function pendingProtocol(bytes32 id) view returns (uint256)",
  "function pendingSink(bytes32 id) view returns (uint256)",
]);
const sinkAbi = parseAbi([
  "function pull(address market)",
  "function claim(address quote)",
  "function claimable(address who, address quote) view returns (uint256)",
]);
const swapRouterAbi = parseAbi([
  "function swap((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, (bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96) params, (bool takeClaims, bool settleUsingBurn) testSettings, bytes hookData) payable returns (int256)",
]);

/** The tick range's ends, one tick inside — a swap may not cross the boundary itself. */
const MIN_SQRT_PRICE_LIMIT = 4295128740n;
const MAX_SQRT_PRICE_LIMIT = 1461446703485210103287273052203988822378723970341n;
const NO_HOOK_DATA = "0x" as const;
const DEFAULT_SETTINGS = { takeClaims: false, settleUsingBurn: false } as const;

/**
 * What the money did, recorded as it moved.
 *
 * Balance deltas measured across the transactions that moved them, because the claim this suite is
 * making is that money ARRIVED — not that a call returned. A row in `fee_events` says the indexer
 * read a log; a balance that went up says the log was about something real.
 */
interface Moved {
  /** USDC that reached the creator when the CREATOR curve's routed share and tax were collected. */
  collectedFromCurve: bigint;
  /** USDC that reached the creator from `CreatorSink.claim`, after graduation and a pool levy. */
  claimedFromSink: bigint;
  /** What `CreatorSink.pull` credited before the claim emptied it. */
  creditedBySink: bigint;
  /** Native MON that reached the treasury from the BURN curve's `collectProtocolFees`. */
  protocolFromCurve: bigint;
}

/**
 * The whole generation-2 protocol, on a chain that ran it.
 *
 * `ingest.test.ts` proves the indexer follows ONE generation-2 market — native MON, routing BURN.
 * The three routings are not variations on a theme, though: BURN spends its routed share on the
 * curve as it accrues and holds nothing, REWARDS escrows until a vault exists, and CREATOR accrues
 * to a shared sink a person claims from. A suite that saw one of them would leave the other two
 * decoded only against synthetic logs — including the six-decimal quote, which is where a scale
 * assumption baked in anywhere finally shows up.
 *
 * So this drives all three, past graduation, through the pool, and out the other side into a
 * wallet. Every assertion below is about a stored row or an on-chain balance.
 */
describe("gen-2 lifecycle on anvil", () => {
  let s: Scenario;
  let db: Db;
  let api: ReturnType<typeof createApi>;
  let cfg: IngestConfig;
  let usdcPoolId: `0x${string}`;
  const moved: Moved = {
    collectedFromCurve: 0n,
    claimedFromSink: 0n,
    creditedBySink: 0n,
    protocolFromCurve: 0n,
  };

  /**
   * One transaction, mined, and refused if it reverted.
   *
   * Loosely typed on purpose: `writeContract`'s parameter is a generic union over the ABI, the
   * function name and whether the call is payable, and a helper that has to serve all of them
   * cannot name that type without re-deriving it per call. The receipt check is what matters —
   * viem resolves a reverted transaction rather than throwing, so without it a failed collection
   * would look exactly like a successful one.
   */
  const send = async (call: Record<string, unknown>): Promise<void> => {
    const hash = await s.wallet.writeContract(call as never);
    const receipt = await s.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("transaction reverted");
  };
  const mine = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) await s.client.request({ method: "anvil_mine", params: [] } as never);
  };
  /**
   * Ingest until the checkpoint reaches the head.
   *
   * One pass covers `DEFAULT_MAX_RANGE` blocks, and this scenario mines one transaction per block
   * and then drives a dozen more of its own. A single `ingestOnce` — which is all the older suites
   * need — silently stops short of the last of them, and every assertion after that would be about
   * a range that was never read.
   */
  const catchUp = async (): Promise<void> => {
    for (let i = 0; i < 60; i++) {
      const { to, head } = await ingestOnce(s.client, db, cfg);
      if (to >= head - 8n) return;
    }
    throw new Error("ingest never reached the head");
  };
  const usdcBalance = (who: `0x${string}`): Promise<bigint> =>
    s.client.readContract({ address: s.usdc, abi: tokenAbi, functionName: "balanceOf", args: [who] });

  beforeAll(async () => {
    s = await startScenario(8563, { extraMarkets: true });
    const database = await memoryDatabase();
    db = database.legacy;
    api = createApi(database);
    cfg = {
      factory: NO_GEN1_FACTORY,
      factory2: s.factory,
      graduation: s.graduation,
      graduation2: s.graduation,
      hook2: s.hook,
      creatorSink: s.creatorSink,
      quoteRegistry: s.quoteRegistry,
      poolManager: s.poolManager,
      positionManager: s.positionManager,
      startBlock: 0n,
      ...transactional(database),
    };

    const me = s.wallet.account!.address;
    const account = s.wallet.account!;
    const chain = s.wallet.chain;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const creator = s.usdcMarket!;
    const holders = s.holdersMarket!;

    await send({ address: s.usdc, abi: tokenAbi, functionName: "approve", args: [creator.curve, 2n ** 255n], chain, account });
    await send({ address: s.usdc, abi: tokenAbi, functionName: "approve", args: [s.swapRouter, 2n ** 255n], chain, account });

    // A buy inside the anti-sniper window, then a collection — so `routed_collected` and
    // `tax_collected` are non-zero BEFORE the market fills. Collecting everything at the end would
    // leave `pending` at zero, and "0 == 0" is not a test of the identity.
    await send({ address: creator.curve, abi: curveAbi, functionName: "buyWithToken", args: [500_000_000n, 0n, deadline], chain, account });
    const beforeCollect = await usdcBalance(me);
    await send({ address: creator.curve, abi: curveAbi, functionName: "collectFees", args: [], chain, account });
    await send({ address: creator.curve, abi: curveAbi, functionName: "collectTax", args: [], chain, account });
    moved.collectedFromCurve = (await usdcBalance(me)) - beforeCollect;

    /**
     * The buy that fills the CREATOR market, with the gas spelled out.
     *
     * `_tryAutoGraduate` forwards at most 63/64 of what is left to the graduator and SWALLOWS the
     * failure, so a transaction sent at exactly the estimator's figure fills the curve, fails to
     * graduate, and still succeeds — leaving a market that is ready and has no pool. Estimation
     * cannot see it, because the outer call returns fine either way.
     */
    await send({ address: creator.curve, abi: curveAbi, functionName: "buyWithToken", args: [40_000_000_000n, 0n, deadline], chain, account, gas: 12_000_000n });

    // The REWARDS market: a native buy whose routed share escrows on the curve. Never filled, so
    // it stays escrowed, which is the state the other two markets cannot show.
    await send({ address: holders.curve, abi: curveAbi, functionName: "buy", args: [0n, deadline], value: parseEther("3"), chain, account });

    await mine(8);
    await catchUp();

    usdcPoolId = (
      await db.query<{ pool_id: string }>("SELECT pool_id FROM graduations WHERE market_address = $1", [creator.curve])
    ).rows[0]!.pool_id as `0x${string}`;

    // A pool swap on each graduated market. The USDC one carries a creator tax, so it is the one
    // that emits `TaxLevied`; both accrue the hook's protocol share, which `sweep` materialises.
    const [c0, c1] = [s.usdc, creator.token].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)) as [`0x${string}`, `0x${string}`];
    const usdcIsCurrency0 = c0.toLowerCase() === s.usdc.toLowerCase();
    await send({
      address: s.swapRouter, abi: swapRouterAbi, functionName: "swap",
      args: [
        { currency0: c0, currency1: c1, fee: 0, tickSpacing: 60, hooks: s.hook },
        { zeroForOne: usdcIsCurrency0, amountSpecified: -100_000_000n, sqrtPriceLimitX96: usdcIsCurrency0 ? MIN_SQRT_PRICE_LIMIT : MAX_SQRT_PRICE_LIMIT },
        DEFAULT_SETTINGS, NO_HOOK_DATA,
      ],
      chain, account,
    });
    await send({
      address: s.swapRouter, abi: swapRouterAbi, functionName: "swap",
      args: [
        { currency0: NATIVE_CURRENCY as `0x${string}`, currency1: s.token, fee: 0, tickSpacing: 60, hooks: s.hook },
        { zeroForOne: true, amountSpecified: -parseEther("2"), sqrtPriceLimitX96: MIN_SQRT_PRICE_LIMIT },
        DEFAULT_SETTINGS, NO_HOOK_DATA,
      ],
      value: parseEther("2"), chain, account,
    });

    // `sweep` is permissionless and is what turns the hook's accrued claims into real balances —
    // and into the `Swept` this suite reads. `CreatorSink.pull` sweeps only when the SINK share is
    // non-zero, so on a CREATOR market the protocol share would otherwise never be materialised.
    for (const id of [usdcPoolId, s.poolId]) {
      const protocol = await s.client.readContract({ address: s.hook, abi: hookAbi, functionName: "pendingProtocol", args: [id] });
      const sink = await s.client.readContract({ address: s.hook, abi: hookAbi, functionName: "pendingSink", args: [id] });
      if (protocol > 0n || sink > 0n) {
        await send({ address: s.hook, abi: hookAbi, functionName: "sweep", args: [id], chain, account });
      }
    }

    // The shared sink, end to end: the hook's ledger pulled into a claimable balance, then claimed
    // into a wallet.
    await send({ address: s.creatorSink, abi: sinkAbi, functionName: "pull", args: [creator.curve], chain, account });
    moved.creditedBySink = await s.client.readContract({ address: s.creatorSink, abi: sinkAbi, functionName: "claimable", args: [me, s.usdc] });
    const beforeClaim = await usdcBalance(me);
    await send({ address: s.creatorSink, abi: sinkAbi, functionName: "claim", args: [s.usdc], chain, account });
    moved.claimedFromSink = (await usdcBalance(me)) - beforeClaim;

    // The protocol's own share, off the BURN curve. Native, and the scenario runs a zero base fee,
    // so the wallet's MON balance moves by the collected amount less only the priority tip.
    const monBefore = await s.client.getBalance({ address: me });
    await send({ address: s.curve, abi: curveAbi, functionName: "collectProtocolFees", args: [], chain, account });
    moved.protocolFromCurve = (await s.client.getBalance({ address: me })) - monBefore;

    await mine(8);
    await catchUp();
  }, 900_000);

  afterAll(() => s?.stop());

  /** `/rewards` as the frontend reads it, so `pending` comes from the query that serves it. */
  const rewards = async (market: string): Promise<Record<string, string>> => {
    const res = await api.request(`http://x/markets/${market}/rewards`);
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, string>;
  };
  const pendingFees = (curve: `0x${string}`): Promise<bigint> =>
    s.client.readContract({ address: curve, abi: curveAbi, functionName: "pendingFees" });

  /**
   * The quote asset, its decimals and the routing — three columns the launch event carries only two
   * of.
   *
   * `quote_decimals` is the third, and it is read out of `quote_assets` at launch. It was stored as
   * 18 for the six-decimal market until the ingester was made to apply `QuoteAssetRegistered`
   * before the launches in the same range: it is the exponent every USD figure for that market is
   * divided by, so an 18 there is a market cap a trillion times too small, and nothing throws.
   */
  it("records all three markets with their quote, decimals and routing", async () => {
    const { rows } = await db.query<{
      market_address: string; quote_asset: string; quote_decimals: number; routing: number; generation: number;
    }>("SELECT market_address, quote_asset, quote_decimals, routing, generation FROM markets ORDER BY block_number");
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.generation).toBe(2);

    const burn = rows.find((r) => r.market_address === s.curve)!;
    const creator = rows.find((r) => r.market_address === s.usdcMarket!.curve)!;
    const holders = rows.find((r) => r.market_address === s.holdersMarket!.curve)!;

    expect(burn.routing).toBe(SINK_BURN);
    expect(burn.quote_asset).toBe(NATIVE_CURRENCY);
    expect(burn.quote_decimals).toBe(18);

    expect(holders.routing).toBe(SINK_REWARDS);
    expect(holders.quote_asset).toBe(NATIVE_CURRENCY);
    expect(holders.quote_decimals).toBe(18);

    expect(creator.routing).toBe(SINK_CREATOR);
    expect(creator.quote_asset).toBe(s.usdc);
    // The whole point of the six-decimal quote being in the scenario at all.
    expect(creator.quote_decimals).toBe(6);

    // And it agrees with the token itself, not merely with the registry row.
    const onChain = await s.client.readContract({
      address: s.usdc,
      abi: parseAbi(["function decimals() view returns (uint8)"]),
      functionName: "decimals",
    });
    expect(creator.quote_decimals).toBe(Number(onChain));
  });

  /**
   * Every stored curve price is the number the curve emitted, on every market.
   *
   * Not re-derived here: generation 2 EMITS the post-trade spot (`quote * 1e36 / base`), and
   * recomputing it in the test would be reimplementing the virtual reserves and then agreeing with
   * my own arithmetic. The comparison is against the chain's own log.
   */
  it("prices trades exactly as the curve emitted them", async () => {
    const emitted = new Map<string, bigint>();
    for (const curve of [s.curve, s.usdcMarket!.curve, s.holdersMarket!.curve]) {
      const logs = await s.client.getLogs({ address: curve, fromBlock: 0n, toBlock: "latest" });
      for (const log of logs) {
        try {
          const d = decodeEventLog({ abi: curve2Abi, data: log.data, topics: log.topics });
          if (d.eventName !== "Bought" && d.eventName !== "Sold") continue;
          emitted.set(`${log.transactionHash}:${log.logIndex}`, (d.args as { price: bigint }).price);
        } catch {
          // Not a curve trade: the same receipts carry the token's `Transfer`.
        }
      }
    }
    // Four on the BURN market, two on the CREATOR market, one on the REWARDS market.
    expect(emitted.size).toBe(7);

    const { rows } = await db.query<{ tx_hash: string; log_index: number; price: string }>(
      "SELECT tx_hash, log_index, price FROM swaps WHERE venue = 'curve' ORDER BY id",
    );
    expect(rows).toHaveLength(emitted.size);
    for (const row of rows) {
      const key = `${row.tx_hash}:${row.log_index}`;
      expect(emitted.has(key), `no chain price for ${key}`).toBe(true);
      expect(BigInt(row.price)).toBe(emitted.get(key)!);
    }
  });

  /**
   * The derived split, to the wei, against what the curve still holds plus what it paid out.
   *
   * Neither `Bought` nor `Sold` carries the protocol/routed split — the indexer derives it from
   * `fee` at 30/70 — so this is the only place that derivation meets the contract's own
   * accounting. Summed over both, because a collection moves money out of `pendingProtocol` and a
   * check against the pending figure alone would pass on a market that had never collected.
   */
  it("splits fees to the wei against pendingProtocol() plus what was collected", async () => {
    for (const curve of [s.curve, s.usdcMarket!.curve, s.holdersMarket!.curve] as const) {
      const { rows } = await db.query<{ generated: string; collected: string }>(
        `SELECT COALESCE(SUM(amount) FILTER (WHERE kind = 'protocol'), 0)::text AS generated,
                COALESCE(SUM(amount) FILTER (WHERE kind = 'protocol_collected'), 0)::text AS collected
           FROM fee_events WHERE market_address = $1 AND venue = 'curve'`,
        [curve],
      );
      const generated = BigInt(rows[0]!.generated);
      const collected = BigInt(rows[0]!.collected);
      // Non-vacuous: every one of these markets was traded.
      expect(generated).toBeGreaterThan(0n);
      const stillHeld = await s.client.readContract({ address: curve, abi: curveAbi, functionName: "pendingProtocol" });
      expect(generated - collected).toBe(stillHeld);
    }
    // And the collection this suite drove really moved native MON into the treasury's wallet.
    expect(moved.protocolFromCurve).toBeGreaterThan(0n);
  });

  /**
   * CREATOR: what `/rewards` calls pending is what the curve says it still owes.
   *
   * Non-trivially so — the market was collected from once before it filled, so `pending` here is
   * `generated − collected` with both terms non-zero rather than an untouched total.
   */
  it("routed pending equals pendingFees() on the CREATOR market, after a real collection", async () => {
    const market = s.usdcMarket!.curve;
    const r = await rewards(market);
    expect(BigInt(r.routedGenerated!)).toBeGreaterThan(0n);
    expect(BigInt(r.routedCollected!)).toBeGreaterThan(0n);
    expect(BigInt(r.pending!)).toBe(await pendingFees(market));
    expect(BigInt(r.pending!)).toBeGreaterThan(0n);
    // Everything collected reached the creator by one of two doors: the curve's own collection
    // (routed share and creator tax, pre-graduation) and the CreatorSink `pull` of the hook's
    // levy (post-graduation). Both are collections on the market's ledger; before generation 4 the
    // hook donated its LP share to the pool and only the curve door existed here.
    expect(moved.collectedFromCurve + moved.creditedBySink).toBe(BigInt(r.routedCollected!) + BigInt(r.taxCollected!));
    expect(moved.collectedFromCurve).toBeGreaterThan(0n);
    expect(moved.creditedBySink).toBeGreaterThan(0n);
  });

  /** REWARDS: the routed share escrows on the curve, with no vault to pay yet. */
  it("routed pending equals pendingFees() on the HOLDERS market, escrowed until graduation", async () => {
    const market = s.holdersMarket!.curve;
    const r = await rewards(market);
    const escrowed = await pendingFees(market);
    expect(escrowed).toBeGreaterThan(0n);
    expect(BigInt(r.pending!)).toBe(escrowed);
    // Nothing has been collected, because there is nowhere for it to go before the pool exists.
    expect(BigInt(r.routedCollected!)).toBe(0n);
    expect(BigInt(r.routedGenerated!)).toBe(escrowed);
  });

  /**
   * BURN: nothing pends, ever, and that is not the same as nothing having been earned.
   *
   * The routed share is spent on the curve and burned as it accrues, so `pendingFees()` is
   * permanently zero while `routed_generated` keeps climbing. Subtracting a `routed_collected`
   * nothing ever writes would report a forever-growing balance nobody can collect, so `/rewards`
   * special-cases the routing — and this is where that case is checked against the chain.
   */
  it("routed pending is 0 on the BUYBACK market, and so is pendingFees()", async () => {
    const r = await rewards(s.curve);
    expect(BigInt(r.routedGenerated!)).toBeGreaterThan(0n);
    expect(BigInt(r.routedCollected!)).toBe(0n);
    expect(await pendingFees(s.curve)).toBe(0n);
    expect(r.pending).toBe("0");
  });

  /**
   * The PoolId, reproduced from a key the event does not carry.
   *
   * Generation 2's `Graduated` emits the quote asset and the id and nothing else about the pool, so
   * `handleGraduated2` rebuilds the `PoolKey` and refuses the row unless it hashes to the emitted
   * id. Both markets are checked because they sort OPPOSITE ways: native MON is `address(0)` and is
   * always `currency0`, while the USDC market's currencies sort by address and either can win.
   */
  it("reproduces the PoolId from the reconstructed key, on both sort orders", async () => {
    const { rows } = await db.query<{
      market_address: string; pool_id: string; currency0: string; currency1: string; fee: number; tick_spacing: number; hooks: string; quote_asset: string;
    }>("SELECT market_address, pool_id, currency0, currency1, fee, tick_spacing, hooks, quote_asset FROM graduations ORDER BY block_number");
    expect(rows).toHaveLength(2);

    const burn = rows.find((r) => r.market_address === s.curve)!;
    expect(burn.pool_id).toBe(s.poolId);
    expect(burn.currency0).toBe(NATIVE_CURRENCY);
    expect(burn.currency1).toBe(s.token);

    const creator = rows.find((r) => r.market_address === s.usdcMarket!.curve)!;
    expect(creator.quote_asset).toBe(s.usdc);
    // Sorted, not assumed — and the pair is exactly {quote, token} whichever way round it came out.
    expect([creator.currency0, creator.currency1].sort()).toEqual([s.usdc, s.usdcMarket!.token].sort());
    expect(BigInt(creator.currency0)).toBeLessThan(BigInt(creator.currency1));

    for (const g of rows) {
      expect(g.hooks).toBe(s.hook);
      expect(g.tick_spacing).toBe(60);
      // A row that reached the table at all is a key that hashed to the emitted id; an empty key
      // would be a row that looks indexed and is not.
      expect(g.pool_id).not.toBe("");
      expect(g.currency0).not.toBe("");
    }
  });

  /**
   * The hook's two events, attributed by pool id rather than by address.
   *
   * The hook is one contract for every DOKU pool, so `log.address` says which protocol emitted a
   * levy and nothing about which market it belongs to. Both pools were swapped and both were swept,
   * so a handler that keyed on anything but the id would put one market's money on the other.
   */
  it("attributes hook TaxLevied and Swept to the right market", async () => {
    const { rows } = await db.query<{ market_address: string; kind: string; total: string }>(
      `SELECT market_address, kind, SUM(amount)::text AS total
         FROM fee_events WHERE venue = 'pool' GROUP BY market_address, kind`,
    );
    const of = (market: string, kind: string): bigint | undefined => {
      const row = rows.find((r) => r.market_address === market && r.kind === kind);
      return row ? BigInt(row.total) : undefined;
    };

    // `TaxLevied` — only the CREATOR market carries a creator tax, so only it has one.
    expect(of(s.usdcMarket!.curve, "tax")).toBeGreaterThan(0n);
    expect(of(s.curve, "tax")).toBeUndefined();

    // `Swept` — the hook's protocol share, materialised on both pools, in each market's own quote.
    const creatorProtocol = of(s.usdcMarket!.curve, "protocol")!;
    const burnProtocol = of(s.curve, "protocol")!;
    expect(creatorProtocol).toBeGreaterThan(0n);
    expect(burnProtocol).toBeGreaterThan(0n);
    // Six-decimal USDC against 18-decimal MON: if the two had been swapped between markets the
    // amounts would be twelve orders of magnitude out, which is the failure this ordering catches.
    expect(creatorProtocol).toBeLessThan(burnProtocol);

    // Every pool-venue row belongs to a market that actually has a pool.
    for (const row of rows) {
      const { rows: g } = await db.query("SELECT 1 FROM graduations WHERE market_address = $1", [row.market_address]);
      expect(g).toHaveLength(1);
    }
  });

  /**
   * The shared sink's ledger, balanced against the sink's own mapping.
   *
   * `creator_balances.claimable` is a SUM of signed ledger deltas — credits positive, claims
   * negative — and `CreatorSink.claimable(who, quote)` is the contract's own number. Both are zero
   * here, and that is the point: the money was credited and then claimed, so a projection that
   * counted only credits would read five dollars against a contract holding nothing.
   */
  it("balances the CreatorSink against claimable() on chain", async () => {
    const me = s.wallet.account!.address.toLowerCase();
    const { rows } = await db.query<{ claimable: string; earned_lifetime: string }>(
      "SELECT claimable::text, earned_lifetime::text FROM creator_balances WHERE who = $1 AND quote_asset = $2",
      [me, s.usdc],
    );
    expect(rows).toHaveLength(1);

    const onChain = await s.client.readContract({
      address: s.creatorSink, abi: sinkAbi, functionName: "claimable",
      args: [s.wallet.account!.address, s.usdc],
    });
    expect(BigInt(rows[0]!.claimable)).toBe(onChain);

    // Non-vacuous: money really passed through the sink and out into the wallet.
    expect(moved.creditedBySink).toBeGreaterThan(0n);
    expect(moved.claimedFromSink).toBe(moved.creditedBySink);

    /**
     * Lifetime earnings are BOTH routes, not just the sink's.
     *
     * A creator is paid two ways: the curve pushes directly on `collectFees`/`collectTax` while it
     * is still open, and the hook's levy is pulled into the shared sink once the market has
     * graduated. `earned_lifetime` is the sum of the two, so it is what the wallet actually
     * received across every collection this suite drove — 28.5 USDC pushed, 5 pulled.
     */
    expect(BigInt(rows[0]!.earned_lifetime)).toBe(moved.collectedFromCurve + moved.creditedBySink);

    // And the ledger rows the projection was built from, in every kind the two routes emit.
    const { rows: kinds } = await db.query<{ kind: string }>(
      "SELECT DISTINCT kind FROM creator_ledger WHERE who = $1 ORDER BY kind", [me],
    );
    const seen = kinds.map((k) => k.kind);
    // The curve's direct push, before graduation.
    expect(seen).toContain("pushed");
    // The sink's pull of the hook's levy, and the withdrawal that emptied it, after.
    expect(seen).toContain("pulled_tax");
    expect(seen).toContain("credited");
    expect(seen).toContain("claimed");
  });

  /** The read surface, over data that came off a chain rather than out of a fixture. */
  it("serves the pairs surface over the ingested data", async () => {
    const me = s.wallet.account!.address;
    const json = async (path: string): Promise<Record<string, unknown>> => {
      const res = await api.request(`http://x${path}`);
      expect(res.status, path).toBe(200);
      return (await res.json()) as Record<string, unknown>;
    };

    // The registry has no catalogue id on a local chain — nothing seeded one — so the pair is the
    // quote's ADDRESS, which `listPaged` accepts as the same filter.
    const board = await json(`/markets?pair=${s.usdc}`);
    const items = board.items as { market_address: string; quote_decimals: number; routing: string }[];
    expect(items.map((i) => i.market_address)).toEqual([s.usdcMarket!.curve]);
    expect(items[0]!.quote_decimals).toBe(6);
    expect(items[0]!.routing).toBe("creator");
    // The chips count the whole board, not the filtered slice.
    expect((board.pairCounts as Record<string, number>)[NATIVE_CURRENCY]).toBe(2);

    const launches = await json(`/accounts/${me}/launches`);
    expect((launches.items as unknown[]).length).toBe(3);

    const creators = await json(`/creators/${me}`);
    expect((creators.markets as unknown[]).length).toBeGreaterThan(0);
    const lifetime = creators.earnedLifetime as { quoteAsset: string; amount: string }[];
    expect(lifetime.find((b) => b.quoteAsset === s.usdc)!.amount).toBe(
      (moved.collectedFromCurve + moved.creditedBySink).toString(),
    );

    const quotes = await json("/quotes");
    const registered = (quotes.items as { address: string | null; status: string; decimals: number }[])
      .filter((q) => q.status === "live");
    expect(registered.map((q) => q.address).sort()).toEqual([NATIVE_CURRENCY, s.usdc].sort());
    expect(registered.find((q) => q.address === s.usdc)!.decimals).toBe(6);
  });

  /**
   * Re-ingesting is not a rare event: it happens after every restart and after every reorg.
   *
   * The fee ledger is the part with a new way to go wrong — `market_rewards` is a projection, and a
   * second pass that inserted the same components again would double every figure on the rewards
   * page while every row count still looked plausible.
   */
  it("is a no-op when the range is ingested again", async () => {
    const snapshot = async () => {
      const { rows } = await db.query<{ table: string; n: string }>(
        `SELECT 'swaps' AS table, COUNT(*)::text AS n FROM swaps
         UNION ALL SELECT 'markets', COUNT(*)::text FROM markets
         UNION ALL SELECT 'graduations', COUNT(*)::text FROM graduations
         UNION ALL SELECT 'fee_events', COUNT(*)::text FROM fee_events
         UNION ALL SELECT 'creator_ledger', COUNT(*)::text FROM creator_ledger`,
      );
      const { rows: totals } = await db.query<{ market_address: string; routed: string; tax: string }>(
        "SELECT market_address, routed_generated::text AS routed, tax_generated::text AS tax FROM market_rewards ORDER BY market_address",
      );
      const { rows: balances } = await db.query<{ who: string; claimable: string; earned_lifetime: string }>(
        "SELECT who, claimable::text, earned_lifetime::text FROM creator_balances ORDER BY who",
      );
      return { rows, totals, balances };
    };
    const before = await snapshot();
    expect(Number(before.rows.find((r) => r.table === "fee_events")!.n)).toBeGreaterThan(0);

    await catchUp();
    await catchUp();

    expect(await snapshot()).toEqual(before);
  }, 300_000);
});
