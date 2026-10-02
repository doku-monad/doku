import { decodeEventLog, parseAbi } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/legacy.js";
import { rewindTo } from "../src/indexer/sync/rewind.js";
import { curve2Abi } from "../src/indexer/abi.js";
import { ingestOnce, type IngestConfig } from "../src/indexer/ingestion/ingest.js";
import { startScenario, type Scenario } from "./anvil.js";
import type { LiveEvent } from "../src/websocket/live.js";
import { memoryDatabase, transactional } from "./helpers.js";

const erc20BalanceAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/**
 * The generation-1 factory, which this chain does not have.
 *
 * `IngestConfig.factory` is required, and its only job is to attribute a `MarketLaunched` to a
 * generation. On a generation-2-only chain it therefore names an address no contract is at.
 * Pointing it at `s.factory` alongside `factory2` would also work — `factoryAbis` writes the
 * generation-2 entry second and it would win — but it would work by insertion order, and the day
 * that order changed every launch here would silently decode as generation 1.
 */
const NO_GEN1_FACTORY = "0x0000000000000000000000000000000000000f01" as const;
/**
 * The indexer against the real contracts.
 *
 * Everything here comes from a chain that actually ran: contracts compiled from source, a market
 * launched through the factory, taxed and untaxed trades, and a graduation into a live V3 pool.
 * The alternative — asserting against hand-written log fixtures — tests that the indexer agrees
 * with my idea of the contracts, which is exactly the thing most likely to be wrong.
 */
describe("ingest against a live chain", () => {
  let s: Scenario;
  let db: Db;
  let cfg: IngestConfig;

  beforeAll(async () => {
    s = await startScenario(8551);
    const database = await memoryDatabase();
    db = database.legacy;
    cfg = {
      // Generation 2 is what this chain runs. The addresses come from the scenario, and the
      // generation of a log is decided by the address that emitted it, never by its name.
      factory: NO_GEN1_FACTORY,
      factory2: s.factory,
      // `graduation` is both the default accepted `Graduated` emitter and the address the holder
      // count excludes, so it names the real graduator. `graduation2` and `quoteRegistry` are not
      // read yet; they are set so this cfg describes the chain rather than the current handlers.
      graduation: s.graduation,
      graduation2: s.graduation,
      // Without this the PoolKey rebuilt for every graduation cannot be checked against the
      // emitted id, and `handleGraduated2` throws rather than guess.
      hook2: s.hook,
      creatorSink: s.creatorSink,
      quoteRegistry: s.quoteRegistry,
      poolManager: s.poolManager,
      startBlock: 0n,
      ...transactional(database),
    };
    await ingestOnce(s.client, db, cfg);
  }, 300_000);

  afterAll(() => s?.stop());

  const count = async (table: string): Promise<number> => {
    const { rows } = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${table}`);
    return Number(rows[0]!.n);
  };

  it("records the launched market", async () => {
    const { rows } = await db.query<{ token_address: string; symbol: string; creator: string }>(
      "SELECT token_address, symbol, creator FROM markets WHERE market_address = $1",
      [s.curve],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_address).toBe(s.token);
    expect(rows[0]!.symbol.length).toBeGreaterThan(0);
  });

  it("records every trade, in both directions", async () => {
    const { rows } = await db.query<{ is_buy: boolean; quote_amount: string; tax: string }>(
      "SELECT is_buy, quote_amount, tax FROM swaps WHERE market_address = $1 ORDER BY block_number, log_index",
      [s.curve],
    );
    // Four, not three: generation 2 launches with a first buy inside the launch transaction
    // itself (`LocalScenario._launch` sets `firstBuyQuote`), so the indexer reads a launch and a
    // trade out of one receipt.
    expect(rows.map((r) => r.is_buy)).toEqual([true, true, false, true]);
    for (const r of rows) expect(BigInt(r.quote_amount)).toBeGreaterThan(0n);
  });

  /**
   * Generation 2 has TWO taxes, and `swaps.tax` is only the first of them.
   *
   * `tax` is the anti-sniper tax: charged on buys inside the opening window and burnt, owed to
   * nobody. The creator tax is a separate column (`creator_tax`) and a separate ledger row
   * (`fee_events.kind = 'tax'`), asserted in the test below. Left as one assertion on `tax` this
   * would quietly have become an assertion about whichever of the two the handler happened to put
   * there.
   *
   * The launch's own first buy is exempt — it happens inside the launch transaction — so the
   * window is exercised by the buys the scenario mines afterwards. A zero on those means the
   * indexer is reading the wrong field, not that the market was untaxed.
   */
  it("captures the anti-sniper tax, and only the anti-sniper tax, in swaps.tax", async () => {
    const { rows } = await db.query<{ tax: string; is_buy: boolean }>(
      `SELECT tax, is_buy FROM swaps
        WHERE market_address = $1 AND venue = 'curve' ORDER BY block_number, log_index`,
      [s.curve],
    );
    expect(rows.map((r) => r.is_buy)).toEqual([true, true, false, true]);
    expect(BigInt(rows[0]!.tax)).toBe(0n); // the launch buy, exempt
    expect(BigInt(rows[1]!.tax)).toBeGreaterThan(0n); // inside the window
    expect(BigInt(rows[2]!.tax)).toBe(0n); // a sell is never anti-sniped
    expect(BigInt(rows[3]!.tax)).toBeGreaterThan(0n); // the buy that fills the curve
  });

  /**
   * The creator tax, which is the other half of what generation 1 called `tax`.
   *
   * This market launched at `creatorTaxBps = 0` (`LocalScenario._launch` sets no creator tax), so
   * what a live chain can assert here is that the creator tax is zero everywhere it is recorded —
   * the column AND the ledger — while the protocol and routed halves of the same 1% fee are
   * ledgered on every trade. A non-zero creator tax on this market would mean the handler had
   * written the anti-sniper tax into the creator's row.
   *
   * The non-zero path is covered by `gen2-trades.test.ts` over synthetic logs, because the only
   * creator-taxed market this scenario launches is the USDC one and `LocalScenario._trade` never
   * trades it. No chain this suite can start carries a creator-taxed trade.
   */
  it("keeps the creator tax out of swaps.tax, and ledgers the fee split", async () => {
    const { rows: sw } = await db.query<{ creator_tax: string }>(
      "SELECT creator_tax FROM swaps WHERE market_address = $1 AND venue = 'curve'",
      [s.curve],
    );
    expect(sw).toHaveLength(4);
    for (const r of sw) expect(BigInt(r.creator_tax)).toBe(0n);

    const { rows: kinds } = await db.query<{ kind: string; n: string; total: string }>(
      `SELECT kind, COUNT(*)::text AS n, SUM(amount)::text AS total
         FROM fee_events WHERE market_address = $1 GROUP BY kind ORDER BY kind`,
      [s.curve],
    );
    expect(kinds.map((k) => k.kind)).toEqual(["protocol", "routed"]);
    for (const k of kinds) expect(Number(k.n)).toBe(sw.length);

    // And the projection agrees with the rows it is recomputed from.
    const { rows: rw } = await db.query<{ p: string; r: string; t: string }>(
      `SELECT protocol_generated::text AS p, routed_generated::text AS r, tax_generated::text AS t
         FROM market_rewards WHERE market_address = $1`,
      [s.curve],
    );
    expect(rw[0]!.p).toBe(kinds[0]!.total);
    expect(rw[0]!.r).toBe(kinds[1]!.total);
    expect(rw[0]!.t).toBe("0");
  });

  /// Amounts are 18-decimal, so they leave float64's exact range. Reading them back as the same
  /// integer is the whole reason the columns are NUMERIC(78,0) and the values stay strings.
  /**
   * Price tracks the curve, not the trade.
   *
   * A trade's average execution price is not comparable between directions: a buy walks the curve
   * upward so its average lands below the resulting price, a sell walks it downward so its average
   * lands above. Recording those made a sell print *higher* than the buy before it — the chart and
   * market cap both moved opposite to what had happened, on a real market, on a real chain.
   *
   * Generation 1 had to derive the post-trade spot from `quoteRaised`, so this asserted an
   * identity against `curveSpotPrice`. Generation 2 EMITS the spot price (`BondingCurve._price`:
   * raw quote per whole token, 18-dp fixed point) and the handler stores that field, so the
   * identity that means something now is against the chain's own number. Re-deriving it here from
   * `quoteRaised` would mean reimplementing generation 2's virtual reserves in the test, which is
   * the "agrees with my idea of the contracts" failure this suite exists to avoid.
   *
   * The two claims underneath are unchanged: the stored price is not the trade's own execution
   * ratio, and it rises and falls with what the curve has raised whichever direction the trade
   * went.
   */
  it("prices a curve trade by what the curve has raised, not by what the trade paid", async () => {
    // What the chain emitted, keyed the way a log is unique.
    const emitted = new Map<string, bigint>();
    const logs = await s.client.getLogs({ address: s.curve, fromBlock: 0n, toBlock: "latest" });
    for (const log of logs) {
      try {
        const d = decodeEventLog({ abi: curve2Abi, data: log.data, topics: log.topics });
        if (d.eventName !== "Bought" && d.eventName !== "Sold") continue;
        emitted.set(`${log.transactionHash}:${log.logIndex}`, (d.args as { price: bigint }).price);
      } catch {
        // Not a curve trade — the same transactions also emit the token's Transfer.
      }
    }
    expect(emitted.size).toBe(4);

    const { rows } = await db.query<{
      quote_raised: string;
      price: string;
      is_buy: boolean;
      quote_amount: string;
      base_amount: string;
      tx_hash: string;
      log_index: number;
    }>(
      `SELECT s.quote_raised, s.price, s.is_buy, s.quote_amount, s.base_amount, s.tx_hash, s.log_index
         FROM swaps s JOIN markets m USING (market_address)
        WHERE s.venue = 'curve' ORDER BY s.id`,
    );
    expect(rows.length).toBeGreaterThan(2);
    // A sell has to be in there, or the direction this guards is never exercised.
    expect(rows.some((r) => !r.is_buy)).toBe(true);

    for (const row of rows) {
      const key = `${row.tx_hash}:${row.log_index}`;
      expect(emitted.has(key), `no chain price for ${key}`).toBe(true);
      expect(BigInt(row.price)).toBe(emitted.get(key)!);

      // Not the trade's own ratio. Same scale as `_price` (1e36 per whole token), so a handler
      // that computed the average instead of reading the field would land here.
      const average = (BigInt(row.quote_amount) * 10n ** 36n) / BigInt(row.base_amount);
      expect(BigInt(row.price)).not.toBe(average);
    }

    // And therefore: more raised, higher price, whichever direction the trade went.
    for (const a of rows) {
      for (const b of rows) {
        if (BigInt(a.quote_raised) < BigInt(b.quote_raised)) {
          expect(BigInt(a.price)).toBeLessThanOrEqual(BigInt(b.price));
        }
      }
    }
  });

  it("stores trade amounts without rounding", async () => {
    const { rows } = await db.query<{ base_amount: string }>(
      "SELECT base_amount FROM swaps WHERE market_address = $1 ORDER BY base_amount DESC LIMIT 1",
      [s.curve],
    );
    const biggest = BigInt(rows[0]!.base_amount);
    expect(biggest).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    expect(rows[0]!.base_amount).toBe(biggest.toString());
  });

  it("tracks curve progress on market_state", async () => {
    const { rows } = await db.query<{
      quote_raised: string;
      trade_count: number;
      ready_to_graduate: boolean;
      pool_address: string | null;
      pool_id: string | null;
    }>("SELECT quote_raised, trade_count, ready_to_graduate, pool_address, pool_id FROM market_state WHERE market_address = $1",
      [s.curve]);
    const st = rows[0]!;
    // Four: the three the scenario mines plus the launch transaction's own first buy.
    expect(st.trade_count).toBe(4);
    expect(st.ready_to_graduate).toBe(true);
    // The PoolManager, and therefore the same value on every graduated market. v4 has no pool
    // contract, so this column no longer identifies anything — it only says "graduated". An
    // earlier revision read a `pool` field the v4 event does not have and wrote the string
    // "undefined" here, which is a value every non-null check accepts.
    expect(st.pool_address).toBe(s.poolManager);
    expect(st.pool_id).toBe(s.poolId);
  });

  /**
   * Under V3 this asserted that the recorded pool address had code, because a mismatched init code
   * hash produced a graduation pointing at an address no pool was ever deployed to. v4 has no pool
   * contract to check for: the equivalent question is whether the recorded PoolId is the one the
   * chain actually initialised, and the way to ask it is to read the pool's price back out of the
   * PoolManager. A PoolId nothing was initialised at reads zero.
   */
  it("records the graduation into a pool that exists on chain", async () => {
    const { rows } = await db.query<{
      pool_address: string;
      pool_id: string;
      currency0: string;
      currency1: string;
      fee: number;
      tick_spacing: number;
      hooks: string;
      liquidity: string;
    }>(
      `SELECT pool_address, pool_id, currency0, currency1, fee, tick_spacing, hooks, liquidity
         FROM graduations WHERE market_address = $1`,
      [s.curve],
    );
    expect(rows).toHaveLength(1);
    const g = rows[0]!;
    expect(g.pool_address).toBe(s.poolManager);
    expect(g.pool_id).toBe(s.poolId);

    /**
     * The whole PoolKey — and what these four columns prove has CHANGED.
     *
     * Generation 1 emitted the key and the indexer stored what it was given, so these asserted
     * that it had not dropped it: the columns silently held empty strings for a while, because
     * nothing read them.
     *
     * Generation 2 does not emit the key. What is stored is REBUILT from the quote asset and the
     * token the event carries, the graduator's own `LP_FEE` and `TICK_SPACING`, and the configured
     * hook — and then checked, because `handleGraduated2` refuses to record a graduation whose id
     * its key does not hash to. So the claim underneath these lines is now: the rebuilt key hashes
     * to the id the chain emitted, and `s.poolId` above is that id computed independently by the
     * scenario script from the PoolKey the graduator actually used.
     *
     * A weaker claim about the same columns, and the reason to keep them is unchanged: an empty
     * key is a row that looks indexed and is not.
     *
     * This is also the sort order the unit tests cannot get from a fixture by accident — native
     * MON is address(0), so here the market's token is `currency1`. `gen2-graduation.test.ts`
     * covers a market whose token sorts BELOW its quote and is therefore `currency0`.
     */
    expect(g.currency0).toBe("0x0000000000000000000000000000000000000000");
    expect(g.currency1).toBe(s.token);
    expect(g.fee).toBe(0);
    expect(g.tick_spacing).toBe(60);
    expect(g.hooks).toBe(s.hook);

    /**
     * The seed liquidity, which moved rather than disappeared.
     *
     * Generation 1's `Graduated` carried a `liquidity` field and this asserted it was non-zero —
     * a market that graduated into an empty pool is untradeable and looks fine. Generation 2's
     * event drops the field, so `graduations.liquidity` is 0 for every generation-2 row by
     * construction and asserting `> 0` on it would only ever be asserting `"0" > 0`.
     *
     * The fact itself is still on chain and still indexed: the PoolManager's `ModifyLiquidity`
     * for the locked position the graduation mints. Asserted there instead, which is a stronger
     * check than the old one — it is the pool's own accounting rather than a number the graduator
     * reported about itself.
     */
    expect(BigInt(g.liquidity)).toBe(0n);
    const { rows: positions } = await db.query<{ liquidity: string; tick_lower: number; tick_upper: number }>(
      `SELECT liquidity, tick_lower, tick_upper FROM positions WHERE pool_id = $1`,
      [s.poolId],
    );
    expect(positions).toHaveLength(1);
    expect(BigInt(positions[0]!.liquidity)).toBeGreaterThan(0n);
    // Full range, which is what a locked graduation position is.
    expect(positions[0]!.tick_lower).toBeLessThan(positions[0]!.tick_upper);

    // Through StateView, not the PoolManager: v4 has no `getSlot0` getter — pool state is read
    // with `extsload` at a computed storage slot, and this lens is what does that computation.
    const slot0 = await s.client.readContract({
      address: s.stateView,
      abi: parseAbi([
        "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
      ]),
      functionName: "getSlot0",
      args: [s.poolId],
    });
    expect(slot0[0]).toBeGreaterThan(0n);
  });

  /**
   * Holders, with the excluded set re-derived against the generation-2 graduation.
   *
   * The count is still 1 — the deployer is the only person on this chain — but the addresses that
   * have to be kept out of it are not the same three, and the old comment named them by
   * generation-1 behaviour. So this asserts the set rather than restating it: every address with a
   * positive balance is either the deployer or one of the contracts `recountHolders` excludes,
   * and the exclusions are read from the graduation row the indexer wrote.
   *
   * Doing it this way is what caught the ordering bug behind `handlePoolRegistered`'s recount:
   * `graduations.sink` arrives on a DEFERRED log, after every `Transfer` in the graduation
   * transaction has already been counted, so the sink's swept dust made it a holder and 2 is a
   * number nobody would have questioned.
   */
  it("counts holders without counting the curve, the pool, the hook or the sink", async () => {
    const { rows: st } = await db.query<{ holders: number }>(
      "SELECT holders FROM market_state WHERE market_address = $1",
      [s.curve],
    );
    const { rows: g } = await db.query<{ pool_address: string; hooks: string; sink: string }>(
      "SELECT pool_address, hooks, sink FROM graduations WHERE market_address = $1",
      [s.curve],
    );
    const { rows: balances } = await db.query<{ holder: string; balance: string }>(
      "SELECT holder, balance FROM token_balances WHERE token_address = $1 AND balance > 0",
      [s.token],
    );

    const excluded = new Set([
      s.curve,
      s.token,
      s.graduation,
      "0x000000000000000000000000000000000000dead",
      g[0]!.pool_address,
      g[0]!.hooks,
      g[0]!.sink,
    ]);
    // Non-empty, or the assertion below passes by excluding nothing.
    expect(g[0]!.sink).not.toBe("");
    const people = balances.filter((b) => !excluded.has(b.holder));
    expect(people.map((p) => p.holder)).toEqual([s.wallet.account!.address.toLowerCase()]);
    expect(st[0]!.holders).toBe(people.length);
    expect(st[0]!.holders).toBe(1);
  });

  /**
   * Balances, checked against the chain rather than against themselves.
   *
   * The token mints its supply before the factory announces the market, so the mint arrives for a
   * token the indexer has not yet registered. Dropped, it leaves the curve's balance negative by
   * the whole supply — a number nothing displays and therefore nothing catches.
   */
  it("mirrors on-chain token balances", async () => {
    const { rows } = await db.query<{ holder: string; balance: string }>(
      "SELECT holder, balance FROM token_balances WHERE token_address = $1",
      [s.token],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const onChain = await s.client.readContract({
        address: s.token,
        abi: erc20BalanceAbi,
        functionName: "balanceOf",
        args: [row.holder as `0x${string}`],
      });
      expect(row.balance, `balance of ${row.holder}`).toBe(onChain.toString());
    }
  });

  /**
   * Ingestion announces what changed.
   *
   * Announced *after* the range is committed, and only what changed plus its address — never a
   * payload to merge. A client told about a swap before its aggregates land would refetch, see
   * nothing new, and then sit on stale numbers until the next event.
   */
  it("announces every kind of change exactly once per range", async () => {
    const freshDatabase = await memoryDatabase();
    const events: LiveEvent[] = [];

    await ingestOnce(s.client, freshDatabase.legacy, {
      ...cfg,
      ...transactional(freshDatabase),
      live: { publish: (e) => events.push(e), clientCount: () => 1, close: async () => {} },
    });

    const kinds = events.map((e) => e.type);
    expect(kinds).toContain("market");
    expect(kinds).toContain("swap");
    expect(kinds).toContain("graduation");

    // Three trades in the scenario, but one "swap" announcement: the client refetches the market,
    // so telling it three times is three identical round trips for one answer.
    expect(kinds.filter((k) => k === "swap")).toHaveLength(1);
    for (const event of events) expect(event.market).toBe(s.curve);
  }, 120_000);

  it("builds candlesticks from the trades", async () => {
    expect(await count("candlesticks")).toBeGreaterThan(0);
    const { rows } = await db.query<{ high: string; low: string; open: string; close: string }>(
      "SELECT high, low, open, close FROM candlesticks WHERE market_address = $1 AND period_secs = 60",
      [s.curve],
    );
    expect(rows.length).toBeGreaterThan(0);
    // Compared as numbers, not BigInt: the column is NUMERIC(78,18) and reads back with a
    // fractional part. Ordering is what is being asserted, and it survives the conversion.
    for (const c of rows) {
      expect(Number(c.high)).toBeGreaterThanOrEqual(Number(c.low));
      expect(Number(c.high)).toBeGreaterThanOrEqual(Number(c.open));
      expect(Number(c.low)).toBeLessThanOrEqual(Number(c.close));
    }
  });

  /// Re-ingesting is not a rare event — it happens after every restart and every reorg. If it
  /// doubles volume, the charts are wrong and nothing throws to say so.
  it("is a no-op when the same range is ingested again", async () => {
    const before = {
      swaps: await count("swaps"),
      markets: await count("markets"),
      graduations: await count("graduations"),
    };
    const { rows: v0 } = await db.query<{ volume_quote: string; trade_count: number }>(
      "SELECT volume_quote, trade_count FROM market_state WHERE market_address = $1",
      [s.curve],
    );

    await rewindTo(db, 0n);
    await db.query("UPDATE indexer_status SET last_block = 0, last_block_hash = NULL WHERE id = 1");
    // Re-ingest from scratch without clearing market_state, which is where double counting would
    // show up.
    await ingestOnce(s.client, db, cfg);
    await ingestOnce(s.client, db, cfg);

    expect(await count("swaps")).toBe(before.swaps);
    expect(await count("markets")).toBe(before.markets);
    expect(await count("graduations")).toBe(before.graduations);

    const { rows: v1 } = await db.query<{ volume_quote: string; trade_count: number }>(
      "SELECT volume_quote, trade_count FROM market_state WHERE market_address = $1",
      [s.curve],
    );
    expect(v1[0]!.trade_count).toBe(v0[0]!.trade_count);
    expect(v1[0]!.volume_quote).toBe(v0[0]!.volume_quote);

    // Balances are deltas, not upserts, so they are the one thing a second pass can quietly
    // double while every row count still looks right.
    const { rows: bal } = await db.query<{ holder: string; balance: string }>(
      "SELECT holder, balance FROM token_balances WHERE token_address = $1 ORDER BY holder",
      [s.token],
    );
    const onChain = await Promise.all(
      bal.map((b) =>
        s.client.readContract({
          address: s.token,
          abi: erc20BalanceAbi,
          functionName: "balanceOf",
          args: [b.holder as `0x${string}`],
        }),
      ),
    );
    bal.forEach((b, i) => expect(b.balance).toBe(onChain[i]!.toString()));
  }, 120_000);
});
