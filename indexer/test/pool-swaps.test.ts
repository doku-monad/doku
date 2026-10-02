import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { erc20Abi, maxUint256, parseAbi, parseEther } from "viem";

import type { Db } from "../src/db/legacy.js";
import { ingestOnce, type IngestConfig } from "../src/indexer/ingestion/ingest.js";
import { NATIVE_CURRENCY } from "../src/indexer/ingestion/ingest.js";
import { startScenario, type Scenario } from "./anvil.js";
import { memoryDatabase, transactional } from "./helpers.js";

/**
 * v4-core's own `PoolSwapTest`, which is what the scenario deploys.
 *
 * There is no DOKU router any more, and no per-market pool to send a swap to: v4 routes everything
 * through the PoolManager singleton, and callers reach it through the unlock callback that this
 * contract implements. A production frontend would use UniversalRouter; the shape of the `Swap`
 * log the indexer reads is identical either way, because the PoolManager emits it.
 */
const swapRouterAbi = parseAbi([
  "function swap((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, (bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96) params, (bool takeClaims, bool settleUsingBurn) testSettings, bytes hookData) payable returns (int256)",
]);

/** The tick range's ends, one tick inside — a swap may not cross the boundary itself. */
const MIN_SQRT_PRICE_LIMIT = 4295128740n;
const MAX_SQRT_PRICE_LIMIT = 1461446703485210103287273052203988822378723970341n;

/** No `hookData`. DokuHook reads the pool's registration, never the caller's bytes. */
const NO_HOOK_DATA = "0x" as const;
const DEFAULT_SETTINGS = { takeClaims: false, settleUsingBurn: false } as const;

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
 * A graduated market keeps a chart and a trade feed.
 *
 * Without indexing the pool, both stop at the moment the curve closed — and a frozen chart is
 * indistinguishable from a market nobody is trading, which is the opposite of what graduation
 * means.
 */
describe("pool swaps after graduation", () => {
  let s: Scenario;
  let db: Db;
  let cfg: IngestConfig;

  const mine = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await s.client.request({ method: "anvil_mine", params: [] } as never);
    }
  };

  beforeAll(async () => {
    s = await startScenario(8575);
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
      // Without this no swap query is issued at all, and every assertion below would pass
      // vacuously by finding the curve's own trades and nothing else.
      poolManager: s.poolManager,
      // Without this no ModifyLiquidity query is issued and the positions table stays empty, so
      // the assertions below would pass vacuously by finding nothing and expecting nothing.
      positionManager: s.positionManager,
      startBlock: 0n,
      ...transactional(database),
    };
    await ingestOnce(s.client, db, cfg);
  }, 300_000);

  afterAll(() => s?.stop());

  /**
   * The market's `PoolKey`, rebuilt for the swap call.
   *
   * `Graduated` no longer carries the key — generation 2 emits the quote asset and the PoolId and
   * nothing else about the pool — so "the indexer must never rebuild it" is no longer available
   * as a rule. What replaced it is a rebuild that is CHECKED: `handleGraduated2` reconstructs the
   * key from the quote, the token, the graduator's constants and the configured hook, and refuses
   * to record the graduation unless `keccak256(abi.encode(key))` is the id the event carried. The
   * assertions below read the key out of `graduations`, so they are reading a key that passed
   * that check.
   *
   * Hardcoding it HERE is still safe for the opposite reason: this is the caller, not the reader,
   * and a swap sent against the wrong key simply reverts. `currency0` is native MON on THIS
   * market — address(0) sorts below every token — so its token is `currency1`. That is a property
   * of this market's quote asset and not of DOKU pools in general: a USDC-quoted market whose
   * token sorts below USDC has its token on `currency0`, which is the case
   * `gen2-graduation.test.ts` covers.
   */
  const poolKey = () => ({
    currency0: NATIVE_CURRENCY as `0x${string}`,
    currency1: s.token,
    fee: 0,
    tickSpacing: 60,
    hooks: s.hook,
  });

  const swapRows = async () => {
    const { rows } = await db.query<{
      venue: string;
      is_buy: boolean;
      quote_amount: string;
      price: string;
      trader: string;
    }>(
      "SELECT venue, is_buy, quote_amount, price, trader FROM swaps WHERE market_address = $1 ORDER BY id",
      [s.curve],
    );
    return rows;
  };

  it("labels the curve's own trades as curve trades", async () => {
    const rows = await swapRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.venue === "curve")).toBe(true);
  });

  it("records a pool buy, with direction and price", async () => {
    const before = await swapRows();
    const monIn = parseEther("2");

    const hash = await s.wallet.writeContract({
      address: s.swapRouter,
      abi: swapRouterAbi,
      functionName: "swap",
      args: [
        poolKey(),
        // Negative is EXACT INPUT in v4: the caller is specifying what they pay, not what they
        // receive. A positive value here would ask the pool for exactly that much MON out, which
        // on `zeroForOne` is the opposite trade.
        { zeroForOne: true, amountSpecified: -monIn, sqrtPriceLimitX96: MIN_SQRT_PRICE_LIMIT },
        DEFAULT_SETTINGS,
        NO_HOOK_DATA,
      ],
      value: monIn,
      chain: s.wallet.chain,
      account: s.wallet.account!,
    });
    await s.client.waitForTransactionReceipt({ hash });
    await mine(8);
    await ingestOnce(s.client, db, cfg);

    const after = await swapRows();
    expect(after.length).toBe(before.length + 1);

    const poolSwap = after.at(-1)!;
    expect(poolSwap.venue).toBe("pool");
    // Tokens left the pool, so this was a buy — the sign convention that inverts if token
    // ordering is assumed rather than read.
    expect(poolSwap.is_buy).toBe(true);
    // Not equal to `monIn`: the hook skims its levy off the swap delta before the pool sees it,
    // so what the pool records is strictly less than what the trader sent. Bounded on both sides
    // rather than asserted exactly, because the exact figure is the levy's business and
    // `HookLevy.t.sol` is where it is pinned.
    const quote = BigInt(poolSwap.quote_amount);
    expect(quote).toBeGreaterThan(0n);
    expect(quote).toBeLessThanOrEqual(monIn);
    expect(BigInt(poolSwap.price)).toBeGreaterThan(0n);

    // And at the SAME SCALE as the curve's own prices, which is not automatic. `poolSpotPrice`
    // derives from a `sqrtPriceX96` -- a ratio of raw amounts that carries no generation with it --
    // and returns it at 1e18, while this generation-2 curve emits `quote * 1e36 / base`. The pool
    // is seeded from the curve's closing reserves, so the first pool price has to sit beside the
    // last curve price rather than 1e18 away from it: one column, one candle series and one
    // all-time high hold both, and a scale that changed at graduation would make every cap wrong on
    // one side of it.
    const lastCurvePrice = BigInt(before.at(-1)!.price);
    expect(lastCurvePrice).toBeGreaterThan(0n);
    expect(BigInt(poolSwap.price)).toBeGreaterThan(lastCurvePrice / 10n);
    expect(BigInt(poolSwap.price)).toBeLessThan(lastCurvePrice * 10n);
  }, 180_000);

  /**
   * Who traded, on a venue whose event does not say.
   *
   * v4's `Swap` carries `sender`, and `sender` is whoever called `PoolManager.swap` — here the
   * test router, in production the UniversalRouter. Never the person. The indexer read
   * `a.recipient`, which the v4 event has no such field for, so `String(undefined)` wrote the
   * four-character string "undefined" into the trader column of every pool trade. Not null, so
   * nothing downstream saw a gap: the trade feed and the portfolio simply attributed every
   * post-graduation trade to a user of that name.
   *
   * This asserts all three distinctions at once — not the literal, not the router, the signer.
   */
  it("attributes a pool trade to the account that signed it, not the router", async () => {
    const rows = await swapRows();
    const poolSwaps = rows.filter((r) => r.venue === "pool");
    expect(poolSwaps.length).toBeGreaterThan(0);

    const signer = s.wallet.account!.address.toLowerCase();
    for (const swap of poolSwaps) {
      expect(swap.trader).toBe(signer);
      expect(swap.trader).not.toBe("undefined");
      expect(swap.trader).not.toBe(s.swapRouter.toLowerCase());
    }
  }, 60_000);

  /**
   * The protocol's own locked position, discovered the only way it can be.
   *
   * Graduation mints through the PositionManager, so `ModifyPosition` fires for it like any other
   * deposit — which makes this a real end-to-end check of the discovery path without the test
   * having to add liquidity itself.
   *
   * Worth stating why the path exists at all: v4's PositionManager is ERC-721 but NOT
   * ERC-721Enumerable, so nothing on chain can list an owner's positions. On Monad it is also the
   * canonical manager shared by every v4 protocol, with hundreds of thousands of positions in it,
   * so the obvious fallback — walk the ids and check each owner — is not slow but infeasible. The
   * The event's `salt` is the token id. Its `sender` is NOT the end user — it is `msg.sender` as
   * the pool manager saw it, which is the PositionManager for anything minted through the
   * periphery — so the row's owner comes from the transaction signer instead. Asserting that here
   * is the point: the first version of this test checked the token id, the liquidity and the ticks,
   * all of which were right while every row was attributed to one address and no user's portfolio
   * could match a single one.
   */
  it("indexes the position graduation minted, scoped to this market", async () => {
    const { rows } = await db.query<{
      token_id: string;
      market_address: string;
      owner: string;
      liquidity: string;
      tick_lower: number;
      tick_upper: number;
    }>(
      `SELECT token_id::text, market_address, owner, liquidity::text, tick_lower, tick_upper
         FROM positions WHERE market_address = $1`,
      [s.curve],
    );

    expect(rows.length).toBeGreaterThan(0);
    const position = rows[0]!;
    // Accumulated from a signed delta, so a minted position is strictly positive.
    expect(BigInt(position.liquidity)).toBeGreaterThan(0n);
    expect(position.tick_lower).toBeLessThan(position.tick_upper);
    // The salt is the token id, so a row keyed on a stringified `bytes32` would show up here as an
    // enormous number rather than a small one.
    expect(BigInt(position.token_id)).toBeLessThan(1_000_000n);
    // The regression that made every position invisible: attributed to the PositionManager, which
    // is one address for every position on the chain and nobody's wallet.
    expect(position.owner).not.toBe(s.positionManager.toLowerCase());
    expect(position.owner).toMatch(/^0x[0-9a-f]{40}$/);
  }, 60_000);

  /// The whole point: the market's headline figures keep moving after graduation.
  it("keeps market state current after graduation", async () => {
    const { rows } = await db.query<{ last_price: string; trade_count: number }>(
      "SELECT last_price, trade_count FROM market_state WHERE market_address = $1",
      [s.curve],
    );
    // Four curve trades — the scenario's three plus the first buy generation 2 makes inside the
    // launch transaction itself — and the pool buy above.
    expect(rows[0]!.trade_count).toBe(5);
    expect(BigInt(rows[0]!.last_price)).toBeGreaterThan(0n);
  });

  it("draws candlesticks from pool trades too", async () => {
    const { rows } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM candlesticks
        WHERE market_address = $1 AND period_secs = 60`,
      [s.curve],
    );
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });

  it("records a pool sell in the other direction", async () => {
    const balance = (await s.client.readContract({
      address: s.token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [s.wallet.account!.address],
    }));

    const approve = await s.wallet.writeContract({
      address: s.token,
      abi: erc20Abi,
      functionName: "approve",
      args: [s.swapRouter, maxUint256],
      chain: s.wallet.chain,
      account: s.wallet.account!,
    });
    await s.client.waitForTransactionReceipt({ hash: approve });

    const hash = await s.wallet.writeContract({
      address: s.swapRouter,
      abi: swapRouterAbi,
      functionName: "swap",
      args: [
        poolKey(),
        {
          zeroForOne: false,
          amountSpecified: -(balance / 20n),
          sqrtPriceLimitX96: MAX_SQRT_PRICE_LIMIT,
        },
        DEFAULT_SETTINGS,
        NO_HOOK_DATA,
      ],
      chain: s.wallet.chain,
      account: s.wallet.account!,
    });
    await s.client.waitForTransactionReceipt({ hash });
    await mine(8);
    await ingestOnce(s.client, db, cfg);

    const poolSwap = (await swapRows()).at(-1)!;
    expect(poolSwap.venue).toBe("pool");
    expect(poolSwap.is_buy).toBe(false);
  }, 180_000);

  /// Re-ingesting must not duplicate pool trades any more than curve ones.
  it("is idempotent over pool trades", async () => {
    const before = await swapRows();
    await ingestOnce(s.client, db, cfg);
    expect(await swapRows()).toHaveLength(before.length);
  }, 120_000);
});
