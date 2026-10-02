import { describe, expect, it } from "vitest";

import { toEventSelector } from "viem";

import { creatorSinkAbi } from "../src/indexer/abi.js";
import {
  BURNED_EVENT,
  FUNDED_EVENT,
  logQueries,
  POOL_SWAP_EVENT,
  rangeEnd,
  TRANSFER_EVENT,
  VAULT_CLAIMED_EVENT,
} from "../src/indexer/ingestion/ingest.js";

/**
 * What the indexer asks the node for.
 *
 * This is not a detail of style. Asking for every log in a block range worked against anvil, where
 * the only traffic is the test's own, and does not work against a chain: Monad testnet carries
 * around 3,300 logs per hundred blocks, of which ours are a handful. And Monad's public RPC caps
 * `eth_getLogs` at a hundred blocks, so a request for two thousand is rejected outright — the
 * indexer never advanced a single block, while reporting itself healthy and zero-lag.
 *
 * Both failures are invisible from the outside, which is why the shape of the request is pinned
 * here rather than left to whatever the anvil tests happen to tolerate.
 */
describe("log queries", () => {
  const from = 1_000n;
  const to = 1_099n;

  it("clamps a range to the configured maximum", () => {
    expect(rangeEnd(1_000n, 9_999_999n, 100n)).toBe(1_099n);
  });

  /// Near the head there is less than a full range left, and asking past it would be asking for
  /// blocks that do not exist yet.
  it("stops at the safe head when the range would overshoot it", () => {
    expect(rangeEnd(1_000n, 1_040n, 100n)).toBe(1_040n);
  });

  it("asks for a single block when that is all there is", () => {
    expect(rangeEnd(1_000n, 1_000n, 100n)).toBe(1_000n);
  });

  /**
   * The protocol's own events are unique to our contracts, so a topic filter is enough and the
   * node does the work. Without one the client downloads every log on the chain and throws
   * away 99.9% of it after decoding.
   */
  it("filters the protocol's events by topic", () => {
    const [protocol] = logQueries({ from, to, tokens: [], poolIds: [], sinks: [] });
    expect(protocol!.fromBlock).toBe(from);
    expect(protocol!.toBlock).toBe(to);
    const names = protocol!.events.map((e) => e.name);
    expect(names).toContain("MarketLaunched");
    expect(names).toContain("Bought");
    // Not `Transfer` or `Swap` — those are shared with every token and pool on the chain.
    expect(names).not.toContain(TRANSFER_EVENT.name);
    expect(names).not.toContain(POOL_SWAP_EVENT.name);
    expect(protocol!.address).toBeUndefined();
  });

  /**
   * `Transfer` and V3's `Swap` are emitted by every token and every pool on the chain, so a topic
   * filter narrows nothing. These are asked for by address instead.
   */
  it("asks for transfers only from tokens it knows about", () => {
    const token = "0x1111111111111111111111111111111111111111";
    const queries = logQueries({ from, to, tokens: [token], poolIds: [], sinks: [] });
    const transfers = queries.find((q) => q.events.some((e) => e.name === TRANSFER_EVENT.name));
    expect(transfers?.address).toEqual([token]);
  });

  /**
   * Under V3 this asserted an address filter, because each pool was its own contract and the
   * address WAS the filter. Under v4 every swap on every v4 pool on the chain comes from the one
   * PoolManager, so the address narrows nothing and the PoolId topic has to do the work.
   *
   * The assertion is therefore on `args.id`, not on `address`: if that ever silently drops, the
   * indexer asks a node for the chain's entire v4 swap volume and decodes all of it.
   */
  it("filters pool swaps by PoolId, not by address", () => {
    const poolManager = "0x1111111111111111111111111111111111111111" as `0x${string}`;
    const poolId = "0x2222222222222222222222222222222222222222222222222222222222222222";
    const queries = logQueries({ from, to, tokens: [], poolIds: [poolId], sinks: [], poolManager });

    const swaps = queries.find((q) => q.events.some((e) => e.name === POOL_SWAP_EVENT.name));
    expect(swaps?.address).toEqual([poolManager]);
    expect((swaps?.args as { id?: string[] } | undefined)?.id).toEqual([poolId]);
  });

  /**
   * No PoolManager configured means no swap query at all, rather than an unfiltered one. A curve-
   * only deployment is a real configuration; asking for every v4 swap on the chain is not.
   */
  it("asks for no pool swaps at all when there is no PoolManager configured", () => {
    const queries = logQueries({
      from,
      to,
      tokens: [],
      poolIds: ["0x2222222222222222222222222222222222222222222222222222222222222222"],
      sinks: [],
    });
    expect(queries.some((q) => q.events.some((e) => e.name === POOL_SWAP_EVENT.name))).toBe(false);
  });

  /**
   * A range with no known tokens and no known pools must not ask for them. An `eth_getLogs` with
   * an empty address array is not "nothing" to a node — it is "no address filter", which is a
   * request for every transfer on the chain.
   */
  it("omits the address-filtered queries entirely when there is nothing to ask about", () => {
    const queries = logQueries({ from, to, tokens: [], poolIds: [], sinks: [] });
    expect(queries.length).toBe(1);
    expect(queries.every((q) => q.address === undefined)).toBe(true);
    expect(queries[0]!.events.length).toBeGreaterThan(0);
  });

  /**
   * `Funded(uint256)`, `Burned(uint256,uint256)` and the vault's `Claimed` are generic signatures
   * any contract on the chain might emit, so they are asked for BY ADDRESS -- the per-market sinks
   * `PoolRegistered` revealed -- exactly as `Transfer` is.
   */
  it("asks for vault and burn-sink events only from sinks it knows about", () => {
    const sink = "0x5555555555555555555555555555555555555555";
    const queries = logQueries({ from, to, tokens: [], poolIds: [], sinks: [sink] });
    const q = queries.find((query) => query.events.some((e) => e.name === FUNDED_EVENT.name));
    expect(q?.address).toEqual([sink]);
    expect(q?.events.map((e) => e.name).sort()).toEqual(["Burned", "Claimed", "Funded"]);
  });

  /**
   * Two `Claimed`s: the CreatorSink's is unique to it and stays a topic filter; the vault's is
   * generic and must not be -- the exclusion has to be by selector, not by name.
   */
  it("keeps CreatorSink.Claimed in the protocol query and RewardVault.Claimed out of it", () => {
    const [protocol] = logQueries({ from, to, tokens: [], poolIds: [], sinks: [] });
    const selectors = protocol!.events.map((e) => toEventSelector(e));
    const creatorClaimed = creatorSinkAbi.find((e) => e.type === "event" && e.name === "Claimed")!;
    expect(selectors).toContain(toEventSelector(creatorClaimed));
    expect(selectors).not.toContain(toEventSelector(VAULT_CLAIMED_EVENT));
    expect(selectors).not.toContain(toEventSelector(FUNDED_EVENT));
    expect(selectors).not.toContain(toEventSelector(BURNED_EVENT));
  });
});
