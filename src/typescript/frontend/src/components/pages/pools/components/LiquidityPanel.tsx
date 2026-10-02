"use client";

import { useCallback, useMemo, useState } from "react";
import { Emoji } from "utils/emoji";
import { formatUnits, maxUint256, parseUnits } from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";

import { CONTRACTS, NATIVE_CURRENCY, poolKeyOf } from "@/lib/chain/addresses";
import { TOKEN_DECIMALS, toNominal } from "@/lib/chain/config";
import { amountsForRange, depositSides } from "@/lib/chain/liquidity";
import { erc20Abi, permit2Abi, positionManagerAbi } from "@/lib/chain/liquidity-abis";
import { buildAddLiquidity } from "@/lib/chain/liquidity-calls";
import { depositWithin, NO_LEVY, withLevy } from "@/lib/chain/maker-levy";
import { POSITIONS_EARN_FEES } from "@/lib/chain/position-fees";
import {
  isFullRange,
  presetRange,
  PRESETS,
  type Range,
  rangeAsMonPerToken,
  rangeFromMonPerToken,
} from "@/lib/chain/range";
import { deadlineFrom } from "@/lib/chain/writes";
import {
  useBalances,
  useMakerLevy,
  usePoolState,
  useUserPositions,
} from "@/lib/hooks/doku/use-liquidity";
import { shorten, useLiquidityActions } from "@/lib/hooks/doku/use-liquidity-actions";
import type { MarketModel } from "@/lib/models";

/**
 * Permit2's argument widths, which are not `uint256`.
 *
 * The amount is `uint160` and the expiration is `uint48`. Passing `maxUint256` for either reverts
 * — a surprising way for an approval to fail after the person has already signed it.
 */
const PERMIT2_MAX_AMOUNT = (1n << 160n) - 1n;
const PERMIT2_MAX_EXPIRATION = Number((1n << 48n) - 1n);

/**
 * Adding and removing liquidity in a graduated market's pool.
 *
 * The protocol's own position is burned, which is often read as "this pool is closed". It is not:
 * the burn makes *that* position unwithdrawable so the market can never lose its floor. The pool
 * itself takes positions from anyone, and gives them back.
 *
 * Full range only. A range picker would mostly produce positions that quietly stop earning the
 * moment the price leaves them, and a launchpad's providers are not sitting at a desk rebalancing.
 */

const SLIPPAGE_BPS = 100;
const DEADLINE_SECS = 300;

const fmt = (value: bigint, dp = 4) => {
  const n = toNominal(value);
  if (n === 0) return "0";
  if (n < 0.0001) return n.toExponential(2);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(dp).replace(/\.?0+$/, "");
};

const label = "font-forma text-[11px] uppercase tracking-[0.08em] text-mute";
const field =
  "flex flex-col gap-2 rounded-doku-xl border border-line bg-well px-4 py-3.5 " +
  "transition-colors focus-within:border-doku focus-within:bg-surface";
const numberInput =
  "w-full min-w-0 bg-transparent font-numeric text-[22px] tabular-nums text-ink outline-none " +
  "placeholder:text-faint";

type Tab = "add" | "remove";

/**
 * A price bound, short enough to sit in a narrow box and precise enough to type back.
 *
 * These prices span orders of magnitude — a launchpad token starts around 1e-7 MON — so a fixed
 * number of decimal places renders most of them as zero, and exponent notation is the only
 * form that stays both readable and round-trippable.
 */
const formatPrice = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value >= 1e9 || value < 1e-4) return value.toExponential(4);
  return Number(value.toPrecision(6)).toString();
};

const Row = ({ label: l, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex items-baseline justify-between gap-3">
    <dt className="font-numeric text-[12px] text-mute">{l}</dt>
    <dd className="font-numeric text-[12px] tabular-nums text-ash">{children}</dd>
  </div>
);


const Action = ({
  disabled,
  pending,
  onClick,
  children,
}: {
  disabled: boolean;
  pending: string | null;
  onClick: () => void;
  children: React.ReactNode;
}) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    className="cta-gradient h-11 w-full rounded-doku-pill font-ui text-[13px] uppercase tracking-[0.08em] transition-colors disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku"
  >
    {pending ?? children}
  </button>
);

export default function LiquidityPanel({ market }: { market: MarketModel }) {
  const pool = market.state.poolAddress;
  const token = market.market.tokenAddress;
  /**
   * What this pool's other side is.
   *
   * It decides the sort order of the `PoolKey`, and therefore the `PoolId` every read below
   * addresses. It was implicit — every market was MON-quoted when this panel was written — and it
   * is a column on the market row now.
   *
   * The arithmetic underneath is NOT yet multi-quote: `positionAmounts` scales both sides by
   * eighteen decimals and every label here says MON. So the panel refuses a non-native pool rather
   * than pricing a six-decimal one as if it were MON, which would be off by a factor of 1e12 and
   * would render as a perfectly ordinary number.
   */
  const quoteAsset = market.market.quote.asset as `0x${string}`;
  const quoteIsNative = quoteAsset.toLowerCase() === NATIVE_CURRENCY.toLowerCase();

  const { address, isConnected } = useAccount();
  const { data: wallet } = useWalletClient();
  const publicClient = usePublicClient();

  const poolState = usePoolState(market.state.poolId, token);
  /**
   * What the hook will take on top of the deposit.
   *
   * Read from the market's own hook, and treated as unknown until it lands — a deposit priced
   * without it is a deposit that reverts, so the panel refuses to submit rather than guessing zero.
   */
  const levy = useMakerLevy(
    market.state.poolId,
    poolKeyOf(token as `0x${string}`, quoteAsset, market.state.poolKey).hooks,
  );
  const { positions, refetch } = useUserPositions(pool, token, poolState);
  const balances = useBalances(token);
  // Withdrawing lives in a shared hook now: the pools-page section and the portfolio do the same
  // two writes, and three copies of a simulate/send/confirm sequence is three places to drift.
  const {
    withdraw,
    pending: actionPending,
    error: actionError,
  } = useLiquidityActions();

  const [tab, setTab] = useState<Tab>("add");
  const [presetId, setPresetId] = useState<string>("full");
  const [custom, setCustom] = useState<{ low: string; high: string } | null>(null);
  const [monInput, setMonInput] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  /** Which field the person typed into last. The other is the one that gets recomputed. */
  const [driver, setDriver] = useState<"mon" | "token">("mon");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * The range being minted over.
   *
   * A preset until someone types a bound, after which the typed bounds win — so adjusting a preset
   * does not silently snap back the moment the amounts recompute.
   */
  const range = useMemo((): Range | null => {
    if (!poolState) return null;
    if (custom) {
      const low = Number(custom.low);
      const high = Number(custom.high);
      if (!(low > 0) || !(high > 0) || low >= high) return null;
      return rangeFromMonPerToken(low, high, poolState.marketTokenIsToken0);
    }
    const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0]!;
    return presetRange(preset, poolState.tickCurrent);
  }, [poolState, presetId, custom]);

  /**
   * Which tokens this range actually needs.
   *
   * The whole reason the picker is worth having: a range that does not straddle the price holds one
   * token, so choosing one is how a single-sided deposit is made. The panel just stops asking for
   * the side that would go unused.
   */
  const sides = useMemo(() => {
    if (!poolState || !range) return { needsToken0: true, needsToken1: true };
    return depositSides({ ...range, tickCurrent: poolState.tickCurrent });
  }, [poolState, range]);

  const needsMon = poolState ? (poolState.marketTokenIsToken0 ? sides.needsToken1 : sides.needsToken0) : true;
  const needsToken = poolState ? (poolState.marketTokenIsToken0 ? sides.needsToken0 : sides.needsToken1) : true;

  /**
   * The other side, computed from the one that was typed into.
   *
   * Whichever field was touched last drives, so a two-sided position can be entered from either
   * end without the two fighting each other. For a one-sided range only one field is live and the
   * other resolves to zero, which is not an error — it is what the range means.
   */
  const pair = useMemo(() => {
    if (!poolState || !range) return null;
    const parse = (text: string) => {
      try {
        const v = parseUnits(text || "0", TOKEN_DECIMALS);
        return v > 0n ? v : null;
      } catch {
        return null;
      }
    };

    const monWanted = needsMon ? parse(monInput) : null;
    const tokenWanted = needsToken ? parse(tokenInput) : null;
    const useMon = needsMon && (driver === "mon" || !needsToken) && monWanted !== null;
    const useToken = needsToken && !useMon && tokenWanted !== null;
    if (!useMon && !useToken) return null;

    const isToken0 = poolState.marketTokenIsToken0;
    const given = useMon
      ? isToken0
        ? { amount1: monWanted! }
        : { amount0: monWanted! }
      : isToken0
        ? { amount0: tokenWanted! }
        : { amount1: tokenWanted! };

    try {
      const r = amountsForRange({ sqrtPriceX96: poolState.sqrtPriceX96, ...range, ...given });
      return {
        amountMon: isToken0 ? r.amount1 : r.amount0,
        amountToken: isToken0 ? r.amount0 : r.amount1,
        // v4 mints by LIQUIDITY, where V3 took the two desired amounts and worked it out itself.
        // It was already computed here — the amounts are derived THROUGH it — so carrying it out
        // is what keeps the minted position identical to the one the panel priced.
        liquidity: r.liquidity,
        drivenBy: useMon ? ('mon' as const) : ('token' as const),
      };
    } catch {
      return null;
    }
  }, [poolState, range, monInput, tokenInput, driver, needsMon, needsToken]);

  // The computed side is reflected back into its field, so what is on screen is what will be sent.
  const bounds = useMemo(
    () => (range && poolState ? rangeAsMonPerToken(range, poolState.marketTokenIsToken0) : null),
    [range, poolState],
  );

  const monShown = pair && pair.drivenBy === "token" ? formatUnits(pair.amountMon, TOKEN_DECIMALS) : monInput;
  const tokenShown = pair && pair.drivenBy === "mon" ? formatUnits(pair.amountToken, TOKEN_DECIMALS) : tokenInput;

  /**
   * What the deposit actually costs, which is not what the pair says.
   *
   * `amountsForRange` answers Uniswap's question — how much of each token this liquidity is worth
   * at this price — and the hook then charges the maker on top of it. Every balance check, every
   * Max and every ceiling below reads THESE, because the paired amounts are what the pool receives
   * and these are what the wallet pays.
   */
  const cost = useMemo(() => {
    if (!pair || !levy) return null;
    return {
      mon: withLevy(pair.amountMon, levy.bps0),
      token: withLevy(pair.amountToken, levy.bps1),
    };
  }, [pair, levy]);

  const shortOfMon = cost !== null && cost.mon > balances.mon;
  const shortOfToken = cost !== null && cost.token > balances.token;

  const submitAdd = useCallback(async () => {
    // `levy` as well as `pair`: the ceilings and the MON attached below are computed from it, and
    // a null levy means the market's configuration has not been read, not that it is zero.
    if (!wallet || !publicClient || !address || !pair || !pool || !levy || !cost) return;
    setError(null);
    try {
      /**
       * Two approvals, not one, and the order is load-bearing.
       *
       * v4 moves ERC-20s through Permit2: the TOKEN approves Permit2, and Permit2 is then told to
       * let the POSITION MANAGER spend. Approving the position manager directly — the V3 habit —
       * succeeds as a transaction and the mint still reverts, with a message about allowances that
       * says nothing about the deposit the person was trying to make.
       *
       * Only when the range actually takes the token. A one-sided MON range needs no approval at
       * all, and native MON never does — it is sent as value.
       */
      // `cost.token`, not `pair.amountToken`: Permit2 has to be allowed to move what the mint
      // actually pulls, and the levy is part of that. An allowance sized to the paired amount is
      // short by the levy and fails inside the mint, as `TRANSFER_FROM_FAILED`.
      if (cost.token > 0n) {
        setPending("Checking allowance");
        const [tokenAllowance, permitAllowance] = await Promise.all([
          publicClient.readContract({
            address: token as `0x${string}`,
            abi: erc20Abi,
            functionName: "allowance",
            args: [address, CONTRACTS.permit2],
          }) as Promise<bigint>,
          publicClient.readContract({
            address: CONTRACTS.permit2,
            abi: permit2Abi,
            functionName: "allowance",
            args: [address, token as `0x${string}`, CONTRACTS.positionManager],
          }) as Promise<readonly [bigint, number, number]>,
        ]);

        if (tokenAllowance < cost.token) {
          setPending("Approving the token");
          const hash = await wallet.writeContract({
            address: token as `0x${string}`,
            abi: erc20Abi,
            functionName: "approve",
            args: [CONTRACTS.permit2, maxUint256],
            chain: wallet.chain,
            account: wallet.account!,
          });
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          if (receipt.status === "reverted") throw new Error("The token approval reverted.");
        }

        // Expiry as well as amount: a Permit2 allowance that has lapsed is large and useless, and
        // reading only the amount would skip the renewal and revert inside the mint.
        const [permitted, expiration] = permitAllowance;
        const now = Math.floor(Date.now() / 1000);
        if (permitted < cost.token || Number(expiration) <= now) {
          setPending("Approving Permit2");
          const hash = await wallet.writeContract({
            address: CONTRACTS.permit2,
            abi: permit2Abi,
            functionName: "approve",
            args: [
              token as `0x${string}`,
              CONTRACTS.positionManager,
              PERMIT2_MAX_AMOUNT,
              PERMIT2_MAX_EXPIRATION,
            ],
            chain: wallet.chain,
            account: wallet.account!,
          });
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          if (receipt.status === "reverted") throw new Error("The Permit2 approval reverted.");
        }
      }

      setPending("Adding liquidity");
      const plan = buildAddLiquidity({
        poolKey: poolKeyOf(token as `0x${string}`, quoteAsset, market.state.poolKey),
        recipient: address,
        liquidity: pair.liquidity,
        amountToken: pair.amountToken,
        amountMon: pair.amountMon,
        tickLower: range!.tickLower,
        tickUpper: range!.tickUpper,
        slippageBps: SLIPPAGE_BPS,
        // The paired amounts go in raw and the levy goes in beside them, so the builder applies
        // the two in the order the contract does. Handing it pre-levied amounts would work today
        // and quietly double-count the moment anything else here starts levying.
        levyBps0: levy.bps0,
        levyBps1: levy.bps1,
        deadline: deadlineFrom(Date.now(), DEADLINE_SECS),
      });

      // Simulated first, so a revert surfaces as a message here rather than as a wallet rejecting
      // a transaction it has already asked the person to sign.
      const { request } = await publicClient.simulateContract({
        address: CONTRACTS.positionManager,
        abi: positionManagerAbi,
        functionName: "modifyLiquidities",
        args: [plan.unlockData, plan.deadline],
        value: plan.value,
        account: address,
      });
      const hash = await wallet.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === "reverted") {
        throw new Error("The deposit reverted on chain. Nothing moved, but the gas was spent.");
      }

      setMonInput("");
      setTokenInput("");
      refetch();
    } catch (e) {
      setError(shorten(e));
    } finally {
      setPending(null);
    }
  }, [wallet, publicClient, address, pair, cost, levy, pool, token, range, refetch, market.state.poolKey, quoteAsset]);

  if (!pool) return null;

  /*
   * A pool quoted in something other than MON is refused, not approximated.
   *
   * Everything below treats the quote side as eighteen-decimal MON: `positionAmounts` scales both
   * sides by `TOKEN_DECIMALS`, the balance row reads the native balance, and every figure is
   * labelled MON. Against six-decimal gold — where one whole token is 1.39e-9 troy ounces — that
   * is wrong by a factor of 1e12, and it would render as a perfectly ordinary number beside a
   * deposit button. Saying so is the only honest thing this panel can do until the arithmetic
   * carries the quote's own decimals.
   */
  if (!quoteIsNative) {
    return (
      <div className="rounded-doku-lg border border-warn/40 bg-warn/10 p-3">
        <p className="font-forma text-[12px] leading-relaxed text-warn">
          <span className="font-semibold uppercase tracking-[0.08em]">
            Liquidity is MON-only for now.
          </span>{" "}
          This market is quoted in {market.market.quote.symbol ?? "another asset"}, and this panel
          prices both sides of a position in MON. Adding here would show you the wrong amounts, so
          it is turned off rather than approximated. Trading the market is unaffected.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-1 rounded-doku-xl bg-sink p-1">
        {(["add", "remove"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            aria-pressed={tab === t}
            className={
              "h-9 rounded-doku-lg font-forma text-[12px] uppercase tracking-[0.08em] transition-colors " +
              (tab === t
                ? "bg-surface text-ink"
                : "text-mute hover:text-ink")
            }
          >
            {t === "add" ? "Add" : "Remove"}
          </button>
        ))}
      </div>

      {tab === "add" ? (
        <>
          {/*
            This warning went away for a while, and it was wrong to. It said this pool pays
            liquidity providers nothing, and at the time that had briefly stopped being true:
            `DokuHook.LP_LEVY_BPS` donated seventy-five basis points of every swap's levy to the
            pool's in-range positions, so a provider earned from volume like an LP anywhere else.

            Generation 4 undoes the donation. `LP_LEVY_BPS` — same name, ABI-frozen — now credits
            that share straight to the market's sink ledger instead, and the pool's own fee is still
            zero and still has to be (see `POOL_FEE_TIER`). So the warning is back, and this time
            permanently rather than behind a flag: `POSITIONS_EARN_FEES` is `false` for the hook a
            market graduates into today, not "not yet true again".
          */}
          {!POSITIONS_EARN_FEES && (
            <div className="rounded-doku-lg border border-warn/40 bg-warn/10 p-3">
              <p className="font-forma text-[12px] leading-relaxed text-warn">
                <span className="font-semibold uppercase tracking-[0.08em]">
                  This pool pays liquidity providers nothing.
                </span>{" "}
                Its fee is zero by design, and the swap levy goes to the market&rsquo;s sink, not to
                your position. You still pay a maker levy on each token, both entering and leaving —
                see &ldquo;Entry fee&rdquo; below — and still carry impermanent loss. On a
                holder-rewards market the tokens you deposit also stop earning dividends: the pool
                is left out of every payout. Providing liquidity is expected to lose money.
              </p>
            </div>
          )}

          {/* The range first: it decides which tokens are even asked for, so choosing it after
              entering amounts would keep invalidating them. */}
          <div className="flex flex-col gap-2">
            <span className={label}>Price range</span>
            <div className="grid grid-cols-4 gap-1.5">
              {PRESETS.map((preset) => {
                const active = !custom && preset.id === presetId;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    title={preset.hint}
                    aria-pressed={active}
                    onClick={() => {
                      setPresetId(preset.id);
                      setCustom(null);
                    }}
                    className={
                      "h-9 rounded-doku-lg border font-numeric text-[12px] transition-colors " +
                      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-doku " +
                      (active
                        ? "border-doku bg-[rgb(10_228_72_/_0.14)] text-doku-ink"
                        : "border-line bg-surface text-ash hover:border-doku hover:text-doku-ink")
                    }
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              {(["low", "high"] as const).map((edge) => (
                <label key={edge} className="flex flex-col gap-1 rounded-doku-lg border border-line bg-surface px-3 py-2">
                  <span className="font-forma text-[11px] uppercase tracking-[0.08em] text-faint">
                    {edge === "low" ? "Min price" : "Max price"}
                  </span>
                  <input
                    inputMode="decimal"
                    value={
                      custom
                        ? custom[edge]
                        : bounds
                          ? formatPrice(edge === "low" ? bounds.low : bounds.high)
                          : ""
                    }
                    onChange={(e) => {
                      const v = e.target.value.replace(/[^0-9.eE+-]/g, "");
                      const base = custom ?? {
                        low: bounds ? formatPrice(bounds.low) : "",
                        high: bounds ? formatPrice(bounds.high) : "",
                      };
                      setCustom({ ...base, [edge]: v });
                    }}
                    className="w-full min-w-0 bg-transparent font-numeric text-[13px] tabular-nums text-ink outline-none"
                    aria-label={`${edge === "low" ? "Minimum" : "Maximum"} price in MON per token`}
                  />
                </label>
              ))}
            </div>

            <p className="font-numeric text-[11px] leading-relaxed text-faint">
              {range === null
                ? "Enter a low price below the high one."
                : isFullRange(range)
                  ? "Every price. Never goes idle."
                  : needsMon && needsToken
                    ? "MON per token. Only two-sided while the price is inside this band."
                    : `Entirely ${needsMon ? "below" : "above"} the market — funded with ${
                        needsMon ? "MON" : "tokens"
                      } alone, and converts as the price moves into it.`}
            </p>
          </div>

          {needsMon && (
            <div className={field}>
              <div className="flex items-baseline justify-between gap-3">
                <span className={label}>MON</span>
                <span className="font-numeric text-[11px] text-mute">{fmt(balances.mon)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <input
                  inputMode="decimal"
                  placeholder="0"
                  value={monShown}
                  onChange={(e) => {
                    setDriver("mon");
                    setMonInput(e.target.value.replace(/[^0-9.]/g, ""));
                  }}
                  className={numberInput}
                  aria-label="MON to deposit"
                />
                <button
                  type="button"
                  onClick={() => {
                    setDriver("mon");
                    // The balance MINUS the room the levy needs. Depositing the whole balance is
                    // the one amount that cannot settle: the mint pulls the deposit plus the levy.
                    setMonInput(
                      formatUnits(depositWithin(balances.mon, (levy ?? NO_LEVY).bps0), TOKEN_DECIMALS),
                    );
                  }}
                  className="shrink-0 rounded-doku-lg border border-line px-2.5 py-1 font-numeric text-[11px] text-ash transition-colors hover:border-doku hover:text-doku-ink"
                >
                  Max
                </button>
              </div>
            </div>
          )}

          {needsToken && (
            <div className={field}>
              <div className="flex items-baseline justify-between gap-3">
                <span className={label}>
                  <Emoji emojis={market.market.symbol} className="text-[13px] leading-none" />
                </span>
                <span className="font-numeric text-[11px] text-mute">{fmt(balances.token, 2)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <input
                  inputMode="decimal"
                  placeholder="0"
                  value={tokenShown}
                  onChange={(e) => {
                    setDriver("token");
                    setTokenInput(e.target.value.replace(/[^0-9.]/g, ""));
                  }}
                  className={numberInput}
                  aria-label="Tokens to deposit"
                />
                <button
                  type="button"
                  onClick={() => {
                    setDriver("token");
                    setTokenInput(
                      formatUnits(
                        depositWithin(balances.token, (levy ?? NO_LEVY).bps1),
                        TOKEN_DECIMALS,
                      ),
                    );
                  }}
                  className="shrink-0 rounded-doku-lg border border-line px-2.5 py-1 font-numeric text-[11px] text-ash transition-colors hover:border-doku hover:text-doku-ink"
                >
                  Max
                </button>
              </div>
            </div>
          )}

          <dl className="flex flex-col gap-2 pt-1">
            <Row label="Range">
              {range === null
                ? "—"
                : custom
                  ? "Custom"
                  : (PRESETS.find((p) => p.id === presetId)?.label ?? "Custom")}
            </Row>
            {/*
              This used to be labelled "Earns" — "Always" / "While in band" — back when the hook's
              donation made that literally true. It no longer is: nothing here earns, in or out of
              band (see the warning above), so the label changed to what the value actually tells
              someone: whether the position is presently two-sided, which is what decides its
              impermanent-loss exposure and whether it can fill a swap in either direction.
            */}
            <Row label="Two-sided">
              {range === null ? "—" : isFullRange(range) ? "Always" : "While in band"}
            </Row>
            {/*
              There used to be an "Earns on volume" row here, reading `LP_LEVY_BPS` straight off
              `config.ts`. It said "1.00%" once, left over from Uniswap V3's fee tier, then said the
              hook's LP-donation share once that shipped. Generation 4 removes the donation — that
              same share now funds the market's sink, not a position — so the honest number is zero,
              and a "0.00%" row next to "Entry fee" would read as a typo, not as an answer. Removed
              rather than zeroed; the warning above states the "earns nothing" fact once, in words,
              instead of restating it here as an implied line item beside a real cost.
            */}
            {/*
              What entering costs, which used to be invisible and is not small.

              The hook levies the maker on `afterAddLiquidity` and again on `afterRemoveLiquidity`,
              so a round trip pays this twice. It was absent from this panel entirely, and the first
              a depositor heard of it was a mint that reverted for the amount they had just been
              shown. A fee a person pays is a fee a person is told about.
            */}
            <Row label="Entry fee">
              {levy === null
                ? "—"
                : levy.bps0 === levy.bps1
                  ? `${(levy.bps0 / 100).toFixed(2)}%`
                  : `${(levy.bps0 / 100).toFixed(2)}% MON · ${(levy.bps1 / 100).toFixed(2)}% token`}
            </Row>
            <Row label="Max slippage">{(SLIPPAGE_BPS / 100).toFixed(2)}%</Row>
          </dl>

          <Action
            disabled={
              !isConnected ||
              range === null ||
              !pair ||
              levy === null ||
              shortOfMon ||
              shortOfToken ||
              pending !== null
            }
            pending={pending}
            onClick={submitAdd}
          >
            {!isConnected
              ? "Connect"
              : range === null
                ? "Set a valid range"
                : !pair
                  ? "Enter an amount"
                  : levy === null
                    ? "Reading the pool"
                    : shortOfMon
                      ? "Not enough MON"
                      : shortOfToken
                        ? "Not enough tokens"
                        : "Add liquidity"}
          </Action>
        </>
      ) : (
        <>
          {positions.length === 0 ? (
            <div className="rounded-doku-xl border border-dashed border-line px-4 py-10 text-center">
              <p className="text-[13px] text-ink">
                {isConnected ? "No position here yet." : "Connect to see your positions."}
              </p>
              <p className="mt-1 text-[12px] text-mute">
                {isConnected ? "Add liquidity and it will show up here." : ""}
              </p>
            </div>
          ) : (
            positions.map((p) => (
              <div key={p.tokenId.toString()} className="rounded-doku-xl border border-line px-4 py-3.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className={label}>Position #{p.tokenId.toString()}</span>
                  <span className="font-numeric text-[11px] text-faint">Full range</span>
                </div>
                <div className="mt-2 flex items-baseline justify-between gap-3">
                  <span className="font-numeric text-[17px] tabular-nums text-ink">
                    {fmt(p.amountMon)} <span className="text-[12px] text-mute">MON</span>
                  </span>
                  <span className="font-numeric text-[17px] tabular-nums text-ink">
                    {fmt(p.amountToken, 2)}{" "}
                    <span className="text-[12px] text-mute">{market.market.symbol}</span>
                  </span>
                </div>
                <button
                  type="button"
                  disabled={pending !== null || actionPending !== null}
                  onClick={() => withdraw({ position: p, token, onDone: refetch })}
                  className="mt-3 h-10 w-full rounded-doku-lg border border-line bg-surface font-forma text-[12px] uppercase tracking-[0.08em] text-ash transition-colors hover:border-loss hover:text-loss-ink disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-doku"
                >
                  {actionPending ?? "Withdraw all"}
                </button>
              </div>
            ))
          )}
        </>
      )}

      {(error ?? actionError) && (
        <p role="alert" className="rounded-doku-lg bg-[rgb(255_77_94_/_0.14)] px-3 py-2 text-[12px] text-loss-ink">
          {error ?? actionError}
        </p>
      )}
    </div>
  );
}
