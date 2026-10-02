import { concatHex, encodeAbiParameters, type Hex, parseAbiParameters } from "viem";

/**
 * The calldata a liquidity action sends, in Uniswap v4.
 *
 * ## What changed from V3, and why none of the old shape survived
 *
 * V3's position manager exposed a function per verb — `mint`, `decreaseLiquidity`, `collect`,
 * `burn` — and you composed them with `multicall`. v4 has exactly one entry point,
 * `modifyLiquidities(bytes unlockData, uint256 deadline)`, and the verbs moved inside it: the
 * payload is `abi.encode(bytes actions, bytes[] params)`, where `actions` is one BYTE per step and
 * `params[i]` is that step's own encoding. There is no function selector to get wrong and no ABI
 * to typo, which is a way of saying the compiler cannot help here at all — an action byte that is
 * off by one is a different, valid operation, decoded against the wrong parameter layout.
 *
 * So the action constants below are copied from `v4-periphery/src/libraries/Actions.sol` and the
 * parameter tuples from `PositionManager._handleAction`, and `liquidity-calls.test.ts` decodes
 * what this module produces rather than comparing it to a fixture that could be wrong in the same
 * direction as the code.
 *
 * ## Two things V3 needed that this does not
 *
 * **Sorting.** V3 ordered a pool's tokens by address, so which side held MON depended on how the
 * token's address happened to sort — and getting it backwards mints at an inverted ratio. In v4
 * native MON is the zero address, and zero sorts below everything, so MON is `currency0` in every
 * DOKU pool without a comparison. `assertNativeIsCurrency0` states that as a checked assumption
 * rather than an implicit one.
 *
 * ## Pure on purpose
 *
 * The pool key is an ARGUMENT rather than something this module derives. `poolKeyFor` lives in
 * `addresses.ts`, which reads `NEXT_PUBLIC_*` at module load and throws when they are absent — so
 * importing it here would mean these builders could only be exercised by a harness that had
 * satisfied every environment variable the app has. The calldata is the part worth testing
 * exhaustively, and it must not need a configured chain to be tested at all.
 *
 * **Wrapping.** V3 took WMON and needed `unwrapWETH9` on the way out and `refundETH` for the
 * remainder, each of which silently strands funds in the manager if forgotten. v4 settles native
 * currency directly: `SETTLE_PAIR` pays what the mint owes, and `SWEEP` returns whatever the ratio
 * did not consume.
 */

/** From `v4-periphery/src/libraries/Actions.sol`. */
export const ACTIONS = {
  INCREASE_LIQUIDITY: 0x00,
  DECREASE_LIQUIDITY: 0x01,
  MINT_POSITION: 0x02,
  BURN_POSITION: 0x03,
  SETTLE_PAIR: 0x0d,
  TAKE_PAIR: 0x11,
  SWEEP: 0x14,
} as const;

const ZERO = "0x0000000000000000000000000000000000000000";
/** Native MON. `Currency.wrap(address(0))` in v4, and the reason no sorting is needed. */
const NATIVE = "0x0000000000000000000000000000000000000000";

/** The pool a liquidity action addresses. Built by `poolKeyFor`, passed in. */
export interface LiquidityPoolKey {
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
}

/**
 * The largest `uint128`, which is how a decrease says "no floor".
 *
 * `1n << 128n`, not `2n ** 128n`. SWC compiles `**` down to `Math.pow` for this project's
 * browserslist target, and `Math.pow` throws on BigInt arguments — at module evaluation time, so
 * the whole route fails to load and the stack points at `Math.pow (<anonymous>)` with no hint that
 * the source said `**`.
 */
const MAX_UINT128 = (1n << 128n) - 1n;

const MINT_PARAMS = parseAbiParameters(
  "(address,address,uint24,int24,address), int24, int24, uint256, uint128, uint128, address, bytes",
);
const MODIFY_PARAMS = parseAbiParameters("uint256, uint256, uint128, uint128, bytes");
const BURN_PARAMS = parseAbiParameters("uint256, uint128, uint128, bytes");
const CURRENCY_PAIR = parseAbiParameters("address, address");
const CURRENCY_PAIR_AND_ADDRESS = parseAbiParameters("address, address, address");
const CURRENCY_AND_ADDRESS = parseAbiParameters("address, address");

/** What `modifyLiquidities` is called with: the payload, the deadline, and any native to send. */
export interface LiquidityPlan {
  unlockData: Hex;
  deadline: bigint;
  /** Native MON to attach. Zero for anything that only takes money out. */
  value: bigint;
}

/**
 * `abi.encode(bytes actions, bytes[] params)`.
 *
 * The action list is PACKED — one byte each, concatenated — while the parameters are a normal
 * dynamic array. Encoding the actions as an array instead produces a payload that decodes to a
 * wildly different action sequence, and the failure surfaces as a revert deep inside the manager.
 */
export function encodeActions(actions: readonly number[], params: readonly Hex[]): Hex {
  if (actions.length !== params.length) {
    throw new Error(`every action needs its parameters: ${actions.length} vs ${params.length}`);
  }
  const packed = concatHex(
    actions.map((action) => {
      if (!Number.isInteger(action) || action < 0 || action > 0xff) {
        throw new Error(`an action is a single byte: ${action}`);
      }
      return `0x${action.toString(16).padStart(2, "0")}` as Hex;
    }),
  );
  return encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), [packed, [...params]]);
}

/**
 * Native MON is `currency0` in every DOKU pool, and this checks rather than assumes.
 *
 * The whole module reads the two sides positionally. If a pool ever paired the token against
 * something other than native MON, every amount below would land on the wrong side — and would do
 * so quietly, because both sides are `uint128` and neither ordering reverts.
 */
function assertNativeIsCurrency0(key: LiquidityPoolKey): void {
  if (key.currency0.toLowerCase() !== NATIVE) {
    throw new Error(`expected native MON as currency0, got ${key.currency0}`);
  }
  if (key.currency1.toLowerCase() === NATIVE) {
    throw new Error("a pool cannot pair native MON against itself");
  }
}

export interface AddLiquidityParams {
  poolKey: LiquidityPoolKey;
  recipient: `0x${string}`;
  /** The position's liquidity, from `amountsForRange` — v4 mints by liquidity, not by amounts. */
  liquidity: bigint;
  /** What the two sides are expected to cost, from the same pairing that produced `liquidity`. */
  amountMon: bigint;
  amountToken: bigint;
  /** Ticks, already snapped to the pool's spacing. */
  tickLower: number;
  tickUpper: number;
  slippageBps: number;
  deadline: bigint;
  /**
   * The hook's maker levy, per currency, from `makerLevyBps`.
   *
   * NOT slippage, and not interchangeable with it. `amount0Max`/`amount1Max` are checked against
   * the caller's delta, and v4 folds a hook's returned delta into that — so the ceiling has to
   * clear the levy before slippage is applied at all. Defaulting to zero keeps a pool with no
   * hook, or a market not yet read, encoding exactly what it used to.
   */
  levyBps0?: number;
  levyBps1?: number;
}

/**
 * Mint a position over the given range, paying the MON side in native MON.
 *
 * v4 mints by LIQUIDITY, where V3 minted by desired amounts and worked the liquidity out itself.
 * The amounts survive as `amount0Max`/`amount1Max`, which are a spending CEILING rather than a
 * request — the inversion matters, because the V3 minimums protected against receiving too little
 * position for the money and these protect against paying too much money for the position.
 *
 * One of the two amounts may be zero, and that is not an error: a range entirely above the market
 * price holds only MON and one entirely below holds only the token, so a single-sided deposit is
 * what a range that does not straddle the price already means.
 */
export function buildAddLiquidity(params: AddLiquidityParams): LiquidityPlan {
  const {
    poolKey,
    recipient,
    liquidity,
    amountMon,
    amountToken,
    tickLower,
    tickUpper,
    slippageBps,
    deadline,
    levyBps0 = 0,
    levyBps1 = 0,
  } = params;
  if (recipient === ZERO) throw new Error("a position needs a recipient that can withdraw it");
  if (liquidity <= 0n) throw new Error("a position needs some liquidity");
  if (amountMon < 0n || amountToken < 0n) throw new Error("an amount cannot be negative");
  if (amountMon === 0n && amountToken === 0n) {
    throw new Error("a position needs at least one side funded");
  }
  if (tickLower >= tickUpper) {
    throw new Error(`the range is empty or inverted: ${tickLower} to ${tickUpper}`);
  }
  if (slippageBps < 0 || slippageBps > 10_000) {
    throw new Error(`slippage must be between 0 and 10000 bps: ${slippageBps}`);
  }
  if (levyBps0 < 0 || levyBps1 < 0) throw new Error("a levy cannot be negative");

  const key = poolKey;
  assertNativeIsCurrency0(key);

  // A CEILING, so slippage widens it. Flooring these — the V3 instinct — sets the maximum below
  // what the mint actually costs and the position reverts every time the price moves against it.
  //
  // The levy goes UNDER the slippage, in that order, because it is not a price movement to be
  // tolerated: `DokuHook._makerLevy` returns a delta that v4 adds to the caller's, so the mint's
  // real cost is the paired amount plus the levy, and slippage is then room around THAT. Applying
  // one combined percentage instead would be arithmetic that happens to be close, and it would
  // silently stop covering the levy the moment a market's rate exceeded the slippage setting.
  const levied = (amount: bigint, bps: number) => amount + (amount * BigInt(bps)) / 10_000n;
  const ceiling = (amount: bigint) => (amount * BigInt(10_000 + slippageBps)) / 10_000n;
  const amount0Max = ceiling(levied(amountMon, levyBps0));
  const amount1Max = ceiling(levied(amountToken, levyBps1));

  const mint = encodeAbiParameters(MINT_PARAMS, [
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    tickLower,
    tickUpper,
    liquidity,
    amount0Max,
    amount1Max,
    recipient,
    "0x",
  ]);
  const settle = encodeAbiParameters(CURRENCY_PAIR, [key.currency0, key.currency1]);

  const actions: number[] = [ACTIONS.MINT_POSITION, ACTIONS.SETTLE_PAIR];
  const encoded: Hex[] = [mint, settle];

  // v4's answer to `refundETH`, and needed for the same reason: the mint takes whichever side
  // binds and the rest of the native MON stays in the manager otherwise — recoverable by anyone,
  // in practice by nobody. Skipped when no MON is attached, since there is nothing to return.
  if (amountMon > 0n) {
    actions.push(ACTIONS.SWEEP);
    encoded.push(encodeAbiParameters(CURRENCY_AND_ADDRESS, [key.currency0, recipient]));
  }

  // `amount0Max` rather than `amountMon`: the ceiling is what the manager may actually pull, so
  // sending only the expected amount reverts precisely when slippage protection was doing its job.
  return { unlockData: encodeActions(actions, encoded), deadline, value: amount0Max };
}

export interface RemoveLiquidityParams {
  tokenId: bigint;
  /** How much of the position to withdraw. The whole of it, to close the position. */
  liquidity: bigint;
  poolKey: LiquidityPoolKey;
  recipient: `0x${string}`;
  minMon: bigint;
  minToken: bigint;
  deadline: bigint;
  /** Whether to burn the emptied NFT. Only meaningful when the whole position is withdrawn. */
  burnPosition: boolean;
}

/**
 * Withdraw from a position and take the proceeds as native MON and tokens.
 *
 * `TAKE_PAIR` pays the user directly. There is no unwrap step and no sweep-to-user, because there
 * is no wrapped token in the middle — the three V3 calls that existed only to undo wrapping have
 * no counterpart here.
 *
 * `BURN_POSITION` decreases to zero on its way, so closing a position is one action rather than a
 * decrease followed by a burn. Partial withdrawals keep the NFT: v4, like V3, refuses to burn a
 * position that still holds liquidity.
 */
export function buildRemoveLiquidity(params: RemoveLiquidityParams): LiquidityPlan {
  const { tokenId, liquidity, poolKey, recipient, minMon, minToken, deadline, burnPosition } =
    params;
  if (recipient === ZERO) throw new Error("the proceeds need a recipient");
  if (liquidity <= 0n) throw new Error("there is no liquidity to withdraw");
  if (minMon < 0n || minToken < 0n) throw new Error("a minimum cannot be negative");

  const key = poolKey;
  assertNativeIsCurrency0(key);

  const actions: number[] = [burnPosition ? ACTIONS.BURN_POSITION : ACTIONS.DECREASE_LIQUIDITY];
  const encoded: Hex[] = [
    burnPosition
      ? encodeAbiParameters(BURN_PARAMS, [tokenId, minMon, minToken, "0x"])
      : encodeAbiParameters(MODIFY_PARAMS, [tokenId, liquidity, minMon, minToken, "0x"]),
  ];

  actions.push(ACTIONS.TAKE_PAIR);
  encoded.push(
    encodeAbiParameters(CURRENCY_PAIR_AND_ADDRESS, [key.currency0, key.currency1, recipient]),
  );

  return { unlockData: encodeActions(actions, encoded), deadline, value: 0n };
}

export interface CollectFeesParams {
  tokenId: bigint;
  poolKey: LiquidityPoolKey;
  recipient: `0x${string}`;
  deadline: bigint;
}

/**
 * Take a position's fees and leave the position where it is.
 *
 * A decrease of ZERO liquidity, which is v4's idiom for it: the position is untouched and the
 * accrued fees fall out as the delta, which `TAKE_PAIR` then pays over.
 *
 * No minimums, unlike the withdrawal. There is nothing to protect against — the fees are whatever
 * the pool says they are when the transaction lands, and a floor could only reject the collection
 * for returning LESS than quoted, after the earning had already happened.
 *
 * Worth stating plainly: in a DOKU pool this collects nothing, always. The pool's LP fee is zero
 * by construction — the market tax is skimmed from the swap's flash accounting, which a non-zero
 * fee makes impossible — so no fee ever accrues to a position. `test_theCanonicalPoolPaysItsLpsNothing`
 * asserts exactly that. The action is here because it is the correct encoding of the verb, not
 * because it will pay anybody.
 */
export function buildCollectFees(params: CollectFeesParams): LiquidityPlan {
  const { tokenId, poolKey, recipient, deadline } = params;
  if (recipient === ZERO) throw new Error("the fees need a recipient");

  const key = poolKey;
  assertNativeIsCurrency0(key);

  return {
    unlockData: encodeActions(
      [ACTIONS.DECREASE_LIQUIDITY, ACTIONS.TAKE_PAIR],
      [
        encodeAbiParameters(MODIFY_PARAMS, [tokenId, 0n, 0n, 0n, "0x"]),
        encodeAbiParameters(CURRENCY_PAIR_AND_ADDRESS, [
          key.currency0,
          key.currency1,
          recipient,
        ]),
      ],
    ),
    deadline,
    value: 0n,
  };
}

export { MAX_UINT128 };
