/**
 * @jest-environment node
 */
import { parseEther } from "viem";

import { curveAbi } from "../../src/lib/chain/abis";
import { applySlippage, buy, sell } from "../../src/lib/chain/writes";
import { type LocalChain, startLocalChain } from "./anvil";

/**
 * The write path against the contracts that ship.
 *
 * The claim being tested is not "the app calls `buy` with these arguments" — that is the
 * assumption, and a mocked client would only echo it back. The claim is that the arguments the app
 * computes produce the outcomes it promises: that a slippage floor is actually enforced by the
 * curve, and that an expired deadline is actually refused.
 */
describe("writes against a live chain", () => {
  let chain: LocalChain;

  beforeAll(async () => {
    chain = await startLocalChain(8561);
  }, 300_000);

  afterAll(() => chain?.stop());

  /** The curve's own quote, so the test asserts against the contract's arithmetic, not a copy. */
  const quote = async (monIn: bigint): Promise<bigint> => {
    /* No cast. `quoteBuy` returns FIVE values — `(baseOut, fee, antiSniperTax, creatorTax,
       refund)` — and this asserted four; `quoteSell` returns three and the one below asserted two.
       Both casts were wrong and both compiled, because a cast is believed and this suite was
       outside `tsconfig`. The ABI already types the tuple, so destructuring is enough. */
    const [baseOut] = await chain.publicClient.readContract({
      address: chain.curve,
      abi: curveAbi,
      functionName: "quoteBuy",
      args: [monIn],
    });
    return baseOut;
  };

  it("buys, and the tokens land in the buyer's wallet", async () => {
    const hash = await buy(chain.wallet, chain.publicClient, {
      curve: chain.curve,
      monIn: parseEther("5"),
      quoted: await quote(parseEther("5")),
      slippageBps: 100,
    });
    const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");

    const balance = (await chain.publicClient.readContract({
      address: chain.token,
      abi: [
        {
          type: "function",
          name: "balanceOf",
          stateMutability: "view",
          inputs: [{ type: "address" }],
          outputs: [{ type: "uint256" }],
        },
      ],
      functionName: "balanceOf",
      args: [chain.wallet.account!.address],
    })) as bigint;
    expect(balance).toBeGreaterThan(0n);
  }, 120_000);

  /**
   * The guard, proven rather than asserted.
   *
   * A minimum set above what the curve can deliver must revert. If it does not, the slippage field
   * is decoration and every trade is unprotected — which is invisible until someone is sandwiched.
   */
  it("reverts when the minimum received cannot be met", async () => {
    const monIn = parseEther("5");
    const quoted = await quote(monIn);

    await expect(
      buy(chain.wallet, chain.publicClient, {
        curve: chain.curve,
        monIn,
        // Ask for more than the curve will give at this price.
        quoted: quoted * 2n,
        slippageBps: 0,
      }),
    ).rejects.toThrow();
  }, 120_000);

  it("accepts a fair fill at the same tolerance", async () => {
    const monIn = parseEther("5");
    const hash = await buy(chain.wallet, chain.publicClient, {
      curve: chain.curve,
      monIn,
      quoted: await quote(monIn),
      slippageBps: 100,
    });
    const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
  }, 120_000);

  /// A deadline that has already passed must be refused by the contract, not merely by the UI.
  it("reverts on an expired deadline", async () => {
    await expect(
      buy(chain.wallet, chain.publicClient, {
        curve: chain.curve,
        monIn: parseEther("1"),
        quoted: 0n,
        slippageBps: 0,
        deadlineSecs: -1 as unknown as number,
      }),
    ).rejects.toThrow();
  }, 120_000);

  it("sells back to the curve", async () => {
    const holder = chain.wallet.account!.address;
    const balance = (await chain.publicClient.readContract({
      address: chain.token,
      abi: [
        {
          type: "function",
          name: "balanceOf",
          stateMutability: "view",
          inputs: [{ type: "address" }],
          outputs: [{ type: "uint256" }],
        },
      ],
      functionName: "balanceOf",
      args: [holder],
    })) as bigint;

    const tokensIn = balance / 4n;
    const approveHash = await chain.wallet.writeContract({
      address: chain.token,
      abi: [
        {
          type: "function",
          name: "approve",
          stateMutability: "nonpayable",
          inputs: [{ type: "address" }, { type: "uint256" }],
          outputs: [{ type: "bool" }],
        },
      ],
      functionName: "approve",
      args: [chain.curve, tokensIn],
      chain: chain.wallet.chain,
      account: chain.wallet.account!,
    });
    await chain.publicClient.waitForTransactionReceipt({ hash: approveHash });

    const [quoted] = await chain.publicClient.readContract({
      address: chain.curve,
      abi: curveAbi,
      functionName: "quoteSell",
      args: [tokensIn],
    });

    const hash = await sell(chain.wallet, chain.publicClient, {
      curve: chain.curve,
      tokensIn,
      quoted,
      slippageBps: 100,
    });
    const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
    expect(applySlippage(quoted, 100)).toBeLessThanOrEqual(quoted);
  }, 120_000);
});
