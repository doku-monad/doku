"use client";

import ButtonWithConnectWalletFallback from "components/header/wallet-button/ConnectWalletButton";
import { translationFunction } from "context/language-context";
import { useDokuWallet, useDokuWalletClient } from "context/wallet-context/DokuWalletProvider";
import type React from "react";
import { type Dispatch, type SetStateAction, useCallback, useEffect, useState } from "react";
import { toast } from "react-toastify";
import { erc20Abi, formatUnits, type Log, maxUint256, parseEventLogs } from "viem";
import { usePublicClient } from "wagmi";

import { ActionKey } from "@/components/ui/action-key";
import { TOKEN_DECIMALS as BASE_DECIMALS } from "@/lib/chain/config";
import {
  buyFromPool,
  buyFromPoolWithNative,
  permit2ApprovalsNeeded,
  sellToPool,
  sellToPoolForNative,
} from "@/lib/chain/pool";
import { planZappedSell, zappedSellCalls } from "@/lib/chain/sell-batch";
import type { Venue } from "@/lib/chain/venue";
import { CONTRACTS } from "@/lib/chain/wagmi";
import { buyOnCurve, isNativeQuote, sell } from "@/lib/chain/writes";
import type { PathKey } from "@/lib/chain/zap";
import { encodeZapSellToNative, zapBuyWithNative, zapSellToNative } from "@/lib/chain/zap";
import { describeZapError } from "@/lib/chain/zap-plan";
import { useBatchSupport } from "@/lib/hooks/use-batch-support";
import type { MarketModel } from "@/lib/models";
import { identityFor } from "@/lib/token-identity";

import { TradeToast } from "./TradeToast";

/**
 * The button that signs.
 *
 * Four things it does that the Aptos version did not need to:
 *
 * 1. **Picks the venue.** Before graduation the curve is the market; after it, the curve is
 *    permanently closed and everything goes through the v4 pool. Same button, same guards. The
 *    venue is decided upstream and passed in — see `lib/chain/venue` for why it is not read off
 *    the indexer's `poolAddress`.
 * 2. **Picks the entry point by quote asset.** `buy` is payable and `buyWithToken` pulls, and a
 *    market accepts exactly one of them: calling the other reverts `QuoteIsNative()` or
 *    `QuoteIsNotNative()` after the wallet has already opened. The choice comes from the market's
 *    own `quote_asset`.
 * 3. **Approves the right spender, which differs three ways.** The CURVE pulls the quote on an
 *    ERC-20 buy and the token on a sell. The POOL pulls through PERMIT2, which is two approvals
 *    rather than one — the token approves Permit2, and Permit2 is told to let the router spend.
 *    Approving the router directly succeeds and the swap still reverts.
 * 4. **Distinguishes a rejection from a failure.** Someone who clicked "reject" has not hit an
 *    error, and reporting it as one teaches people to dismiss the messages that matter.
 *
 * And one thing it does in BOTH directions: a `zap`, which trades native MON on a market priced in
 * something else — MON in on a buy, MON out on a sell. It arrives already measured and bounded from
 * the panel; this file only sends it.
 *
 * The two directions are not symmetric about approvals, and the docblock here said for a while that
 * a zap "has no approval at all". That was true while it only bought: MON rides as `value`, so
 * there is nothing to approve and nothing to pull. A SELL is the seller's own ERC-20 being pulled,
 * so it owes exactly the approvals point 3 describes, chosen by the same rule — the ZapRouter pulls
 * on a curve sell, Permit2 pulls on a pool one. That is why `ZapIntent` carries its DIRECTION
 * rather than leaving it to be inferred: a sell intent that fell into the buy road below would send
 * MON it does not have to a function that cannot sell.
 */

/**
 * What this wallet actually received, read out of the receipt.
 *
 * The panel quotes before the block and the receipt records after it, and on a curve mid-fill or a
 * pool with another trade in the same block those are different numbers. The toast reports the
 * second, because it is the one somebody can check their balance against.
 *
 * `null` when the received asset is native MON: value moves without an ERC-20 `Transfer`, so there
 * is nothing here to decode, and an estimate dressed as an outcome is worse than no figure.
 */
function receivedFromLogs(logs: Log[], asset: `0x${string}`, to: `0x${string}`): bigint | null {
  try {
    const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs });
    const total = transfers
      .filter(
        (log) =>
          log.address.toLowerCase() === asset.toLowerCase() &&
          log.args.to.toLowerCase() === to.toLowerCase()
      )
      .reduce((sum, log) => sum + log.args.value, 0n);
    return total > 0n ? total : null;
  } catch {
    // A receipt whose logs cannot be decoded is not a failed trade. The toast drops the figure.
    return null;
  }
}

/** Permit2's own allowance ceiling: `uint160` for the amount, `uint48` for the expiry. */
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT48 = (1n << 48n) - 1n;

/** The one call `permit2ApprovalsNeeded` implies but does not perform. */
const permit2Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
    ],
    outputs: [],
  },
] as const;

/**
 * A measured, bounded route between native MON and this market's token.
 *
 * Present only when the panel has actually quoted one — see `zapPlan`, `poolZapPlan`,
 * `sellZapPlan` and `poolSellZapPlan`. Its absence is the ordinary path, and the only path on a
 * market priced in MON.
 *
 * FOUR SHAPES: two roads times two directions, and neither axis is cosmetic.
 *
 * The VENUE decides which contract is called. A curve is not a Uniswap pool and cannot be a hop in
 * a swap, so trading MON against one needs the ZapRouter: swap into the quote asset then
 * `buyWithToken`, or sell to the curve then swap its payout out — two legs either way, and
 * therefore two floors. A graduated market IS a pool, so the whole trade is one multi-hop swap
 * through Uniswap's own router, one leg and one floor, with no zap router in the path at all.
 *
 * The DIRECTION decides what is bounded and what is owed. A buy's floors are in the market's token
 * (`minBaseOut`); a sell's last floor is in wei (`minNativeOut`), because MON is what the seller
 * walks away with. And a buy pays with `value` while a sell is pulled — see the approvals note in
 * the file docblock. It is a discriminant on the union rather than a boolean beside it so that the
 * branch below cannot read a sell's fields off a buy's shape.
 */
export type ZapIntent =
  | {
      venue: "curve";
      direction: "buy";
      router: `0x${string}`;
      path: PathKey[];
      /** Least quote the swap leg may produce, from the trader's own slippage setting. */
      minQuoteOut: bigint;
      /** Least market token the curve leg may produce, from the same setting. */
      minBaseOut: bigint;
      /** What the swap is expected to deliver — used to predict a curve-filling buy, never as a bound. */
      expectedQuoteOut: bigint;
    }
  | {
      venue: "pool";
      direction: "buy";
      /** MON through to the market's own token: the route, with the market's pool on the end. */
      path: PathKey[];
      /** Least market token the swap may produce. The only figure the buyer receives. */
      minBaseOut: bigint;
    }
  | {
      venue: "curve";
      direction: "sell";
      router: `0x${string}`;
      /** The market's quote asset through to MON — the route the curve's payout is carried down. */
      path: PathKey[];
      /** Least quote the CURVE leg may pay, from the trader's own slippage setting. */
      minQuoteOut: bigint;
      /** Least wei the swap leg may produce. The only figure the seller receives. */
      minNativeOut: bigint;
    }
  | {
      venue: "pool";
      direction: "sell";
      /** The market's own token through to MON: its pool first, then whatever hops it takes. */
      path: PathKey[];
      /** Least wei the swap may produce. The only figure the seller receives. */
      minNativeOut: bigint;
    };

export const SwapButton = ({
  inputAmount,
  isSell,
  market,
  venue,
  setSubmit,
  disabled,
  minOutputAmount,
  label,
  zap,
}: {
  /**
   * RAW units of whatever is being SPENT: the market's quote asset on a buy, the token on a sell —
   * and native MON in wei when a BUY carries a `zap`, which is the one case where the unit is not
   * the market's own. A zapped SELL still spends the market's token: MON is what it produces, and
   * that end of it is bounded by `minNativeOut` rather than counted here.
   */
  inputAmount: bigint;
  isSell: boolean;
  market: MarketModel;
  /** Decided by `chooseVenue` upstream, from the CURVE rather than from the indexer. */
  venue: Venue;
  setSubmit: Dispatch<SetStateAction<(() => Promise<void>) | null>>;
  disabled?: boolean;
  minOutputAmount: bigint;
  label?: React.ReactNode;
  zap?: ZapIntent;
}) => {
  const { t } = translationFunction();
  const { address, status, wrongChain, switchToMonad, refetchBalance } = useDokuWallet();
  const wallet = useDokuWalletClient();
  const publicClient = usePublicClient();
  const [pending, setPending] = useState(false);

  /*
   * Whether this wallet will take an approve and a sell as ONE prompt — the only asymmetry left
   * between a zapped buy and a zapped sell.
   *
   * Through the shared hook, not an inline `useCapabilities`, which is what this was. The hook
   * exists precisely to stop two surfaces reading the same capability independently and reaching
   * different answers, and this file was the second reader it was written to prevent. It also
   * means the market page now carries the same dev-only diagnostic the launch page has, which is
   * the thing that turns "why three prompts" from a guess into a lookup.
   */
  const batchSupport = useBatchSupport(address);

  const curve = market.market.marketAddress as `0x${string}`;
  const token = market.market.tokenAddress as `0x${string}`;
  const quoteAsset = market.market.quote.asset as `0x${string}`;
  const nativeQuote = isNativeQuote(quoteAsset);
  const onPool = venue === "pool";

  const handleClick = useCallback(async () => {
    if (!wallet || !publicClient || !address) return;
    const account = wallet.account!;
    setPending(true);

    /**
     * What the spender may already pull, read fresh.
     *
     * Split out of `ensureAllowance` rather than duplicated, because a batched sell needs the
     * ANSWER without the approval that usually follows it: whether an approval is needed at all is
     * what decides between one call and two, and a batch of one call is a worse ordinary
     * transaction. Two readers of the same allowance that drifted apart would put the two paths on
     * different definitions of "already approved".
     */
    const readAllowance = async (erc20: `0x${string}`, spender: `0x${string}`) =>
      (await publicClient.readContract({
        address: erc20,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address, spender],
      })) as bigint;

    /** The approval itself, awaited to a receipt — whatever the caller writes next depends on it. */
    const approveMax = async (erc20: `0x${string}`, spender: `0x${string}`) => {
      const hash = await wallet.writeContract({
        address: erc20,
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, maxUint256],
        chain: wallet.chain,
        account,
      });
      await publicClient.waitForTransactionReceipt({ hash });
    };

    /**
     * An ERC-20 allowance, topped up only when it is short.
     *
     * Prompting for a signature the chain does not need is the fastest way to make a wallet feel
     * untrustworthy, and on a token that requires an allowance to be zeroed before it is raised it
     * is also a revert.
     */
    const ensureAllowance = async (
      erc20: `0x${string}`,
      spender: `0x${string}`,
      amount: bigint
    ) => {
      if ((await readAllowance(erc20, spender)) >= amount) return;
      await approveMax(erc20, spender);
    };

    /**
     * The two approvals a v4 trade needs to spend an ERC-20, and why there are two.
     *
     * UniversalRouter holds no allowance of its own — it pulls through Permit2. So the token
     * approves PERMIT2, and then Permit2 is told to let the ROUTER spend. Approving the router
     * directly is a transaction that succeeds and a swap that still reverts.
     */
    const ensurePermit2 = async (erc20: `0x${string}`, amount: bigint) => {
      const { needsTokenApproval, needsPermit2Approval } = await permit2ApprovalsNeeded(
        publicClient,
        { token: erc20, owner: address, amount }
      );
      if (needsTokenApproval) await ensureAllowance(erc20, CONTRACTS.permit2, amount);
      if (needsPermit2Approval) {
        const hash = await wallet.writeContract({
          address: CONTRACTS.permit2,
          abi: permit2Abi,
          functionName: "approve",
          args: [erc20, CONTRACTS.universalRouter, MAX_UINT160, Number(MAX_UINT48)],
          chain: wallet.chain,
          account,
        });
        await publicClient.waitForTransactionReceipt({ hash });
      }
    };

    try {
      /*
       * The slippage floor was applied upstream, where the receipt shows it. Passing it through
       * with zero tolerance keeps exactly the number the person agreed to.
       */
      const hash = await (async () => {
        if (isSell) {
          /*
           * Being paid in MON out of a market priced in something else.
           *
           * Before the venue branch for the same reason the buy's is, and before the `onPool` check
           * below: the intent already carries the venue it was quoted against, so a click that
           * outran a mid-session graduation cannot land in the other road's contract.
           *
           * Unlike the buy, this one is PULLED, so each road owes its own approval.
           *
           * Matched on the DIRECTION and not merely on `isSell`, because the direction is what
           * narrows the union: `zap.venue === "pool"` alone still admits the buy shape, and reading
           * `minNativeOut` off it would be a floor of `undefined` on the figure the seller receives.
           */
          if (zap && zap.direction === "sell") {
            if (zap.venue === "pool") {
              // The same two approvals an ordinary pool sell owes: UniversalRouter pulls the token
              // through Permit2, and the extra hops on the far end change nothing about that.
              await ensurePermit2(token, inputAmount);
              return sellToPoolForNative(wallet, publicClient, {
                token,
                path: zap.path,
                amountIn: inputAmount,
                minOut: zap.minNativeOut,
              });
            }
            /*
             * The ROUTER is the spender here, not the curve. A direct curve sell approves the curve
             * because the curve pulls; a zapped sell approves the router, which pulls and then
             * approves the curve itself inside the one transaction.
             *
             * And that approval is the asymmetry this branch exists to close. A zapped BUY is one
             * signature — MON rides as `value`, nothing is pulled, nothing is approved. A zapped
             * sell owed two. Where the wallet can batch, it now owes one; where it cannot, the two
             * lines below are the path this app has always taken, unchanged.
             */
            const sellParams = {
              router: zap.router,
              curve,
              path: zap.path,
              baseIn: inputAmount,
              minQuoteOut: zap.minQuoteOut,
              minNativeOut: zap.minNativeOut,
            };
            const plan = planZappedSell({
              allowance: await readAllowance(token, zap.router),
              amount: inputAmount,
              support: batchSupport,
            });

            if (plan.kind === "batched") {
              const { id } = await wallet.sendCalls({
                account,
                chain: wallet.chain,
                calls: zappedSellCalls({
                  token,
                  spender: zap.router,
                  // Encoded rather than simulated: the approval it depends on is in this same
                  // batch and has not landed yet, so there is no simulation that could pass. See
                  // `encodeZapSellToNative` for what that costs and what still bounds the trade.
                  sell: encodeZapSellToNative(sellParams),
                }),
                /*
                 * Ask for atomicity only where the wallet said it has it. `forceAtomic` sets the
                 * spec's `atomicRequired`, which a wallet that batches sequentially must REFUSE —
                 * so asking blindly would turn a working one-prompt sell into an error.
                 */
                forceAtomic: plan.atomic,
              });

              /*
               * A batch returns an id, not a hash, and the id says nothing about landing. Waiting
               * on the status is what keeps "Sold" from appearing over a sale that has not
               * happened; `throwOnFailure` sends a reverted batch to `describeZapError` below, on
               * the same road as every other failure.
               */
              const { receipts } = await wallet.waitForCallsStatus({ id, throwOnFailure: true });
              /*
               * The LAST receipt is the sell. An atomic batch has one; a sequential one has the
               * approval first, and reporting that as the trade would link a toast reading "Sold"
               * to a transaction that sold nothing.
               *
               * A confirmed batch carries receipts — EIP-5792 requires them at status 200 — so the
               * throw below is for a wallet that answered outside its own spec. It reads as a
               * failure because that is honest: with no transaction to inspect, this app cannot
               * say what happened, and claiming a sale it cannot show is the worse mistake.
               */
              const last = receipts?.at(-1);
              if (!last) {
                throw new Error(
                  "Your wallet confirmed the batch but returned no transaction. Check your balance before selling again."
                );
              }
              /*
               * The last receipt's own STATUS, not merely its existence.
               *
               * `throwOnFailure` reads the BATCH's status code, and viem maps EIP-5792 v1.0's
               * `"CONFIRMED"` string straight to success without looking at the receipts at all
               * (`getCallsStatus.js`). `waitForTransactionReceipt` downstream does not throw on a
               * reverted receipt either. So a wallet answering the older shape can hand back a
               * "confirmed" batch whose last call reverted — a sale that never happened,
               * reported to the seller as "Sold".
               */
              if (last.status !== "success") {
                throw new Error(
                  "Your wallet reported the batch as confirmed, but the last call reverted. Check your balance before selling again."
                );
              }
              return last.transactionHash;
            }

            if (plan.kind === "approve-then-sell") await approveMax(token, zap.router);
            return zapSellToNative(wallet, publicClient, sellParams);
          }

          if (onPool) {
            await ensurePermit2(token, inputAmount);
            return sellToPool(wallet, publicClient, {
              token,
              quoteAsset,
              tokensIn: inputAmount,
              quoted: minOutputAmount,
              slippageBps: 0,
            });
          }
          // The curve pulls the tokens itself, so the curve is the spender. Approving the router
          // here would be an allowance nothing uses and a sell that still reverts.
          await ensureAllowance(token, curve, inputAmount);
          return sell(wallet, publicClient, {
            curve,
            tokensIn: inputAmount,
            quoted: minOutputAmount,
            slippageBps: 0,
          });
        }

        /*
         * Paying with MON on a market priced in something else.
         *
         * Before the venue branch, because the intent already carries the venue it was quoted
         * against. The panel withdraws and re-measures the option when a market graduates
         * mid-session; this ordering means a stale click cannot outrun it into the wrong branch.
         *
         * No approval of any kind, on either road: MON rides as `value`.
         *
         * The direction is checked as well as the venue. A sell intent is handled above and can
         * never reach here — but the guard is what makes that a type error rather than a trust in
         * the ordering, and the two shapes differ in every field that bounds the trade.
         */
        if (zap && zap.direction === "buy") {
          /*
           * A graduated market: one swap, no router of ours, no approval. `TAKE_ALL` collects the
           * last currency in the path, which is the market's token, so the floor is in the asset
           * the buyer actually receives.
           */
          if (zap.venue === "pool") {
            return buyFromPoolWithNative(wallet, publicClient, {
              path: zap.path,
              amountIn: inputAmount,
              minOut: zap.minBaseOut,
            });
          }
          return zapBuyWithNative(wallet, publicClient, {
            router: zap.router,
            curve,
            path: zap.path,
            monIn: inputAmount,
            minQuoteOut: zap.minQuoteOut,
            minBaseOut: zap.minBaseOut,
            expectedQuoteOut: zap.expectedQuoteOut,
          });
        }

        if (onPool) {
          // Native MON settles straight through as `value`; an ERC-20 quote is pulled exactly as a
          // token is on a sell, and owes the same two approvals.
          if (!nativeQuote) await ensurePermit2(quoteAsset, inputAmount);
          return buyFromPool(wallet, publicClient, {
            token,
            quoteAsset,
            quoteIn: inputAmount,
            quoted: minOutputAmount,
            slippageBps: 0,
          });
        }

        // On the curve an ERC-20 quote is pulled by the CURVE — not the factory, which is the
        // launch path's spender, and not the router, which is the pool's.
        if (!nativeQuote) await ensureAllowance(quoteAsset, curve, inputAmount);
        return buyOnCurve(wallet, publicClient, {
          curve,
          quoteAsset,
          quoteIn: inputAmount,
          quoted: minOutputAmount,
          slippageBps: 0,
        });
      })();

      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      refetchBalance();

      /*
       * The toast, with the two facts a trader wants in the second after signing: how much landed,
       * and where the transaction is. It said `Bought`.
       */
      const identity = identityFor(market.market);
      const receivedAsset = isSell ? quoteAsset : token;
      const receivedDecimals = isSell ? market.market.quote.decimals : BASE_DECIMALS;
      const raw = address ? receivedFromLogs(receipt.logs, receivedAsset, address) : null;
      const amount =
        raw === null
          ? null
          : Number(formatUnits(raw, receivedDecimals)).toLocaleString(undefined, {
              maximumFractionDigits: 4,
            });

      toast.success(
        <TradeToast
          side={isSell ? "sell" : "buy"}
          amount={amount}
          symbol={isSell ? identity.quote.symbol : identity.ticker}
          txHash={hash}
        />
      );
    } catch (error) {
      /*
       * `describeZapError` on every path, not only the zap's.
       *
       * It names the router's spend ceiling and defers everything else — including Monad's 10 MON
       * reserve — to `describeTxError`, so it is that function plus one case. Branching on `zap`
       * here would be a second place to keep the two in step.
       */
      const described = describeZapError(error);
      if (described.kind === "rejected") {
        toast.info(described.message);
      } else {
        toast.error(described.message);
      }
    } finally {
      setPending(false);
    }
  }, [
    wallet,
    publicClient,
    address,
    isSell,
    token,
    curve,
    quoteAsset,
    nativeQuote,
    onPool,
    zap,
    batchSupport,
    inputAmount,
    minOutputAmount,
    refetchBalance,
    market.market,
  ]);

  useEffect(() => {
    setSubmit(() => handleClick);
  }, [handleClick, setSubmit]);

  if (wrongChain) {
    return (
      <ButtonWithConnectWalletFallback block variant="solid">
        <ActionKey onClick={switchToMonad} tone="warn">
          {t("Switch to Monad")}
        </ActionKey>
      </ButtonWithConnectWalletFallback>
    );
  }

  const inert = disabled || pending || status !== "ready";

  return (
    <ButtonWithConnectWalletFallback block variant="solid">
      <ActionKey
        disabled={inert}
        onClick={handleClick}
        tone={isSell ? "sell" : "buy"}
        loading={pending}
      >
        {pending ? t("Confirming…") : (label ?? t("Swap"))}
      </ActionKey>
    </ButtonWithConnectWalletFallback>
  );
};
