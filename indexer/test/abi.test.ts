import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type AbiEvent, toEventSelector } from "viem";
import {
  allEvents,
  burnSinkAbi,
  creatorSinkAbi,
  curve2Abi,
  curveAbi,
  erc20Abi,
  factory2Abi,
  factoryAbi,
  factoryAbis,
  graduation2Abi,
  graduationAbi,
  hook2Abi,
  poolManagerAbi,
  quoteRegistryAbi,
  rewardVaultAbi,
} from "../src/indexer/abi.js";

/**
 * The indexer's ABIs are hand-written, so they can drift from the contracts without anything
 * failing to compile. When they do, `eth_getLogs` matches nothing and the feed goes quiet.
 *
 * Two claims are pinned, and they are different claims. "The signature exists in some artifact"
 * is what the old test checked, and it passed while `ModifyPosition` — present in the vendored
 * PositionManager ABI — was never emitted on mainnet. "The signature is in the artifact of the
 * contract whose address we filter by" is what indexes anything.
 */
function selectorsFrom(artifact: string): Set<string> {
  const base = `../contracts/out/${artifact}`;
  const candidates = [base, base.replace(/\.json$/, ".default.json")];
  const path = candidates.find((c) => existsSync(c));
  if (!path) throw new Error(`no artifact at ${candidates.join(" or ")} — has forge build run?`);
  return selectorsInFile(path);
}

/** Same read, but for a path given whole — the gen-1 snapshot lives outside `out/`. */
function selectorsFromPath(path: string): Set<string> {
  if (!existsSync(path)) {
    throw new Error(`no gen-1 artifact at ${path} — run the contracts plan's out-gen1 snapshot step`);
  }
  return selectorsInFile(path);
}

function selectorsInFile(path: string): Set<string> {
  const json = JSON.parse(readFileSync(path, "utf8")) as {
    abi?: { type: string; name: string; inputs: { type: string }[] }[];
  };
  const out = new Set<string>();
  for (const item of json.abi ?? []) {
    if (item.type === "event") {
      out.add(toEventSelector(`${item.name}(${item.inputs.map((i) => i.type).join(",")})`));
    }
  }
  return out;
}

const sig = (e: AbiEvent): string => `${e.name}(${e.inputs.map((i) => i.type).join(",")})`;

/**
 * Which artifact emits which ABI. Gen-2 contracts are the SAME source files modified in place
 * (see the contracts plan's Appendix I), so gen-1 signatures are pinned against the last gen-1
 * build kept under `contracts/out-gen1/` — the contracts plan commits that snapshot — and gen-2
 * against `out/`.
 */
const EMITTERS: [string, readonly AbiEvent[]][] = [
  ["../contracts/out-gen1/DokuFactory.sol/DokuFactory.json", factoryAbi],
  ["../contracts/out-gen1/BondingCurve.sol/BondingCurve.json", curveAbi],
  ["../contracts/out-gen1/DokuGraduation.sol/DokuGraduation.json", graduationAbi],
  ["DokuFactory.sol/DokuFactory.json", factory2Abi],
  ["BondingCurve.sol/BondingCurve.json", curve2Abi],
  ["DokuGraduation.sol/DokuGraduation.json", graduation2Abi],
  ["DokuHook.sol/DokuHook.json", hook2Abi],
  ["CreatorSink.sol/CreatorSink.json", creatorSinkAbi], // foundry `out/` is flat by source-file
  //                                                       BASENAME, never by source directory
  ["QuoteRegistry.sol/QuoteRegistry.json", quoteRegistryAbi],
  ["RewardVault.sol/RewardVault.json", rewardVaultAbi],
  ["BurnSink.sol/BurnSink.json", burnSinkAbi],
  ["DokuToken.sol/DokuToken.json", erc20Abi],
  ["PoolManager.sol/PoolManager.json", poolManagerAbi],
];

describe("abi drift", () => {
  it.each(EMITTERS)("%s emits every event we decode from it", (artifact, abi) => {
    const onChain = artifact.startsWith("../") ? selectorsFromPath(artifact) : selectorsFrom(artifact);
    for (const event of abi) {
      if (event.type !== "event") continue;
      expect(onChain.has(toEventSelector(sig(event))), `${sig(event)} not emitted by ${artifact}`)
        .toBe(true);
    }
  });

  it("every event in allEvents is claimed by exactly one emitter list", () => {
    const claimed = new Set(
      EMITTERS.flatMap(([, abi]) => abi.filter((e) => e.type === "event").map(sig)),
    );
    for (const event of allEvents) {
      if (event.type !== "event") continue;
      expect(claimed.has(sig(event)), `${sig(event)} is decoded but pinned to no contract`).toBe(true);
    }
  });

  /// Same name, different selector — the whole reason both generations can share one list.
  it("gen-1 and gen-2 MarketLaunched/Bought/Sold/Graduated have distinct selectors", () => {
    const pairs: [readonly AbiEvent[], readonly AbiEvent[], string][] = [
      [factoryAbi, factory2Abi, "MarketLaunched"],
      [curveAbi, curve2Abi, "Bought"],
      [curveAbi, curve2Abi, "Sold"],
      [graduationAbi, graduation2Abi, "Graduated"],
    ];
    for (const [a, b, name] of pairs) {
      const ea = a.find((e) => e.type === "event" && e.name === name)!;
      const eb = b.find((e) => e.type === "event" && e.name === name)!;
      expect(toEventSelector(sig(ea))).not.toBe(toEventSelector(sig(eb)));
    }
  });

  it("maps each factory address to its generation and ABI", () => {
    const map = factoryAbis({
      factory: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      factory2: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    });
    expect(map.get("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")?.generation).toBe(1);
    // Lowercased on the way in: logs carry EIP-55, the map must not care.
    expect(map.get("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")?.generation).toBe(2);
    expect(map.get("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")?.abi).toBe(factory2Abi);
    expect(factoryAbis({ factory: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }).size).toBe(1);
  });

  /// Guards the fields the gen-2 handlers read without an RPC call.
  it("gen-2 Bought carries antiSniperTax, creatorTax, quoteRaised and price", () => {
    const bought = curve2Abi.find((e) => e.type === "event" && e.name === "Bought")!;
    const names = bought.inputs.map((i) => i.name);
    for (const n of ["quoteIn", "baseOut", "fee", "antiSniperTax", "creatorTax", "quoteRaised", "price"]) {
      expect(names).toContain(n);
    }
  });
});
