/** @jest-environment node */
import { decodeAbiParameters, type Hex, parseAbiParameters } from "viem";

import { sellToPoolForNative } from "../../src/lib/chain/pool";

const TOKEN = "0x5755b8edcd8765d7319fc6ae05389c1e7c7fa17e" as const;
const USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603" as const;
const NATIVE = "0x0000000000000000000000000000000000000000";
const USER = "0xea12f846d7a298caa94469d398eb099be3c8d034" as const;

const SWAP_EXACT_IN = 0x07;
const SETTLE_ALL = 0x0c;
const TAKE_ALL = 0x0f;

const AMOUNT_IN = 1_234n * 10n ** 18n;
const MIN_OUT = 42n * 10n ** 17n;

/** Token → quote asset → MON. The last hop is what makes the proceeds native. */
const PATH = [
  {
    intermediateCurrency: USDC,
    fee: 3000,
    tickSpacing: 60,
    hooks: NATIVE as `0x${string}`,
    hookData: "0x" as `0x${string}`,
  },
  {
    intermediateCurrency: NATIVE as `0x${string}`,
    fee: 500,
    tickSpacing: 10,
    hooks: NATIVE as `0x${string}`,
    hookData: "0x" as `0x${string}`,
  },
] as const;

const EXACT_IN_PARAMS = parseAbiParameters(
  "(address, (address,uint24,int24,address,bytes)[], uint128, uint128)"
);
const SETTLE_TAKE_PARAMS = parseAbiParameters("address, uint256");

/**
 * The transaction the function would send, taken apart.
 *
 * Nothing in a UniversalRouter call is checked by a compiler: the commands are a byte string and
 * the inputs are opaque `bytes`, so an action byte off by one is a different, valid operation
 * decoded against the wrong layout. These tests therefore decode what was actually encoded rather
 * than comparing it to a fixture that could be wrong in the same direction as the code.
 */
async function capture(): Promise<{
  call: Record<string, unknown>;
  commands: Hex;
  actions: number[];
  params: Hex[];
}> {
  const simulateContract = jest.fn().mockResolvedValue({ request: {} });
  const writeContract = jest.fn().mockResolvedValue("0xdead" as Hex);

  await sellToPoolForNative(
    { account: { address: USER }, writeContract } as never,
    { simulateContract } as never,
    { token: TOKEN, path: PATH, amountIn: AMOUNT_IN, minOut: MIN_OUT }
  );

  const call = simulateContract.mock.calls[0][0] as Record<string, unknown>;
  const args = call.args as readonly [Hex, readonly Hex[], bigint];
  const [packed, params] = decodeAbiParameters(parseAbiParameters("bytes, bytes[]"), args[1][0]);

  const actions: number[] = [];
  for (let i = 2; i < packed.length; i += 2) {
    actions.push(Number.parseInt(packed.slice(i, i + 2), 16));
  }
  return { call, commands: args[0], actions, params: params as Hex[] };
}

describe("selling a graduated market's token for native MON", () => {
  it("sends the one V4_SWAP command", async () => {
    const { commands } = await capture();
    expect(commands).toBe("0x10");
  });

  it("uses the MULTI-HOP swap, then settles and takes", async () => {
    // 0x06 is the single-pool form and takes a `PoolKey`, not a path. Decoded against these
    // parameters it is a different swap entirely, on a pool that was never named.
    const { actions } = await capture();
    expect(actions).toEqual([SWAP_EXACT_IN, SETTLE_ALL, TAKE_ALL]);
  });

  it("names the market's token as `currencyIn`, not native MON", async () => {
    const { params } = await capture();
    const [[currencyIn, path, amountIn, amountOutMinimum]] = decodeAbiParameters(
      EXACT_IN_PARAMS,
      params[0]
    );
    expect(currencyIn.toLowerCase()).toBe(TOKEN);
    expect(currencyIn).not.toBe(NATIVE);
    expect(amountIn).toBe(AMOUNT_IN);
    expect(amountOutMinimum).toBe(MIN_OUT);
    expect(path.map((hop) => hop[0].toLowerCase())).toEqual([USDC, NATIVE]);
  });

  it("settles the token, for exactly what is being spent", async () => {
    const [currency, amount] = decodeAbiParameters(SETTLE_TAKE_PARAMS, (await capture()).params[1]);
    expect(currency.toLowerCase()).toBe(TOKEN);
    expect(amount).toBe(AMOUNT_IN);
  });

  it("takes NATIVE MON, so the floor is in the asset the seller receives", async () => {
    const [currency, amount] = decodeAbiParameters(SETTLE_TAKE_PARAMS, (await capture()).params[2]);
    expect(currency).toBe(NATIVE);
    expect(amount).toBe(MIN_OUT);
  });

  it("sends NO value, because the input currency is an ERC-20", async () => {
    // MON sent alongside a swap that pulls its input through Permit2 is never spent and never
    // refunded — it is stranded in the router. Absent, not zero: `in` is the assertion.
    const { call } = await capture();
    expect("value" in call).toBe(false);
  });

  it("refuses an empty path, which would settle a token for nothing", async () => {
    await expect(
      sellToPoolForNative(
        { account: { address: USER }, writeContract: jest.fn() } as never,
        { simulateContract: jest.fn() } as never,
        { token: TOKEN, path: [], amountIn: AMOUNT_IN, minOut: MIN_OUT }
      )
    ).rejects.toThrow(/at least one hop/);
  });

  it("refuses a wallet with no connected account", async () => {
    await expect(
      sellToPoolForNative(
        { writeContract: jest.fn() } as never,
        { simulateContract: jest.fn() } as never,
        { token: TOKEN, path: PATH, amountIn: AMOUNT_IN, minOut: MIN_OUT }
      )
    ).rejects.toThrow(/no connected account/);
  });
});
