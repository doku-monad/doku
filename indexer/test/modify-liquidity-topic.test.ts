import { describe, expect, it } from "vitest";
import { toEventSelector } from "viem";

import { allEvents } from "../src/indexer/abi.js";
import { MODIFY_LIQUIDITY_EVENT, logQueries } from "../src/indexer/ingestion/ingest.js";

/**
 * The position feed, pinned against a real mainnet transaction rather than against a contract.
 *
 * `abi.test.ts` asks whether a signature exists in some compiled artifact. That question passed
 * for `ModifyPosition` for as long as the indexer was broken, because the vendored v4-periphery
 * PositionManager really does declare and emit it — just not the canonical one Monad mainnet runs.
 * So this asks the only question that could have caught it: is this the topic a real deployment
 * actually logged?
 *
 * The values come from tx 0x53da5b4153f033e37b5a9cf8ba3167fa1004b67d664e2dc93eb315683ac0965e
 * (block 100763549), a mint into the 🎄🎄 pool. Its PoolManager log carries topic0
 * 0xf208f491…, and its only PositionManager log is the ERC-721 Transfer.
 */
const MAINNET_MODIFY_LIQUIDITY_TOPIC0 =
  "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec";
/** What the indexer used to look for. No contract on Monad mainnet has ever emitted it. */
const MODIFY_POSITION_TOPIC0 =
  "0x54e5dca345d804c4bcfd2d92dae077325838444a21d118beb4d25ec99a5788e5";

const POOL_MANAGER = "0x188d586ddcf52439676ca21a244753fa19f9ea8e" as const;
const POSITION_MANAGER = "0x5b7ec4a94ff9bedb700fb82ab09d5846972f4016" as const;
const POOL_ID = "0xe2dd498dd8777061a9d07448489f947c363458adbecb321d6833801366e18f5a" as const;

const topicOf = (e: { name: string; inputs: readonly { type: string }[] }) =>
  toEventSelector(`${e.name}(${e.inputs.map((i) => i.type).join(",")})`);

describe("position discovery", () => {
  it("watches the topic mainnet actually emits", () => {
    expect(topicOf(MODIFY_LIQUIDITY_EVENT as never)).toBe(MAINNET_MODIFY_LIQUIDITY_TOPIC0);
  });

  it("no longer watches a topic nothing emits", () => {
    for (const event of allEvents) {
      if (event.type !== "event") continue;
      expect(topicOf(event as never)).not.toBe(MODIFY_POSITION_TOPIC0);
    }
  });

  it("asks the pool manager for it, not the position manager", () => {
    const queries = logQueries({
      from: 1n,
      to: 2n,
      tokens: [],
      poolIds: [POOL_ID],
      sinks: [],
      poolManager: POOL_MANAGER,
      positionManager: POSITION_MANAGER,
    });
    const q = queries.find((x) =>
      (x.events ?? []).some((e) => (e as { name?: string }).name === "ModifyLiquidity"),
    );
    expect(q, "no ModifyLiquidity query is issued at all").toBeDefined();
    expect(q!.address).toEqual([POOL_MANAGER]);
    // The pool-id gate is a correctness requirement here: without it this returns every liquidity
    // change in every v4 pool on the chain, since the manager is shared by every protocol.
    expect(q!.args).toEqual({ id: [POOL_ID] });
  });

  it("issues the query even when no position manager is configured", () => {
    const queries = logQueries({
      from: 1n,
      to: 2n,
      tokens: [],
      poolIds: [POOL_ID],
      sinks: [],
      poolManager: POOL_MANAGER,
    });
    expect(
      queries.some((x) =>
        (x.events ?? []).some((e) => (e as { name?: string }).name === "ModifyLiquidity"),
      ),
    ).toBe(true);
  });
});

describe("the chain-wide query", () => {
  /**
   * The cost gate. `ModifyLiquidity` is emitted by the one PoolManager every v4 protocol on Monad
   * shares, so an unaddressed query for it returns the whole chain's liquidity traffic.
   */
  it("never asks for ModifyLiquidity without an address and a pool id", () => {
    const queries = logQueries({
      from: 1n,
      to: 2n,
      tokens: ["0x9b9238e222f731a18505a2c0c45f0ff32606aa78"],
      poolIds: [POOL_ID],
      sinks: [],
      poolManager: POOL_MANAGER,
      positionManager: POSITION_MANAGER,
    });
    for (const q of queries) {
      const wants = (q.events ?? []).some(
        (e) => (e as { name?: string }).name === "ModifyLiquidity",
      );
      if (!wants) continue;
      expect(q.address, "ModifyLiquidity asked for chain-wide").toBeDefined();
      expect(q.args, "ModifyLiquidity asked for without a pool id").toBeDefined();
    }
  });
});
