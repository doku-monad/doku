import { parseAbi } from "viem";

/**
 * The v4 surface the liquidity panel uses.
 *
 * Hand-written rather than pasted from the artifacts, and kept to the handful of functions that
 * are actually called — the generated ABIs in `abis.ts` are full contract dumps.
 *
 * ## There is no pool contract any more
 *
 * `poolAbi` is gone with V3. In v4 every pool lives inside the one PoolManager and is addressed by
 * a `PoolId`, so `slot0()` and `liquidity()` are not calls on a pool — they are calls on StateView
 * that take the id. `token0()`/`token1()` have no counterpart at all: the pair is part of the
 * `PoolKey` the caller already holds, which is why `poolKeyFor` exists.
 */

/**
 * Uniswap v4's PositionManager.
 *
 * `modifyLiquidities` is the ONLY write. Mint, increase, decrease, burn, settle and take are all
 * actions encoded into `unlockData` — see `liquidity-calls.ts`, which builds it.
 *
 * `tokenOfOwnerByIndex` is deliberately absent: v4's PositionManager is ERC-721 but NOT
 * ERC-721Enumerable, so there is no on-chain way to list an owner's positions. `nextTokenId` plus
 * `ownerOf` is the substitute — see `use-liquidity.ts`.
 */
export const positionManagerAbi = parseAbi([
  "function modifyLiquidities(bytes unlockData, uint256 deadline) payable",
  "function getPositionLiquidity(uint256 tokenId) view returns (uint128 liquidity)",
  "function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)",
  "function nextTokenId() view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
]);

/**
 * StateView, for reading a pool that has no address of its own.
 *
 * Every one of these takes the `PoolId` — `keccak256(abi.encode(poolKey))` — because the pool is a
 * row in the PoolManager's storage rather than a contract.
 */
export const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);

/**
 * Permit2, which is how v4 moves ERC-20s.
 *
 * The token approves PERMIT2, and Permit2 is then told to let the POSITION MANAGER spend. Approving
 * the position manager directly is the trap: the approval succeeds and the mint still reverts, with
 * a message about allowances that says nothing about the deposit the person was trying to make.
 *
 * Note the widths. The amount is `uint160` and the expiration is `uint48`; passing `maxUint256` for
 * either reverts, which is a surprising way for an approval to fail after it has been signed.
 */
export const permit2Abi = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);

/**
 * `DokuHook`, for the one thing the deposit panel cannot compute without it: how the market is
 * configured, so the maker levy on a deposit can be predicted rather than discovered by reverting.
 *
 * `sink` and `protocolBps` only. `makerBps0`/`makerBps1` come back in the same tuple and must not
 * be used — see `maker-levy.ts` for why the recorded rates and the charged ones differ.
 *
 * Called at the market's OWN hook, never at the configured one. Two hooks are live and a market
 * keeps whichever it graduated through, so a rate read from the wrong hook is a rate for a pool
 * that is not this one — and `markets` answers for an unknown id with zeros rather than a revert.
 */
export const dokuHookAbi = parseAbi([
  "function markets(bytes32 poolId) view returns (bool registered, uint8 sink, uint16 protocolBps, uint16 sinkBps, bool seeded, address sinkAddr, uint16 makerBps0, uint16 makerBps1, uint128 seedLiquidity, int24 seedTickLower, int24 seedTickUpper)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
]);
