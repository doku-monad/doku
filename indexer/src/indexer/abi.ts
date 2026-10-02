/**
 * Event ABIs for the contracts this indexer follows.
 *
 * Hand-written rather than generated from the Foundry artifacts so a contract change breaks the
 * indexer at type-check time instead of at runtime, when the symptom is a silently empty feed.
 * `test/abi.test.ts` pins each signature hash against the compiled artifact, so drift is caught
 * rather than assumed away.
 */
import { parseAbi } from "viem";

export const factoryAbi = parseAbi([
  "event MarketLaunched(bytes32 indexed key, address indexed curve, address indexed token, address creator, string symbol, uint256 quoteTarget, uint8 sink)",
]);

export const curveAbi = parseAbi([
  "event Bought(address indexed buyer, uint256 quoteIn, uint256 baseOut, uint256 fee, uint256 tax, uint256 quoteRaised)",
  "event Sold(address indexed seller, uint256 baseIn, uint256 quoteOut, uint256 fee, uint256 quoteRaised)",
  "event ReadyToGraduate(uint256 quoteRaised)",
  // The filling buy's swallowed graduation, with the gas it had left. This is the stranding
  // signal: the curve is closed and no pool exists until somebody calls `graduate()` again.
  "event AutoGraduationFailed(uint256 gasLeft)",
]);

/**
 * The graduation event, carrying the whole `PoolKey` as a tuple.
 *
 * The key is emitted rather than reconstructed here. Every field is a protocol constant today —
 * native MON, zero fee, tick spacing 60, the hook — so rebuilding it from literals would work
 * until one of them changed, and then hash to a PoolId no pool is at. That failure is silent: the
 * swap filter matches nothing and the market simply looks untraded.
 */
export const graduationAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "event Graduated(address indexed curve, address indexed token, bytes32 indexed poolId, uint256 tokenId, uint256 quoteAmount, uint256 baseAmount, uint128 liquidity, address sink, uint8 sinkKind, PoolKey key)",
]);

export const erc20Abi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

/**
 * The Uniswap v4 PoolManager's swap event.
 *
 * Indexed so a market keeps a chart and a trade feed after it graduates. Without it both freeze at
 * the moment the curve closed — and a frozen chart looks exactly like a market nobody is trading,
 * rather than one whose data stopped being collected.
 *
 * ## This is not the V3 event with different field names
 *
 * V3 emitted `Swap(address indexed sender, address indexed recipient, int256, int256, ...)` from a
 * PER-POOL contract, so the address the log came from identified the market. v4 emits from the ONE
 * PoolManager singleton and identifies the pool by an indexed `PoolId` topic instead. Different
 * topic0, different types (int128, not int256), different address, and one extra field.
 *
 * ## The consequence that matters: the address filter stops filtering
 *
 * Under V3, a log from an address we did not know about was simply another protocol's pool and
 * never reached us. Under v4 EVERY swap on EVERY Uniswap v4 pool on the chain arrives at the same
 * address — memecoins, stablecoin pairs, someone's test pool — so the address is no longer evidence
 * of anything. `topics[1]` is, and the PoolId gate in `ingest.ts` is what replaces the filter the
 * address used to provide. It is a correctness requirement, not an optimisation.
 */
/**
 * The PoolManager, which emits BOTH of the pool-level events this indexer needs.
 *
 * ## `ModifyLiquidity`, and the two things that were wrong about it
 *
 * Liquidity positions are DISCOVERED here and nowhere else. The PositionManager is ERC-721 but not
 * ERC-721Enumerable, so nothing on chain can list an owner's positions — and on Monad it is the
 * canonical manager shared by every v4 protocol, with over six hundred thousand positions in it,
 * so walking the ids is not an option either. If this event is not captured, the positions table
 * stays empty forever and every liquidity surface in the app renders nothing.
 *
 * It was `ModifyPosition`, queried at the PositionManager, and that worked on testnet and indexed
 * nothing at all on mainnet. The difference is WHOSE PositionManager each network runs:
 *
 *   - `lib/v4-periphery/src/PositionManager.sol` emits `ModifyPosition` (lines 445 and 520). On
 *     testnet the protocol deploys that source itself, so the event exists and the query matched.
 *   - Monad mainnet already has canonical v4, so the app points at Uniswap's own PositionManager
 *     at `0x5b7eC4a9…`, which does not emit it. Verified against a real mint — tx `0x53da5b41…`,
 *     block 100763549 — whose only PositionManager log is the ERC-721 `Transfer` for the NFT.
 *
 * `ModifyLiquidity` is the event BOTH networks share: `v4-core/src/PoolManager.sol:175` emits it
 * whether the PoolManager is ours or Uniswap's. That is why the fix is not "use the other name" but
 * "read it from the contract that actually emits it on every deployment".
 *
 * None of this could fail a compile, and `abi.test.ts` passed throughout: it asserts each signature
 * exists in some compiled artifact, and `ModifyPosition` genuinely does exist in the vendored
 * PositionManager's ABI. Existing in an ABI and being emitted by the deployed contract are
 * different claims, and only the second one indexes anything.
 *
 * Both useful fields are indexed: `id` scopes the log to one of our pools, and `sender` is the end
 * user rather than the manager (the periphery documents exactly that). `salt` is the token id —
 * the manager passes `bytes32(tokenId)` so each position gets unique storage in the pool manager.
 */
export const poolManagerAbi = parseAbi([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  "event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)",
]);

/* ------------------------------------------------------------------------------------------ */
/* Generation 2 — the compiled artifacts in `../contracts/out/` are authoritative for every      */
/* signature below, and `test/abi.test.ts` pins each one against the contract that emits it.     */
/* ------------------------------------------------------------------------------------------ */

/**
 * The pairs factory. Same source file as gen 1, modified in place, deployed at a new address —
 * so `MarketLaunched` here has a different selector from the gen-1 one above, and the address the
 * log came from is what says which is which (`factoryAbis`).
 */
export const factory2Abi = parseAbi([
  "event MarketLaunched(address indexed curve, address indexed token, address indexed creator, address quoteAsset, uint256 quoteTarget, uint8 sink, address routedRecipient, uint16 creatorTaxBps, address taxRecipient)",
  "event MetadataSet(address indexed curve, string name, string ticker, string logoURI, string bannerURI, string description, string website, string x, string telegram)",
]);

/** The gen-2 curve. `price` is emitted, so nothing has to be derived from `quoteRaised`. */
export const curve2Abi = parseAbi([
  "event Bought(address indexed buyer, uint256 quoteIn, uint256 baseOut, uint256 fee, uint256 antiSniperTax, uint256 creatorTax, uint256 quoteRaised, uint256 price)",
  "event Sold(address indexed seller, uint256 baseIn, uint256 quoteOut, uint256 fee, uint256 creatorTax, uint256 quoteRaised, uint256 price)",
  "event FeesCollected(address indexed recipient, uint256 amount)",
  "event TaxCollected(address indexed recipient, uint256 amount)",
  "event ProtocolFeesCollected(address indexed recipient, uint256 amount)",
  // `ReadyToGraduate(uint256)` is byte-identical to gen 1 and decoded by `curveAbi`.
]);

/**
 * Gen-2 graduation. NO PoolKey on the event any more — it carries the quote asset instead, and
 * the key is rebuilt from (quote, token, hook) and CHECKED against the emitted id. See
 * `processing/pool-key.ts` for why the check is what makes the rebuild safe.
 */
export const graduation2Abi = parseAbi([
  "event Graduated(address indexed curve, bytes32 indexed id, address token, address quoteAsset, uint256 quoteAmount, uint256 baseAmount, uint256 tokenId)",
]);

/** Gen-2 hook: registration (with the creator tax) and the two levy events the ledger reads. */
export const hook2Abi = parseAbi([
  "event PoolRegistered(bytes32 indexed id, address token, uint8 sink, address sinkAddr, uint16 protocolBps, uint16 lpBps, uint16 creatorTaxBps)",
  "event TaxLevied(bytes32 indexed id, uint256 amount)",
  "event Swept(bytes32 indexed id, uint256 protocolAmount, uint256 sinkAmount)",
]);

/** The one shared CreatorSink. */
export const creatorSinkAbi = parseAbi([
  "event Registered(address indexed market, bytes32 indexed id, address quote, address routed, address tax)",
  "event Credited(address indexed who, address indexed quote, uint256 amount, uint8 kind)",
  "event Pulled(address indexed market, uint256 routedAmount, uint256 taxAmount)",
  "event Claimed(address indexed who, address indexed quote, uint256 amount)",
  "event RecipientTransferred(address indexed market, address indexed from, address indexed to)",
]);

export const quoteRegistryAbi = parseAbi([
  "event QuoteAssetRegistered(address indexed asset, uint8 decimals, uint256 quoteTarget)",
  "event QuoteTargetChanged(address indexed asset, uint256 previous, uint256 current)",
  "event QuoteAssetEnabled(address indexed asset, bool enabled)",
]);

/**
 * Per-market sinks, discovered from `PoolRegistered.sinkAddr` and asked for BY ADDRESS, like
 * `Transfer`: `Funded(uint256)` and `Burned(uint256,uint256)` are signatures any contract might
 * emit, so a topic-only query would be a request for every such log on the chain.
 */
export const rewardVaultAbi = parseAbi([
  "event Funded(uint256 amount)",
  "event Claimed(address indexed holder, uint256 indexed epoch, uint256 amount)",
]);
export const burnSinkAbi = parseAbi(["event Burned(uint256 amount, uint256 newTotalSupply)"]);

/**
 * The factory address → generation + ABI map. Built from config, keyed lowercase, and the single
 * place a `MarketLaunched` log is attributed to a generation.
 */
export interface FactoryEntry {
  generation: 1 | 2;
  abi: typeof factoryAbi | typeof factory2Abi;
}
export function factoryAbis(cfg: { factory: string; factory2?: string }): Map<string, FactoryEntry> {
  const map = new Map<string, FactoryEntry>();
  map.set(cfg.factory.toLowerCase(), { generation: 1, abi: factoryAbi });
  if (cfg.factory2) map.set(cfg.factory2.toLowerCase(), { generation: 2, abi: factory2Abi });
  return map;
}

/**
 * Every event the ingester decodes, in one list so `eth_getLogs` can be called once per range.
 *
 * Both generations live here together: `decodeEventLog` selects by `topics[0]`, and every gen-2
 * signature that shares a NAME with a gen-1 one has different inputs and therefore a different
 * selector. Which contract emitted a log is decided by its address, never by the event's name —
 * `creatorSinkAbi.Claimed(address,address,uint256)` and
 * `rewardVaultAbi.Claimed(address,uint256,uint256)` are the same story one level down.
 */
export const allEvents = [
  ...factoryAbi,
  ...curveAbi,
  ...graduationAbi,
  ...erc20Abi,
  ...poolManagerAbi,
  ...factory2Abi,
  ...curve2Abi,
  ...graduation2Abi,
  ...hook2Abi,
  ...creatorSinkAbi,
  ...quoteRegistryAbi,
  ...rewardVaultAbi,
  ...burnSinkAbi,
] as const;
