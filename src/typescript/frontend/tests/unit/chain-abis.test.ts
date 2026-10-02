import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CONTRACT_ARTIFACTS, DOKU_ABIS } from "../../src/lib/chain/abis";

/**
 * The app's ABIs are generated from the compiled contracts, and generated files drift the moment
 * someone edits a contract without re-running the generator. Nothing fails to compile when that
 * happens — viem simply stops matching, and the symptom is a button that does nothing.
 *
 * These compare what shipped against the artifacts on disk.
 */
const artifactPath = (artifact: string) =>
  join(__dirname, "../../../../../contracts/out", artifact);

type AbiItem = { type: string; name?: string; inputs?: { type: string }[] };

const signature = (item: AbiItem) =>
  `${item.type}:${item.name}(${(item.inputs ?? []).map((i) => i.type).join(",")})`;

describe("generated contract ABIs", () => {
  it.each(Object.keys(DOKU_ABIS))("%s matches the compiled artifact", (name) => {
    const key = name as keyof typeof DOKU_ABIS;
    const compiled = JSON.parse(readFileSync(artifactPath(CONTRACT_ARTIFACTS[key]), "utf8")) as {
      abi: AbiItem[];
    };

    const onDisk = new Set(compiled.abi.map(signature));
    for (const item of DOKU_ABIS[key] as unknown as AbiItem[]) {
      expect(onDisk.has(signature(item))).toBe(true);
    }
  });

  /// The three the UI cannot work without. Named individually so a generator that silently emits
  /// an empty ABI fails here rather than at the first click.
  it.each([
    ["factory", "launch"],
    ["curve", "buy"],
    ["curve", "sell"],
    ["token", "balanceOf"],
  ])("%s exposes %s", (contract, fn) => {
    const abi = DOKU_ABIS[contract as keyof typeof DOKU_ABIS] as unknown as AbiItem[];
    expect(abi.some((i) => i.type === "function" && i.name === fn)).toBe(true);
  });
});
