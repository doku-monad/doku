/**
 * @jest-environment node
 */
import { erc20Abi } from "viem";

import { curveAbi } from "../../src/lib/chain/abis";
import { buyOnCurve, sell } from "../../src/lib/chain/writes";
import { type LocalChain, startLocalChain } from "./anvil";

/**
 * Trading a market that is priced in an ERC-20 rather than in native MON.
 *
 * The whole point of the pairs launchpad is that a coin can be quoted in anything the registry
 * lists, and until now every write test traded the native market. The two paths are different
 * functions with different failure modes: `buy` is payable and needs no allowance, `buyWithToken`
 * pulls through an allowance the buyer gave THE CURVE and reverts `QuoteIsNative()` if called on a
 * MON market. Sending `value` alongside an ERC-20 buy reverts too. None of that was exercised.
 *
 * The market here is quoted in the scenario's six-decimal USDC, which also puts the decimals under
 * test: an amount scaled at eighteen would be a millionth of what the caller meant.
 */
describe("trading a market quoted in an ERC-20", () => {
  let chain: LocalChain;
  /** Narrowed once; `startLocalChain` types the market optional because most tests do not ask. */
  let market: { quote: `0x${string}`; curve: `0x${string}`; token: `0x${string}` };

  beforeAll(async () => {
    chain = await startLocalChain(8562, { launchOnly: true, erc20Quote: true });
    if (!chain.usdc) throw new Error("scenario did not report an ERC-20 quoted market");
    market = chain.usdc;
  }, 300_000);

  afterAll(() => chain?.stop());

  const me = () => chain.wallet.account!.address;

  const balanceOf = (token: `0x${string}`, who: `0x${string}`) =>
    chain.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [who],
    }) as Promise<bigint>;

  const approve = async (token: `0x${string}`, spender: `0x${string}`, amount: bigint) => {
    const hash = await chain.wallet.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, amount],
      chain: null,
      account: chain.wallet.account!,
    });
    await chain.publicClient.waitForTransactionReceipt({ hash });
  };

  /** The curve's own quote, so this asserts against the contract's arithmetic and not a copy. */
  const quoteBuy = async (quoteIn: bigint) => {
    const [baseOut] = await chain.publicClient.readContract({
      address: market.curve,
      abi: curveAbi,
      functionName: "quoteBuy",
      args: [quoteIn],
    });
    return baseOut;
  };

  it("is quoted in a six-decimal asset, which is what the decimals bug hid behind", async () => {
    const [quoteAsset, decimals] = await Promise.all([
      chain.publicClient.readContract({
        address: market.curve,
        abi: curveAbi,
        functionName: "quoteAsset",
      }) as Promise<`0x${string}`>,
      chain.publicClient.readContract({
        address: market.quote,
        abi: erc20Abi,
        functionName: "decimals",
      }) as Promise<number>,
    ]);
    expect(quoteAsset.toLowerCase()).toBe(market.quote.toLowerCase());
    expect(Number(decimals)).toBe(6);
  }, 120_000);

  it("buys through the allowance the buyer gave the CURVE, and the tokens arrive", async () => {
    const spend = 250_000_000n; // 250 USDC at six decimals.
    await approve(market.quote, market.curve, spend);

    const before = await balanceOf(market.token, me());
    const usdcBefore = await balanceOf(market.quote, me());

    const hash = await buyOnCurve(chain.wallet, chain.publicClient, {
      curve: market.curve,
      quoteAsset: market.quote,
      quoteIn: spend,
      quoted: await quoteBuy(spend),
      slippageBps: 100,
    });
    const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");

    expect(await balanceOf(market.token, me())).toBeGreaterThan(before);
    // The quote actually left the buyer, which a payable path would not have done.
    expect(usdcBefore - (await balanceOf(market.quote, me()))).toBe(spend);
  }, 180_000);

  it("carries no value, so the buy cannot be paid for twice", async () => {
    // A native buy sends `value`; an ERC-20 buy must not, and the curve reverts if it does. The
    // balance check is the proof: MON left the account only as gas.
    const spend = 10_000_000n;
    await approve(market.quote, market.curve, spend);
    const monBefore = await chain.publicClient.getBalance({ address: me() });

    const hash = await buyOnCurve(chain.wallet, chain.publicClient, {
      curve: market.curve,
      quoteAsset: market.quote,
      quoteIn: spend,
      quoted: await quoteBuy(spend),
      slippageBps: 100,
    });
    const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");

    const spentMon = monBefore - (await chain.publicClient.getBalance({ address: me() }));
    const gas = receipt.gasUsed * receipt.effectiveGasPrice;
    expect(spentMon).toBe(gas);
  }, 180_000);

  it("refuses a minimum the curve cannot meet, so the slippage field is not decoration", async () => {
    const spend = 10_000_000n;
    await approve(market.quote, market.curve, spend);
    const honest = await quoteBuy(spend);

    await expect(
      buyOnCurve(chain.wallet, chain.publicClient, {
        curve: market.curve,
        quoteAsset: market.quote,
        quoteIn: spend,
        // Ten times what the curve will deliver, asked for with no tolerance at all.
        quoted: honest * 10n,
        slippageBps: 0,
      }),
    ).rejects.toThrow();
  }, 180_000);

  it("sells back, and the quote asset returns to the seller", async () => {
    const held = await balanceOf(market.token, me());
    expect(held).toBeGreaterThan(0n);

    const amount = held / 4n;
    await approve(market.token, market.curve, amount);
    const usdcBefore = await balanceOf(market.quote, me());

    const [quoteOut] = await chain.publicClient.readContract({
      address: market.curve,
      abi: curveAbi,
      functionName: "quoteSell",
      args: [amount],
    });

    const hash = await sell(chain.wallet, chain.publicClient, {
      curve: market.curve,
      tokensIn: amount,
      quoted: quoteOut,
      slippageBps: 100,
    });
    const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");

    // USDC came back, and tokens went away.
    expect(await balanceOf(market.quote, me())).toBeGreaterThan(usdcBefore);
    expect(await balanceOf(market.token, me())).toBe(held - amount);
  }, 180_000);
});
