import { type AbiEvent, decodeEventLog, type Log, type PublicClient, toEventSelector } from "viem";
import {
  allEvents,
  burnSinkAbi,
  erc20Abi,
  factoryAbis,
  poolManagerAbi,
  rewardVaultAbi,
} from "../abi.js";
import { type Db, getStatus, setStatus } from "../../db/legacy.js";
import {
  chainsTo,
  type IndexedBlock,
  pruneBlocksBelow,
  recentBlocks,
  recordBlock,
  recordEvent,
} from "../blocks.js";
import { rewindTo } from "../sync/rewind.js";
import { updateCandles } from "../processing/derive.js";
import { applySupplyDelta, applyTransfer, recountHolders } from "../processing/holders.js";
import { type LiveEvent, type LiveFeed, nullFeed } from "../../websocket/live.js";
import { curveSpotPrice, poolSpotPrice, PRICE_SCALE } from "../processing/price.js";
import { GEN2_PRICE_SCALE_UP } from "../generations.js";
import { handleMarketLaunched2, handleMetadataSet } from "./gen2/launch.js";
import { handleTrade2 } from "./gen2/trades.js";
import { handleCollection } from "./gen2/collections.js";
import { handleGraduated2, handlePoolRegistered } from "./gen2/graduation.js";
import { handleHookEvent } from "./gen2/hook.js";
import { handleCreatorSinkEvent } from "./gen2/creator-sink.js";
import { handleSinkEvent } from "./gen2/sinks.js";
import { handleRegistryEvent } from "./gen2/registry.js";
import { poolKeyFor } from "../processing/pool-key.js";
import { createLogger } from "../../utils/logger.js";

/**
 * How far behind head we stay.
 *
 * Monad finalises in roughly 0.8 s — two blocks. Five blocks was the original margin, and on
 * 2026-09-12 it was measured as the single largest wait between a trade and the board: ~2.5 s of
 * the ~5 s a swap took to appear. Two blocks sits at finality itself, so what the margin buys now
 * is exactly the reorg handling below, which exists anyway: "unlikely" is not "impossible", and an
 * indexer that assumes finality eventually serves a trade that never happened.
 */
export const CONFIRMATIONS = 2n;

/**
 * How many blocks one `eth_getLogs` may cover.
 *
 * A hundred because that is what Monad's public RPC allows, and a request for more is rejected
 * outright — which is how this was found: at two thousand the indexer never advanced a single
 * block while reporting itself healthy with zero lag, because lag is measured against what it has
 * indexed and it had indexed nothing. A dedicated node will allow more, so this is configurable.
 */
export const DEFAULT_MAX_RANGE = 100n;

/** `Transfer(address,address,uint256)`. Emitted by every token on the chain, not only ours. */
export const TRANSFER_EVENT = erc20Abi[0] as AbiEvent;

/**
 * v4's `Swap`. Emitted by the ONE PoolManager for every v4 pool on the chain, not only ours.
 *
 * Under V3 this was emitted per pool, so an address filter was a market filter. Under v4 the
 * address is shared by every v4 pool in existence, so it filters nothing — see `logQueries`, where
 * the `PoolId` topic takes over that job.
 */
export const POOL_SWAP_EVENT = poolManagerAbi[0] as AbiEvent;

/**
 * See `poolManagerAbi`: the only way to discover which positions are in our pools.
 *
 * From the POOL manager, and named `ModifyLiquidity`. It was previously declared as
 * `ModifyPosition` and queried at the position manager, which matched no log ever emitted — so no
 * position was indexed at all, including the protocol's own seeded ones.
 */
export const MODIFY_LIQUIDITY_EVENT = poolManagerAbi[1] as AbiEvent;

/**
 * A market's own reward vault and burn sink.
 *
 * `Funded(uint256)` and `Burned(uint256,uint256)` are signatures any contract might emit, and
 * `RewardVault.Claimed(address,uint256,uint256)` shares its NAME with the CreatorSink's very
 * different `Claimed(address,address,uint256)`. All three are asked for by address -- the sinks
 * `PoolRegistered` revealed -- exactly as `Transfer` is.
 */
export const FUNDED_EVENT = rewardVaultAbi[0] as AbiEvent;
export const VAULT_CLAIMED_EVENT = rewardVaultAbi[1] as AbiEvent;
export const BURNED_EVENT = burnSinkAbi[0] as AbiEvent;

/**
 * The events belonging to contracts only we deploy.
 *
 * `Transfer`, `Swap` and `ModifyLiquidity` are deliberately absent: their signatures are shared
 * with every token and every v4 pool in existence, so filtering on them narrows nothing. All three
 * are asked for by address and pool id instead — see `logQueries`.
 *
 * Excluded BY SELECTOR rather than by name, because `Claimed` exists twice across our own
 * contracts and only the vault's is generic: `CreatorSink.Claimed` is unique to that contract and
 * stays a topic-filtered protocol event, while `RewardVault.Claimed` must not be. Matching on the
 * name would have dropped both.
 *
 * `ModifyLiquidity` joined this exclusion with the fix that made it match anything. While the
 * indexer looked for `ModifyPosition` the omission was invisible: that event is in this list too,
 * unaddressed and chain-wide, and cost nothing only because no contract on the chain emits it.
 * Renaming it without excluding it here would have turned a query that returned nothing into one
 * that returns every liquidity change in every v4 pool on Monad.
 */
const ADDRESS_FILTERED = new Set(
  [
    TRANSFER_EVENT,
    POOL_SWAP_EVENT,
    MODIFY_LIQUIDITY_EVENT,
    FUNDED_EVENT,
    VAULT_CLAIMED_EVENT,
    BURNED_EVENT,
  ].map((event) => toEventSelector(event)),
);
const PROTOCOL_EVENTS = (allEvents as readonly AbiEvent[]).filter(
  (event) => !ADDRESS_FILTERED.has(toEventSelector(event)),
);

/** The last block a range may cover, given where it starts and how far it may reach. */
export function rangeEnd(from: bigint, safeHead: bigint, maxRange: bigint): bigint {
  const end = from + maxRange - 1n;
  return end > safeHead ? safeHead : end;
}

export interface LogQuery {
  fromBlock: bigint;
  toBlock: bigint;
  /**
   * Expressed as ABI events rather than as raw topic hashes.
   *
   * viem's `getLogs` builds the topic filter from these. A hand-built `topics` array is *silently
   * ignored* by it — not rejected — so the request goes out with no filter at all and the node
   * returns every log in the range. Which is exactly what happened: the ingester reported 2,100
   * logs per hundred blocks while appearing to filter.
   */
  events: AbiEvent[];
  address?: `0x${string}`[];
  /**
   * Values for the event's INDEXED parameters, which viem turns into the remaining topics.
   *
   * This is how the `PoolId` gate is expressed. It is the same rule as `events` above and it fails
   * the same silent way if bypassed: a hand-built `topics` array is ignored rather than rejected,
   * so the request goes out unfiltered and the node returns every log in the range.
   */
  args?: Record<string, unknown>;
}

/**
 * The `eth_getLogs` calls that cover one block range.
 *
 * Up to three, because the events fall into two kinds. Ours — `MarketLaunched`, `Bought`, `Sold`,
 * `ReadyToGraduate`, `Graduated` — have signatures no other contract emits, so a topic filter is
 * exact and the node does the filtering. `Transfer` and V3's `Swap` do not: every token and every
 * pool on the chain emits them, so those are narrowed by address instead.
 *
 * The alternative, and what this replaced, was asking for every log in the range and discarding
 * whatever failed to decode. That is correct and unusable: Monad testnet carries around 3,300 logs
 * per hundred blocks, essentially none of them ours.
 *
 * An address-filtered query is **omitted entirely** when there is nothing to ask about. An
 * `eth_getLogs` with an empty address array does not mean "no addresses" to a node; it means no
 * address filter, which is a request for every transfer on the chain.
 */
export function logQueries(args: {
  from: bigint;
  to: bigint;
  tokens: string[];
  poolIds: string[];
  /**
   * The per-market sink contracts discovered from `PoolRegistered.sinkAddr`.
   *
   * Required rather than optional, so every caller states whether it has any. An omitted field
   * and an empty list read the same at the call site and mean opposite things to a node.
   */
  sinks: string[];
  poolManager?: `0x${string}`;
  /**
   * Accepted and NOT queried, deliberately.
   *
   * Every liquidity fact this service stores comes from the POOL manager's `ModifyLiquidity` —
   * `positions` is written from nowhere else. The position manager emits only the ERC-721
   * `Transfer` for the NFT, which nothing here reads. It stays in the signature so a caller
   * threading it does not have to change, and is named here so the next person does not add a
   * query believing `positions` depends on it.
   */
  positionManager?: `0x${string}`;
}): LogQuery[] {
  const { from, to, tokens, poolIds, sinks, poolManager } = args;
  const queries: LogQuery[] = [{ fromBlock: from, toBlock: to, events: PROTOCOL_EVENTS }];
  if (tokens.length > 0) {
    queries.push({
      fromBlock: from,
      toBlock: to,
      address: tokens as `0x${string}`[],
      events: [TRANSFER_EVENT],
    });
  }
  // THE POOL ID GATE.
  //
  // Under V3 this asked for `Swap` from a list of pool ADDRESSES, and that was the whole filter: a
  // log from an address we did not know about belonged to another protocol and never reached us.
  //
  // Under v4 there is no pool contract. Every swap on every v4 pool on the chain — memecoins,
  // stablecoin pairs, someone's test pool — is emitted by the same PoolManager, so an address
  // filter narrows nothing and the node would return the chain's entire v4 swap volume. The
  // indexer would then decode all of it, look each one up, and discard almost all of it, at a cost
  // that grows with somebody else's traffic rather than with ours.
  //
  // `args.id` is the filter now. viem turns it into `topics[1]`, so the NODE does the narrowing.
  // The handler re-checks anyway: this filter is for cost, and the lookup in the `Swap` case is
  // for correctness, and they are not the same requirement.
  if (poolIds.length > 0 && poolManager) {
    queries.push({
      fromBlock: from,
      toBlock: to,
      address: [poolManager],
      events: [POOL_SWAP_EVENT],
      args: { id: poolIds },
    });
  }
  // The same gate, and the same contract. `ModifyLiquidity` comes from the POOL manager — the
  // position manager emits only the ERC-721 `Transfer` for the NFT — and on Monad that pool manager
  // is the CANONICAL one shared by every v4 protocol, so without `args.id` this would return every
  // liquidity change in every v4 pool in existence.
  if (poolIds.length > 0 && poolManager) {
    queries.push({
      fromBlock: from,
      toBlock: to,
      address: [poolManager],
      events: [MODIFY_LIQUIDITY_EVENT],
      args: { id: poolIds },
    });
  }
  // The same rule as `Transfer`: generic signatures, narrowed by the addresses we know are ours,
  // and the query omitted entirely when there are none. An empty address array is not "no
  // addresses" to a node; it is "no address filter".
  if (sinks.length > 0) {
    queries.push({
      fromBlock: from,
      toBlock: to,
      address: sinks as `0x${string}`[],
      events: [FUNDED_EVENT, VAULT_CLAIMED_EVENT, BURNED_EVENT],
    });
  }
  return queries;
}

/**
 * How far back a reorg is allowed to rewrite history.
 *
 * Bounded deliberately. A divergence deeper than this is not a reorg any chain produces; it means
 * the node was replaced, rolled back, or pointed at a different network, and silently rewinding
 * further would hide that rather than fix it.
 */
export const MAX_REORG_DEPTH = 128n;

/**
 * Whether the market's token is a pool's token0.
 *
 * It decides both the direction and the price of every pool trade, and getting it wrong inverts
 * them on some markets and not others, so one market behaving correctly says nothing about the
 * next.
 *
 * This used to be a sort-order comparison against WMON, because V3 ordered a pool's tokens by
 * address and either side could be the market's. Under v4 it is an identity check instead: every
 * DOKU pool's `currency0` is native MON — `address(0)`, which sorts below every possible token —
 * so the market's token is always `currency1`. The comparison is kept rather than hardcoded to
 * `false` because the value it reads is the pool's OWN stored `currency0`, and a pool that ever
 * disagrees should be believed over an assumption made here.
 *
 * Both sides are lowercased before comparing. They arrive from two places in two cases — the
 * database stores lowercase, a log carries EIP-55 checksummed — and a raw comparison would sort
 * `0xF…` below `0xa…`, because uppercase letters come first in ASCII.
 */
export function marketTokenIsCurrency0(token: string, currency0: string): boolean {
  return token.toLowerCase() === currency0.toLowerCase();
}

/** v4 spells native MON this way inside a `PoolKey`. There is no wrapper any more. */
export const NATIVE_CURRENCY = "0x0000000000000000000000000000000000000000";

export interface IngestConfig {
  factory: `0x${string}`;
  graduation: `0x${string}`;
  /** Every accepted `Graduated` emitter. Defaults to `[graduation]` when a caller passes none. */
  graduators?: string[];
  /**
   * The Uniswap v4 PoolManager singleton.
   *
   * Required for graduated markets to have a chart at all: it is the only address v4 `Swap` logs
   * come from. Optional in the type so a curve-only deployment — or a test that never graduates —
   * does not have to invent one; when it is absent no swap query is issued, which is the correct
   * behaviour rather than a silent gap.
   */
  poolManager?: `0x${string}`;
  /**
   * Uniswap v4's PositionManager.
   *
   * Only used to discover liquidity POSITIONS, so a deployment that does not surface a pools page
   * can leave it out and simply index no positions. On Monad this is the canonical manager shared
   * by every v4 protocol, which is why the query that uses it is gated on our pool ids.
   */
  positionManager?: `0x${string}`;
  /**
   * The generation-2 addresses. All optional, and all absent on the deployment that follows only
   * the live emoji launchpad — unsetting them returns the process to exactly today's behaviour.
   *
   * `factory2` is what attributes a `MarketLaunched` to generation 2 (`factoryAbis`); the others
   * gate the events only their own contract can legitimately emit.
   */
  factory2?: `0x${string}`;
  graduation2?: `0x${string}`;
  hook2?: `0x${string}`;
  creatorSink?: `0x${string}`;
  quoteRegistry?: `0x${string}`;
  startBlock: bigint;
  /** How many blocks one `eth_getLogs` may cover. Defaults to what a public RPC allows. */
  maxRange?: bigint;
  /** Where to announce changes. Defaults to a feed that does nothing. */
  live?: LiveFeed;
}

/** Named so it is never shadowed by the `log` a handler is iterating. */
const ingestLog = createLogger().child({ component: "ingest" });

type AnyLog = Log<bigint, number, false>;
type DecodedLog = { eventName: string; args: Record<string, unknown> };

function priceOf(quote: bigint, base: bigint): string {
  if (base === 0n) return "0";
  // 18-dp fixed point, done in integers. Floating point here would round token amounts that
  // exceed float64's exact range.
  return ((quote * 10n ** 18n) / base).toString();
}

/**
 * The hash at a height, or null if the chain does not currently reach it.
 *
 * A rolled-back node is shorter than it was, so the height we last indexed may simply not exist
 * any more. That is a reorg, not an error — but `getBlock` reports it by throwing.
 */
async function hashAt(client: PublicClient, height: bigint): Promise<string | null> {
  try {
    const block = await client.getBlock({ blockNumber: height });
    return block.hash;
  } catch {
    return null;
  }
}

/**
 * Detects whether the chain reorganised under us.
 *
 * Compares the stored hash of the last indexed block against what the node reports for that
 * height. A mismatch means our history diverged, so everything at or above it is dropped and
 * re-ingested. Returns the block to resume from.
 */
/**
 * Every log in a range that could be ours.
 *
 * Two passes, because a market's token and a graduated pool are discovered *inside* the range they
 * first emit in. The launch transaction mints the whole supply, and that `Transfer` comes from a
 * token address nothing knew about a moment earlier — so a single address-filtered pass would miss
 * it, leaving the curve's balance short by the entire supply. A negative number nothing displays.
 *
 * The second pass asks only about what the first pass revealed, so it runs at most once per range
 * and usually returns nothing.
 */
async function fetchLogs(
  client: PublicClient,
  db: Db,
  from: bigint,
  to: bigint,
  poolManager?: `0x${string}`,
  positionManager?: `0x${string}`,
): Promise<AnyLog[]> {
  const known = await knownAddresses(db);
  const collected = new Map<string, AnyLog>();

  const run = async (queries: LogQuery[]) => {
    for (const query of queries) {
      const logs = (await client.getLogs(query as never)) as AnyLog[];
      for (const log of logs) {
        // Keyed rather than concatenated: the passes overlap by construction, since the second
        // asks about addresses the first may already have covered.
        collected.set(`${log.transactionHash}:${log.logIndex}`, log);
      }
    }
  };

  await run(logQueries({ from, to, ...known, poolManager, positionManager }));

  // What the first pass just revealed: tokens from launches, pools from graduations.
  const discovered = { tokens: [] as string[], poolIds: [] as string[], sinks: [] as string[] };
  for (const log of collected.values()) {
    try {
      const decoded = decodeEventLog({ abi: allEvents, data: log.data, topics: log.topics }) as
        DecodedLog;
      if (decoded.eventName === "MarketLaunched") {
        const token = String(decoded.args.token).toLowerCase();
        if (!known.tokens.includes(token)) discovered.tokens.push(token);
      } else if (decoded.eventName === "Graduated") {
        // A PoolId, not an address. Case matters less than it did — it is a hash, not a checksummed
        // address — but it is lowercased for the same reason everything else here is: so the
        // comparison is against one representation rather than two.
        //
        // `poolId` under gen 1, `id` under gen 2: the field was renamed when the PoolKey came off
        // the event. Reading only the first would leave every gen-2 pool undiscovered, so the
        // node's `args.id` filter would never be asked for its swaps.
        const poolId = String(decoded.args.poolId ?? decoded.args.id).toLowerCase();
        if (!known.poolIds.includes(poolId)) discovered.poolIds.push(poolId);
      } else if (decoded.eventName === "PoolRegistered") {
        // The sink address is only ever revealed here, and it is what the vault and burn-sink
        // queries filter by.
        const sink = String(decoded.args.sinkAddr).toLowerCase();
        if (!known.sinks.includes(sink)) discovered.sinks.push(sink);
      }
    } catch {
      // Not one of ours.
    }
  }
  if (
    discovered.tokens.length > 0 ||
    discovered.poolIds.length > 0 ||
    discovered.sinks.length > 0
  ) {
    await run(logQueries({ from, to, ...discovered, poolManager, positionManager }));
  }

  // Chain order, restored. The passes are separate requests, so what arrives is grouped by query
  // rather than by position in the chain — and every downstream step assumes a trade is applied
  // after the launch it belongs to.
  return [...collected.values()].sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? (a.logIndex ?? 0) - (b.logIndex ?? 0)
      : Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)),
  );
}

/** The token and pool addresses already on record, which is what the address filters ask about. */
async function knownAddresses(
  db: Db,
): Promise<{ tokens: string[]; poolIds: string[]; sinks: string[] }> {
  const { rows: tokens } = await db.query<{ token_address: string }>(
    "SELECT token_address FROM markets",
  );
  const { rows: pools } = await db.query<{ pool_id: string }>(
    "SELECT pool_id FROM graduations WHERE pool_id <> ''",
  );
  const { rows: sinks } = await db.query<{ sink: string }>(
    "SELECT DISTINCT sink FROM graduations WHERE sink <> ''",
  );
  return {
    tokens: tokens.map((r) => r.token_address),
    poolIds: pools.map((r) => r.pool_id),
    sinks: sinks.map((r) => r.sink),
  };
}

/**
 * Where the next pass should begin, having established that the chain still agrees with what we
 * stored.
 *
 * Three outcomes:
 *
 *   the tip we recorded is still on the chain   → continue from the block after it
 *   it is not, but an ancestor is               → rewind above that ancestor and replay from it
 *   nothing within the lookback is              → rewind to the floor and re-scan
 *
 * The middle case is a reorg, and finding the *right* ancestor is the whole job: stopping too high
 * leaves orphaned rows in place, and every one of them is a plausible-looking number that nothing
 * ever checks again.
 */
async function resolveStart(
  client: PublicClient,
  db: Db,
  configuredStart: bigint,
  graduationAddress?: string,
): Promise<bigint> {
  const { lastBlock, lastBlockHash } = await getStatus(db);
  if (lastBlock === 0n || !lastBlockHash) return configuredStart;

  // The cheap path, and overwhelmingly the common one. If the hash at our checkpoint still matches,
  // nothing below it can have changed either — a reorg at any depth rewrites every hash above it.
  if ((await hashAt(client, lastBlock)) === lastBlockHash) return lastBlock + 1n;

  /**
   * Bounded on purpose. A divergence deeper than this is not a reorg any chain produces; it means
   * the node was replaced, rolled back, or pointed at a different network — and silently rewinding
   * further would hide that rather than fix it.
   */
  const floor = lastBlock > MAX_REORG_DEPTH ? lastBlock - MAX_REORG_DEPTH : configuredStart;

  /**
   * The block ledger, newest first.
   *
   * This used to reconstruct candidates by `UNION`-ing `block_hash` out of the four event tables,
   * so only blocks that emitted something were comparable. On a quiet chain that is almost none of
   * them, and the walk could "find" an agreeing ancestor hundreds of blocks below the real fork.
   * `indexed_blocks` records every block a pass ended on and every block that produced an event,
   * which makes the search dense where it matters.
   */
  const recorded = await recentBlocks(db, lastBlock - 1n, floor);

  let previous: IndexedBlock | undefined;
  for (const block of recorded) {
    // Continuity between adjacent records. Two heights whose hashes each still match can still
    // have a reorg between them, and the parent link is what catches that.
    if (previous && !chainsTo(previous, block)) break;
    previous = block;

    if ((await hashAt(client, block.number)) === block.hash) {
      const resume = block.number + 1n;
      await rewindTo(db, resume, graduationAddress);
      return resume;
    }
  }

  // Nothing we stored still matches, so everything we know may be orphaned. Rewinding to the floor
  // costs a re-scan; keeping the rows costs correctness.
  await rewindTo(db, floor, graduationAddress);
  return floor;
}

export interface IngestDeps {
  /**
   * Runs one function inside a database transaction.
   *
   * Injected rather than imported so a caller without a managed client — the older tests, which
   * hold a bare `Db` — can pass a pass-through and keep the previous, non-atomic behaviour. The
   * service always supplies the real one.
   */
  transaction?: <T>(work: (db: Db) => Promise<T>) => Promise<T>;
}

export async function ingestOnce(
  client: PublicClient,
  db: Db,
  cfg: IngestConfig & IngestDeps,
): Promise<{ from: bigint; to: bigint; logs: number; head: bigint }> {
  // No transaction: this is the caller's own `Db`, used for reads and for the rewind path, which
  // manages its own atomicity.
  const runInTransaction = cfg.transaction ?? ((work: (d: Db) => Promise<unknown>) => work(db));

  const head = await client.getBlockNumber();
  const safeHead = head > CONFIRMATIONS ? head - CONFIRMATIONS : 0n;
  const from = await resolveStart(client, db, cfg.startBlock, cfg.graduation);
  if (from > safeHead) return { from, to: from - 1n, logs: 0, head };

  const to = rangeEnd(from, safeHead, cfg.maxRange ?? DEFAULT_MAX_RANGE);

  const logs = await fetchLogs(client, db, from, to, cfg.poolManager, cfg.positionManager);
  const timestamps = new Map<bigint, Date>();

  // Collected, de-duplicated by kind and market, and published once the range is committed.
  /**
   * One announcement per kind per market, and the *last* one wins.
   *
   * A range can hold several trades on the same market and the client refetches either way, so
   * announcing each would be repeated work for the same result. Later ones overwrite rather than
   * being dropped, because a swap announcement carries the trade's direction and the useful answer
   * to "what just happened here" is the most recent thing, not the first.
   */
  const pending = new Map<string, LiveEvent>();
  const announce = (event: LiveEvent) => {
    // A `fees` frame is keyed by its recipient too. One trade credits the routed recipient and the
    // tax recipient separately, and collapsing both into `fees:<market>` would drop one of them —
    // leaving that person watching a balance that never appears to move.
    const key =
      event.type === "fees" ? `fees:${event.market}:${event.recipient}` : `${event.type}:${event.market}`;
    pending.set(key, event);
  };

  const decodedLogs: { log: AnyLog; decoded: DecodedLog }[] = [];
  for (const log of logs) {
    if (!log.blockNumber || !log.blockHash || log.logIndex === null) continue;
    try {
      decodedLogs.push({
        log,
        decoded: decodeEventLog({
          abi: allEvents,
          data: log.data,
          topics: log.topics,
        }),
      });
    } catch {
      // Not one of ours. The queries are narrow, but `Transfer` and `Swap` are asked for by
      // address, and an address can emit events beyond the one we asked about.
    }
  }

  /**
   * Registrations, then launches, then everything else in chain order.
   *
   * A market's token mints its supply *before* the factory emits `MarketLaunched` — both happen in
   * the launch transaction, and the token's constructor runs first. Handled strictly in log order,
   * that mint arrives for a token the indexer has never heard of and is discarded, which leaves
   * the curve's balance short by the entire supply and, being a negative number nothing reads,
   * silently wrong. Every other event for a market necessarily comes after its launch, so
   * promoting launches within the range reorders nothing that matters.
   *
   * The registry has to be promoted AHEAD of that, and for the same shape of reason one level up.
   * `handleMarketLaunched2` reads the quote asset's DECIMALS out of `quote_assets` — the launch
   * event does not carry them — and defaults to 18 when the row is not there yet. Promoting
   * launches over a `QuoteAssetRegistered` from an earlier block in the same range made that
   * default fire on a market quoted in a six-decimal asset, and `quote_decimals` is the exponent
   * every USD figure for that market is divided by: measured on anvil, a market quoted in a
   * six-decimal USDC stored 18 and would have reported a market cap a TRILLION times too small.
   * Nothing throws, and the number still looks like a number.
   *
   * Safe in the other direction because the registry events write only `quote_assets`, keyed by
   * asset address, and never read a market — and because the chain will not let a market launch
   * against a quote asset that is not registered yet, so a registration is never legitimately
   * *after* a launch that depends on it.
   */
  const REGISTRY_EVENTS = new Set([
    "QuoteAssetRegistered",
    "QuoteTargetChanged",
    "QuoteAssetEnabled",
  ]);
  const isRegistry = (name: string): boolean => REGISTRY_EVENTS.has(name);
  const ordered = [
    ...decodedLogs.filter((d) => isRegistry(d.decoded.eventName)),
    ...decodedLogs.filter((d) => d.decoded.eventName === "MarketLaunched"),
    ...decodedLogs.filter(
      (d) => d.decoded.eventName !== "MarketLaunched" && !isRegistry(d.decoded.eventName),
    ),
  ];

  /**
   * Every block timestamp this range needs, fetched *before* the transaction opens.
   *
   * These are RPC round trips. Making them inside the transaction would hold a database
   * connection open across the network for as long as the node takes to answer — and a slow node
   * would push the pass past the transaction timeout, rolling back work that had already
   * succeeded. Nothing here writes, so there is no reason for it to be inside.
   */
  const seenBlocks = new Map<bigint, IndexedBlock>();
  for (const { log } of ordered) {
    if (!timestamps.has(log.blockNumber)) {
      const block = await client.getBlock({ blockNumber: log.blockNumber });
      timestamps.set(log.blockNumber, new Date(Number(block.timestamp) * 1000));
      // The parent hash comes free with the block we were already fetching, and it is what turns
      // the ledger below into a chain rather than a set of independent samples.
      seenBlocks.set(log.blockNumber, {
        number: log.blockNumber,
        hash: block.hash,
        parentHash: block.parentHash,
      });
    }
  }
  /**
   * Who actually traded, for pool swaps.
   *
   * v4's `Swap` carries `sender`, and `sender` is whoever CALLED `PoolManager.swap` — the
   * UniversalRouter for every trade this app sends, never the person. There is no field on the
   * event for the person, so it comes from the transaction that carried the log.
   *
   * The code that this replaces read `a.recipient`, a field the v4 event does not have. That is
   * `undefined`, and it went through `String()` on its way into a text column, so every graduated
   * market's trade feed recorded the four-letter string "undefined" as the trader — which is not
   * null, so nothing downstream treated it as missing.
   *
   * Fetched out here with the block timestamps, and for the same reason: these are RPC round trips
   * and the transaction below must not be held open across them.
   */
  const traders = new Map<string, string>();
  for (const { log, decoded } of ordered) {
    // `ModifyLiquidity` needs this for a sharper reason than `Swap` does. Its `sender` is
    // `msg.sender` ON THE POOL MANAGER, which for every deposit made through the periphery is the
    // PositionManager — the same address for every position ever minted. Attributing rows to it
    // makes `listForAccount` match nobody, so the portfolio renders empty while the positions are
    // sitting right there in the table.
    if (decoded.eventName !== "Swap" && decoded.eventName !== "ModifyLiquidity") continue;
    const hash = log.transactionHash;
    if (traders.has(hash)) continue;
    try {
      const tx = await client.getTransaction({ hash: hash });
      traders.set(hash, tx.from.toLowerCase());
    } catch {
      // A node that cannot answer should not cost us the swap. The router is wrong but it is an
      // address, and the alternative is dropping a real trade from the feed.
      traders.set(hash, String(decoded.args.sender).toLowerCase());
    }
  }

  const lastBlock = await client.getBlock({ blockNumber: to });
  // The block a pass ends on is recorded whether or not it emitted anything: it is the checkpoint,
  // so it is the first height a reorg check will ask about.
  seenBlocks.set(to, { number: to, hash: lastBlock.hash, parentHash: lastBlock.parentHash });

  /**
   * The whole range, and the checkpoint that says it was indexed, in one transaction.
   *
   * This is the property the service was missing. Written as independent statements, a crash
   * between an event and the aggregate it feeds left `market_state.volume_quote` disagreeing with
   * the trades it came from — permanently, because nothing recomputes it outside a rewind, and
   * invisibly, because a wrong total is still a plausible number.
   *
   * The checkpoint moves with the events or not at all. A pass that fails re-runs from the same
   * block, and the `ON CONFLICT` clauses make that a no-op.
   */
  await runInTransaction(async (tx) => {
    for (const { log, decoded } of orderForApply(ordered)) {
      await applyLog(tx, log, decoded, timestamps.get(log.blockNumber)!, cfg, announce, traders);
      await recordEvent(tx, log.blockNumber, log.transactionHash, log.logIndex, decoded.eventName);
    }
    for (const block of seenBlocks.values()) await recordBlock(tx, block);
    await setStatus(tx, to, lastBlock.hash, head);

    // Trimmed in the same transaction, so the ledger cannot be pruned by a pass that then rolls
    // back. Kept well beyond the lookback: the cost of a spare row is nothing, and the cost of
    // having pruned one the reorg walk needed is a rewind to the floor.
    const retain = to > MAX_REORG_DEPTH * 4n ? to - MAX_REORG_DEPTH * 4n : 0n;
    await pruneBlocksBelow(tx, retain);
  });

  /**
   * Announced only once the transaction has committed.
   *
   * A client told about a swap before the row is visible would refetch, see the market unchanged,
   * and sit on stale numbers until the next event. Publishing inside the transaction makes that
   * the common case rather than a race — and a rolled-back transaction would have announced a
   * trade that never happened.
   */
  const feed = cfg.live ?? nullFeed;
  for (const event of pending.values()) feed.publish(event);

  return { from, to, logs: logs.length, head };
}

/**
 * Two logs in one transaction that have to be applied out of emission order.
 *
 * A `ModifyLiquidity` log is attached to its market by looking the pool id up in `graduations`.
 * Graduation MINTS the protocol's locked position, so on the transaction that creates a market's
 * pool both logs land together -- and the mint comes first, because the `Graduated` event is
 * emitted at the end of `graduate()`. Handled in log order, that position finds no graduation
 * row, silently returns, and the market's first and largest position is never indexed.
 *
 * `PoolRegistered` is deferred for the same reason and it is the same transaction: the hook
 * registers the pool inside `graduate()`, before the `Graduated` that creates the row it patches
 * with the sink address. In log order it finds nothing to update and the sink is never
 * discovered, which silently costs the market its reward-vault and burn ledger.
 */
const DEFERRED = new Set(["ModifyLiquidity", "PoolRegistered"]);

/**
 * Chain order, with the two deferred events moved to the end of THEIR OWN TRANSACTION.
 *
 * Per transaction, not per range, and the difference is a whole class of dropped rows. Deferring
 * to the end of the range puts `PoolRegistered` after every LATER transaction as well, including
 * the `Funded` and `Burned` logs that can only be attributed once `graduations.sink` is set. Those
 * find no sink, return silently, and the market's dividends and burns are permanently short by
 * whatever happened in the rest of that range -- which on a backfill is a hundred blocks at a
 * time, so it is the common case there rather than a corner.
 *
 * Both reasons for deferring are same-transaction reasons, so a same-transaction fix is the whole
 * of what they need. Logs arrive sorted by (block, logIndex) and a transaction's logs are
 * contiguous in that order, so one pass over the runs is enough.
 */
export function orderForApply<T extends { log: AnyLog; decoded: DecodedLog }>(entries: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < entries.length; ) {
    const tx = entries[i]!.log.transactionHash;
    let j = i;
    while (j < entries.length && entries[j]!.log.transactionHash === tx) j++;
    const run = entries.slice(i, j);
    for (const entry of run) if (!DEFERRED.has(entry.decoded.eventName)) out.push(entry);
    for (const entry of run) if (DEFERRED.has(entry.decoded.eventName)) out.push(entry);
    i = j;
  }
  return out;
}

/**
 * Apply one decoded log.
 *
 * Exported so a handler test can drive it with logs built by `encodeEventTopics` rather than by
 * standing up a chain — the gen-2 contracts are not in the anvil scenario the other suites use,
 * and a test that reimplemented the dispatch would prove nothing about the dispatch.
 */
export async function applyLog(
  db: Db,
  log: AnyLog,
  decoded: { eventName: string; args: Record<string, unknown> },
  ts: Date,
  cfg: IngestConfig,
  announce: (event: LiveEvent) => void,
  /** Transaction hash to the address that signed it, for events that do not carry the trader. */
  traders: Map<string, string> = new Map(),
): Promise<void> {
  const base = {
    block: log.blockNumber.toString(),
    hash: log.blockHash,
    idx: log.logIndex,
    tx: log.transactionHash,
  };
  // viem returns a union across every event in the ABI, so fields are read positionally per
  // branch below. Narrowed at each use rather than up front, because the branch is what knows
  // which fields this particular log actually carries.
  const a = decoded.args as Record<string, string | bigint>;

  switch (decoded.eventName) {
    case "MarketLaunched": {
      // Which generation a launch belongs to is decided by the address that emitted it, never by
      // the event's name: both factories emit `MarketLaunched`, with different inputs and so
      // different selectors, and a log from neither is another protocol's.
      const entry = factoryAbis(cfg).get(log.address.toLowerCase());
      if (!entry) return;
      if (entry.generation === 2) return handleMarketLaunched2(db, a, ts, base, announce);
      await db.query(
        `INSERT INTO markets (market_address, token_address, symbol, name, symbol_key, creator,
                              quote_target, block_number, block_hash, log_index, tx_hash, created_at)
         VALUES ($1,$2,$3,$3,$4,$5,$11,$6,$7,$8,$9,$10)
         ON CONFLICT (tx_hash, log_index) DO NOTHING`,
        [
          String(a.curve).toLowerCase(),
          String(a.token).toLowerCase(),
          String(a.symbol),
          String(a.key),
          String(a.creator).toLowerCase(),
          base.block,
          base.hash,
          base.idx,
          base.tx,
          ts,
          // From the event, not a contract call: it is per-market and immutable, and reading zero
          // here would make every progress bar on the site show 0%.
          (a.quoteTarget as bigint).toString(),
        ],
      );
      await db.query(
        `INSERT INTO market_state (market_address) VALUES ($1) ON CONFLICT DO NOTHING`,
        [String(a.curve).toLowerCase()],
      );
      announce({ type: "market", market: String(a.curve).toLowerCase() });
      return;
    }

    case "MetadataSet": {
      if (!cfg.factory2 || log.address.toLowerCase() !== cfg.factory2.toLowerCase()) return;
      return handleMetadataSet(db, a, ts, base, announce);
    }

    case "Bought":
    case "Sold": {
      const market = log.address.toLowerCase();
      const isBuy = decoded.eventName === "Bought";
      // Gen 2 emits `price`; gen 1 never did. The selector already told viem which ABI to use, so
      // the presence of the field is the generation.
      if ("price" in a) return handleTrade2(db, market, isBuy, a, ts, base, announce);
      const quote = (isBuy ? a.quoteIn : a.quoteOut) as bigint;
      const b = (isBuy ? a.baseOut : a.baseIn) as bigint;
      const raised = a.quoteRaised as bigint;
      const tax = isBuy ? ((a.tax as bigint | undefined) ?? 0n) : 0n;

      /**
       * The price the trade *leaves behind*, not the price it got.
       *
       * A trade's average execution price is not comparable between directions: a buy walks the
       * curve upward so its average sits below the resulting price, and a sell walks it downward
       * so its average sits above. Recording those made a sell print higher than the buy before
       * it, so the chart and market cap rose when someone sold.
       *
       * Derivable because the curve's price is a function of what it has raised, and the event
       * carries that. A market with no target on record cannot be priced; the fallback is the
       * amounts, which is wrong in the way described above but better than a zero that would
       * silently flatten a chart.
       */
      // `::text`, because this row is read back into JavaScript. Through Prisma an un-cast
      // NUMERIC arrives as a Decimal, and `BigInt(decimal)` throws — the same hazard the read API
      // has, and the reason every column crossing this boundary is cast in SQL rather than
      // converted afterwards.
      const { rows: targetRows } = await db.query<{ quote_target: string }>(
        "SELECT quote_target::text AS quote_target FROM markets WHERE market_address = $1",
        [market],
      );
      // Not one of ours. The protocol-event query has no address filter, so any contract on the
      // chain whose `Bought`/`Sold` shares this signature lands here; `swaps.market_address` is a
      // foreign key, so inserting it would fail the whole pass and halt ingestion for good.
      // `handleTrade2` already returns here; this is the same rule for the older signature.
      if (!targetRows[0]) return;
      const target = BigInt(targetRows[0].quote_target);
      const price = target > 0n ? curveSpotPrice(raised, target).toString() : priceOf(quote, b);

      const inserted = await db.query(
        `INSERT INTO swaps (market_address, trader, is_buy, venue, quote_amount, base_amount, fee,
                            tax, quote_raised, price, block_number, block_hash, log_index, tx_hash,
                            ts)
         VALUES ($1,$2,$3,'curve',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (tx_hash, log_index) DO NOTHING
         RETURNING id`,
        [
          market,
          String(isBuy ? a.buyer : a.seller).toLowerCase(),
          isBuy,
          quote.toString(),
          b.toString(),
          (a.fee as bigint).toString(),
          tax.toString(),
          raised.toString(),
          price,
          base.block,
          base.hash,
          base.idx,
          base.tx,
          ts,
        ],
      );
      // Only fold into aggregates when the row is new, or a re-ingest would double the volume.
      if (inserted.rowCount === 0) return;

      // VOLUME IS THE BUYER'S LEG, and that is a decision rather than an accident.
      //
      // The curve's own intake per buy is larger than `quoteIn`: the tax enters the curve too,
      // buying the token back to burn. So there are two defensible numbers here — what the trader
      // paid for tokens, and what the curve absorbed. This column feeds the price charts and the
      // volume figures a person reads, and the number that belongs there is what someone actually
      // spent buying. The tax is revenue, not trade.
      //
      // The consequence, stated so nobody treats the two as interchangeable later: volume here is
      // strictly less than the curve's intake while the tax window is open, so volume and
      // `quote_raised` will not reconcile on a hot launch. That is correct, not drift.
      await db.query(
        `UPDATE market_state
            SET quote_raised = $2,
                last_price = $3,
                volume_quote = volume_quote + $4,
                trade_count = trade_count + 1,
                block_number = $5
          WHERE market_address = $1`,
        [market, raised.toString(), price, quote.toString(), base.block],
      );
      await updateCandles(db, market, ts, price, quote);
      announce({ type: "swap", market, isBuy });
      return;
    }

    case "FeesCollected":
    case "TaxCollected":
    case "ProtocolFeesCollected":
      return handleCollection(db, decoded.eventName, log.address.toLowerCase(), a, ts, base, announce);

    case "Transfer": {
      // Only tokens this indexer knows about; the log filter is by block range, not by address,
      // so unrelated ERC20 traffic on the chain shows up here too.
      const token = log.address.toLowerCase();
      const { rows } = await db.query<{ market_address: string }>(
        "SELECT market_address FROM markets WHERE token_address = $1",
        [token],
      );
      const market = rows[0]?.market_address;
      if (!market) return;

      const from = String(a.from).toLowerCase();
      const to = String(a.to).toLowerCase();
      const value = a.value as bigint;

      const inserted = await db.query(
        `INSERT INTO transfers (token_address, from_address, to_address, value,
                                block_number, block_hash, log_index, tx_hash, ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (tx_hash, log_index) DO NOTHING
         RETURNING id`,
        [token, from, to, value.toString(), base.block, base.hash, base.idx, base.tx, ts],
      );
      // A balance is a running delta, so applying it twice is not idempotent the way an upsert is.
      // Re-ingesting a range must not move anyone's balance.
      if (inserted.rowCount === 0) return;

      await applySupplyDelta(db, market, from, to, value);

      await applyTransfer(db, token, from, to, value);
      await recountHolders(db, market, cfg.graduation);
      return;
    }

    case "Swap": {
      /**
       * A trade on a graduated market's pool.
       *
       * Recorded so the chart and the trade feed keep working after the curve closes. Without it
       * both stop at the moment of graduation, and a frozen chart is indistinguishable from a
       * market nobody is trading.
       */
      // THE POOL ID GATE, and it is a correctness requirement rather than an optimisation.
      //
      // Under V3 `log.address` identified the market, because each pool was its own contract. Under
      // v4 every swap on every v4 pool on the chain is emitted by the same PoolManager, so the
      // address proves nothing and the id in `topics[1]` is the only thing that does.
      //
      // Without this, a market's chart and trade feed would fill with other people's stablecoin
      // swaps. `logQueries` already asks the node to filter on the same id — that is for cost. This
      // is for correctness, and the two are separate requirements: a node that ignores a topic
      // filter, an operator who widens the query while debugging, or a replay through a different
      // path all bypass the first and none of them bypass this.
      const poolId = String(a.id).toLowerCase();
      const { rows } = await db.query<{
        market_address: string;
        token_address: string;
        currency0: string;
        quote_asset: string;
        generation: number;
      }>(
        `SELECT g.market_address, m.token_address, g.currency0, g.quote_asset, m.generation
           FROM graduations g
           JOIN markets m USING (market_address)
          WHERE g.pool_id = $1`,
        [poolId],
      );
      const market = rows[0];
      if (!market) return;

      // Which side is the market's token, read from the pool's OWN stored `currency0` rather than
      // reconstructed from constants — a key rebuilt here is one refactor away from disagreeing
      // with the pool it claims to describe, and the failure is silent.
      //
      // `||`, not `??`: the column defaults to the EMPTY STRING for rows written before the key
      // was stored, and an empty string is not null. The fallback re-derives the sort from
      // `(quote_asset, token)` — the same sort the graduator uses — rather than assuming native
      // MON, which was only ever true while every pool was quoted in MON. `quote_asset` itself
      // defaults to address(0), so a gen-1 row with no stored key still resolves MON-first.
      const currency0 =
        market.currency0 ||
        poolKeyFor(market.quote_asset || NATIVE_CURRENCY, market.token_address, NATIVE_CURRENCY)
          .currency0;
      const token0IsMarketToken = marketTokenIsCurrency0(market.token_address, currency0);
      const amount0 = a.amount0 as unknown as bigint;
      const amount1 = a.amount1 as unknown as bigint;
      const baseDelta = token0IsMarketToken ? amount0 : amount1;
      const quoteDelta = token0IsMarketToken ? amount1 : amount0;

      // Signs are from the SWAPPER's perspective in v4, and they were from the POOL's in V3. This
      // is the single most invertible line in the ingester: v4's `Swap` carries the `BalanceDelta`
      // applied to the caller, so a negative amount is what they PAID and a positive amount is what
      // they RECEIVED. Someone receiving the market's token is buying it.
      //
      // Under V3 the same field meant the opposite — positive was what the pool took in — so the
      // V3-era `baseDelta < 0n` survived the migration and labelled every pool buy a sell and every
      // sell a buy. Nothing about the data looks wrong when this is backwards: the volume, the
      // price and the counts are all still right, and only the arrow is reversed.
      const isBuy = baseDelta > 0n;
      const baseAmount = baseDelta < 0n ? -baseDelta : baseDelta;
      const quoteAmount = quoteDelta < 0n ? -quoteDelta : quoteDelta;
      if (baseAmount === 0n || quoteAmount === 0n) return;

      // V3 reports the exact post-swap price in the event, so nothing has to be inferred from the
      // amounts — which would again give an average rather than a price. The curve formula cannot
      // be used here: a graduated curve's `quoteRaised` never moves again, so it would freeze the
      // price at the moment of graduation while the pool kept trading.
      //
      // Scaled to the MARKET's generation, not left at the function's own. A `sqrtPriceX96` is a
      // ratio of raw amounts and carries no generation with it, so the scale has to be told to it.
      // Generation 2's curve emits `quote * 1e36 / base` (`BondingCurve._price`, scaled that far so
      // a six-decimal quote does not truncate), and its pool prices land in the SAME `price`
      // column, the same candles and the same all-time high. At generation 1's 1e18 a
      // generation-2 market's price scale would drop by 1e18 the moment it graduated: every candle
      // after graduation a billion-billionth the height of the ones before it, an all-time high
      // permanently pinned to the curve era, and a market cap that cannot be right on both sides of
      // the event whichever divisor the read side picks.
      //
      // PASSED IN, not multiplied onto the result. `poolSpotPrice` divides, so a factor applied
      // afterwards is applied to something already truncated — and on a six-decimal quote as coarse
      // as gold the 1e18 figure is below 1 and truncates to zero, which multiplying cannot undo.
      const price = poolSpotPrice(
        a.sqrtPriceX96 as bigint,
        token0IsMarketToken,
        Number(market.generation) === 2 ? PRICE_SCALE * GEN2_PRICE_SCALE_UP : PRICE_SCALE,
      ).toString();

      const inserted = await db.query(
        `INSERT INTO swaps (market_address, trader, is_buy, venue, quote_amount, base_amount, fee,
                            tax, quote_raised, price, block_number, block_hash, log_index, tx_hash,
                            ts)
         VALUES ($1,$2,$3,'pool',$4,$5,0,0,
                 -- Carried forward, not recomputed. quote_raised describes the curve, which is
                 -- closed by now; writing zero would make a graduated market's progress collapse
                 -- to nothing on its next trade.
                 (SELECT quote_raised FROM market_state WHERE market_address = $1),
                 $6,$7,$8,$9,$10,$11)
         ON CONFLICT (tx_hash, log_index) DO NOTHING
         RETURNING id`,
        [
          market.market_address,
          traders.get(log.transactionHash) ?? String(a.sender).toLowerCase(),
          isBuy,
          quoteAmount.toString(),
          baseAmount.toString(),
          price,
          base.block,
          base.hash,
          base.idx,
          base.tx,
          ts,
        ],
      );
      if (inserted.rowCount === 0) return;

      await db.query(
        `UPDATE market_state
            SET last_price = $2,
                volume_quote = volume_quote + $3,
                trade_count = trade_count + 1,
                block_number = $4
          WHERE market_address = $1`,
        [market.market_address, price, quoteAmount.toString(), base.block],
      );
      await updateCandles(db, market.market_address, ts, price, quoteAmount);
      announce({ type: "swap", market: market.market_address, isBuy });
      return;
    }

    case "ReadyToGraduate": {
      await db.query(
        `UPDATE market_state SET ready_to_graduate = TRUE, ready_block = $2
          WHERE market_address = $1`,
        [log.address.toLowerCase(), base.block],
      );
      return;
    }

    /**
     * The filling buy could not graduate the market, and said so.
     *
     * Nothing to write: the state this describes — ready, and poolless — is already what the row
     * says after `ReadyToGraduate` with no `Graduated` behind it, and that row is exactly what the
     * graduation keeper polls. This is the diagnostic the contract emits so the reason is on
     * record: `gasLeft` near zero is a starved buy, which the keeper repairs; `gasLeft` in the
     * millions is a graduation that reverted for a reason of its own, which it will not.
     */
    case "AutoGraduationFailed": {
      const market = log.address.toLowerCase();
      const { rows } = await db.query<{ market_address: string }>(
        "SELECT market_address FROM markets WHERE market_address = $1",
        [market],
      );
      if (!rows[0]) return;
      ingestLog.warn("a filling buy could not graduate its market", {
        market,
        gasLeft: String(a.gasLeft),
        block: base.block,
        tx: log.transactionHash,
      });
      return;
    }

    /**
     * A liquidity position changed in one of our pools.
     *
     * The event is the ONLY discovery route. v4's PositionManager is ERC-721 but not Enumerable,
     * and on Monad it is the canonical manager shared by every v4 protocol — over six hundred
     * thousand positions — so nothing can walk it to find an owner's holdings.
     *
     * `salt` is the token id: the manager passes `bytes32(tokenId)` so each position gets unique
     * storage in the pool manager.
     *
     * `owner` is the transaction's SIGNER, not the event's `sender`. `sender` here is `msg.sender`
     * as the pool manager saw it, which is the PositionManager for anything minted through the
     * periphery — one address for every position on the chain. (The periphery's own
     * `ModifyPosition` did carry the end user, which is where the older comment came from; this is
     * a different event from a different contract.) The signer is a DISCOVERY hint, exactly as the
     * repository documents: a position minted to someone else, or transferred as an NFT, leaves it
     * stale, and callers confirm against `ownerOf` before showing anything.
     */
    case "ModifyLiquidity": {
      const poolId = String(a.id).toLowerCase();
      const { rows } = await db.query<{ market_address: string }>(
        "SELECT market_address FROM graduations WHERE pool_id = $1",
        [poolId],
      );
      const market = rows[0];
      // The topic filter already narrows to our pools; this is the correctness half of the same
      // requirement, exactly as in the `Swap` case.
      if (!market) return;

      const tokenId = BigInt(String(a.salt)).toString();
      const delta = (a.liquidityDelta as unknown as bigint).toString();

      await db.query(
        `INSERT INTO positions (token_id, pool_id, market_address, owner, tick_lower, tick_upper,
                                liquidity, block_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (token_id) DO UPDATE SET
           -- Accumulated, because the event carries a DELTA. A withdrawal is negative and a closed
           -- position settles at exactly zero rather than vanishing, which is what lets the read
           -- side tell "emptied" apart from "never existed".
           liquidity    = positions.liquidity + EXCLUDED.liquidity,
           owner        = EXCLUDED.owner,
           block_number = EXCLUDED.block_number,
           updated_at   = NOW()`,
        [
          tokenId,
          poolId,
          market.market_address,
          traders.get(log.transactionHash) ?? String(a.sender).toLowerCase(),
          Number(a.tickLower),
          Number(a.tickUpper),
          delta,
          log.blockNumber.toString(),
        ],
      );
      return;
    }

    case "PoolRegistered":
      return handlePoolRegistered(db, a, log.address, cfg);

    case "TaxLevied":
    case "Swept":
      return handleHookEvent(db, decoded.eventName, a, log.address, ts, base, cfg, announce);

    case "Registered":
    case "Credited":
    case "Pulled":
    case "RecipientTransferred":
      return handleCreatorSinkEvent(
        db,
        decoded.eventName,
        a,
        log.address,
        ts,
        base,
        cfg,
        announce,
      );

    /**
     * `Claimed` twice over, and the ADDRESS is what tells them apart.
     *
     * `CreatorSink.Claimed(address,address,uint256)` and
     * `RewardVault.Claimed(address,uint256,uint256)` have different selectors, so viem already
     * decoded the right one — but a vault's claim and a creator's claim are different money in
     * different tables, and the shared name is exactly the kind of thing a later refactor
     * collapses. The emitter decides.
     */
    case "Claimed": {
      if (cfg.creatorSink && log.address.toLowerCase() === cfg.creatorSink.toLowerCase())
        return handleCreatorSinkEvent(db, "Claimed", a, log.address, ts, base, cfg, announce);
      return handleSinkEvent(db, "Claimed", a, log.address, ts, base, announce);
    }

    case "Funded":
    case "Burned":
      return handleSinkEvent(db, decoded.eventName, a, log.address, ts, base, announce);

    case "QuoteAssetRegistered":
    case "QuoteTargetChanged":
    case "QuoteAssetEnabled":
      return handleRegistryEvent(db, decoded.eventName, a, log.address, base.block, cfg);

    case "Graduated": {
      // Any of the accepted graduators, not just the newest. Markets pin their graduator at launch,
      // so the ones bonding when a new one is deployed graduate through the old one — and dropping
      // those would record a market as never having graduated while it trades on chain.
      const emitters = cfg.graduators ?? [cfg.graduation];
      if (!emitters.some((g) => g.toLowerCase() === log.address.toLowerCase())) return;
      // Gen 2 carries the quote asset and no PoolKey; gen 1 carries the key and no quote. The
      // selector already told viem which ABI to use, so the presence of the field is the
      // generation — the same test the `Bought`/`Sold` split uses.
      if ("quoteAsset" in a) return handleGraduated2(db, a, ts, base, cfg, announce);
      const market = String(a.curve).toLowerCase();
      // Emitted as a tuple by `DokuGraduation._announce`. Defaulted rather than required so a log
      // from an older deployment still records the market instead of throwing mid-batch and
      // stalling the whole ingester behind one row.
      const key = (a.key ?? {}) as {
        currency0?: string;
        currency1?: string;
        fee?: number;
        tickSpacing?: number;
        hooks?: string;
      };
      await db.query(
        // `pool_address` is the PoolManager under v4 — the same value on every row, which is
        // exactly right for the holder exclusion (it really does hold every market's tokens) and
        // exactly useless for routing. `pool_id` is what routes, and it is stored alongside the
        // full PoolKey rather than reconstructed from constants later.
        `INSERT INTO graduations (market_address, pool_address, pool_id, currency0, currency1,
                                  fee, tick_spacing, hooks, sink, sink_kind, token_id, quote_amount,
                                  base_amount, liquidity, block_number, block_hash, log_index,
                                  tx_hash, ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (tx_hash, log_index) DO NOTHING`,
        [
          market,
          (cfg.poolManager ?? "").toLowerCase(),
          String(a.poolId).toLowerCase(),
          String(key.currency0 ?? "").toLowerCase(),
          String(key.currency1 ?? "").toLowerCase(),
          Number(key.fee ?? 0),
          Number(key.tickSpacing ?? 0),
          String(key.hooks ?? "").toLowerCase(),
          String(a.sink ?? "").toLowerCase(),
          Number(a.sinkKind ?? 0),
          (a.tokenId as bigint).toString(),
          (a.quoteAmount as bigint).toString(),
          (a.baseAmount as bigint).toString(),
          (a.liquidity as bigint).toString(),
          base.block,
          base.hash,
          base.idx,
          base.tx,
          ts,
        ],
      );
      // The PoolManager, not a per-market pool: v4 has no pool contract, and the event carries no
      // `pool` field to read. An earlier revision still read one here and wrote the string
      // "undefined" into the column, which is a value every `IS NOT NULL` check accepts.
      await db.query(
        "UPDATE market_state SET pool_address = $2, pool_id = $3 WHERE market_address = $1",
        [market, (cfg.poolManager ?? "").toLowerCase(), String(a.poolId).toLowerCase()],
      );
      announce({ type: "graduation", market });
      return;
    }
  }
}
