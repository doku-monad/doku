import {
  type Abi,
  type AbiEvent,
  decodeEventLog,
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
  type Log,
} from "viem";
import { allEvents } from "../src/indexer/abi.js";

export type FakeLog = Log<bigint, number, false>;
export type Decoded = { eventName: string; args: Record<string, unknown> };

let counter = 0;

/**
 * The `data` and `topics` the contract would emit for one event.
 *
 * viem has no `encodeEventLog` — it ships `encodeEventTopics` for the indexed half and
 * `encodeAbiParameters` for the rest, and a log is exactly those two halves. Built here rather
 * than hand-written hex so a signature change in `abi.ts` changes these bytes with it; a fixture
 * of literal topics would keep decoding cleanly into the wrong shape.
 */
function encodeEventLog(opts: {
  abi: Abi;
  eventName: string;
  args: Record<string, unknown>;
}): { data: Hex; topics: [Hex, ...Hex[]] } {
  const event = opts.abi.find(
    (item): item is AbiEvent => item.type === "event" && item.name === opts.eventName,
  );
  if (!event) throw new Error(`no event ${opts.eventName} in this abi`);
  const topics = encodeEventTopics({
    abi: opts.abi,
    eventName: opts.eventName,
    args: opts.args,
  }) as [Hex, ...Hex[]];
  const unindexed = event.inputs.filter((input) => !input.indexed);
  const data =
    unindexed.length === 0
      ? ("0x" as Hex)
      : encodeAbiParameters(
          unindexed,
          unindexed.map((input) => opts.args[input.name!]) as never,
        );
  return { data, topics };
}

/**
 * A log exactly as a node would return it, plus its decoding through the ingester's own list.
 *
 * `encodeEventLog` produces the topics and data the contract would; decoding them back through
 * `allEvents` is what proves the merged list still selects the right generation by selector.
 */
export function fakeLog(opts: {
  abi: Abi;
  eventName: string;
  args: Record<string, unknown>;
  address: string;
  block?: number;
  logIndex?: number;
  tx?: string;
}): { log: FakeLog; decoded: Decoded } {
  const { data, topics } = encodeEventLog({
    abi: opts.abi,
    eventName: opts.eventName,
    args: opts.args,
  });
  const block = BigInt(opts.block ?? 100);
  const n = counter++;
  const log = {
    address: opts.address as `0x${string}`,
    data,
    topics,
    blockNumber: block,
    blockHash: `0xblock${block}` as `0x${string}`,
    logIndex: opts.logIndex ?? n,
    transactionHash: (opts.tx ?? `0xtx${n}`) as `0x${string}`,
    transactionIndex: 0,
    removed: false,
  } as unknown as FakeLog;
  const decoded = decodeEventLog({ abi: allEvents, data, topics }) as unknown as Decoded;
  return { log, decoded };
}

export const TS = new Date("2026-09-07T00:00:00Z");
export const FACTORY2 = "0xf2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2";
export const FACTORY1 = "0xf1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1";
export const GRADUATION2 = "0xe2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2";
export const HOOK2 = "0xd2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2";
export const CREATOR_SINK = "0xc2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2";
export const REGISTRY = "0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
export const POOL_MANAGER = "0x188d586ddcf52439676ca21a244753fa19f9ea8e";
export const USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603";
export const CURVE = "0x1010101010101010101010101010101010101010";
export const TOKEN = "0x2020202020202020202020202020202020202020";
export const CREATOR = "0x3030303030303030303030303030303030303030";
export const ALICE = "0x4040404040404040404040404040404040404040";

/** The `IngestConfig` a gen-2 handler test hands to `applyLog`. */
export const cfg2 = {
  factory: FACTORY1 as `0x${string}`,
  factory2: FACTORY2 as `0x${string}`,
  graduation: "0xe1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1" as `0x${string}`,
  graduation2: GRADUATION2 as `0x${string}`,
  graduators: ["0xe1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1", GRADUATION2],
  hook2: HOOK2 as `0x${string}`,
  creatorSink: CREATOR_SINK as `0x${string}`,
  quoteRegistry: REGISTRY as `0x${string}`,
  poolManager: POOL_MANAGER as `0x${string}`,
  startBlock: 0n,
};
