import {
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  type PublicClient,
  type WalletClient,
} from "viem";

import { universalRouterAbi, v4QuoterAbi } from "./abis";
import { CONTRACTS, NATIVE_CURRENCY, poolKeyFor } from "./addresses";
import type { EncodedCall } from "./encoded-call";
import type { PoolKeyLike } from "./pool-key";
import { applySlippage, deadlineFrom } from "./writes";

/**
 * Trading a market after it has graduated.
 *
 * The bonding curve is permanently closed at graduation, so everything past that point goes
 * through the Uniswap v4 pool. Same guards as the curve path — the slippage floor and the deadline
 * come from the same two functions — because the ways a trade goes wrong do not change with the
 * venue.
 *
 * ## What changed from V3, and why none of it is cosmetic
 *
 * There is no pool contract to call. A v4 pool is state inside one PoolManager singleton, addressed
 * by `PoolId = keccak256(PoolKey)`, so a swap is described by the KEY rather than sent to an
 * address. `poolKeyFor` builds it in one place for exactly that reason.
 *
 * There is no wrapper. `currency0` is native MON, so the swap-then-unwrap multicall that V3 needed
 * is gone — along with the second signature and the WMON balance a seller was left holding.
 *
 * And the router is generic. UniversalRouter takes a byte string of COMMANDS with a parallel array
 * of ABI-encoded inputs, rather than a named function per trade shape. That is more to get right
 * here, and it is the reason this file is the only place that encodes one.
 */

const DEFAULT_DEADLINE_SECS = 120;

/**
 * UniversalRouter command bytes.
 *
 * `V4_SWAP` is 0x10. The high bit (0x80) is a flag meaning "allow revert", which must NOT be set —
 * a swap allowed to fail silently would leave the user believing they had traded.
 */
const V4_SWAP = 0x10;

/**
 * v4 `Actions`, the second layer. UniversalRouter's V4_SWAP input is itself a `(bytes actions,
 * bytes[] params)` pair, because one swap is three separate accounting steps.
 */
const SWAP_EXACT_IN_SINGLE = 0x06;
/** The multi-hop form: one input currency, a `PathKey[]`, and one floor on the far end. */
const SWAP_EXACT_IN = 0x07;
const SETTLE_ALL = 0x0c;
const TAKE_ALL = 0x0f;

/** The `PoolKey` tuple, as viem needs it described for `encodeAbiParameters`. */
const POOL_KEY_ABI = {
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
} as const;

const EXACT_IN_SINGLE_ABI = {
  type: "tuple",
  components: [
    { name: "poolKey", ...POOL_KEY_ABI },
    { name: "zeroForOne", type: "bool" },
    { name: "amountIn", type: "uint128" },
    { name: "amountOutMinimum", type: "uint128" },
    { name: "hookData", type: "bytes" },
  ],
} as const;

/** `PathKey`, the hop shape a multi-hop swap is described in. Same tuple the quoter takes. */
const PATH_KEY_ABI = {
  type: "tuple[]",
  components: [
    { name: "intermediateCurrency", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
    { name: "hookData", type: "bytes" },
  ],
} as const;

const EXACT_IN_ABI = {
  type: "tuple",
  components: [
    { name: "currencyIn", type: "address" },
    { name: "path", ...PATH_KEY_ABI },
    { name: "amountIn", type: "uint128" },
    { name: "amountOutMinimum", type: "uint128" },
  ],
} as const;

/**
 * Which pool, and which of its two currencies is the money.
 *
 * `quoteAsset` is not decoration. It decides the sort order of the key, which side of the swap is
 * `zeroForOne`, and whether a buy carries `value` — three answers that were all constants while
 * every market was priced in MON and are all properties of the pair now.
 */
export interface PoolMarket {
  token: `0x${string}`;
  /** `NATIVE_CURRENCY` for MON. From the market row's `quote_asset`, never from a global. */
  quoteAsset: `0x${string}`;
  /**
   * The pool's recorded key.
   *
   * Required in practice, optional in the type only so the just-graduated window — where the pool
   * exists but the indexer has not recorded it yet — falls back to the newest hook, which is the
   * one that created it.
   */
  poolKey?: PoolKeyLike | null;
}

export interface PoolTradeParams extends PoolMarket {
  quoted: bigint;
  slippageBps: number;
  deadlineSecs?: number;
}

/** The key this trade addresses: the recorded one where there is one, else the pair's own. */
const keyOf = (m: PoolMarket): PoolKeyLike => m.poolKey ?? poolKeyFor(m.token, m.quoteAsset);

/**
 * Whether a BUY — quote in, token out — swaps currency0 for currency1.
 *
 * v4 names the direction after the sorted key rather than after the trade, so this is a lookup
 * against the key and not a constant. It was `true` for every buy while `currency0` was always
 * native MON; on a pool whose token sorts below its quote, `true` is a SELL.
 */
const buyIsZeroForOne = (key: PoolKeyLike, quoteAsset: `0x${string}`): boolean =>
  key.currency0.toLowerCase() === quoteAsset.toLowerCase();

/** Whether the money side of this pool is the chain's own currency, and so rides as `value`. */
const quoteIsNative = (m: PoolMarket): boolean => m.quoteAsset.toLowerCase() === NATIVE_CURRENCY;

/**
 * What the pool would give for an amount in.
 *
 * `V4Quoter` is not a `view` function: it performs the swap and reverts with the result, which the
 * contract catches. So this must be SIMULATED rather than read — `readContract` would refuse it,
 * and hand-rolled price maths would be a second implementation of the pool's own arithmetic,
 * drifting from it at exactly the tick boundaries that matter.
 *
 * `zeroForOne` decides the direction, and it is worth being explicit because v4's convention reads
 * backwards twice over. `currency0` is MON and `currency1` is the token, so `true` is MON in and
 * token out — a BUY — and it makes the pool's price, which is currency1-per-currency0, FALL.
 */
export async function quotePool(
  publicClient: PublicClient,
  params: PoolMarket & { zeroForOne: boolean; amountIn: bigint }
): Promise<bigint> {
  const { result } = await publicClient.simulateContract({
    address: CONTRACTS.quoter,
    abi: v4QuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        poolKey: keyOf(params),
        zeroForOne: params.zeroForOne,
        exactAmount: params.amountIn,
        hookData: "0x",
      },
    ],
  });
  // `(amountOut, gasEstimate)`. The gas figure is the quoter's own estimate of the swap and is not
  // the transaction's cost, so it is deliberately not surfaced.
  return (result as readonly [bigint, bigint])[0];
}

/** Quote in, token out. `quoteIn` is RAW units of THAT MARKET'S quote asset. */
export const quotePoolBuy = (publicClient: PublicClient, market: PoolMarket, quoteIn: bigint) =>
  quotePool(publicClient, {
    ...market,
    zeroForOne: buyIsZeroForOne(keyOf(market), market.quoteAsset),
    amountIn: quoteIn,
  });

/** Token in, quote out. */
export const quotePoolSell = (publicClient: PublicClient, market: PoolMarket, tokensIn: bigint) =>
  quotePool(publicClient, {
    ...market,
    zeroForOne: !buyIsZeroForOne(keyOf(market), market.quoteAsset),
    amountIn: tokensIn,
  });

/**
 * Encodes one exact-input swap as UniversalRouter expects it.
 *
 * Three actions, not one, because v4 splits a swap into moving the price and settling the two
 * currencies. `SETTLE_ALL` pays what the swap owes and `TAKE_ALL` collects what it produced; the
 * amounts are bounds, so `SETTLE_ALL` carries the exact input and `TAKE_ALL` carries the slippage
 * floor. Omitting either leaves a non-zero delta and the whole unlock reverts `CurrencyNotSettled`.
 */
function encodeV4Swap(
  params: PoolMarket & { zeroForOne: boolean; amountIn: bigint; minOut: bigint }
): `0x${string}` {
  const key = keyOf(params);
  const currencyIn = params.zeroForOne ? key.currency0 : key.currency1;
  const currencyOut = params.zeroForOne ? key.currency1 : key.currency0;

  const actions = encodePacked(
    ["uint8", "uint8", "uint8"],
    [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]
  );

  const swap = encodeAbiParameters(
    [EXACT_IN_SINGLE_ABI],
    [
      {
        poolKey: key,
        zeroForOne: params.zeroForOne,
        amountIn: params.amountIn,
        amountOutMinimum: params.minOut,
        hookData: "0x" as `0x${string}`,
      },
    ]
  );
  const settle = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [currencyIn, params.amountIn]
  );
  const take = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [currencyOut, params.minOut]
  );

  return encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [actions, [swap, settle, take]]
  );
}

/**
 * Buys from the pool, paying in the market's own quote asset.
 *
 * Native MON rides along as `value` and settles straight through — no wrapping, no approval, no
 * Permit2. That is the whole benefit of a native-currency pool, and it is why a MON buy needs one
 * signature where a sell needs an approval first.
 *
 * An ERC-20 quote gets neither of those benefits: `value` is zero and the router pulls the quote
 * through Permit2 exactly as it pulls a token on a sell, so the caller owes the same two approvals
 * — see `permit2ApprovalsNeeded`. Sending `value` alongside an ERC-20 quote would hand MON to a
 * swap that never asked for it and leave it stranded in the router.
 */
export async function buyFromPool(
  wallet: WalletClient,
  publicClient: PublicClient,
  params: PoolTradeParams & { quoteIn: bigint }
): Promise<`0x${string}`> {
  const account = wallet.account;
  if (!account) throw new Error("no connected account");

  const { request } = await publicClient.simulateContract({
    address: CONTRACTS.universalRouter,
    abi: universalRouterAbi,
    functionName: "execute",
    args: [
      encodePacked(["uint8"], [V4_SWAP]),
      [
        encodeV4Swap({
          token: params.token,
          quoteAsset: params.quoteAsset,
          zeroForOne: buyIsZeroForOne(keyOf(params), params.quoteAsset),
          amountIn: params.quoteIn,
          minOut: applySlippage(params.quoted, params.slippageBps),
          poolKey: params.poolKey,
        }),
      ],
      deadlineFrom(Date.now(), params.deadlineSecs ?? DEFAULT_DEADLINE_SECS),
    ],
    ...(quoteIsNative(params) ? { value: params.quoteIn } : {}),
    account,
  });
  return wallet.writeContract(request);
}

/**
 * One native-in exact-input swap along a route, however many pools it takes.
 *
 * Named and exported because three things take it now: the sent buy, the launch page's dev-buy
 * swap, and the encode-only variant a batch carries. It was an inline parameter type, which is
 * fine until a second caller has to describe the same shape and a third has to spell it
 * `Parameters<typeof …>[2]`.
 */
export interface NativeSwapParams {
  /** The route. Ends at the market's own token for a buy, at the pair's asset for a dev buy. */
  path: readonly {
    intermediateCurrency: `0x${string}`;
    fee: number;
    tickSpacing: number;
    hooks: `0x${string}`;
    hookData: `0x${string}`;
  }[];
  /** MON in, in wei. */
  amountIn: bigint;
  /** The floor, in whatever currency the path ends at. */
  minOut: bigint;
  deadlineSecs?: number;
}

/**
 * The three arguments `UniversalRouter.execute` takes for a native-in exact-input swap.
 *
 * Split out of `buyFromPoolWithNative` so that the same bytes can be either SIMULATED and sent, or
 * encoded into an EIP-5792 batch, without the encoding existing twice. Two copies of this is a
 * standing invitation for the batched path to drift from the path that has been trading for
 * months — a wrong `SETTLE_ALL` amount, a floor left off `TAKE_ALL` — and the drift would only
 * show up as a revert on somebody's launch.
 *
 * The deadline is stamped HERE, at build time, on both paths. That is right for a sent
 * transaction, and it is the property a batch depends on: one left unsigned in a wallet expires
 * rather than executing later at a price nobody agreed to.
 */
function nativeSwapExecuteArgs(
  params: NativeSwapParams
): readonly [`0x${string}`, readonly `0x${string}`[], bigint] {
  if (params.path.length === 0) throw new Error("a zap needs at least one hop");

  const actions = encodePacked(["uint8", "uint8", "uint8"], [SWAP_EXACT_IN, SETTLE_ALL, TAKE_ALL]);
  const currencyOut = params.path[params.path.length - 1].intermediateCurrency;

  const swap = encodeAbiParameters(
    [EXACT_IN_ABI],
    [
      {
        currencyIn: NATIVE_CURRENCY as `0x${string}`,
        path: params.path.map((hop) => ({ ...hop })),
        amountIn: params.amountIn,
        amountOutMinimum: params.minOut,
      },
    ]
  );
  const settle = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [NATIVE_CURRENCY as `0x${string}`, params.amountIn]
  );
  const take = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [currencyOut, params.minOut]
  );

  return [
    encodePacked(["uint8"], [V4_SWAP]),
    [
      encodeAbiParameters(
        [{ type: "bytes" }, { type: "bytes[]" }],
        [actions, [swap, settle, take]]
      ),
    ],
    deadlineFrom(Date.now(), params.deadlineSecs ?? DEFAULT_DEADLINE_SECS),
  ] as const;
}

/**
 * Buys a graduated market's token with native MON, across however many pools it takes.
 *
 * The single-pool functions above are the market's own pool and nothing else. This one puts a
 * route in front of it: MON → … → the market's quote asset → the token, as ONE exact-input swap.
 * There is no zap router here and there does not need to be — a graduated market is an ordinary v4
 * pool, and Uniswap's own router walks a path natively. The ZapRouter exists for the case this
 * cannot serve, which is a market still on its bonding curve.
 *
 * Three things this gets from being one swap rather than two: one signature, no intermediate
 * balance for the buyer to be left holding if the second leg fails, and a single floor that bounds
 * what they actually receive. `TAKE_ALL` collects the LAST currency in the path, so `minOut` is in
 * the market's token — the only figure the buyer cares about.
 *
 * `value` carries the MON because the input currency is native. `SETTLE_ALL` still names it and
 * still carries the exact amount: the settlement is what tells the PoolManager where the input is
 * coming from, and omitting it leaves a non-zero delta that reverts the whole unlock.
 */
export async function buyFromPoolWithNative(
  wallet: WalletClient,
  publicClient: PublicClient,
  params: NativeSwapParams
): Promise<`0x${string}`> {
  const account = wallet.account;
  if (!account) throw new Error("no connected account");

  const { request } = await publicClient.simulateContract({
    address: CONTRACTS.universalRouter,
    abi: universalRouterAbi,
    functionName: "execute",
    args: nativeSwapExecuteArgs(params),
    value: params.amountIn,
    account,
  });
  return wallet.writeContract(request);
}

/**
 * The same swap, encoded rather than sent, for a launch that travels as one EIP-5792 batch.
 *
 * Not simulated, and it could not be. The calls that follow it in the batch spend what this one
 * delivers, none of which exists yet at the moment the batch is built — so a simulation of the
 * launch would revert on an allowance and a balance that are perfectly good by the time the chain
 * executes them. `buyFromPoolWithNative` keeps its simulate-then-write shape for every wallet that
 * cannot batch, which is where the readable error message still lives.
 *
 * What that does NOT cost is safety. `amountOutMinimum` is enforced by the pool inside the
 * transaction: the launcher cannot be filled below the floor they agreed to, only charged gas for
 * finding out. That floor is also what makes the batch possible at all — see `planMonDevBuy`,
 * where it becomes the dev buy itself, because a batch cannot read a balance between its calls.
 *
 * `value` is on the call, not on the batch. Each call in `wallet_sendCalls` carries its own, and
 * the swap's input currency is native: the MON is `msg.value` here and `SETTLE_ALL` names it.
 */
export function encodeSwapNativeFor(params: NativeSwapParams): EncodedCall {
  return {
    to: CONTRACTS.universalRouter,
    data: encodeFunctionData({
      abi: universalRouterAbi,
      functionName: "execute",
      args: nativeSwapExecuteArgs(params),
    }),
    value: params.amountIn,
  };
}

/**
 * Swaps native MON into an ERC-20 and delivers it to the caller's own wallet.
 *
 * The launch page's dev buy needs this and nothing else: the coin does not exist yet, so there is
 * no pool to end the path at and nothing to buy. It swaps into the pair's asset, the launcher
 * holds it, and the launch transaction that follows spends it — inside the launch, so the dev buy
 * is still the un-frontrunnable first trade it has always been.
 *
 * The same encoding as `buyFromPoolWithNative`, and deliberately the same function underneath: a
 * path is a path, and the only difference is where it stops.
 */
export const swapNativeFor = (
  wallet: WalletClient,
  publicClient: PublicClient,
  params: Parameters<typeof buyFromPoolWithNative>[2]
) => buyFromPoolWithNative(wallet, publicClient, params);

/**
 * The same swap, waited on.
 *
 * The launch that follows spends what this produced, so reading a balance before it lands reads
 * the balance from before it — and approves the factory for an amount the wallet does not yet
 * hold. Same reason the launch path waits on its approval.
 */
export const swapNativeForAndWait = async (
  wallet: WalletClient,
  publicClient: PublicClient,
  params: Parameters<typeof buyFromPoolWithNative>[2]
): Promise<`0x${string}`> => {
  const hash = await swapNativeFor(wallet, publicClient, params);
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
};

/**
 * Sells tokens to the pool and receives the market's quote asset.
 *
 * One call, where V3 needed a swap-then-unwrap multicall: a native-quote pool pays out MON
 * directly, so there is nothing to unwrap and the seller is never left holding a wrapper token
 * they did not ask for.
 *
 * The caller is responsible for the Permit2 allowance — see `ensurePermit2Allowance`. That is two
 * approvals rather than one, and it is not avoidable: UniversalRouter pulls ERC-20s through
 * Permit2, so the token must approve Permit2 and Permit2 must approve the router.
 */
export async function sellToPool(
  wallet: WalletClient,
  publicClient: PublicClient,
  params: PoolTradeParams & { tokensIn: bigint }
): Promise<`0x${string}`> {
  const account = wallet.account;
  if (!account) throw new Error("no connected account");

  const { request } = await publicClient.simulateContract({
    address: CONTRACTS.universalRouter,
    abi: universalRouterAbi,
    functionName: "execute",
    args: [
      encodePacked(["uint8"], [V4_SWAP]),
      [
        encodeV4Swap({
          token: params.token,
          quoteAsset: params.quoteAsset,
          zeroForOne: !buyIsZeroForOne(keyOf(params), params.quoteAsset),
          amountIn: params.tokensIn,
          minOut: applySlippage(params.quoted, params.slippageBps),
          poolKey: params.poolKey,
        }),
      ],
      deadlineFrom(Date.now(), params.deadlineSecs ?? DEFAULT_DEADLINE_SECS),
    ],
    account,
  });
  return wallet.writeContract(request);
}

/**
 * Sells a graduated market's token for native MON, across however many pools it takes.
 *
 * The mirror of `buyFromPoolWithNative`, and the same route read the other way round: the market's
 * own pool first, then whatever hops it takes to reach MON — token → … → quote asset → MON, as ONE
 * exact-input swap. Same three gains: one signature, no intermediate quote-asset balance for the
 * seller to be left holding if a later leg fails, and a single floor on the far end.
 *
 * That floor is the point of `TAKE_ALL` naming native. `TAKE_ALL` bounds the LAST currency in the
 * path, so `minOut` is denominated in MON — the asset the seller actually walks away with — rather
 * than in some mid-route quote asset whose own leg to MON could then move against them unbounded.
 *
 * There is deliberately NO `value` on this call. The input currency is an ERC-20, so the router
 * pulls it through Permit2 and has no use for MON; sending some would hand it to a swap that never
 * asked for it and strand it in the router.
 *
 * The caller owes the Permit2 pair of approvals — token → Permit2, Permit2 → UniversalRouter —
 * exactly as an ordinary pool sell does, and for the same reason: the token being spent is the same
 * one either way. See `permit2ApprovalsNeeded`. Like `sellToPool`, this function does not do it.
 */
export async function sellToPoolForNative(
  wallet: WalletClient,
  publicClient: PublicClient,
  params: {
    /** The market's own token — the currency being SPENT. */
    token: `0x${string}`;
    /** The route, starting at the market's own pool and ENDING at native MON. */
    path: readonly {
      intermediateCurrency: `0x${string}`;
      fee: number;
      tickSpacing: number;
      hooks: `0x${string}`;
      hookData: `0x${string}`;
    }[];
    /** Market tokens in, raw units. */
    amountIn: bigint;
    /** The floor, in wei of MON. The only figure the seller receives. */
    minOut: bigint;
    deadlineSecs?: number;
  }
): Promise<`0x${string}`> {
  const account = wallet.account;
  if (!account) throw new Error("no connected account");
  if (params.path.length === 0) throw new Error("a zap needs at least one hop");

  const actions = encodePacked(["uint8", "uint8", "uint8"], [SWAP_EXACT_IN, SETTLE_ALL, TAKE_ALL]);

  const swap = encodeAbiParameters(
    [EXACT_IN_ABI],
    [
      {
        currencyIn: params.token,
        path: params.path.map((hop) => ({ ...hop })),
        amountIn: params.amountIn,
        amountOutMinimum: params.minOut,
      },
    ]
  );
  const settle = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [params.token, params.amountIn]
  );
  const take = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [NATIVE_CURRENCY as `0x${string}`, params.minOut]
  );

  const { request } = await publicClient.simulateContract({
    address: CONTRACTS.universalRouter,
    abi: universalRouterAbi,
    functionName: "execute",
    args: [
      encodePacked(["uint8"], [V4_SWAP]),
      [
        encodeAbiParameters(
          [{ type: "bytes" }, { type: "bytes[]" }],
          [actions, [swap, settle, take]]
        ),
      ],
      deadlineFrom(Date.now(), params.deadlineSecs ?? DEFAULT_DEADLINE_SECS),
    ],
    account,
  });
  return wallet.writeContract(request);
}

/**
 * The two-step allowance a v4 sell needs, and why it is two.
 *
 * UniversalRouter never holds an allowance of its own. It pulls ERC-20s through Permit2, so the
 * token approves PERMIT2, and then Permit2 is told to let the ROUTER spend. Approving the router
 * directly does nothing at all — the transaction succeeds and the swap still reverts.
 *
 * Returns the calls that are actually missing, so a caller can skip signatures that are already in
 * place rather than asking for both every time.
 */
export async function permit2ApprovalsNeeded(
  publicClient: PublicClient,
  /**
   * @param token the currency being SPENT — the market's token on a sell, and the quote asset on a
   *        buy against an ERC-20-quoted pool. Native MON needs neither approval and must never be
   *        passed here: `address(0)` has no `allowance` to read.
   */
  params: { token: `0x${string}`; owner: `0x${string}`; amount: bigint }
): Promise<{ needsTokenApproval: boolean; needsPermit2Approval: boolean }> {
  const allowance = (await publicClient.readContract({
    address: params.token,
    abi: [
      {
        type: "function",
        name: "allowance",
        stateMutability: "view",
        inputs: [{ type: "address" }, { type: "address" }],
        outputs: [{ type: "uint256" }],
      },
    ] as const,
    functionName: "allowance",
    args: [params.owner, CONTRACTS.permit2],
  })) as bigint;

  const [permitted, expiration] = (await publicClient.readContract({
    address: CONTRACTS.permit2,
    abi: [
      {
        type: "function",
        name: "allowance",
        stateMutability: "view",
        inputs: [{ type: "address" }, { type: "address" }, { type: "address" }],
        outputs: [{ type: "uint160" }, { type: "uint48" }, { type: "uint48" }],
      },
    ] as const,
    functionName: "allowance",
    args: [params.owner, params.token, CONTRACTS.universalRouter],
  })) as readonly [bigint, number, number];

  return {
    needsTokenApproval: allowance < params.amount,
    // Expired counts as missing. Permit2 allowances lapse, and an expired one fails exactly like
    // an absent one — at the swap, after the user has signed.
    needsPermit2Approval:
      permitted < params.amount || BigInt(expiration) <= BigInt(Math.floor(Date.now() / 1000)),
  };
}

/** Native MON, re-exported so callers building a key do not reach into `wagmi.ts` for it. */
export { NATIVE_CURRENCY };
