import { decodeEventLog, parseAbi, erc20Abi as tokenAbi, type TransactionReceipt } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApi } from "../src/app/index.js";
import type { Db } from "../src/db/legacy.js";
import { curve2Abi, factory2Abi, graduation2Abi } from "../src/indexer/abi.js";
import { SINK_CREATOR } from "../src/indexer/generations.js";
import { ingestOnce, type IngestConfig } from "../src/indexer/ingestion/ingest.js";
import { rebuildMarketStats } from "../src/indexer/processing/stats.js";
import {
  forkRpcUrl,
  GOLD_TARGET,
  MONAD_GOLD,
  MONAD_MAINNET_CHAIN_ID,
  MONAD_POOL_MANAGER,
  MONAD_POSITION_MANAGER,
  startForkScenario,
  type ForkScenario,
} from "./anvil.js";
import { memoryDatabase, transactional } from "./helpers.js";

/** The generation-1 factory, which this chain does not have. A dead address, never the gen-2 one. */
const NO_GEN1_FACTORY = "0x0000000000000000000000000000000000000f01" as const;

const factoryAbi = parseAbi([
  "struct Metadata { string name; string ticker; string logoURI; string bannerURI; string description; string website; string x; string telegram; }",
  "struct LaunchParams { Metadata meta; address quoteAsset; uint8 sink; address routedRecipient; uint16 creatorTaxBps; address taxRecipient; bytes32 economicsPin; uint256 firstBuyQuote; uint256 firstBuyMinOut; uint256 deadline; }",
  "function launch(LaunchParams p) payable returns (address curve, address token)",
  "function economicsPin(address quoteAsset, uint8 sink, uint16 creatorTaxBps) view returns (bytes32)",
  "function launchFee(address who) view returns (uint256)",
]);
const curveAbi = parseAbi([
  "function buyWithToken(uint256 quoteIn, uint256 minBaseOut, uint256 deadline) returns (uint256)",
  "function sell(uint256 baseIn, uint256 minQuoteOut, uint256 deadline) returns (uint256)",
  "function collectFees()",
  "function collectTax()",
  "function collectProtocolFees()",
  "function pendingFees() view returns (uint256)",
  "function pendingProtocol() view returns (uint256)",
  "function pendingTax() view returns (uint256)",
  "function quoteRaised() view returns (uint256)",
  "function readyToGraduate() view returns (bool)",
  "function reserves() view returns (uint128 base, uint128 quote)",
  "function taxRate() view returns (uint256)",
  "function TAX_WINDOW() view returns (uint32)",
]);
const graduationAbi = parseAbi([
  "function graduated(address market) view returns (bool)",
  "function poolIdOf(address market) view returns (bytes32)",
  "function sinkOf(address market) view returns (address)",
]);
const lockerAbi = parseAbi(["function collect(uint256 tokenId)"]);
const hookAbi = parseAbi([
  "function sweep(bytes32 id)",
  "function owedTax(bytes32 id) view returns (uint256)",
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
const decimalsAbi = parseAbi(["function decimals() view returns (uint8)"]);

/** The tick range's ends, one tick inside — a swap may not cross the boundary itself. */
const MIN_SQRT_PRICE_LIMIT = 4295128740n;
const NO_HOOK_DATA = "0x" as const;
const DEFAULT_SETTINGS = { takeClaims: false, settleUsingBurn: false } as const;

/** `DokuToken.TOTAL_SUPPLY`, and the scale a generation-2 price carries. */
const GEN2_PRICE_SCALE = 10n ** 36n;
/** One whole gold token is one troy ounce, at six decimals. */
const RAW_UNITS_PER_OUNCE = 1_000_000n;

/** What the money did, measured as balance deltas rather than as calls that returned. */
interface Moved {
  /** Gold that reached the creator when the curve's routed share and creator tax were collected. */
  collectedFromCurve: bigint;
  /** What `CreatorSink.pull` credited after graduation, before the claim emptied it. */
  creditedBySink: bigint;
  /** Gold that reached the creator from `CreatorSink.claim`. */
  claimedFromSink: bigint;
  /** Gold that reached the treasury from the curve's `collectProtocolFees`. */
  protocolFromCurve: bigint;
}

/**
 * The market as it stood after the sell and BEFORE the filling buy — the one moment where every
 * input to the market cap is readable at once.
 *
 * Taken here rather than at the end because graduation zeroes `quoteRaised` and the curve's
 * reserves stop describing anything: the cap has to be checked against numbers the chain still
 * holds while the curve is still the price.
 */
interface Midpoint {
  reserveBase: bigint;
  reserveQuote: bigint;
  chainSupply: bigint;
  storedPrice: bigint;
  storedSupply: bigint;
  storedCap: bigint;
}

const forkUrl = forkRpcUrl();

/**
 * A gold market on a fork of Monad mainnet, from launch to a pool swap.
 *
 * `gen2-lifecycle.test.ts` drives three markets on a chain this repository built from source —
 * Uniswap v4 included — with a mock six-decimal token it minted itself. Everything that chain
 * knows about Monad is what this repository told it, and its coarsest quote is a dollar.
 *
 * This one runs against Monad. Real v4 singletons, real Permit2, and real XAUt0: six decimals with
 * one whole token a troy ounce, so a raw unit is worth ~3,300x a raw unit of USDC. It is the
 * coarsest quote on the chain and the asset that exposed both of the contracts' market-bricking
 * bugs, and until now the indexer's price, cap and decimals handling had never seen it.
 *
 * Skipped, not failed, without `MONAD_RPC_URL`: the offline suite has to keep running on a machine
 * with no access to the chain.
 */
describe.skipIf(!forkUrl)("a gold market on a Monad mainnet fork", () => {
  let s: ForkScenario;
  let db: Db;
  let api: ReturnType<typeof createApi>;
  let cfg: IngestConfig;
  let curve: `0x${string}`;
  let token: `0x${string}`;
  let poolId: `0x${string}`;
  let seedTokenId: bigint;
  let goldIsCurrency0: boolean;
  const moved: Moved = {
    collectedFromCurve: 0n,
    creditedBySink: 0n,
    claimedFromSink: 0n,
    protocolFromCurve: 0n,
  };
  let mid: Midpoint;

  /**
   * One transaction, mined, and refused if it reverted.
   *
   * viem resolves a reverted transaction rather than throwing, so without the receipt check a
   * failed collection would look exactly like a successful one — and every "the money arrived"
   * assertion below would then be measuring a delta of zero against a call that did nothing.
   */
  const send = async (call: Record<string, unknown>): Promise<TransactionReceipt> => {
    const hash = await s.wallet.writeContract(call as never);
    const receipt = await s.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("transaction reverted");
    return receipt;
  };
  const mine = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) await s.client.request({ method: "anvil_mine", params: [] } as never);
  };
  const deadline = async (): Promise<bigint> =>
    (await s.client.getBlock({ blockTag: "latest" })).timestamp + 3600n;
  const gold = (who: `0x${string}`): Promise<bigint> =>
    s.client.readContract({ address: s.gold, abi: tokenAbi, functionName: "balanceOf", args: [who] });

  /**
   * Ingest until the checkpoint reaches the head.
   *
   * One pass covers `DEFAULT_MAX_RANGE` blocks and the deployment alone mines a dozen, so a single
   * `ingestOnce` stops short and every assertion after it would be about a range never read.
   */
  const catchUp = async (): Promise<void> => {
    for (let i = 0; i < 60; i++) {
      const { to, head } = await ingestOnce(s.client, db, cfg);
      if (to >= head - 8n) return;
    }
    throw new Error("ingest never reached the head");
  };

  beforeAll(async () => {
    s = await startForkScenario(8570);
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
      // One past the fork, not the fork block itself: that block belongs to Monad and holds every
      // log the chain produced in it, none of them ours. The deployment's first transaction is the
      // first block this node made.
      startBlock: s.forkBlock + 1n,
      ...transactional(database),
    };

    const account = s.wallet.account!;
    const chain = s.wallet.chain;
    const me = s.account;
    const MAX = 2n ** 255n;

    /**
     * A CREATOR market with a 5% creator tax, in gold.
     *
     * CREATOR because it is the routing whose money leaves the protocol through the shared sink and
     * into a wallet, so "arrived" is a balance rather than a mapping; and 500 bps because a taxed
     * buy is one of the legs this has to cover.
     */
    await send({ address: s.gold, abi: tokenAbi, functionName: "approve", args: [s.factory, MAX], chain, account });
    const pin = await s.client.readContract({
      address: s.factory, abi: factoryAbi, functionName: "economicsPin",
      args: [s.gold, SINK_CREATOR, 500],
    });
    const fee = await s.client.readContract({
      address: s.factory, abi: factoryAbi, functionName: "launchFee", args: [me],
    });
    const launch = await send({
      address: s.factory, abi: factoryAbi, functionName: "launch", chain, account, value: fee,
      args: [{
        meta: {
          name: "Fork Gold", ticker: "GLDF", logoURI: "ipfs://bafyforkgold", bannerURI: "",
          description: "", website: "", x: "", telegram: "",
        },
        quoteAsset: s.gold,
        sink: SINK_CREATOR,
        routedRecipient: "0x0000000000000000000000000000000000000000",
        creatorTaxBps: 500,
        taxRecipient: "0x0000000000000000000000000000000000000000",
        economicsPin: pin,
        // A first buy in the launch transaction itself, because that is the shape the frontend
        // sends and the indexer has to read a launch and a trade out of one receipt.
        firstBuyQuote: GOLD_TARGET / 10n,
        firstBuyMinOut: 0n,
        deadline: await deadline(),
      }],
    });
    for (const log of launch.logs) {
      try {
        const d = decodeEventLog({ abi: factory2Abi, data: log.data, topics: log.topics });
        if (d.eventName !== "MarketLaunched") continue;
        const a = d.args as { curve: `0x${string}`; token: `0x${string}` };
        curve = a.curve.toLowerCase() as `0x${string}`;
        token = a.token.toLowerCase() as `0x${string}`;
      } catch {
        // Not the launch: the same receipt carries the token's and gold's `Transfer`.
      }
    }
    if (!curve) throw new Error("no MarketLaunched in the launch receipt");
    goldIsCurrency0 = BigInt(s.gold) < BigInt(token);

    await send({ address: s.gold, abi: tokenAbi, functionName: "approve", args: [curve, MAX], chain, account });
    await send({ address: s.gold, abi: tokenAbi, functionName: "approve", args: [s.swapRouter, MAX], chain, account });
    await send({ address: token, abi: tokenAbi, functionName: "approve", args: [curve, MAX], chain, account });

    // Inside the anti-sniper window, so the trade carries both taxes the event reports separately.
    const rate = await s.client.readContract({ address: curve, abi: curveAbi, functionName: "taxRate" });
    if (rate === 0n) throw new Error("the anti-sniper window is not open right after launch");
    await send({
      address: curve, abi: curveAbi, functionName: "buyWithToken",
      args: [GOLD_TARGET / 10n, 0n, await deadline()], chain, account,
    });

    // Collected BEFORE the market fills, so `routed_collected` and `tax_collected` are non-zero
    // while `pending` still is: "0 == 0" is not a test of the identity.
    const beforeCollect = await gold(me);
    await send({ address: curve, abi: curveAbi, functionName: "collectFees", args: [], chain, account });
    await send({ address: curve, abi: curveAbi, functionName: "collectTax", args: [], chain, account });
    moved.collectedFromCurve = (await gold(me)) - beforeCollect;

    // The protocol's own share, also in gold, so it is a token balance and the gas the collection
    // cost does not enter the delta. Taken while the curve is still open, because that is the state
    // `pendingProtocol()` describes and a collection after graduation would be a different claim.
    const beforeProtocol = await gold(me);
    await send({ address: curve, abi: curveAbi, functionName: "collectProtocolFees", args: [], chain, account });
    moved.protocolFromCurve = (await gold(me)) - beforeProtocol;

    const held = await s.client.readContract({
      address: token, abi: tokenAbi, functionName: "balanceOf", args: [me],
    });
    await send({
      address: curve, abi: curveAbi, functionName: "sell",
      args: [held / 2n, 0n, await deadline()], chain, account,
    });

    /**
     * The midpoint, with the curve still open.
     *
     * Both reserves and the token's supply are read off the chain here and the stats rollup is run
     * against what the indexer has, so the cap can be checked against an arithmetic done from the
     * contract's own numbers rather than against another of the indexer's queries.
     */
    await mine(8);
    await catchUp();
    await rebuildMarketStats(db);
    {
      const [reserveBase, reserveQuote] = await s.client.readContract({
        address: curve, abi: curveAbi, functionName: "reserves",
      });
      const chainSupply = await s.client.readContract({
        address: token, abi: tokenAbi, functionName: "totalSupply",
      });
      const { rows } = await db.query<{ price: string; supply: string; cap: string }>(
        `SELECT st.last_price::text AS price, m.total_supply::text AS supply,
                s.market_cap_quote::text AS cap
           FROM markets m
           JOIN market_state st USING (market_address)
           JOIN market_stats s USING (market_address)
          WHERE m.market_address = $1`,
        [curve],
      );
      const row = rows[0]!;
      mid = {
        reserveBase,
        reserveQuote,
        chainSupply,
        storedPrice: BigInt(row.price),
        storedSupply: BigInt(row.supply),
        storedCap: BigInt(row.cap),
      };
    }

    // Past the anti-sniper window, so the filling buy is priced the way an ordinary one is.
    const window = await s.client.readContract({ address: curve, abi: curveAbi, functionName: "TAX_WINDOW" });
    await s.client.request({ method: "evm_increaseTime", params: [Number(window) + 1] } as never);
    await mine(1);

    /**
     * The buy that fills the curve, with the gas spelled out.
     *
     * `_tryAutoGraduate` forwards at most 63/64 of what is left to the graduator and SWALLOWS the
     * failure, so a transaction sent at exactly the estimator's figure fills the curve, fails to
     * graduate, and still reports success — leaving a market that is ready and has no pool.
     * Estimation cannot see it, because the outer call returns fine either way.
     */
    const fill = await send({
      address: curve, abi: curveAbi, functionName: "buyWithToken",
      args: [5n * GOLD_TARGET, 0n, await deadline()], chain, account, gas: 30_000_000n,
    });
    if (!(await s.client.readContract({ address: curve, abi: curveAbi, functionName: "readyToGraduate" }))) {
      throw new Error("the overshooting buy did not fill the curve");
    }
    if (!(await s.client.readContract({
      address: s.graduation, abi: graduationAbi, functionName: "graduated", args: [curve],
    }))) {
      throw new Error("the filling buy did not graduate on the real Uniswap v4");
    }
    for (const log of fill.logs) {
      try {
        const d = decodeEventLog({ abi: graduation2Abi, data: log.data, topics: log.topics });
        if (d.eventName !== "Graduated") continue;
        seedTokenId = (d.args as { tokenId: bigint }).tokenId;
      } catch {
        // Not the graduation: the same receipt carries the pool's `Initialize` and `ModifyLiquidity`.
      }
    }
    if (!seedTokenId) throw new Error("no Graduated in the filling receipt");
    poolId = await s.client.readContract({
      address: s.graduation, abi: graduationAbi, functionName: "poolIdOf", args: [curve],
    });

    // A pool swap on the real PoolManager, paying the hook's levy and the market's creator tax.
    const [c0, c1] = goldIsCurrency0 ? [s.gold, token] : [token, s.gold];
    await send({
      address: s.swapRouter, abi: swapRouterAbi, functionName: "swap",
      args: [
        { currency0: c0, currency1: c1, fee: 0, tickSpacing: 60, hooks: s.hook },
        {
          zeroForOne: goldIsCurrency0,
          amountSpecified: -(GOLD_TARGET / 2n),
          sqrtPriceLimitX96: goldIsCurrency0 ? MIN_SQRT_PRICE_LIMIT : 2n ** 160n - 1n,
        },
        DEFAULT_SETTINGS, NO_HOOK_DATA,
      ],
      chain, account, gas: 30_000_000n,
    });

    // The seed position's own fees, into the hook's ledger; then `sweep`, which is what turns the
    // hook's accrued claims into real balances and into the `Swept` this suite reads.
    await send({ address: s.seedLocker, abi: lockerAbi, functionName: "collect", args: [seedTokenId], chain, account });
    await send({ address: s.hook, abi: hookAbi, functionName: "sweep", args: [poolId], chain, account });

    // The shared sink, end to end: the hook's ledger pulled into a claimable balance, then claimed.
    await send({ address: s.creatorSink, abi: sinkAbi, functionName: "pull", args: [curve], chain, account });
    moved.creditedBySink = await s.client.readContract({
      address: s.creatorSink, abi: sinkAbi, functionName: "claimable", args: [me, s.gold],
    });
    const beforeClaim = await gold(me);
    await send({ address: s.creatorSink, abi: sinkAbi, functionName: "claim", args: [s.gold], chain, account });
    moved.claimedFromSink = (await gold(me)) - beforeClaim;

    await mine(8);
    await catchUp();
    await rebuildMarketStats(db);
  }, 900_000);

  afterAll(() => s?.stop());

  const rewards = async (market: string): Promise<Record<string, string>> => {
    const res = await api.request(`http://x/markets/${market}/rewards`);
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, string>;
  };

  /**
   * The premise of the whole file: this is Monad, and the v4 DOKU graduates into is the protocol's
   * own deployment rather than one this repository stood up.
   */
  it("ran against Monad mainnet and the v4 that is already deployed on it", async () => {
    expect(await s.client.getChainId()).toBe(MONAD_MAINNET_CHAIN_ID);
    for (const singleton of [MONAD_POOL_MANAGER, MONAD_POSITION_MANAGER] as const) {
      const code = await s.client.getCode({ address: singleton });
      expect(code, singleton).toBeTruthy();
      expect(code!.length, singleton).toBeGreaterThan(2);
    }
    // The gold this suite traded is the real token at the real address, not a mock the harness
    // minted: its decimals come from the chain, and its balance had to be written by hand.
    expect(s.gold).toBe(MONAD_GOLD.toLowerCase());
    expect(
      Number(await s.client.readContract({ address: s.gold, abi: decimalsAbi, functionName: "decimals" })),
    ).toBe(6);
    expect(await gold(s.account)).toBeGreaterThan(0n);

    // And the market really raised its whole target in that token and graduated into the real v4:
    // `quoteRaised` is zeroed by graduation, so the figure to check afterwards is the pool's.
    expect(await s.client.readContract({
      address: s.graduation, abi: graduationAbi, functionName: "graduated", args: [curve],
    })).toBe(true);
    // Lowercased at the boundary, the way every address the indexer stores is: the chain answers
    // in EIP-55 and a raw comparison against a stored address would fail on the checksum alone.
    expect((await s.client.readContract({
      address: s.graduation, abi: graduationAbi, functionName: "sinkOf", args: [curve],
    })).toLowerCase()).toBe(s.creatorSink);
    // The seed position lives in the canonical PositionManager, not one this repository deployed.
    expect(seedTokenId).toBeGreaterThan(0n);
  });

  /**
   * Six decimals, stored — not the eighteen a default gives.
   *
   * `quote_decimals` is the exponent every USD figure for this market divides by, and gold is the
   * asset on which getting it wrong is least visible: an 18 there makes the cap a trillion times
   * too small and nothing throws. It comes from the `QuoteAssetRegistered` the deploy script
   * emitted, which the ingester has to apply BEFORE the launch in the same range.
   */
  it("stores six decimals for the real gold quote, and the target the registry set", async () => {
    const { rows: quotes } = await db.query<{
      decimals: number; registered: boolean; enabled: boolean; target: string;
    }>(
      "SELECT decimals, registered, enabled, quote_target::text AS target FROM quote_assets WHERE address = $1",
      [s.gold],
    );
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.decimals).toBe(6);
    expect(quotes[0]!.registered).toBe(true);
    expect(quotes[0]!.enabled).toBe(true);
    // Divisible by five, or a filled market could never graduate.
    expect(BigInt(quotes[0]!.target)).toBe(GOLD_TARGET);
    expect(GOLD_TARGET % 5n).toBe(0n);

    const { rows } = await db.query<{
      quote_asset: string; quote_decimals: number; routing: number; generation: number;
      creator_tax_bps: number; quote_target: string;
    }>(
      `SELECT quote_asset, quote_decimals, routing, generation, creator_tax_bps,
              quote_target::text AS quote_target
         FROM markets WHERE market_address = $1`,
      [curve],
    );
    expect(rows).toHaveLength(1);
    const m = rows[0]!;
    expect(m.generation).toBe(2);
    expect(m.quote_asset).toBe(s.gold);
    expect(m.routing).toBe(SINK_CREATOR);
    expect(m.creator_tax_bps).toBe(500);
    expect(BigInt(m.quote_target)).toBe(GOLD_TARGET);
    // The whole point: six, and it agrees with the token itself rather than only with the registry.
    expect(m.quote_decimals).toBe(6);
    expect(m.quote_decimals).toBe(
      Number(await s.client.readContract({ address: s.gold, abi: decimalsAbi, functionName: "decimals" })),
    );
  });

  /** Every stored curve price is the number the real curve emitted, on the real token. */
  it("prices the gold curve exactly as the chain emitted it", async () => {
    const emitted = new Map<string, bigint>();
    const logs = await s.client.getLogs({ address: curve, fromBlock: s.forkBlock + 1n, toBlock: "latest" });
    for (const log of logs) {
      try {
        const d = decodeEventLog({ abi: curve2Abi, data: log.data, topics: log.topics });
        if (d.eventName !== "Bought" && d.eventName !== "Sold") continue;
        emitted.set(`${log.transactionHash}:${log.logIndex}`, (d.args as { price: bigint }).price);
      } catch {
        // Not a curve trade: the same receipts carry the token's `Transfer`.
      }
    }
    // The first buy in the launch, the taxed buy, the sell, and the buy that filled it.
    expect(emitted.size).toBe(4);

    const { rows } = await db.query<{ tx_hash: string; log_index: number; price: string }>(
      "SELECT tx_hash, log_index, price::text AS price FROM swaps WHERE venue = 'curve' ORDER BY id",
    );
    expect(rows).toHaveLength(emitted.size);
    for (const row of rows) {
      const key = `${row.tx_hash}:${row.log_index}`;
      expect(emitted.has(key), `no chain price for ${key}`).toBe(true);
      expect(BigInt(row.price)).toBe(emitted.get(key)!);
    }
  });

  /**
   * The market cap, against an arithmetic done from the contract's own numbers.
   *
   * `BondingCurve._price()` is `reserves.quote * 1e36 / reserves.base`, and a market cap is that
   * price times the supply, back down by the same 1e36. Both reserves and the supply are read off
   * the chain, so nothing here re-uses the indexer's price, its scale constant or its supply
   * tracking — the only shared thing is the two multiplications, which is what "by hand" means.
   *
   * The last assertion is the one a person can check on a calculator with no context at all: a
   * gold market that raised a couple of troy ounces is worth a handful of troy ounces. Six decimals
   * read as eighteen would put it at a millionth of a millionth of an ounce; a price scale left at
   * 1e18 would put it at zero.
   */
  it("values the gold market at the cap its reserves say, by hand", async () => {
    const price = (mid.reserveQuote * GEN2_PRICE_SCALE) / mid.reserveBase;
    expect(mid.storedPrice).toBe(price);
    // The supply the indexer tracked from `Transfer` mints and burns is the token's own supply —
    // the anti-sniper tax burns, so this is not the constant 1e27 either.
    expect(mid.storedSupply).toBe(mid.chainSupply);
    expect(mid.chainSupply).toBeLessThan(10n ** 27n);
    /**
     * ROUNDED, not floored, and the difference is one raw unit — a third of a US cent on gold.
     *
     * `rebuildMarketStats` divides in Postgres `numeric`, which is exact decimal arithmetic, and
     * then casts to `numeric(78,0)`, which rounds half away from zero. A bigint `/` truncates. The
     * cast is the shipped behaviour, so the hand computation matches it rather than the other way
     * round; asserting the floor here would fail on roughly half of all states, which is a worse
     * test than no test.
     */
    const product = price * mid.chainSupply;
    expect(mid.storedCap).toBe((product + GEN2_PRICE_SCALE / 2n) / GEN2_PRICE_SCALE);

    const ounces = Number(mid.storedCap) / Number(RAW_UNITS_PER_OUNCE);
    expect(ounces).toBeGreaterThan(0.1);
    expect(ounces).toBeLessThan(10_000);
  });

  /**
   * The price does not fall off a cliff when the market graduates.
   *
   * A curve price is `quote * 1e36 / base`; a pool price is derived from a `sqrtPriceX96`, which is
   * a ratio of raw amounts carrying no scale at all. The two land in the same column, the same
   * candles and the same all-time high. On an 18-decimal quote a scale error there is a factor of
   * 1e18; on gold — a raw unit worth a third of a US cent, a token worth ~0.02 raw units — the
   * intermediate at generation-1 scale is BELOW ONE and the price truncates to zero outright, which
   * no later multiplication can undo. This is the assertion that found that.
   */
  it("keeps the price on one scale across graduation", async () => {
    const { rows } = await db.query<{ venue: string; price: string }>(
      "SELECT venue, price::text AS price FROM swaps WHERE market_address = $1 ORDER BY id",
      [curve],
    );
    const curveRows = rows.filter((r) => r.venue === "curve");
    const poolRows = rows.filter((r) => r.venue === "pool");
    expect(curveRows.length).toBeGreaterThan(0);
    expect(poolRows.length).toBeGreaterThan(0);

    const lastCurve = BigInt(curveRows.at(-1)!.price);
    const firstPool = BigInt(poolRows[0]!.price);
    expect(lastCurve).toBeGreaterThan(0n);
    // Not "greater than zero because a price is never zero" — it was zero, for exactly this market.
    expect(firstPool).toBeGreaterThan(0n);
    // The pool is seeded from the curve's closing reserves, so the first pool price sits beside the
    // last curve price. A hundredfold band is wide enough for one swap of half a target to move it
    // and narrow enough that a 1e18 scale slip is off by sixteen orders of magnitude.
    expect(firstPool).toBeLessThan(lastCurve * 100n);
    expect(firstPool * 100n).toBeGreaterThan(lastCurve);

    // And the cap that price feeds is still a handful of troy ounces on the other side of it.
    const { rows: stats } = await db.query<{ cap: string }>(
      "SELECT market_cap_quote::text AS cap FROM market_stats WHERE market_address = $1",
      [curve],
    );
    const ounces = Number(BigInt(stats[0]!.cap)) / Number(RAW_UNITS_PER_OUNCE);
    expect(ounces).toBeGreaterThan(0.1);
    expect(ounces).toBeLessThan(10_000);
  });

  /**
   * The fee ledger against the curve's own accounting, and against money that arrived.
   *
   * Neither `Bought` nor `Sold` carries the protocol/routed split — the indexer derives it from
   * `fee` at 30/70 — so this is where that derivation meets the contract. Summed over generated
   * and collected, because a collection moves money out of `pendingProtocol` and a check against
   * the pending figure alone would pass on a market that had never collected.
   */
  it("ledgers the gold fees to the raw unit, and the gold arrived", async () => {
    const { rows } = await db.query<{ generated: string; collected: string }>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE kind = 'protocol'), 0)::text AS generated,
              COALESCE(SUM(amount) FILTER (WHERE kind = 'protocol_collected'), 0)::text AS collected
         FROM fee_events WHERE market_address = $1 AND venue = 'curve'`,
      [curve],
    );
    const generated = BigInt(rows[0]!.generated);
    const collected = BigInt(rows[0]!.collected);
    expect(generated).toBeGreaterThan(0n);
    expect(collected).toBeGreaterThan(0n);
    const stillHeld = await s.client.readContract({
      address: curve, abi: curveAbi, functionName: "pendingProtocol",
    });
    expect(generated - collected).toBe(stillHeld);
    expect(moved.protocolFromCurve).toBe(collected);

    const r = await rewards(curve);
    expect(BigInt(r.routedGenerated!)).toBeGreaterThan(0n);
    expect(BigInt(r.routedCollected!)).toBeGreaterThan(0n);
    expect(BigInt(r.pending!)).toBe(
      await s.client.readContract({ address: curve, abi: curveAbi, functionName: "pendingFees" }),
    );
    // The collection before the fill moved gold into the creator's wallet — routed plus tax.
    expect(moved.collectedFromCurve).toBe(BigInt(r.routedCollected!) + BigInt(r.taxCollected!));
    expect(moved.collectedFromCurve).toBeGreaterThan(0n);

    // The hook's two events, on the real PoolManager, attributed to this market by pool id.
    const { rows: pool } = await db.query<{ kind: string; total: string }>(
      "SELECT kind, SUM(amount)::text AS total FROM fee_events WHERE market_address = $1 AND venue = 'pool' GROUP BY kind",
      [curve],
    );
    const of = (kind: string): bigint | undefined => {
      const row = pool.find((p) => p.kind === kind);
      return row ? BigInt(row.total) : undefined;
    };
    // 5% of what the swap put through the pool, levied by the hook on the real PoolManager. The
    // `- 1` is the levy's own rounding, which `HookLevy.t.sol` is where it is pinned to the wei.
    expect(of("tax")).toBeGreaterThanOrEqual(((GOLD_TARGET / 2n) * 500n) / 10_000n - 1n);
    expect(of("protocol")).toBeGreaterThan(0n);

    // The shared sink's ledger against the sink's own mapping — both zero, because the money was
    // credited and then claimed, and a projection that counted only credits would disagree.
    const { rows: balances } = await db.query<{ claimable: string; earned: string }>(
      `SELECT claimable::text AS claimable, earned_lifetime::text AS earned
         FROM creator_balances WHERE who = $1 AND quote_asset = $2`,
      [s.account.toLowerCase(), s.gold],
    );
    expect(balances).toHaveLength(1);
    expect(BigInt(balances[0]!.claimable)).toBe(
      await s.client.readContract({
        address: s.creatorSink, abi: sinkAbi, functionName: "claimable", args: [s.account, s.gold],
      }),
    );
    expect(moved.creditedBySink).toBeGreaterThan(0n);
    expect(moved.claimedFromSink).toBe(moved.creditedBySink);
    expect(BigInt(balances[0]!.earned)).toBe(moved.collectedFromCurve + moved.creditedBySink);
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
      const { rows: balances } = await db.query<{ who: string; claimable: string; earned: string }>(
        "SELECT who, claimable::text AS claimable, earned_lifetime::text AS earned FROM creator_balances ORDER BY who",
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
