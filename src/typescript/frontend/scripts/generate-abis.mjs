#!/usr/bin/env node
/**
 * Emits `src/lib/chain/abis.ts` from the compiled Foundry artifacts.
 *
 * Generated rather than hand-written because viem infers argument and return types from the ABI
 * literal, so a hand-copied ABI does not just risk drift — it silently gives up the type checking
 * that would have caught the drift. `tests/unit/chain-abis.test.ts` compares what is emitted here
 * against the artifacts, so forgetting to re-run this is a test failure rather than a runtime one.
 *
 * Usage: pnpm generate:abis
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, "../../../../contracts/out");
const TARGET = join(here, "../src/lib/chain/abis.ts");

/** The contracts the app talks to, and nothing else. */
const CONTRACTS = {
  factory: "DokuFactory.sol/DokuFactory.json",
  curve: "BondingCurve.sol/BondingCurve.json",
  token: "DokuToken.sol/DokuToken.json",
  graduation: "DokuGraduation.sol/DokuGraduation.json",
  // Generation 2. The emoji registry is gone with the allowlist; a market's identity is metadata in
  // the launch transaction now. The quote registry says which assets a launch may raise in and at
  // what target, the CreatorSink is where a creator's routed share and tax are claimed from, and
  // the vault is where a holder claims dividends.
  quoteRegistry: "QuoteRegistry.sol/QuoteRegistry.json",
  creatorSink: "CreatorSink.sol/CreatorSink.json",
  rewardVault: "RewardVault.sol/RewardVault.json",
  // The hook. A graduated market's levy, its per-market terms, and the sink its share goes to are
  // all read from here — none of them are derivable from the pool, because under v4 the pool is
  // state inside a singleton rather than a contract with an interface of its own.
  hook: "DokuHook.sol/DokuHook.json",
  /**
   * Uniswap's v4 periphery. Not deployed by this repository — these are the canonical singletons
   * the app talks to — but the ABIs come from the same vendored source the contracts build
   * against, so the app cannot drift from the version the protocol was tested on.
   *
   * `SwapRouter` and `Quoter` used to be here. Both were V3 and both are gone; the artifacts
   * lingered in a stale `out/` long enough to keep generating cleanly, which is the same failure
   * shape `foundry.toml` warns about for the hook's creation code.
   */
  v4Quoter: "V4Quoter.sol/V4Quoter.json",
  stateView: "StateView.sol/StateView.json",
};

/**
 * UniversalRouter is NOT built from source here, and that is deliberate.
 *
 * It is not in the vendored tree, and pulling it in would add a dependency the protocol never
 * deploys just to obtain a type. The app calls exactly one function on it, so the interface is
 * declared by hand — and because `execute` takes opaque `bytes`, a fuller ABI would not buy any
 * more type safety than this does.
 */
const UNIVERSAL_ROUTER_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
];

/**
 * Drops everything but the interface.
 *
 * Foundry artifacts carry bytecode, source maps and metadata — hundreds of kilobytes that would
 * otherwise be shipped to the browser to describe contracts it only ever calls.
 */
const interfaceOnly = (abi) =>
  abi.filter((item) => ["function", "event", "error"].includes(item.type));

const parts = [];
for (const [name, artifact] of Object.entries(CONTRACTS)) {
  // Foundry emits per-profile artifacts when more than one compilation profile exists
  // (`Name.json` and `Name.<profile>.json`). The unsuffixed one is the default profile's and is
  // the only correct one — it is what the deployed bytecode is built from.
  const artifactPath = join(OUT_DIR, artifact);
  const { abi } = JSON.parse(readFileSync(artifactPath, "utf8"));
  parts.push(
    `export const ${name}Abi = ${JSON.stringify(interfaceOnly(abi), null, 2)} as const;`
  );
}

parts.push(
  `export const universalRouterAbi = ${JSON.stringify(UNIVERSAL_ROUTER_ABI, null, 2)} as const;`
);

const header = `/**
 * GENERATED FILE — do not edit.
 *
 * Produced by \`scripts/generate-abis.mjs\` from the compiled contracts. Re-run
 * \`pnpm generate:abis\` after any contract change; \`tests/unit/chain-abis.test.ts\` fails if you
 * forget.
 */
`;

const footer = `
/** Which artifact each ABI came from, so the drift test can find it again. */
export const CONTRACT_ARTIFACTS = ${JSON.stringify(CONTRACTS, null, 2)} as const;

/** Every ABI, keyed the same way as the artifacts above. */
export const DOKU_ABIS = {
${Object.keys(CONTRACTS)
  .map((name) => `  ${name}: ${name}Abi,`)
  .join("\n")}
} as const;
`;

writeFileSync(TARGET, `${header}\n${parts.join("\n\n")}\n${footer}`);
console.log(`wrote ${TARGET}`);
